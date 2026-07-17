import { readdir } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import { tokenBudgetCharge } from "./budget.js";
import { JournalError } from "./errors.js";
import { readRunEventRecords } from "./journal.js";
import type { RunEventRecord } from "./journal.js";
import { assertRunId } from "./run-id.js";

export type PublicRunStatus =
  "queued" | "running" | "accepted" | "stopped" | "budget_exhausted" | "failed" | "interrupted";

export interface PublicRunEvent {
  readonly sequence: number;
  readonly at: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PublicRunView {
  readonly runId: string;
  readonly workflow?: string;
  readonly status: PublicRunStatus;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly lastSequence: number;
  readonly rounds: number;
  readonly agentTurns: number;
  readonly totalAgents: number;
  readonly totalTokens: number;
  readonly selectedCandidateId?: string;
  readonly applied?: boolean;
}

export interface ReadRunEventsOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

const PRIVATE_KEYS = new Set([
  "cause",
  "command",
  "configpath",
  "cwd",
  "evaluatorstderr",
  "evaluatorstdout",
  "instructions",
  "objective",
  "outputschemapath",
  "patchpath",
  "path",
  "prompt",
  "rawevent",
  "retainedworktree",
  "sessionid",
  "stderr",
  "stdout",
  "task",
  "threadid",
  "workspace",
  "worktreepath",
]);

function compactKey(key: string): string {
  return key.replaceAll(/[_-]/gu, "").toLowerCase();
}

function isPrivateKey(key: string): boolean {
  const compact = compactKey(key);
  return (
    PRIVATE_KEYS.has(compact) ||
    compact.includes("prompt") ||
    compact.includes("rawevent") ||
    compact.includes("sessionid") ||
    compact.includes("threadid") ||
    compact.endsWith("workspace") ||
    compact.endsWith("path") ||
    compact.endsWith("directory")
  );
}

function redactHostPaths(value: string): string {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith("file://")) {
    return "[redacted]";
  }
  return value
    .replaceAll(/\.harness-audit(?:[\\/][^\s"'`,)}\]]*)?/gu, "[redacted]")
    .replaceAll(/file:\/\/[^\s"'`,)}\]]+/gu, "[redacted]")
    .replaceAll(/(^|[\s("'=])\/(?:[^\s"'`,)}\]]+)/gu, "$1[redacted]")
    .replaceAll(/[A-Za-z]:\\[^\s"'`,)}\]]+/gu, "[redacted]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactHostPaths(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isPrivateKey(key)) output[key] = redactValue(nested);
  }
  return output;
}

function publicEvent(record: RunEventRecord): PublicRunEvent | undefined {
  if (record.type === "codex.raw_event" || record.type.startsWith("harness.private.")) {
    return undefined;
  }
  const redacted = redactValue(record);
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
    return undefined;
  }
  return {
    ...redacted,
    sequence: record.sequence,
    at: record.at,
    type: record.type,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function completedStatus(value: unknown): PublicRunStatus | undefined {
  return value === "accepted" || value === "stopped" || value === "budget_exhausted"
    ? value
    : undefined;
}

function projectedTokenCharge(value: unknown): number {
  const usage = recordValue(value);
  if (usage === undefined) return 0;
  const inputTokens = numberValue(usage.inputTokens);
  const cachedInputTokens = numberValue(usage.cachedInputTokens);
  const outputTokens = numberValue(usage.outputTokens);
  if (inputTokens !== undefined && cachedInputTokens !== undefined && outputTokens !== undefined) {
    return tokenBudgetCharge({
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: numberValue(usage.totalTokens) ?? inputTokens + outputTokens,
    });
  }
  return numberValue(usage.totalTokens) ?? 0;
}

function projectRun(runId: string, records: ReadonlyArray<RunEventRecord>): PublicRunView {
  if (records.length === 0) {
    throw new Error(`Run ${runId} has no complete journal records`);
  }

  let workflow: string | undefined;
  let status: PublicRunStatus = "queued";
  let createdAt: string | undefined = records[0]?.at;
  let startedAt: string | undefined;
  let completedAt: string | undefined;
  let rounds = 0;
  let agentTurns = 0;
  let totalAgents = 0;
  let totalTokens = 0;
  let selectedCandidateId: string | undefined;
  let applied: boolean | undefined;
  const agentIds = new Set<string>();

  for (const record of records) {
    if (record.type === "run.created") {
      createdAt = record.at;
      const recordedWorkflow = stringValue(record.workflow);
      workflow = recordedWorkflow === undefined ? workflow : redactHostPaths(recordedWorkflow);
      status = "queued";
    } else if (record.type === "run.started") {
      startedAt = record.at;
      const recordedWorkflow = stringValue(record.workflow);
      workflow = recordedWorkflow === undefined ? workflow : redactHostPaths(recordedWorkflow);
      status = "running";
    } else if (record.type === "supervisor.turn_started") {
      rounds = Math.max(rounds, numberValue(record.round) ?? 0);
    } else if (record.type === "agent.turn_started") {
      agentTurns += 1;
      const agentId = stringValue(record.agentId);
      if (agentId !== undefined) {
        agentIds.add(agentId);
        totalAgents = Math.max(totalAgents, agentIds.size);
      }
    }

    if (record.type === "supervisor.decision" || record.type === "agent.turn_completed") {
      totalTokens += projectedTokenCharge(record.usage);
    }

    if (record.type === "run.budget_exhausted") {
      status = "budget_exhausted";
    } else if (record.type === "run.completed") {
      const summary = recordValue(record.summary);
      status = completedStatus(summary?.status) ?? status;
      completedAt = stringValue(summary?.completedAt) ?? record.at;
      const summaryWorkflow = stringValue(summary?.workflow);
      workflow = summaryWorkflow === undefined ? workflow : redactHostPaths(summaryWorkflow);
      rounds = numberValue(summary?.rounds) ?? rounds;
      agentTurns = numberValue(summary?.agentTurns) ?? agentTurns;
      totalTokens = numberValue(summary?.totalTokens) ?? totalTokens;
      selectedCandidateId = stringValue(summary?.selectedCandidateId);
      applied = booleanValue(summary?.applied);
      const summaryTotalAgents = numberValue(summary?.totalAgents);
      totalAgents = summaryTotalAgents ?? totalAgents;
    } else if (record.type === "run.failed") {
      status = record.interrupted === true ? "interrupted" : "failed";
      completedAt = record.at;
    }
  }

  return {
    runId,
    ...(workflow === undefined ? {} : { workflow }),
    status,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    lastSequence: records.at(-1)!.sequence,
    rounds,
    agentTurns,
    totalAgents,
    totalTokens,
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    ...(applied === undefined ? {} : { applied }),
  };
}

function queryError(runId: string, cause: unknown): JournalError {
  return cause instanceof JournalError
    ? cause
    : new JournalError({ message: `Unable to inspect run ${runId}`, cause });
}

export function inspectRunState(
  harnessHome: string,
  runId: string,
): Effect.Effect<PublicRunView, JournalError> {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => assertRunId(runId),
      catch: (cause) => queryError(runId, cause),
    });
    const records = yield* readRunEventRecords(harnessHome, runId);
    return yield* Effect.try({
      try: () => projectRun(runId, records),
      catch: (cause) => queryError(runId, cause),
    });
  });
}

export function readRunEvents(
  harnessHome: string,
  runId: string,
  options: ReadRunEventsOptions = {},
): Effect.Effect<ReadonlyArray<PublicRunEvent>, JournalError> {
  return Effect.gen(function* () {
    const afterSequence = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return yield* new JournalError({
        message: "afterSequence must be a non-negative safe integer",
        cause: options,
      });
    }
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit <= 0)
    ) {
      return yield* new JournalError({
        message: "limit must be a positive safe integer",
        cause: options,
      });
    }

    const records = yield* readRunEventRecords(harnessHome, runId);
    const events: Array<PublicRunEvent> = [];
    for (const record of records) {
      if (record.sequence <= afterSequence) continue;
      const projected = publicEvent(record);
      if (projected !== undefined) events.push(projected);
      if (options.limit !== undefined && events.length >= options.limit) break;
    }
    return events;
  });
}

async function runDirectories(harnessHome: string): Promise<ReadonlyArray<string>> {
  const runsDirectory = path.join(path.resolve(harnessHome), "runs");
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    const runIds: Array<string> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        assertRunId(entry.name);
        const children = await readdir(path.join(runsDirectory, entry.name));
        if (children.includes("events.jsonl")) runIds.push(entry.name);
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          continue;
        }
        if (cause instanceof Error && cause.message.startsWith("Invalid run ID:")) continue;
        throw cause;
      }
    }
    return runIds;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return [];
    }
    throw cause;
  }
}

export function listRuns(
  harnessHome: string,
): Effect.Effect<ReadonlyArray<PublicRunView>, JournalError> {
  return Effect.gen(function* () {
    const runIds = yield* Effect.tryPromise({
      try: () => runDirectories(harnessHome),
      catch: (cause) =>
        new JournalError({ message: `Unable to list runs in ${path.resolve(harnessHome)}`, cause }),
    });
    const runs: Array<PublicRunView> = [];
    for (const runId of runIds) {
      const records = yield* readRunEventRecords(harnessHome, runId);
      if (records.length === 0) continue;
      runs.push(
        yield* Effect.try({
          try: () => projectRun(runId, records),
          catch: (cause) => queryError(runId, cause),
        }),
      );
    }
    return [...runs].sort((left, right) => {
      const byCreatedAt = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
      return byCreatedAt !== 0 ? byCreatedAt : right.runId.localeCompare(left.runId);
    });
  });
}
