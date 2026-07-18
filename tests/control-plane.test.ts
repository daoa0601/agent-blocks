import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { RuntimeTurnInput, RuntimeTurnResult, WorkflowDefinition } from "../src/domain.js";
import { RuntimeError } from "../src/errors.js";
import { makeRunJournal } from "../src/journal.js";
import {
  assertRunId,
  createRunId,
  readRunEventRecords,
  runDirectoryFor,
} from "../src/persistence.js";
import {
  inspectRunState,
  listRuns,
  readRunEvents,
} from "../src/templates/scoped-worktree-control-plane.js";
import { runOrchestration } from "../src/templates/scoped-worktree.js";
import type { AgentRuntime } from "../src/runtime.js";
import { makeGitRepository, makeTempDirectory } from "./helpers.js";

const report = JSON.stringify({
  status: "completed",
  summary: "Completed the scoped edit.",
  evidence: ["answer.txt updated"],
  risks: [],
  nextSteps: [],
});

function turnResult(threadId: string, finalText: string): RuntimeTurnResult {
  return {
    threadId,
    finalText,
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2 },
    events: [
      {
        type: "fake.private_event",
        prompt: "raw-private-prompt",
        sessionId: "raw-private-session",
        path: "/private/raw-event-path",
      },
    ],
  };
}

function workflowFor(
  workspace: string,
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    version: 1,
    name: "control-plane-fixture",
    objective: "Exercise the local query API.",
    configPath: path.join(workspace, "workflow.yaml"),
    workspace,
    allowDirtyWorkspace: false,
    supervisor: { instructions: "Use the configured candidate.", model: undefined },
    roles: [
      {
        id: "builder",
        kind: "candidate",
        description: "Builds a deterministic candidate.",
        instructions: "Edit only answer.txt.",
        maxInstances: 1,
        maxTurns: 2,
        model: undefined,
      },
    ],
    limits: {
      maxRounds: 3,
      maxConcurrentAgents: 1,
      maxTotalAgents: 1,
      maxTotalAgentTurns: 2,
      maxWallClockSeconds: 30,
      turnTimeoutSeconds: 10,
      maxTotalTokens: 100,
    },
    evaluation: undefined,
    codex: {
      binary: "never-call-the-real-codex-runtime",
      ignoreUserConfig: true,
      maxOutputBytes: 1024,
    },
    ...overrides,
  };
}

function gatedRuntime(): {
  readonly runtime: AgentRuntime;
  readonly supervisorStarted: Promise<void>;
  readonly release: () => void;
} {
  let releaseGate!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const supervisorStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let supervisorTurns = 0;

  const runtime: AgentRuntime = {
    runTurn: (input) =>
      Effect.tryPromise({
        try: async () => {
          if (input.agentId === "supervisor") {
            supervisorTurns += 1;
            if (supervisorTurns === 1) {
              markStarted();
              await gate;
              return turnResult(
                "private-supervisor-thread",
                JSON.stringify({
                  status: "continue",
                  summary: "Create one candidate.",
                  assignments: [
                    {
                      agentId: "builder-1",
                      roleId: "builder",
                      task: "private-assignment-task",
                      targetCandidateId: null,
                    },
                  ],
                  selectedCandidateId: null,
                }),
              );
            }
            return turnResult(
              "private-supervisor-thread",
              JSON.stringify({
                status: "accept",
                summary: "Accept the deterministic candidate.",
                assignments: [],
                selectedCandidateId: "builder-1",
              }),
            );
          }
          await writeFile(path.join(input.cwd, "answer.txt"), "answer\n", "utf8");
          return turnResult("private-builder-thread", report);
        },
        catch: (cause) =>
          new RuntimeError({
            message: "Gated fake runtime failed",
            agentId: input.agentId,
            cause,
          }),
      }),
  };
  return { runtime, supervisorStarted, release: releaseGate };
}

