import { execFileSync } from "node:child_process";
import { appendFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  HARNESS_AUDIT_MAX_BYTES,
  HARNESS_AUDIT_TRACE_PATH,
  runOrchestration,
} from "../src/templates/scoped-worktree.js";
import { readRunEvents } from "../src/templates/scoped-worktree-control-plane.js";
import type { RuntimeTurnInput, RuntimeTurnResult, WorkflowDefinition } from "../src/domain.js";
import { RuntimeError } from "../src/errors.js";
import type { AgentRuntime } from "../src/runtime.js";
import { makeGitRepository, makeTempDirectory } from "./helpers.js";

const report = JSON.stringify({
  status: "completed",
  summary: "Completed the scoped assignment.",
  evidence: ["Checked the candidate workspace."],
  risks: [],
  nextSteps: [],
});

function turnResult(
  threadId: string,
  finalText = report,
  events: ReadonlyArray<unknown> = [],
): RuntimeTurnResult {
  return {
    threadId,
    finalText,
    usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3, totalTokens: 5 },
    events,
  };
}

function auditWorkflow(workspace: string): WorkflowDefinition {
  return {
    version: 1,
    name: "trace-audit-fixture",
    objective: "Produce and independently audit a deterministic candidate.",
    configPath: path.join(workspace, "workflow.yaml"),
    workspace,
    allowDirtyWorkspace: false,
    supervisor: { instructions: "Require a trace-based review.", model: undefined },
    roles: [
      {
        id: "builder",
        kind: "candidate",
        description: "Builds an isolated candidate.",
        instructions: "Make only the assigned edit.",
        maxInstances: 2,
        maxTurns: 2,
        model: undefined,
      },
      {
        id: "auditor",
        kind: "review",
        description: "Audits one candidate and its trace.",
        instructions: "Verify the candidate empirically.",
        maxInstances: 1,
        maxTurns: 1,
        model: undefined,
      },
    ],
    limits: {
      maxRounds: 4,
      maxConcurrentAgents: 2,
      maxTotalAgents: 3,
      maxTotalAgentTurns: 4,
      maxWallClockSeconds: 30,
      turnTimeoutSeconds: 10,
      maxTotalTokens: 200,
    },
    evaluation: {
      command: [
        process.execPath,
        "-e",
        "const fs=require('fs');process.exit(fs.readFileSync('answer.txt','utf8')==='first\\nsecond\\n'?0:1)",
      ],
      timeoutSeconds: 10,
    },
    codex: {
      binary: "never-call-real-codex",
      ignoreUserConfig: true,
      maxOutputBytes: 2 * 1024 * 1024,
    },
  };
}

function privateRuntimeError(input: RuntimeTurnInput, cause: unknown): RuntimeError {
  return new RuntimeError({
    message: `Fake runtime failed for ${input.agentId}`,
    agentId: input.agentId,
    cause,
  });
}

