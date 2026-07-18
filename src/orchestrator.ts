import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Cause, Effect, Exit, Fiber, Result, Semaphore } from "effect";

import { publishPatchArtifact } from "./artifacts.js";
import { materializeCandidateAuditTrace } from "./audit.js";
import type { CandidateTurnTrace, MaterializedAuditTrace } from "./audit.js";
import { makeRunBudget, tokenBudgetCharge } from "./budget.js";
import type { RunBudget } from "./budget.js";
import { makeCodexRuntime } from "./codex-runtime.js";
import type {
  AgentObservation,
  AgentReport,
  Assignment,
  CandidateSnapshot,
  RoleDefinition,
  RunSummary,
  SupervisorDecision,
  WorkflowDefinition,
} from "./domain.js";
import {
  AGENT_REPORT_JSON_SCHEMA,
  decodeAgentReport,
  decodeSupervisorDecision,
  SUPERVISOR_OUTPUT_JSON_SCHEMA,
} from "./domain.js";
import { evaluateCandidate } from "./evaluator.js";
import type { HarnessError } from "./errors.js";
import { BudgetExceeded, DecisionError, errorMessage, JournalError } from "./errors.js";
import { makeRunJournal } from "./journal.js";
import type { RunJournal } from "./journal.js";
import { buildAgentPrompt, buildSupervisorPrompt } from "./prompts.js";
import { createRunId, runDirectoryFor } from "./run-id.js";
import type { AgentRuntime } from "./runtime.js";
import {
  acquireCandidateWorktree,
  applyCandidatePatch,
  assertCandidateAuditPathUntracked,
  captureCandidatePatch,
  inspectBaseWorkspace,
  prepareCandidateAuditDirectoryForTurn,
  reserveCandidateAuditDirectory,
  verifyCandidateAuditDirectoryAfterTurn,
} from "./workspace.js";

interface AgentState {
  readonly agentId: string;
  readonly role: RoleDefinition;
  readonly cwd: string;
  readonly sandbox: "read-only" | "workspace-write";
  readonly candidateId: string | undefined;
  readonly targetCandidateId: string | undefined;
  threadId: string | undefined;
  turns: number;
}

interface CandidateState {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly patchPath: string;
  artifactId: string | undefined;
  artifactDigest: string | undefined;
  diffStat: string;
  evaluation: CandidateSnapshot["evaluation"];
  readonly trace: Array<CandidateTurnTrace>;
}

interface PreparedAssignment {
  readonly assignment: Assignment;
  readonly agent: AgentState;
}

interface WorkerOutcome {
  readonly observation: AgentObservation;
  readonly tokenBudgetExceeded: BudgetExceeded | undefined;
  readonly candidateTrace: CandidateTurnTrace | undefined;
}

interface LoopTermination {
  readonly status: RunSummary["status"];
  readonly selectedCandidateId: string | undefined;
  readonly reason: string;
}

export interface OrchestratorOptions {
  readonly workflow: WorkflowDefinition;
  readonly runtime?: AgentRuntime;
  readonly harnessHome?: string;
  readonly runId?: string;
  readonly apply?: boolean;
  readonly keepWorktrees?: boolean;
}

export function defaultHarnessHome(): string {
  return path.resolve(process.env.AGENT_BLOCKS_HOME ?? path.join(os.homedir(), ".agent-blocks"));
}

function writeJsonArtifact(filePath: string, value: unknown): Effect.Effect<void, JournalError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new JournalError({
        message: `Unable to write artifact ${filePath}`,
        cause,
      }),
  });
}

function allocateRunDirectory(runDirectory: string): Effect.Effect<void, JournalError> {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(runDirectory), { recursive: true });
      await mkdir(runDirectory);
    },
    catch: (cause) => {
      const collision =
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
      return new JournalError({
        message: collision
          ? `Run directory already exists; refusing to reuse it: ${runDirectory}`
          : `Unable to allocate run directory ${runDirectory}`,
        cause,
      });
    },
  });
}

