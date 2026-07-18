#!/usr/bin/env node

import { parseArgs } from "node:util";

import { Effect } from "effect";

import { loadWorkflow } from "./config.js";
import { doctor } from "./doctor.js";
import type { RunSummary } from "./domain.js";
import { errorMessage } from "./errors.js";
import { inspectRun } from "./inspect.js";
import { defaultHarnessHome, runOrchestration } from "./orchestrator.js";

const HELP = `agent-blocks

Usage:
  agent-blocks scoped-worktree doctor [--cwd DIR] [--json]
  agent-blocks scoped-worktree run WORKFLOW.yaml [--apply] [--keep-worktrees] [--home DIR] [--json]
  agent-blocks scoped-worktree inspect RUN_ID [--home DIR] [--json]
  agent-blocks help

The scoped-worktree template reuses the local Codex ChatGPT login. It never reads or stores an API key.`;

function printHumanSummary(summary: RunSummary): void {
  process.stdout.write(
    [
      `Run: ${summary.runId}`,
      `Status: ${summary.status}`,
      `Rounds: ${summary.rounds}`,
      `Agents/turns: ${summary.totalAgents}/${summary.agentTurns}`,
      `Tokens: ${summary.totalTokens}`,
      `Selected: ${summary.selectedCandidateId ?? "none"}`,
      `Applied: ${summary.applied ? "yes" : "no"}`,
      `Artifacts: ${summary.runDirectory}`,
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const [template = "help", ...templateArgs] = process.argv.slice(2);

  if (template === "help" || template === "--help" || template === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (template !== "scoped-worktree") {
    throw new Error(`Unknown template: ${template}\n\n${HELP}`);
  }

  const [command = "help", ...args] = templateArgs;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (command === "doctor") {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        cwd: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    const report = await Effect.runPromise(doctor(parsed.values.cwd ?? process.cwd()));
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(`${check.ok ? "ok" : "FAIL"}  ${check.name}: ${check.detail}\n`);
      }
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === "run") {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        apply: { type: "boolean", default: false },
        "keep-worktrees": { type: "boolean", default: false },
        home: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    const workflowPath = parsed.positionals[0];
    if (workflowPath === undefined || parsed.positionals.length !== 1) {
      throw new Error("run requires exactly one workflow YAML path");
    }
    const summary = await Effect.runPromise(
      Effect.gen(function* () {
        const workflow = yield* loadWorkflow(workflowPath);
        return yield* runOrchestration({
          workflow,
          ...(parsed.values.home === undefined ? {} : { harnessHome: parsed.values.home }),
          apply: parsed.values.apply,
          keepWorktrees: parsed.values["keep-worktrees"],
        });
      }),
    );
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printHumanSummary(summary);
    }
    return;
  }

  if (command === "inspect") {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        home: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    const runId = parsed.positionals[0];
    if (runId === undefined || parsed.positionals.length !== 1) {
      throw new Error("inspect requires exactly one run ID");
    }
    const summary = await Effect.runPromise(
      inspectRun(parsed.values.home ?? defaultHarnessHome(), runId),
    );
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      printHumanSummary(summary);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch((cause: unknown) => {
  process.stderr.write(`agent-blocks: ${errorMessage(cause)}\n`);
  process.exitCode = 1;
});