describe("trace-based candidate audit", () => {
  it("gives a pinned reviewer a target-only multi-turn trace and declared evaluator", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-audit-");
    const workflow = auditWorkflow(repository);
    const calls: Array<RuntimeTurnInput> = [];
    let supervisorTurns = 0;
    let builderOneTurns = 0;
    let reviewerTrace = "";
    let reviewerReranEvaluator = false;

    const runtime: AgentRuntime = {
      runTurn: (input) =>
        Effect.tryPromise({
          try: async () => {
            calls.push(input);
            if (input.agentId === "supervisor") {
              supervisorTurns += 1;
              const decisions = [
                {
                  status: "continue",
                  summary: "Create two independent candidates.",
                  assignments: [
                    {
                      agentId: "builder-1",
                      roleId: "builder",
                      task: "Write the first answer line.",
                      targetCandidateId: null,
                    },
                    {
                      agentId: "builder-2",
                      roleId: "builder",
                      task: "Create a separate decoy candidate.",
                      targetCandidateId: null,
                    },
                  ],
                  selectedCandidateId: null,
                },
                {
                  status: "continue",
                  summary: "Finish the first candidate.",
                  assignments: [
                    {
                      agentId: "builder-1",
                      roleId: "builder",
                      task: "Append the second answer line.",
                      targetCandidateId: null,
                    },
                  ],
                  selectedCandidateId: null,
                },
                {
                  status: "continue",
                  summary: "Audit the passing candidate.",
                  assignments: [
                    {
                      agentId: "reviewer-1",
                      roleId: "auditor",
                      task: "Inspect the implementation and its full trace.",
                      targetCandidateId: "builder-1",
                    },
                  ],
                  selectedCandidateId: null,
                },
                {
                  status: "accept",
                  summary: "The candidate passed evaluation and independent review.",
                  assignments: [],
                  selectedCandidateId: "builder-1",
                },
              ];
              return turnResult(
                "supervisor-thread",
                JSON.stringify(decisions[supervisorTurns - 1]),
                [{ marker: `supervisor-event-${supervisorTurns}` }],
              );
            }

            if (input.agentId === "builder-1") {
              builderOneTurns += 1;
              if (builderOneTurns === 1) {
                await writeFile(path.join(input.cwd, "answer.txt"), "first\n", "utf8");
              } else {
                await appendFile(path.join(input.cwd, "answer.txt"), "second\n", "utf8");
              }
              return turnResult("builder-one-thread", report, [
                {
                  type: "item.completed",
                  item: { type: "command_execution", marker: `target-turn-${builderOneTurns}` },
                },
              ]);
            }

            if (input.agentId === "builder-2") {
              await writeFile(path.join(input.cwd, "decoy.txt"), "decoy\n", "utf8");
              return turnResult("builder-two-thread", report, [
                { type: "item.completed", marker: "other-candidate-event" },
              ]);
            }

            expect(input.agentId).toBe("reviewer-1");
            expect(input.sandbox).toBe("read-only");
            reviewerTrace = await readFile(path.join(input.cwd, HARNESS_AUDIT_TRACE_PATH), "utf8");
            const [command, ...args] = workflow.evaluation!.command;
            execFileSync(command!, [...args], { cwd: input.cwd });
            reviewerReranEvaluator = true;
            return turnResult("reviewer-thread", report, [{ marker: "reviewer-private-event" }]);
          },
          catch: (cause) => privateRuntimeError(input, cause),
        }),
    };

    const summary = await Effect.runPromise(
      runOrchestration({
        workflow,
        runtime,
        harnessHome,
        keepWorktrees: true,
      }),
    );

    expect(summary.status).toBe("accepted");
    expect(reviewerReranEvaluator).toBe(true);
    const builderCalls = calls.filter((call) => call.agentId === "builder-1");
    expect(builderCalls).toHaveLength(2);
    for (const call of builderCalls) {
      expect(call.prompt).toContain(".harness-audit/");
      expect(call.prompt).toContain("Do not create, modify, delete");
      expect(call.prompt).toContain(JSON.stringify(workflow.evaluation!.command));
    }

    const reviewerCall = calls.find((call) => call.agentId === "reviewer-1")!;
    expect(reviewerCall.cwd).toBe(summary.candidates[0]!.retainedWorktree);
    expect(reviewerCall.prompt).toContain(HARNESS_AUDIT_TRACE_PATH);
    expect(reviewerCall.prompt).toContain(JSON.stringify(workflow.evaluation!.command));
    expect(reviewerCall.prompt).toContain("independently rerun");
    expect(reviewerCall.prompt).toContain("hardcoding");
    expect(reviewerCall.prompt).toContain("cache reuse");
    expect(reviewerCall.prompt).toContain("grader/test detection");
    expect(reviewerCall.prompt).toContain("path or environment");
    expect(reviewerCall.prompt).toContain("unsupported");

    const traceRecords = reviewerTrace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traceRecords.every((record) => record.schemaVersion === 1)).toBe(true);
    expect(traceRecords.every((record) => record.candidateId === "builder-1")).toBe(true);
    expect(traceRecords.filter((record) => record.type === "candidate.turn_started")).toHaveLength(
      2,
    );
    expect(
      traceRecords.filter((record) => record.type === "candidate.turn_completed"),
    ).toHaveLength(2);
    const runtimeMarkers = traceRecords
      .filter((record) => record.type === "candidate.runtime_event")
      .map((record) => JSON.stringify(record.rawEvent));
    expect(runtimeMarkers).toEqual([
      expect.stringContaining("target-turn-1"),
      expect.stringContaining("target-turn-2"),
    ]);
    expect(reviewerTrace).not.toContain("supervisor-event");
    expect(reviewerTrace).not.toContain("other-candidate-event");
    expect(reviewerTrace).not.toContain("reviewer-private-event");
    expect(
      traceRecords
        .filter((record) => record.type === "candidate.turn_started")
        .map((record) => record.prompt),
    ).toEqual(builderCalls.map((call) => call.prompt));

    const provenance = traceRecords.find(
      (record) => record.type === "candidate.snapshot_provenance",
    )!;
    expect(provenance.artifactId).toMatch(/^[a-f0-9]{64}$/u);
    expect(provenance.digest).toBe(provenance.artifactId);
    expect(provenance.evaluation).toMatchObject({ passed: true, exitCode: 0 });
    expect(
      summary.candidates.find((candidate) => candidate.candidateId === "builder-1")?.artifactId,
    ).toBe(provenance.artifactId);

    const selected = summary.candidates.find((candidate) => candidate.candidateId === "builder-1")!;
    const compatibilityPatch = await readFile(selected.patchPath, "utf8");
    const immutablePatch = await readFile(
      path.join(summary.runDirectory, "artifacts", `${selected.artifactId}.patch`),
      "utf8",
    );
    expect(compatibilityPatch).not.toContain(".harness-audit");
    expect(immutablePatch).toBe(compatibilityPatch);

    const publicJson = JSON.stringify(
      await Effect.runPromise(readRunEvents(harnessHome, summary.runId)),
    );
    expect(publicJson).not.toContain(".harness-audit");
    expect(publicJson).not.toContain("target-turn-1");
    expect(publicJson).not.toContain("harness.private.");
  }, 30_000);

  it("rejects a candidate that tracks or spoofs the reserved audit path", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-audit-smuggle-");
    const workflow = auditWorkflow(repository);
    let candidatePrompt = "";
    let supervisorTurns = 0;
    const runtime: AgentRuntime = {
      runTurn: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (input.agentId === "supervisor") {
              supervisorTurns += 1;
              return turnResult(
                "supervisor-thread",
                JSON.stringify({
                  status: "continue",
                  summary: "Create a candidate.",
                  assignments: [
                    {
                      agentId: "builder-1",
                      roleId: "builder",
                      task: "Attempt the scoped edit.",
                      targetCandidateId: null,
                    },
                  ],
                  selectedCandidateId: null,
                }),
              );
            }
            candidatePrompt = input.prompt;
            await writeFile(
              path.join(input.cwd, HARNESS_AUDIT_TRACE_PATH),
              "forged trusted trace\n",
              "utf8",
            );
            execFileSync("git", ["add", "-f", HARNESS_AUDIT_TRACE_PATH], {
              cwd: input.cwd,
            });
            await writeFile(path.join(input.cwd, "answer.txt"), "candidate\n", "utf8");
            return turnResult("builder-thread");
          },
          catch: (cause) => privateRuntimeError(input, cause),
        }),
    };

    await expect(
      Effect.runPromise(runOrchestration({ workflow, runtime, harnessHome })),
    ).rejects.toThrow(/reserved .*audit|audit state/iu);
    expect(supervisorTurns).toBe(1);
    expect(candidatePrompt).toContain(".harness-audit/");
    expect(candidatePrompt).toContain("Do not create, modify, delete");

    const [runId] = await readdir(path.join(harnessHome, "runs"));
    expect(runId).toBeDefined();
    await expect(
      readFile(path.join(harnessHome, "runs", runId!, "candidates", "builder-1.patch"), "utf8"),
    ).rejects.toThrow();
    const publicJson = JSON.stringify(await Effect.runPromise(readRunEvents(harnessHome, runId!)));
    expect(publicJson).not.toContain(".harness-audit");
    expect(publicJson).not.toContain("forged trusted trace");
  }, 30_000);

  it("caps oversized traces explicitly while retaining snapshot provenance", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-audit-cap-");
    const baseWorkflow = auditWorkflow(repository);
    const workflow: WorkflowDefinition = {
      ...baseWorkflow,
      limits: {
        ...baseWorkflow.limits,
        maxRounds: 3,
        maxTotalAgents: 2,
        maxTotalAgentTurns: 2,
      },
      roles: baseWorkflow.roles.map((role) =>
        role.kind === "candidate" ? { ...role, maxInstances: 1, maxTurns: 1 } : role,
      ),
    };
    let supervisorTurns = 0;
    let reviewTrace = "";
    let reviewPrompt = "";
    const hugePrivatePayload = `HUGE_PRIVATE_${"x".repeat(HARNESS_AUDIT_MAX_BYTES)}`;
    const runtime: AgentRuntime = {
      runTurn: (input) =>
        Effect.tryPromise({
          try: async () => {
            if (input.agentId === "supervisor") {
              supervisorTurns += 1;
              const decision =
                supervisorTurns === 1
                  ? {
                      status: "continue",
                      summary: "Create one candidate.",
                      assignments: [
                        {
                          agentId: "builder-1",
                          roleId: "builder",
                          task: "Create the answer.",
                          targetCandidateId: null,
                        },
                      ],
                      selectedCandidateId: null,
                    }
                  : supervisorTurns === 2
                    ? {
                        status: "continue",
                        summary: "Audit the oversized trace.",
                        assignments: [
                          {
                            agentId: "reviewer-1",
                            roleId: "auditor",
                            task: "Review the bounded trace.",
                            targetCandidateId: "builder-1",
                          },
                        ],
                        selectedCandidateId: null,
                      }
                    : {
                        status: "accept",
                        summary: "The bounded audit was explicit.",
                        assignments: [],
                        selectedCandidateId: "builder-1",
                      };
              return turnResult("supervisor-thread", JSON.stringify(decision));
            }
            if (input.agentId === "builder-1") {
              await writeFile(path.join(input.cwd, "answer.txt"), "first\nsecond\n", "utf8");
              return turnResult("builder-thread", report, [
                { marker: "small-event-before-overflow" },
                { marker: "oversized-event", payload: hugePrivatePayload },
              ]);
            }
            reviewPrompt = input.prompt;
            reviewTrace = await readFile(path.join(input.cwd, HARNESS_AUDIT_TRACE_PATH), "utf8");
            return turnResult("reviewer-thread");
          },
          catch: (cause) => privateRuntimeError(input, cause),
        }),
    };

    const summary = await Effect.runPromise(
      runOrchestration({ workflow, runtime, harnessHome, keepWorktrees: true }),
    );
    const traceStat = await stat(
      path.join(summary.candidates[0]!.retainedWorktree!, HARNESS_AUDIT_TRACE_PATH),
    );
    expect(traceStat.size).toBeLessThanOrEqual(HARNESS_AUDIT_MAX_BYTES);
    const records = reviewTrace
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      type: "trace.header",
      truncated: true,
      byteCap: HARNESS_AUDIT_MAX_BYTES,
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "trace.truncation",
        omittedBodyRecords: expect.any(Number),
      }),
    );
    expect(records.at(-1)).toMatchObject({
      type: "candidate.snapshot_provenance",
      artifactId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      evaluation: expect.objectContaining({ passed: true }),
    });
    expect(reviewTrace).toContain("small-event-before-overflow");
    expect(reviewTrace).not.toContain(hugePrivatePayload);
    expect(reviewPrompt).toContain("trace.header");
    expect(reviewPrompt).toContain("trace.truncation");
    expect(reviewPrompt).toContain("degraded audit coverage");
    expect(reviewPrompt).toContain("do not claim the trace review was complete");

    const publicJson = JSON.stringify(
      await Effect.runPromise(readRunEvents(harnessHome, summary.runId)),
    );
    expect(publicJson).not.toContain("HUGE_PRIVATE_");
    expect(publicJson).not.toContain(".harness-audit");
    expect(publicJson).not.toContain("harness.private.");
  }, 30_000);
});
