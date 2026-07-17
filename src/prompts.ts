import type {
  AgentObservation,
  Assignment,
  CandidateSnapshot,
  RoleDefinition,
  WorkflowDefinition,
} from "./domain.js";
import { HARNESS_AUDIT_DIRECTORY, HARNESS_AUDIT_TRACE_PATH } from "./audit.js";

interface AgentPromptState {
  readonly assignment: Assignment;
  readonly role: RoleDefinition;
  readonly turn: number;
  readonly candidateId: string | undefined;
  readonly targetCandidateId: string | undefined;
}

export function buildSupervisorPrompt(options: {
  readonly workflow: WorkflowDefinition;
  readonly round: number;
  readonly agents: ReadonlyArray<{
    readonly agentId: string;
    readonly roleId: string;
    readonly turns: number;
    readonly maxTurns: number;
    readonly candidateId: string | undefined;
    readonly targetCandidateId: string | undefined;
  }>;
  readonly observations: ReadonlyArray<AgentObservation>;
  readonly candidates: ReadonlyArray<CandidateSnapshot>;
}): string {
  const { workflow } = options;
  const roleCatalog = workflow.roles.map((role) => ({
    id: role.id,
    kind: role.kind,
    description: role.description,
    maxInstances: role.maxInstances,
    maxTurns: role.maxTurns,
    enforcedScope:
      role.kind === "candidate"
        ? "isolated writable Git worktree"
        : role.kind === "review"
          ? "one named candidate worktree, read-only"
          : "base workspace, read-only",
  }));

  const candidateEvidence = options.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    diffStat: candidate.diffStat,
    patchPath: candidate.patchPath,
    evaluation:
      candidate.evaluation === undefined
        ? undefined
        : {
            passed: candidate.evaluation.passed,
            exitCode: candidate.evaluation.exitCode,
            durationMs: candidate.evaluation.durationMs,
            stdoutTail: candidate.evaluation.stdout.slice(-4_000),
            stderrTail: candidate.evaluation.stderr.slice(-4_000),
          },
  }));

  return `You are the supervisor inside a deterministic agent harness.

Objective: ${workflow.objective}

Supervisor instructions:
${workflow.supervisor.instructions}

This is round ${options.round} of at most ${workflow.limits.maxRounds}.

Configured role catalog:
${JSON.stringify(roleCatalog, null, 2)}

Current logical agents (an existing agentId resumes the same immutable role and workspace):
${JSON.stringify(options.agents, null, 2)}

Fresh observations from the previous worker batch:
${JSON.stringify(options.observations, null, 2)}

Current candidate snapshots. Full patches are durable artifacts; reviewers can inspect a chosen
candidate directly when assigned with targetCandidateId:
${JSON.stringify(candidateEvidence, null, 2)}

Harness rules you cannot override:
- Assign only configured role IDs and use a stable lowercase agentId.
- Each agentId has one immutable role. A review agent is also pinned to one target candidate.
- research and candidate assignments require targetCandidateId = null.
- review assignments require an existing candidate agent ID as targetCandidateId.
- Use status "continue" with at least one assignment when more work is needed.
- Use status "accept" with no assignments and selectedCandidateId set to a candidate only when it
  is ready. If deterministic evaluation is configured, only a passing candidate can be accepted.
- Use status "stop" with no assignments and selectedCandidateId = null when no sound candidate can
  be produced.
- Do not ask agents to escape their scope, alter harness limits, or spawn nested agents.

Return exactly the structured decision required by the output schema.`;
}

export function buildAgentPrompt(workflow: WorkflowDefinition, state: AgentPromptState): string {
  const evaluatorArgv =
    workflow.evaluation === undefined
      ? "No deterministic evaluator is declared for this workflow."
      : `Declared deterministic evaluator argv: ${JSON.stringify(workflow.evaluation.command)}`;
  const scope =
    state.role.kind === "candidate"
      ? `You may modify only your isolated candidate worktree. Your candidate ID is ${state.candidateId}.
${HARNESS_AUDIT_DIRECTORY}/ is reserved ephemeral harness state. Do not create, modify, delete,
stage, inspect, or rely on that path or any content beneath it.`
      : state.role.kind === "review"
        ? `Inspect candidate ${state.targetCandidateId} read-only. Do not modify it.
The trusted candidate-scoped audit trace is at ${HARNESS_AUDIT_TRACE_PATH}. The harness recreated it
immediately before this turn; treat it as read-only trusted-role input.`
        : "Inspect the base workspace read-only. Do not modify it.";

  const roleSpecificRules =
    state.role.kind === "candidate"
      ? `${evaluatorArgv}
- When an evaluator is declared, use that exact argv for focused local checks when practical. The
  harness independently reruns the same configured evaluator after your turn.`
      : state.role.kind === "review"
        ? `${evaluatorArgv}
- Read the candidate changes end-to-end and inspect the complete scoped trace before concluding.
- Check trace.header and any trace.truncation record first. If truncated is true or records were
  omitted, report degraded audit coverage explicitly and do not claim the trace review was complete.
- When an evaluator is declared, independently rerun that exact argv in this read-only workspace;
  do not substitute a model-chosen command or rely only on the recorded result.
- Explicitly report suspicious hardcoding, cache reuse, grader/test detection, path or environment
  tricks, and claims unsupported by the candidate, trace, or empirical check results.
- Summarize findings without copying raw trace records or repeating the private trace path.
- You cannot select the candidate or edit any candidate file, including harness audit state.`
        : "";

  return `You are logical subagent ${state.assignment.agentId}, turn ${state.turn}/${state.role.maxTurns}.

Overall objective: ${workflow.objective}

Your role: ${state.role.id} (${state.role.kind})
${state.role.description}

Standing role instructions:
${state.role.instructions}

This turn's scoped assignment:
${state.assignment.task}

Enforced scope:
${scope}

Rules:
- Work directly on the assignment and verify claims with available local evidence.
- Do not delegate, spawn nested agents, or try to communicate with other agents.
- Do not access paths outside the supplied workspace.
- Candidate agents should make the requested edits and run focused checks when practical.
- Report facts compactly. The filesystem and deterministic evaluator, not your prose, decide
  whether candidate changes exist or pass.
${roleSpecificRules}

Return exactly the structured report required by the output schema.`;
}
