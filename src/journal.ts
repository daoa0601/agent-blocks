import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Semaphore } from "effect";

import { errorMessage, JournalError } from "./errors.js";
import { runDirectoryFor } from "./run-id.js";

export interface JournalEventInput {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A normalized journal record. Legacy unversioned records are exposed as version 0. */
export interface RunEventRecord {
  readonly schemaVersion: 0 | 1;
  readonly runId: string;
  readonly sequence: number;
  readonly at: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface RunJournal {
  readonly path: string;
  readonly append: (event: JournalEventInput) => Effect.Effect<void, JournalError>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIncompleteFinalJson(text: string, cause: unknown): boolean {
  if (!(cause instanceof SyntaxError) || text.trim().length === 0) return false;
  if (
    cause.message.includes("Unexpected end of JSON input") ||
    cause.message.includes("Unterminated string")
  ) {
    return true;
  }

  const position = /at position (\d+)/u.exec(cause.message)?.[1];
  return position !== undefined && Number(position) >= text.length;
}

function normalizeRecord(
  input: unknown,
  expectedRunId: string,
  previousSequence: number,
  lineNumber: number,
): RunEventRecord {
  if (!isObject(input)) {
    throw new Error(`Journal line ${lineNumber} must be a JSON object`);
  }

  const schemaVersion = input.schemaVersion === undefined ? 0 : input.schemaVersion;
  if (schemaVersion !== 0 && schemaVersion !== 1) {
    throw new Error(
      `Journal line ${lineNumber} has unsupported schemaVersion ${String(schemaVersion)}`,
    );
  }
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) <= 0) {
    throw new Error(`Journal line ${lineNumber} has an invalid sequence field`);
  }
  if (Number(input.sequence) <= previousSequence) {
    throw new Error(
      `Journal sequence must be strictly increasing after ${previousSequence}, received ${String(input.sequence)}`,
    );
  }
  if (typeof input.at !== "string" || !Number.isFinite(Date.parse(input.at))) {
    throw new Error(`Journal line ${lineNumber} has an invalid at field`);
  }
  if (typeof input.type !== "string" || input.type.trim().length === 0) {
    throw new Error(`Journal line ${lineNumber} has an invalid type field`);
  }

  if (schemaVersion === 1 && input.runId !== expectedRunId) {
    throw new Error(
      `Journal line ${lineNumber} belongs to run ${String(input.runId)}, not ${expectedRunId}`,
    );
  }
  if (schemaVersion === 0 && input.runId !== undefined && input.runId !== expectedRunId) {
    throw new Error(`Legacy journal line ${lineNumber} belongs to a different run`);
  }

  return {
    ...input,
    schemaVersion,
    runId: expectedRunId,
    sequence: Number(input.sequence),
    at: input.at,
    type: input.type,
  };
}

function decodeJournal(source: string, runId: string): ReadonlyArray<RunEventRecord> {
  if (source.length === 0) return [];

  const hasTrailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (hasTrailingNewline) lines.pop();

  const records: Array<RunEventRecord> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const isFinalUnterminatedLine = !hasTrailingNewline && index === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      if (isFinalUnterminatedLine && isIncompleteFinalJson(line, cause)) break;
      throw new Error(`Invalid JSON on journal line ${index + 1}`, { cause });
    }
    records.push(normalizeRecord(parsed, runId, records.at(-1)?.sequence ?? 0, index + 1));
  }
  return records;
}

async function readRecordsAtPath(
  journalPath: string,
  runId: string,
): Promise<ReadonlyArray<RunEventRecord>> {
  return decodeJournal(await readFile(journalPath, "utf8"), runId);
}

/** Reads and validates the complete private journal for trusted harness code. */
export function readRunEventRecords(
  harnessHome: string,
  runId: string,
): Effect.Effect<ReadonlyArray<RunEventRecord>, JournalError> {
  return Effect.tryPromise({
    try: () => {
      const journalPath = path.join(runDirectoryFor(harnessHome, runId), "events.jsonl");
      return readRecordsAtPath(journalPath, runId);
    },
    catch: (cause) =>
      new JournalError({
        message: `Unable to read journal for run ${runId}: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

export function makeRunJournal(
  runDirectory: string,
  suppliedRunId?: string,
): Effect.Effect<RunJournal, JournalError> {
  return Effect.gen(function* () {
    const runId = suppliedRunId ?? path.basename(runDirectory);
    yield* Effect.tryPromise({
      try: () => mkdir(runDirectory, { recursive: true }),
      catch: (cause) =>
        new JournalError({
          message: `Unable to create run directory ${runDirectory}`,
          cause,
        }),
    });
    const semaphore = yield* Semaphore.make(1);
    const journalPath = path.join(runDirectory, "events.jsonl");
    const existing = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readRecordsAtPath(journalPath, runId);
        } catch (cause) {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
          ) {
            return [];
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new JournalError({
          message: `Unable to initialize journal ${journalPath}`,
          cause,
        }),
    });
    let sequence = existing.at(-1)?.sequence ?? 0;

    const append = (event: JournalEventInput): Effect.Effect<void, JournalError> => {
      if (event.type.trim().length === 0) {
        return Effect.fail(
          new JournalError({ message: "Journal event type must not be empty", cause: event }),
        );
      }
      return Effect.uninterruptible(
        semaphore.withPermit(
          Effect.tryPromise({
            try: async () => {
              const nextSequence = sequence + 1;
              const record: RunEventRecord = {
                ...event,
                schemaVersion: 1,
                runId,
                sequence: nextSequence,
                at: new Date().toISOString(),
              };
              const handle = await open(journalPath, "a");
              try {
                await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
                await handle.sync();
              } finally {
                await handle.close();
              }
              sequence = nextSequence;
            },
            catch: (cause) =>
              new JournalError({
                message: `Unable to append ${event.type} to ${journalPath}`,
                cause,
              }),
          }),
        ),
      );
    };

    return { path: journalPath, append };
  });
}