describe("public run control surface", () => {
  it("projects in-flight token usage with the same uncached budget charge as terminal summaries", async () => {
    const harnessHome = await makeTempDirectory("agent-blocks-token-projection-");
    const runId = "token_projection-001";
    const runDirectory = runDirectoryFor(harnessHome, runId);
    await mkdir(runDirectory, { recursive: true });
    const journal = await Effect.runPromise(makeRunJournal(runDirectory, runId));
    await Effect.runPromise(journal.append({ type: "run.created", workflow: "fixture" }));
    await Effect.runPromise(journal.append({ type: "run.started", workflow: "fixture" }));
    await Effect.runPromise(
      journal.append({
        type: "supervisor.decision",
        usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3, totalTokens: 15 },
      }),
    );

    await expect(Effect.runPromise(inspectRunState(harnessHome, runId))).resolves.toMatchObject({
      status: "running",
      totalTokens: 11,
    });
  });

  it("uses a supplied ID, exposes a running projection, redacts events, and rejects collisions", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-control-");
    const runId = "caller_run-001";
    const gated = gatedRuntime();
    const fiber = Effect.runFork(
      runOrchestration({
        workflow: workflowFor(repository),
        runtime: gated.runtime,
        harnessHome,
        runId,
      }),
    );

    await gated.supervisorStarted;
    const running = await Effect.runPromise(inspectRunState(harnessHome, runId));
    expect(running).toMatchObject({
      runId,
      workflow: "control-plane-fixture",
      status: "running",
      rounds: 1,
      agentTurns: 0,
    });
    expect(running.lastSequence).toBeGreaterThanOrEqual(3);
    expect((await Effect.runPromise(listRuns(harnessHome))).map((run) => run.runId)).toEqual([
      runId,
    ]);

    gated.release();
    const summary = await Effect.runPromise(Fiber.join(fiber));
    expect(summary.runId).toBe(runId);
    expect(summary.status).toBe("accepted");
    expect(runDirectoryFor(harnessHome, runId)).toBe(summary.runDirectory);

    const completed = await Effect.runPromise(inspectRunState(harnessHome, runId));
    expect(completed).toMatchObject({
      status: "accepted",
      selectedCandidateId: "builder-1",
      totalAgents: 1,
      agentTurns: 1,
      totalTokens: 6,
      applied: false,
    });

    const publicEvents = await Effect.runPromise(readRunEvents(harnessHome, runId));
    expect(publicEvents[0]?.type).toBe("run.created");
    expect(publicEvents[1]?.type).toBe("run.started");
    expect(
      publicEvents.every(
        (event, index) => index === 0 || event.sequence > publicEvents[index - 1]!.sequence,
      ),
    ).toBe(true);
    const publicJson = JSON.stringify(publicEvents);
    expect(publicJson).not.toContain("codex.raw_event");
    expect(publicJson).not.toContain("raw-private-prompt");
    expect(publicJson).not.toContain("raw-private-session");
    expect(publicJson).not.toContain("private-supervisor-thread");
    expect(publicJson).not.toContain("private-builder-thread");
    expect(publicJson).not.toContain("private-assignment-task");
    expect(publicJson).not.toContain(repository);
    expect(publicJson).not.toContain(summary.runDirectory);
    expect(publicJson).not.toContain(summary.candidates[0]!.patchPath);

    const rawJournal = await readFile(path.join(summary.runDirectory, "events.jsonl"), "utf8");
    expect(rawJournal).toContain("codex.raw_event");
    expect(rawJournal).toContain("raw-private-prompt");
    expect(rawJournal).toContain("private-supervisor-thread");

    const firstPage = await Effect.runPromise(
      readRunEvents(harnessHome, runId, { afterSequence: 0, limit: 2 }),
    );
    const secondPage = await Effect.runPromise(
      readRunEvents(harnessHome, runId, {
        afterSequence: firstPage.at(-1)!.sequence,
        limit: 2,
      }),
    );
    expect(secondPage[0]!.sequence).toBeGreaterThan(firstPage.at(-1)!.sequence);

    await expect(
      Effect.runPromise(
        runOrchestration({
          workflow: workflowFor(repository),
          runtime: gated.runtime,
          harnessHome,
          runId,
        }),
      ),
    ).rejects.toThrow(/refusing to reuse/u);

    const generatedRunId = createRunId();
    expect(() => assertRunId(generatedRunId)).not.toThrow();
    for (const invalidRunId of ["", ".", "..", "../escape", "with space", "x".repeat(129)]) {
      expect(() => assertRunId(invalidRunId)).toThrow(/Invalid run ID/u);
    }
    await expect(
      Effect.runPromise(
        runOrchestration({
          workflow: workflowFor(repository),
          runtime: gated.runtime,
          harnessHome,
          runId: "../escape",
        }),
      ),
    ).rejects.toThrow(/Invalid run ID/u);
  }, 30_000);

  it("makes successive snapshots immutable while retaining the latest legacy patch", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-artifacts-");
    let supervisorTurns = 0;
    let candidateTurns = 0;
    const runtime: AgentRuntime = {
      runTurn: (input: RuntimeTurnInput) =>
        Effect.tryPromise({
          try: async () => {
            if (input.agentId === "supervisor") {
              supervisorTurns += 1;
              if (supervisorTurns <= 2) {
                return turnResult(
                  "supervisor-thread",
                  JSON.stringify({
                    status: "continue",
                    summary: "Advance the same candidate.",
                    assignments: [
                      {
                        agentId: "builder-1",
                        roleId: "builder",
                        task: `Candidate turn ${supervisorTurns}`,
                        targetCandidateId: null,
                      },
                    ],
                    selectedCandidateId: null,
                  }),
                );
              }
              return turnResult(
                "supervisor-thread",
                JSON.stringify({
                  status: "accept",
                  summary: "Candidate complete.",
                  assignments: [],
                  selectedCandidateId: "builder-1",
                }),
              );
            }
            candidateTurns += 1;
            const answer = path.join(input.cwd, "answer.txt");
            if (candidateTurns === 1) await writeFile(answer, "first\n", "utf8");
            else await appendFile(answer, "second\n", "utf8");
            return turnResult("builder-thread", report);
          },
          catch: (cause) =>
            new RuntimeError({ message: "Artifact fake failed", agentId: input.agentId, cause }),
        }),
    };

    const summary = await Effect.runPromise(
      runOrchestration({
        workflow: workflowFor(repository),
        runtime,
        harnessHome,
        runId: "artifact-run",
      }),
    );
    const records = await Effect.runPromise(readRunEventRecords(harnessHome, summary.runId));
    const published = records.filter((event) => event.type === "artifact.published");
    const snapshots = records.filter((event) => event.type === "candidate.snapshot");
    expect(published).toHaveLength(2);
    expect(snapshots).toHaveLength(2);
    const artifactIds = published.map((event) => String(event.artifactId));
    expect(new Set(artifactIds).size).toBe(2);
    expect(snapshots.map((event) => event.artifactId)).toEqual(artifactIds);

    for (const event of published) {
      const artifactId = String(event.artifactId);
      const bytes = await readFile(
        path.join(summary.runDirectory, "artifacts", `${artifactId}.patch`),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifactId);
      expect(event.digest).toBe(artifactId);
      expect(event.size).toBe(bytes.byteLength);
      expect(event.mediaType).toBe("text/x-diff");
    }
    const firstArtifact = await readFile(
      path.join(summary.runDirectory, "artifacts", `${artifactIds[0]}.patch`),
      "utf8",
    );
    const secondArtifact = await readFile(
      path.join(summary.runDirectory, "artifacts", `${artifactIds[1]}.patch`),
      "utf8",
    );
    expect(firstArtifact).toContain("+first");
    expect(firstArtifact).not.toContain("+second");
    expect(secondArtifact).toContain("+first");
    expect(secondArtifact).toContain("+second");
    expect(await readFile(summary.candidates[0]!.patchPath, "utf8")).toBe(secondArtifact);
    expect(summary.candidates[0]!.artifactId).toBe(artifactIds[1]);
  }, 30_000);

  it("keeps preflight, runtime, and interruption failures queryable without summaries", async () => {
    const harnessHome = await makeTempDirectory("agent-blocks-failures-");
    const missingWorkspace = path.join(harnessHome, "missing-workspace");
    const neverRuntime: AgentRuntime = {
      runTurn: (input) =>
        Effect.fail(
          new RuntimeError({
            message: "Runtime must not start",
            agentId: input.agentId,
            cause: input,
          }),
        ),
    };
    await expect(
      Effect.runPromise(
        runOrchestration({
          workflow: workflowFor(missingWorkspace),
          runtime: neverRuntime,
          harnessHome,
          runId: "missing-run",
        }),
      ),
    ).rejects.toThrow(/Workspace does not exist/u);
    const missingView = await Effect.runPromise(inspectRunState(harnessHome, "missing-run"));
    expect(missingView.status).toBe("failed");
    expect(missingView.startedAt).toBeUndefined();
    await expect(
      readFile(path.join(runDirectoryFor(harnessHome, "missing-run"), "summary.json"), "utf8"),
    ).rejects.toThrow();

    const dirtyRepository = await makeGitRepository();
    await writeFile(path.join(dirtyRepository, "dirty.txt"), "dirty\n", "utf8");
    await expect(
      Effect.runPromise(
        runOrchestration({
          workflow: workflowFor(dirtyRepository),
          runtime: neverRuntime,
          harnessHome,
          runId: "dirty-run",
        }),
      ),
    ).rejects.toThrow(/workspace is dirty/iu);
    expect((await Effect.runPromise(inspectRunState(harnessHome, "dirty-run"))).status).toBe(
      "failed",
    );

    const runtimeRepository = await makeGitRepository();
    const failingRuntime: AgentRuntime = {
      runTurn: (input) =>
        Effect.fail(
          new RuntimeError({
            message: "scripted supervisor runtime failure",
            agentId: input.agentId,
            cause: "fixture",
          }),
        ),
    };
    await expect(
      Effect.runPromise(
        runOrchestration({
          workflow: workflowFor(runtimeRepository),
          runtime: failingRuntime,
          harnessHome,
          runId: "runtime-run",
        }),
      ),
    ).rejects.toThrow(/scripted supervisor runtime failure/u);
    expect((await Effect.runPromise(inspectRunState(harnessHome, "runtime-run"))).status).toBe(
      "failed",
    );

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const never = new Promise<RuntimeTurnResult>(() => undefined);
    const interruptRuntime: AgentRuntime = {
      runTurn: () =>
        Effect.tryPromise({
          try: () => {
            markStarted();
            return never;
          },
          catch: (cause) =>
            new RuntimeError({ message: "Interrupted fake failed", agentId: "supervisor", cause }),
        }),
    };
    const interruptedFiber = Effect.runFork(
      runOrchestration({
        workflow: workflowFor(runtimeRepository),
        runtime: interruptRuntime,
        harnessHome,
        runId: "interrupted-run",
      }),
    );
    await started;
    await Effect.runPromise(Fiber.interrupt(interruptedFiber));
    expect(await Effect.runPromise(inspectRunState(harnessHome, "interrupted-run"))).toMatchObject({
      status: "interrupted",
    });

    const runs = await Effect.runPromise(listRuns(harnessHome));
    expect(new Set(runs.map((run) => run.runId))).toEqual(
      new Set(["missing-run", "dirty-run", "runtime-run", "interrupted-run"]),
    );
    expect(runs.every((run) => run.status === "failed" || run.status === "interrupted")).toBe(true);
  }, 30_000);
});
