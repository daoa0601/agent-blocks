import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import type { CandidateSnapshot, EvaluationResult, RunSummary } from "./domain.js";
import { JournalError } from "./errors.js";
import { runDirectoryFor } from "./run-id.js";

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function decodeEvaluation(value: unknown, label: string): EvaluationResult | undefined {
  if (value === undefined) return undefined;
  const input = objectValue(value, label);
  return {
    candidateId: stringValue(input.candidateId, `${label}.candidateId`),
    passed: booleanValue(input.passed, `${label}.passed`),
    exitCode: numberValue(input.exitCode, `${label}.exitCode`),
    stdout: stringValue(input.stdout, `${label}.stdout`),
    stderr: stringValue(input.stderr, `${label}.stderr`),
    durationMs: numberValue(input.durationMs, `${label}.durationMs`),
  };
}

function decodeCandidate(value: unknown, index: number): CandidateSnapshot {
  const label = `summary.candidates[${index}]`;
  const input = objectValue(value, label);
  const artifactId = optionalString(input.artifactId, `${label}.artifactId`);
  return {
    candidateId: stringValue(input.candidateId, `${label}.candidateId`),
    diffStat: stringValue(input.diffStat, `${label}.diffStat`),
    patchPath: stringValue(input.patchPath, `${label}.patchPath`),
    retainedWorktree: optionalString(input.retainedWorktree, `${label}.retainedWorktree`),
    evaluation: decodeEvaluation(input.evaluation, `${label}.evaluation`),
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

function decodeRunSummary(value: unknown): RunSummary {
  const input = objectValue(value, "summary");
  const status = input.status;
  if (status !== "accepted" && status !== "stopped" && status !== "budget_exhausted") {
    throw new Error("summary.status is invalid");
  }
  if (!Array.isArray(input.candidates)) throw new Error("summary.candidates must be an array");
  return {
    runId: stringValue(input.runId, "summary.runId"),
    workflow: stringValue(input.workflow, "summary.workflow"),
    objective: stringValue(input.objective, "summary.objective"),
    status,
    startedAt: stringValue(input.startedAt, "summary.startedAt"),
    completedAt: stringValue(input.completedAt, "summary.completedAt"),
    rounds: numberValue(input.rounds, "summary.rounds"),
    agentTurns: numberValue(input.agentTurns, "summary.agentTurns"),
    totalAgents: numberValue(input.totalAgents, "summary.totalAgents"),
    totalTokens: numberValue(input.totalTokens, "summary.totalTokens"),
    selectedCandidateId: optionalString(input.selectedCandidateId, "summary.selectedCandidateId"),
    applied: booleanValue(input.applied, "summary.applied"),
    runDirectory: stringValue(input.runDirectory, "summary.runDirectory"),
    candidates: input.candidates.map(decodeCandidate),
  };
}

export function inspectRun(
  harnessHome: string,
  runId: string,
): Effect.Effect<RunSummary, JournalError> {
  return Effect.tryPromise({
    try: async () => {
      const summaryPath = path.join(runDirectoryFor(harnessHome, runId), "summary.json");
      const summary = decodeRunSummary(JSON.parse(await readFile(summaryPath, "utf8")));
      if (summary.runId !== runId) {
        throw new Error(`Summary belongs to run ${summary.runId}, not ${runId}`);
      }
      return summary;
    },
    catch: (cause) =>
      new JournalError({
        message: `Unable to inspect terminal summary for run ${runId}`,
        cause,
      }),
  });
}
