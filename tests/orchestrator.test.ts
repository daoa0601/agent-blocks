import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { RuntimeTurnInput, RuntimeTurnResult, WorkflowDefinition } from "../src/domain.js";
import { RuntimeError } from "../src/errors.js";
import { runOrchestration } from "../src/orchestrator.js";
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
    events: [{ type: "fake.event", threadId }],
  };
}

describe("orchestrator", () => {
  it("runs resumable scoped candidate turns, evaluates, journals, and cleans the worktree", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-home-");
    const calls: Array<RuntimeTurnInput> = [];
    let supervisorTurns = 0;
    let candidateTurns = 0;

    const runtime: AgentRuntime = {
      metadata: {
        adapter: "test-runtime",
        binary: null,
        ignoreUserConfig: true,
        maxOutputBytes: null,
        toolPolicy: "scripted",
      },
      runTurn: (input) =>
        Effect.tryPromise({
          try: async () => {
            calls.push(input);
            if (input.agentId === "supervisor") {
              supervisorTurns += 1;
              if (supervisorTurns === 1) {
                return turnResult(
                  "supervisor-thread",
                  JSON.stringify({
                    status: "continue",
                    summary: "Create a candidate.",
                    assignments: [
                      {
                        agentId: "builder-1",
                        roleId: "builder",
                        task: "Create answer.txt with the first line.",
                        targetCandidateId: null,
                      },
                    ],
                    selectedCandidateId: null,
                  }),
                );
              }
              if (supervisorTurns === 2) {
                return turnResult(
                  "supervisor-thread",
                  JSON.stringify({
                    status: "continue",
                    summary: "Complete the same candidate.",
                    assignments: [
                      {
                        agentId: "builder-1",
                        roleId: "builder",
                        task: "Append the second line.",
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
                  summary: "The candidate passes deterministic evaluation.",
                  assignments: [],
                  selectedCandidateId: "builder-1",
                }),
              );
            }

            candidateTurns += 1;
            const answerPath = path.join(input.cwd, "answer.txt");
            if (candidateTurns === 1) {
              await writeFile(answerPath, "first\n", "utf8");
            } else {
              await appendFile(answerPath, "second\n", "utf8");
            }
            return turnResult("builder-thread", report);
          },
          catch: (cause) =>
            new RuntimeError({
              message: "Fake runtime failed",
              agentId: input.agentId,
              cause,
            }),
        }),
    };

    const workflow: WorkflowDefinition = {
      version: 1,
      name: "fake-loop",
      objective: "Produce a two-line answer file.",
      configPath: path.join(repository, "workflow.yaml"),
      workspace: repository,
      allowDirtyWorkspace: false,
      supervisor: { instructions: "Use the builder and require tests.", model: "supervisor-model" },
      roles: [
        {
          id: "builder",
          kind: "candidate",
          description: "Owns one isolated candidate.",
          instructions: "Make only the assigned edit.",
          maxInstances: 1,
          maxTurns: 2,
          model: "builder-model",
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
      evaluation: {
        command: [
          process.execPath,
          "-e",
          "const fs=require('fs');process.exit(fs.readFileSync('answer.txt','utf8')==='first\\nsecond\\n'?0:1)",
        ],
        timeoutSeconds: 10,
      },
      codex: { binary: "codex", ignoreUserConfig: true, maxOutputBytes: 1024 * 1024 },
    };

    const summary = await Effect.runPromise(runOrchestration({ workflow, runtime, harnessHome }));

    expect(summary.status).toBe("accepted");
    expect(summary.selectedCandidateId).toBe("builder-1");
    expect(summary.rounds).toBe(3);
    expect(summary.agentTurns).toBe(2);
    expect(summary.totalAgents).toBe(1);
    expect(summary.totalTokens).toBe(10);
    expect(summary.candidates[0]?.evaluation?.passed).toBe(true);
    expect(await readFile(summary.candidates[0]!.patchPath, "utf8")).toContain("answer.txt");

    const supervisorCalls = calls.filter((call) => call.agentId === "supervisor");
    const builderCalls = calls.filter((call) => call.agentId === "builder-1");
    expect(supervisorCalls.map((call) => call.threadId)).toEqual([
      undefined,
      "supervisor-thread",
      "supervisor-thread",
    ]);
    expect(builderCalls.map((call) => call.threadId)).toEqual([undefined, "builder-thread"]);
    expect(builderCalls.every((call) => call.sandbox === "workspace-write")).toBe(true);
    expect(supervisorCalls.every((call) => call.sandbox === "read-only")).toBe(true);
    expect(builderCalls.every((call) => call.model === "builder-model")).toBe(true);
    expect(supervisorCalls.every((call) => call.model === "supervisor-model")).toBe(true);

    const journal = (await readFile(path.join(summary.runDirectory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(journal.find((event) => event.type === "run.started")).toMatchObject({
      runtime: {
        adapter: "test-runtime",
        binary: null,
        ignoreUserConfig: true,
        toolPolicy: "scripted",
      },
      models: {
        supervisor: "supervisor-model",
        roles: [{ roleId: "builder", model: "builder-model" }],
      },
    });
    expect(journal.find((event) => event.type === "supervisor.turn_started")).toMatchObject({
      model: "supervisor-model",
      sandbox: "read-only",
    });
    expect(journal.find((event) => event.type === "agent.turn_started")).toMatchObject({
      model: "builder-model",
      sandbox: "workspace-write",
    });

    const cleanedWorktree = path.join(harnessHome, "worktrees", summary.runId, "builder-1");
    await expect(readFile(path.join(cleanedWorktree, "answer.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  it("rejects a supervisor attempt to give a candidate an out-of-scope target", async () => {
    const repository = await makeGitRepository();
    const harnessHome = await makeTempDirectory("agent-blocks-scope-");
    let workerStarted = false;
    const runtime: AgentRuntime = {
      runTurn: (input) => {
        if (input.agentId !== "supervisor") workerStarted = true;
        return Effect.succeed(
          turnResult(
            "supervisor-thread",
            JSON.stringify({
              status: "continue",
              summary: "Attempt an illegal target.",
              assignments: [
                {
                  agentId: "builder-1",
                  roleId: "builder",
                  task: "Write outside the candidate scope.",
                  targetCandidateId: "not-a-candidate",
                },
              ],
              selectedCandidateId: null,
            }),
          ),
        );
      },
    };
    const workflow: WorkflowDefinition = {
      version: 1,
      name: "scope-rejection",
      objective: "Prove deterministic scope validation.",
      configPath: path.join(repository, "workflow.yaml"),
      workspace: repository,
      allowDirtyWorkspace: false,
      supervisor: { instructions: "Use configured scopes.", model: undefined },
      roles: [
        {
          id: "builder",
          kind: "candidate",
          description: "Owns a candidate.",
          instructions: "Stay scoped.",
          maxInstances: 1,
          maxTurns: 1,
          model: undefined,
        },
      ],
      limits: {
        maxRounds: 1,
        maxConcurrentAgents: 1,
        maxTotalAgents: 1,
        maxTotalAgentTurns: 1,
        maxWallClockSeconds: 10,
        turnTimeoutSeconds: 5,
        maxTotalTokens: 100,
      },
      evaluation: undefined,
      codex: { binary: "codex", ignoreUserConfig: true, maxOutputBytes: 1024 },
    };

    await expect(
      Effect.runPromise(runOrchestration({ workflow, runtime, harnessHome })),
    ).rejects.toThrow(/violates harness scope/u);
    expect(workerStarted).toBe(false);

    const [runId] = await readdir(path.join(harnessHome, "runs"));
    expect(runId).toBeDefined();
    const journal = await readFile(path.join(harnessHome, "runs", runId!, "events.jsonl"), "utf8");
    expect(journal).toContain('"type":"run.failed"');
  });
});