function decodeJson<A>(
  text: string,
  decode: (input: unknown) => A,
  label: string,
): Effect.Effect<A, DecisionError> {
  return Effect.try({
    try: () => decode(JSON.parse(text)),
    catch: (cause) =>
      new DecisionError({
        message: `${label} was not valid structured JSON: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

function roleMap(workflow: WorkflowDefinition): ReadonlyMap<string, RoleDefinition> {
  return new Map(workflow.roles.map((role) => [role.id, role]));
}

function validateDecision(options: {
  readonly workflow: WorkflowDefinition;
  readonly decision: SupervisorDecision;
  readonly agents: ReadonlyMap<string, AgentState>;
  readonly candidates: ReadonlyMap<string, CandidateState>;
}): Effect.Effect<void, DecisionError> {
  return Effect.try({
    try: () => {
      const { decision, workflow } = options;
      if (decision.summary.trim().length === 0) {
        throw new Error("Decision summary must not be empty");
      }
      if (decision.status === "continue") {
        if (decision.assignments.length === 0) {
          throw new Error("continue requires at least one assignment");
        }
        if (decision.selectedCandidateId !== null) {
          throw new Error("continue requires selectedCandidateId = null");
        }
      } else if (decision.assignments.length !== 0) {
        throw new Error(`${decision.status} requires an empty assignments array`);
      }
      if (decision.status === "stop" && decision.selectedCandidateId !== null) {
        throw new Error("stop requires selectedCandidateId = null");
      }
      if (decision.status === "accept") {
        if (decision.selectedCandidateId === null) {
          throw new Error("accept requires selectedCandidateId");
        }
        const selected = options.candidates.get(decision.selectedCandidateId);
        if (selected === undefined) {
          throw new Error(`Unknown selected candidate: ${decision.selectedCandidateId}`);
        }
        if (workflow.evaluation !== undefined && selected.evaluation?.passed !== true) {
          throw new Error(`Candidate ${decision.selectedCandidateId} has not passed evaluation`);
        }
      }

      const roles = roleMap(workflow);
      const candidateIds = new Set(options.candidates.keys());
      for (const assignment of decision.assignments) {
        const role = roles.get(assignment.roleId);
        if (role?.kind === "candidate") candidateIds.add(assignment.agentId);
      }

      const seenAgents = new Set<string>();
      const instanceCounts = new Map<string, number>();
      for (const state of options.agents.values()) {
        instanceCounts.set(state.role.id, (instanceCounts.get(state.role.id) ?? 0) + 1);
      }

      for (const assignment of decision.assignments) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(assignment.agentId)) {
          throw new Error(`Invalid agentId: ${assignment.agentId}`);
        }
        if (assignment.agentId === "supervisor") {
          throw new Error("agentId supervisor is reserved");
        }
        if (assignment.task.trim().length === 0) {
          throw new Error(`Assignment task is empty for ${assignment.agentId}`);
        }
        if (seenAgents.has(assignment.agentId)) {
          throw new Error(`Agent ${assignment.agentId} appears twice in one batch`);
        }
        seenAgents.add(assignment.agentId);

        const role = roles.get(assignment.roleId);
        if (role === undefined) {
          throw new Error(`Unknown roleId: ${assignment.roleId}`);
        }
        if (role.kind === "review") {
          if (
            assignment.targetCandidateId === null ||
            !candidateIds.has(assignment.targetCandidateId)
          ) {
            throw new Error(
              `Review agent ${assignment.agentId} requires a known targetCandidateId`,
            );
          }
        } else if (assignment.targetCandidateId !== null) {
          throw new Error(
            `${role.kind} agent ${assignment.agentId} requires targetCandidateId = null`,
          );
        }

        const existing = options.agents.get(assignment.agentId);
        if (existing !== undefined) {
          if (existing.role.id !== role.id) {
            throw new Error(`Agent ${assignment.agentId} cannot change roles`);
          }
          const nextTarget = assignment.targetCandidateId ?? undefined;
          if (existing.targetCandidateId !== nextTarget) {
            throw new Error(`Agent ${assignment.agentId} cannot change target workspaces`);
          }
          if (existing.turns >= role.maxTurns) {
            throw new Error(`Agent ${assignment.agentId} exhausted role maxTurns=${role.maxTurns}`);
          }
        } else {
          const nextCount = (instanceCounts.get(role.id) ?? 0) + 1;
          if (nextCount > role.maxInstances) {
            throw new Error(`Role ${role.id} exhausted maxInstances=${role.maxInstances}`);
          }
          instanceCounts.set(role.id, nextCount);
        }
      }
    },
    catch: (cause) =>
      new DecisionError({
        message: `Supervisor decision violates harness scope: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

function candidateSnapshots(
  candidates: ReadonlyMap<string, CandidateState>,
  keepWorktrees: boolean,
): ReadonlyArray<CandidateSnapshot> {
  return [...candidates.values()]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      diffStat: candidate.diffStat,
      patchPath: candidate.patchPath,
      retainedWorktree: keepWorktrees ? candidate.worktreePath : undefined,
      evaluation: candidate.evaluation,
      ...(candidate.artifactId === undefined ? {} : { artifactId: candidate.artifactId }),
    }));
}

function agentPromptState(agents: ReadonlyMap<string, AgentState>): ReadonlyArray<{
  readonly agentId: string;
  readonly roleId: string;
  readonly turns: number;
  readonly maxTurns: number;
  readonly candidateId: string | undefined;
  readonly targetCandidateId: string | undefined;
}> {
  return [...agents.values()]
    .sort((left, right) => left.agentId.localeCompare(right.agentId))
    .map((agent) => ({
      agentId: agent.agentId,
      roleId: agent.role.id,
      turns: agent.turns,
      maxTurns: agent.role.maxTurns,
      candidateId: agent.candidateId,
      targetCandidateId: agent.targetCandidateId,
    }));
}

function appendRuntimeEvents(
  journal: RunJournal,
  agentId: string,
  threadId: string,
  events: ReadonlyArray<unknown>,
): Effect.Effect<void, JournalError> {
  return Effect.forEach(
    events,
    (rawEvent) =>
      journal.append({
        type: "codex.raw_event",
        agentId,
        threadId,
        rawEvent,
      }),
    { discard: true },
  );
}

function appendPrivateCandidateTrace(
  journal: RunJournal,
  candidateId: string,
  trace: CandidateTurnTrace,
): Effect.Effect<void, JournalError> {
  return journal.append({
    type: "harness.private.candidate_trace",
    candidateId,
    trace,
  });
}

function executeWorker(options: {
  readonly prepared: PreparedAssignment;
  readonly workflow: WorkflowDefinition;
  readonly runtime: AgentRuntime;
  readonly reportSchemaPath: string;
  readonly journal: RunJournal;
  readonly budget: RunBudget;
}): Effect.Effect<WorkerOutcome, HarnessError> {
  const { agent, assignment } = options.prepared;
  return Effect.gen(function* () {
    const prompt = buildAgentPrompt(options.workflow, {
      assignment,
      role: agent.role,
      turn: agent.turns,
      candidateId: agent.candidateId,
      targetCandidateId: agent.targetCandidateId,
    });
    yield* options.journal.append({
      type: "agent.turn_started",
      agentId: agent.agentId,
      roleId: agent.role.id,
      roleKind: agent.role.kind,
      turn: agent.turns,
      candidateId: agent.candidateId,
      targetCandidateId: agent.targetCandidateId,
      task: assignment.task,
    });

    const runtimeResult = yield* Effect.result(
      options.runtime.runTurn({
        agentId: agent.agentId,
        cwd: agent.cwd,
        sandbox: agent.sandbox,
        prompt,
        threadId: agent.threadId,
        model: agent.role.model,
        outputSchemaPath: options.reportSchemaPath,
        timeoutSeconds: options.workflow.limits.turnTimeoutSeconds,
      }),
    );

    if (Result.isFailure(runtimeResult)) {
      const observation: AgentObservation = {
        agentId: agent.agentId,
        roleId: agent.role.id,
        roleKind: agent.role.kind,
        turn: agent.turns,
        report: undefined,
        runtimeError: runtimeResult.failure.message,
        candidateId: agent.candidateId,
        targetCandidateId: agent.targetCandidateId,
      };
      yield* options.journal.append({
        type: "agent.turn_failed",
        ...observation,
      });
      const candidateTrace: CandidateTurnTrace | undefined =
        agent.candidateId === undefined
          ? undefined
          : {
              turn: agent.turns,
              assignment,
              prompt,
              finalText: undefined,
              report: undefined,
              runtimeError: runtimeResult.failure.message,
              usage: undefined,
              events: [],
            };
      if (candidateTrace !== undefined) {
        yield* appendPrivateCandidateTrace(options.journal, agent.candidateId!, candidateTrace);
        yield* verifyCandidateAuditDirectoryAfterTurn(agent.cwd);
      }
      return {
        observation,
        tokenBudgetExceeded: undefined,
        candidateTrace,
      };
    }

    const turn = runtimeResult.success;
    agent.threadId = turn.threadId;
    yield* appendRuntimeEvents(options.journal, agent.agentId, turn.threadId, turn.events);

    let report: AgentReport | undefined;
    let parseError: string | undefined;
    try {
      report = decodeAgentReport(JSON.parse(turn.finalText));
    } catch (cause) {
      parseError = `Invalid agent report: ${errorMessage(cause)}`;
    }

    const charged = yield* Effect.result(
      options.budget.chargeTokens(tokenBudgetCharge(turn.usage)),
    );
    const tokenBudgetExceeded = Result.isFailure(charged) ? charged.failure : undefined;
    const observation: AgentObservation = {
      agentId: agent.agentId,
      roleId: agent.role.id,
      roleKind: agent.role.kind,
      turn: agent.turns,
      report,
      runtimeError: parseError,
      candidateId: agent.candidateId,
      targetCandidateId: agent.targetCandidateId,
    };
    yield* options.journal.append({
      type: "agent.turn_completed",
      ...observation,
      usage: turn.usage,
      threadId: turn.threadId,
    });
    const candidateTrace: CandidateTurnTrace | undefined =
      agent.candidateId === undefined
        ? undefined
        : {
            turn: agent.turns,
            assignment,
            prompt,
            finalText: turn.finalText,
            report,
            runtimeError: parseError,
            usage: turn.usage,
            events: turn.events,
          };
    if (candidateTrace !== undefined) {
      yield* appendPrivateCandidateTrace(options.journal, agent.candidateId!, candidateTrace);
      yield* verifyCandidateAuditDirectoryAfterTurn(agent.cwd);
    }
    return { observation, tokenBudgetExceeded, candidateTrace };
  });
}

export function runOrchestration(
  options: OrchestratorOptions,
): Effect.Effect<RunSummary, HarnessError> {
  const keepWorktrees = options.keepWorktrees ?? false;
  const shouldApply = options.apply ?? false;
  const harnessHome = path.resolve(options.harnessHome ?? defaultHarnessHome());
  const runtime = options.runtime ?? makeCodexRuntime(options.workflow.codex);
  const runId = options.runId ?? createRunId();
  let runDirectory: string;
  try {
    runDirectory = runDirectoryFor(harnessHome, runId);
  } catch (cause) {
    return Effect.fail(new JournalError({ message: `Invalid run ID: ${runId}`, cause }));
  }
  const worktreesDirectory = path.join(harnessHome, "worktrees", runId);
  const candidatesDirectory = path.join(runDirectory, "candidates");
  const artifactsDirectory = path.join(runDirectory, "artifacts");
  const supervisorSchemaPath = path.join(runDirectory, "schemas", "supervisor-decision.json");
  const reportSchemaPath = path.join(runDirectory, "schemas", "agent-report.json");
  let activeJournal: RunJournal | undefined;
  let terminalRecorded = false;

  const program = Effect.gen(function* () {
    const journal = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* allocateRunDirectory(runDirectory);
        const allocated = yield* makeRunJournal(runDirectory, runId);
        activeJournal = allocated;
        yield* allocated.append({
          type: "run.created",
          workflow: options.workflow.name,
          objective: options.workflow.objective,
          configPath: options.workflow.configPath,
          requestedWorkspace: options.workflow.workspace,
          keepWorktrees,
          applyRequested: shouldApply,
        });
        return allocated;
      }),
    );
    const base = yield* inspectBaseWorkspace(
      options.workflow.workspace,
      options.workflow.allowDirtyWorkspace,
    );
    const startedAt = new Date().toISOString();
    yield* journal.append({
      type: "run.started",
      workflow: options.workflow.name,
      objective: options.workflow.objective,
      configPath: options.workflow.configPath,
      workspace: base.root,
      baseHead: base.head,
      limits: options.workflow.limits,
      keepWorktrees,
      applyRequested: shouldApply,
    });
    yield* writeJsonArtifact(supervisorSchemaPath, SUPERVISOR_OUTPUT_JSON_SCHEMA);
    yield* writeJsonArtifact(reportSchemaPath, AGENT_REPORT_JSON_SCHEMA);
    const budget = yield* makeRunBudget(options.workflow.limits);
    const semaphore = yield* Semaphore.make(options.workflow.limits.maxConcurrentAgents);
    const agents = new Map<string, AgentState>();
    const candidates = new Map<string, CandidateState>();
    let supervisorThreadId: string | undefined;
    let observations: ReadonlyArray<AgentObservation> = [];

    const loop = Effect.gen(function* () {
      for (let roundIndex = 0; roundIndex < options.workflow.limits.maxRounds; roundIndex += 1) {
        const wallCheck = yield* Effect.result(budget.checkWallClock());
        if (Result.isFailure(wallCheck)) {
          return {
            status: "budget_exhausted",
            selectedCandidateId: undefined,
            reason: wallCheck.failure.budget,
          } satisfies LoopTermination;
        }
        const round = yield* budget.beginRound();

        yield* journal.append({ type: "supervisor.turn_started", round });
        const supervisorTurn = yield* runtime.runTurn({
          agentId: "supervisor",
          cwd: base.root,
          sandbox: "read-only",
          prompt: buildSupervisorPrompt({
            workflow: options.workflow,
            round,
            agents: agentPromptState(agents),
            observations,
            candidates: candidateSnapshots(candidates, keepWorktrees),
          }),
          threadId: supervisorThreadId,
          model: options.workflow.supervisor.model,
          outputSchemaPath: supervisorSchemaPath,
          timeoutSeconds: options.workflow.limits.turnTimeoutSeconds,
        });
        supervisorThreadId = supervisorTurn.threadId;
        yield* appendRuntimeEvents(
          journal,
          "supervisor",
          supervisorTurn.threadId,
          supervisorTurn.events,
        );
        const supervisorCharge = yield* Effect.result(
          budget.chargeTokens(tokenBudgetCharge(supervisorTurn.usage)),
        );
        if (Result.isFailure(supervisorCharge)) {
          yield* journal.append({
            type: "run.budget_exhausted",
            budget: supervisorCharge.failure.budget,
            attempted: supervisorCharge.failure.attempted,
            limit: supervisorCharge.failure.limit,
          });
          return {
            status: "budget_exhausted",
            selectedCandidateId: undefined,
            reason: supervisorCharge.failure.budget,
          } satisfies LoopTermination;
        }

        const decision = yield* decodeJson(
          supervisorTurn.finalText,
          decodeSupervisorDecision,
          "Supervisor decision",
        );
        yield* validateDecision({
          workflow: options.workflow,
          decision,
          agents,
          candidates,
        });
        yield* journal.append({
          type: "supervisor.decision",
          round,
          threadId: supervisorTurn.threadId,
          usage: supervisorTurn.usage,
          decision,
        });

        if (decision.status === "accept") {
          return {
            status: "accepted",
            selectedCandidateId: decision.selectedCandidateId ?? undefined,
            reason: decision.summary,
          } satisfies LoopTermination;
        }
        if (decision.status === "stop") {
          return {
            status: "stopped",
            selectedCandidateId: undefined,
            reason: decision.summary,
          } satisfies LoopTermination;
        }

        const roles = roleMap(options.workflow);

        // Candidate worktrees are allocated first so a reviewer in the same batch can target one.
        for (const assignment of decision.assignments) {
          const role = roles.get(assignment.roleId);
          if (role?.kind === "candidate" && !candidates.has(assignment.agentId)) {
            const worktreePath = yield* acquireCandidateWorktree({
              base,
              candidateId: assignment.agentId,
              worktreesDirectory,
              keep: keepWorktrees,
            });
            yield* reserveCandidateAuditDirectory(worktreePath);
            candidates.set(assignment.agentId, {
              candidateId: assignment.agentId,
              worktreePath,
              patchPath: path.join(candidatesDirectory, `${assignment.agentId}.patch`),
              artifactId: undefined,
              artifactDigest: undefined,
              diffStat: "(not captured yet)",
              evaluation: undefined,
              trace: [],
            });
            yield* journal.append({
              type: "candidate.worktree_created",
              candidateId: assignment.agentId,
              worktreePath,
              baseHead: base.head,
            });
          }
        }

        const prepared: Array<PreparedAssignment> = [];
        let preparationBudgetError: BudgetExceeded | undefined;
        for (const assignment of decision.assignments) {
          const role = roles.get(assignment.roleId);
          if (role === undefined) {
            return yield* new DecisionError({
              message: `Role disappeared during preparation: ${assignment.roleId}`,
              cause: assignment,
            });
          }
          const existing = agents.get(assignment.agentId);
          const reservation = yield* Effect.result(budget.reserveAgentTurn(existing === undefined));
          if (Result.isFailure(reservation)) {
            preparationBudgetError = reservation.failure;
            break;
          }

          let agent = existing;
          if (agent === undefined) {
            const targetCandidateId = assignment.targetCandidateId ?? undefined;
            const candidate =
              role.kind === "candidate"
                ? candidates.get(assignment.agentId)
                : role.kind === "review" && targetCandidateId !== undefined
                  ? candidates.get(targetCandidateId)
                  : undefined;
            if (role.kind !== "research" && candidate === undefined) {
              return yield* new DecisionError({
                message: `No candidate workspace for ${assignment.agentId}`,
                cause: assignment,
              });
            }
            agent = {
              agentId: assignment.agentId,
              role,
              cwd: role.kind === "research" ? base.root : candidate!.worktreePath,
              sandbox: role.kind === "candidate" ? "workspace-write" : "read-only",
              candidateId: role.kind === "candidate" ? assignment.agentId : undefined,
              targetCandidateId,
              threadId: undefined,
              turns: 0,
            };
            agents.set(agent.agentId, agent);
          }
          agent.turns += 1;
          prepared.push({ assignment, agent });
        }

        if (preparationBudgetError !== undefined) {
          yield* journal.append({
            type: "run.budget_exhausted",
            budget: preparationBudgetError.budget,
            attempted: preparationBudgetError.attempted,
            limit: preparationBudgetError.limit,
          });
          return {
            status: "budget_exhausted",
            selectedCandidateId: undefined,
            reason: preparationBudgetError.budget,
          } satisfies LoopTermination;
        }

        const runPreparedBatch = (batch: ReadonlyArray<PreparedAssignment>) =>
          Effect.gen(function* () {
            for (const item of batch) {
              if (item.agent.role.kind === "candidate") {
                yield* prepareCandidateAuditDirectoryForTurn(item.agent.cwd);
              }
            }

            const materializedTargets = new Map<string, MaterializedAuditTrace>();
            for (const item of batch) {
              if (item.agent.role.kind !== "review") continue;
              const targetCandidateId = item.agent.targetCandidateId;
              const candidate =
                targetCandidateId === undefined ? undefined : candidates.get(targetCandidateId);
              if (candidate === undefined) {
                return yield* new DecisionError({
                  message: `No audit target for review agent ${item.agent.agentId}`,
                  cause: item.assignment,
                });
              }
              let bundle = materializedTargets.get(candidate.candidateId);
              if (bundle === undefined) {
                yield* assertCandidateAuditPathUntracked(candidate.worktreePath);
                bundle = yield* materializeCandidateAuditTrace({
                  worktreePath: candidate.worktreePath,
                  candidateId: candidate.candidateId,
                  turns: candidate.trace,
                  provenance: {
                    artifactId: candidate.artifactId,
                    artifactDigest: candidate.artifactDigest,
                    evaluation: candidate.evaluation,
                  },
                });
                materializedTargets.set(candidate.candidateId, bundle);
              }
              yield* journal.append({
                type: "harness.private.audit_materialized",
                reviewAgentId: item.agent.agentId,
                candidateId: candidate.candidateId,
                tracePath: bundle.relativePath,
                bytes: bundle.bytes,
                truncated: bundle.truncated,
                includedRecords: bundle.includedRecords,
                omittedRecords: bundle.omittedRecords,
              });
            }

            const workerResults = yield* Effect.scoped(
              Effect.gen(function* () {
                const fibers = [];
                for (const item of batch) {
                  const fiber = yield* Effect.forkScoped(
                    semaphore.withPermit(
                      executeWorker({
                        prepared: item,
                        workflow: options.workflow,
                        runtime,
                        reportSchemaPath,
                        journal,
                        budget,
                      }).pipe(Effect.result),
                    ),
                  );
                  fibers.push(fiber);
                }
                return yield* Effect.forEach(fibers, Fiber.join);
              }),
            );

            const completed: Array<{
              readonly prepared: PreparedAssignment;
              readonly outcome: WorkerOutcome;
            }> = [];
            for (let index = 0; index < workerResults.length; index += 1) {
              const result = workerResults[index]!;
              if (Result.isFailure(result)) {
                return yield* Effect.fail(result.failure);
              }
              completed.push({ prepared: batch[index]!, outcome: result.success });
            }
            return completed;
          });

        const nonReviewPrepared = prepared.filter((item) => item.agent.role.kind !== "review");
        const reviewPrepared = prepared.filter((item) => item.agent.role.kind === "review");
        const initialCompleted = yield* runPreparedBatch(nonReviewPrepared);
        for (const completed of initialCompleted) {
          const candidateId = completed.prepared.agent.candidateId;
          if (candidateId !== undefined && completed.outcome.candidateTrace !== undefined) {
            candidates.get(candidateId)?.trace.push(completed.outcome.candidateTrace);
          }
        }

        const touchedCandidates = [
          ...new Set(
            nonReviewPrepared
              .map((item) => item.agent.candidateId)
              .filter((candidateId): candidateId is string => candidateId !== undefined),
          ),
        ].sort();

        for (const candidateId of touchedCandidates) {
          const candidate = candidates.get(candidateId);
          if (candidate === undefined) continue;
          const patch = yield* captureCandidatePatch({
            candidateId,
            worktreePath: candidate.worktreePath,
            candidatesDirectory,
          });
          const artifact = yield* publishPatchArtifact({
            patchPath: patch.patchPath,
            artifactsDirectory,
          });
          candidate.artifactId = artifact.artifactId;
          candidate.artifactDigest = artifact.digest;
          candidate.diffStat = patch.diffStat;
          yield* journal.append({
            type: "artifact.published",
            artifactId: artifact.artifactId,
            digest: artifact.digest,
            size: artifact.size,
            mediaType: artifact.mediaType,
            candidateId,
          });
          if (options.workflow.evaluation !== undefined) {
            candidate.evaluation = yield* evaluateCandidate({
              candidateId,
              worktreePath: candidate.worktreePath,
              definition: options.workflow.evaluation,
            });
          }
          yield* journal.append({
            type: "candidate.snapshot",
            candidateId,
            artifactId: artifact.artifactId,
            patchPath: patch.patchPath,
            diffStat: patch.diffStat,
            empty: patch.empty,
            evaluation: candidate.evaluation,
          });
        }

        const initialTokenBudgetError = initialCompleted.find(
          (completed) => completed.outcome.tokenBudgetExceeded !== undefined,
        )?.outcome.tokenBudgetExceeded;
        if (initialTokenBudgetError !== undefined) {
          yield* journal.append({
            type: "run.budget_exhausted",
            budget: initialTokenBudgetError.budget,
            attempted: initialTokenBudgetError.attempted,
            limit: initialTokenBudgetError.limit,
          });
          return {
            status: "budget_exhausted",
            selectedCandidateId: undefined,
            reason: initialTokenBudgetError.budget,
          } satisfies LoopTermination;
        }

        const reviewCompleted = yield* runPreparedBatch(reviewPrepared);
        const completedByAgent = new Map(
          [...initialCompleted, ...reviewCompleted].map((completed) => [
            completed.prepared.agent.agentId,
            completed,
          ]),
        );
        observations = prepared.map(
          (item) => completedByAgent.get(item.agent.agentId)!.outcome.observation,
        );

        const tokenBudgetError = reviewCompleted.find(
          (completed) => completed.outcome.tokenBudgetExceeded !== undefined,
        )?.outcome.tokenBudgetExceeded;
        if (tokenBudgetError !== undefined) {
          yield* journal.append({
            type: "run.budget_exhausted",
            budget: tokenBudgetError.budget,
            attempted: tokenBudgetError.attempted,
            limit: tokenBudgetError.limit,
          });
          return {
            status: "budget_exhausted",
            selectedCandidateId: undefined,
            reason: tokenBudgetError.budget,
          } satisfies LoopTermination;
        }
      }

      return {
        status: "budget_exhausted",
        selectedCandidateId: undefined,
        reason: "maxRounds",
      } satisfies LoopTermination;
    });

    const termination = yield* loop.pipe(
      Effect.timeoutOrElse({
        duration: `${options.workflow.limits.maxWallClockSeconds} seconds`,
        orElse: () =>
          Effect.succeed<LoopTermination>({
            status: "budget_exhausted",
            selectedCandidateId: undefined,
            reason: "maxWallClockSeconds",
          }),
      }),
    );

    let applied = false;
    if (shouldApply && termination.status === "accepted") {
      const selected =
        termination.selectedCandidateId === undefined
          ? undefined
          : candidates.get(termination.selectedCandidateId);
      if (selected === undefined) {
        return yield* new DecisionError({
          message: "Accepted run has no selected candidate",
          cause: termination,
        });
      }
      applied = yield* applyCandidatePatch({ base, patchPath: selected.patchPath });
    }

    const usage = yield* budget.usage;
    const summary: RunSummary = {
      runId,
      workflow: options.workflow.name,
      objective: options.workflow.objective,
      status: termination.status,
      startedAt,
      completedAt: new Date().toISOString(),
      rounds: usage.rounds,
      agentTurns: usage.agentTurns,
      totalAgents: usage.totalAgents,
      totalTokens: usage.totalTokens,
      selectedCandidateId: termination.selectedCandidateId,
      applied,
      runDirectory,
      candidates: candidateSnapshots(candidates, keepWorktrees),
    };
    yield* writeJsonArtifact(path.join(runDirectory, "summary.json"), summary);
    yield* journal.append({
      type: "run.completed",
      reason: termination.reason,
      summary,
    });
    terminalRecorded = true;
    return summary;
  });

  return Effect.scoped(program).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit) || activeJournal === undefined || terminalRecorded) {
        return Effect.void;
      }
      const interrupted = Cause.hasInterrupts(exit.cause);
      const failure = Cause.squash(exit.cause);
      return activeJournal
        .append({
          type: "run.failed",
          interrupted,
          errorTag: interrupted
            ? "Interrupted"
            : typeof failure === "object" && failure !== null && "_tag" in failure
              ? String(failure._tag)
              : "UnknownError",
          message: interrupted ? "Run execution was interrupted" : errorMessage(failure),
        })
        .pipe(Effect.ignore);
    }),
  );
}
