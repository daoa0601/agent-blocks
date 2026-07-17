import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";

import type { AgentReport, Assignment, EvaluationResult, TokenUsage } from "./domain.js";
import { errorMessage, WorkspaceError } from "./errors.js";

export const HARNESS_AUDIT_DIRECTORY = ".harness-audit";
export const HARNESS_AUDIT_TRACE_PATH = `${HARNESS_AUDIT_DIRECTORY}/trace.jsonl`;
export const HARNESS_AUDIT_SCHEMA_VERSION = 1;
export const HARNESS_AUDIT_MAX_BYTES = 1024 * 1024;

const EVALUATION_STREAM_MAX_BYTES = 64 * 1024;

export interface CandidateTurnTrace {
  readonly turn: number;
  readonly assignment: Assignment;
  readonly prompt: string;
  readonly finalText: string | undefined;
  readonly report: AgentReport | undefined;
  readonly runtimeError: string | undefined;
  readonly usage: TokenUsage | undefined;
  readonly events: ReadonlyArray<unknown>;
}

export interface CandidateAuditProvenance {
  readonly artifactId: string | undefined;
  readonly artifactDigest: string | undefined;
  readonly evaluation: EvaluationResult | undefined;
}

export interface MaterializedAuditTrace {
  /** Trusted harness-internal location. Never expose through public run projections. */
  readonly path: string;
  readonly relativePath: typeof HARNESS_AUDIT_TRACE_PATH;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly includedRecords: number;
  readonly omittedRecords: number;
}

interface AuditRecord {
  readonly schemaVersion: typeof HARNESS_AUDIT_SCHEMA_VERSION;
  readonly traceSequence: number;
  readonly type: string;
  readonly candidateId: string;
  readonly [key: string]: unknown;
}

interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

function boundedUtf8Tail(value: string): BoundedText {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= EVALUATION_STREAM_MAX_BYTES) {
    return { text: value, truncated: false, originalBytes: bytes.byteLength };
  }
  return {
    text: bytes.subarray(bytes.byteLength - EVALUATION_STREAM_MAX_BYTES).toString("utf8"),
    truncated: true,
    originalBytes: bytes.byteLength,
  };
}

function evaluationRecord(
  evaluation: EvaluationResult | undefined,
): Record<string, unknown> | undefined {
  if (evaluation === undefined) return undefined;
  const stdout = boundedUtf8Tail(evaluation.stdout);
  const stderr = boundedUtf8Tail(evaluation.stderr);
  return {
    candidateId: evaluation.candidateId,
    passed: evaluation.passed,
    exitCode: evaluation.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs: evaluation.durationMs,
    stdoutTruncated: stdout.truncated,
    stdoutOriginalBytes: stdout.originalBytes,
    stderrTruncated: stderr.truncated,
    stderrOriginalBytes: stderr.originalBytes,
  };
}

function serializeRecords(records: ReadonlyArray<AuditRecord>): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function traceBody(
  candidateId: string,
  turns: ReadonlyArray<CandidateTurnTrace>,
): ReadonlyArray<AuditRecord> {
  const records: Array<AuditRecord> = [];
  let traceSequence = 2;
  for (const turn of turns) {
    records.push({
      schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
      traceSequence,
      type: "candidate.turn_started",
      candidateId,
      turn: turn.turn,
      assignment: turn.assignment,
      prompt: turn.prompt,
    });
    traceSequence += 1;
    for (let eventIndex = 0; eventIndex < turn.events.length; eventIndex += 1) {
      records.push({
        schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
        traceSequence,
        type: "candidate.runtime_event",
        candidateId,
        turn: turn.turn,
        eventIndex,
        rawEvent: turn.events[eventIndex],
      });
      traceSequence += 1;
    }
    records.push({
      schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
      traceSequence,
      type: "candidate.turn_completed",
      candidateId,
      turn: turn.turn,
      finalText: turn.finalText,
      report: turn.report,
      runtimeError: turn.runtimeError,
      usage: turn.usage,
    });
    traceSequence += 1;
  }
  return records;
}

function makeHeader(options: {
  readonly candidateId: string;
  readonly generatedAt: string;
  readonly turns: number;
  readonly truncated: boolean;
  readonly originalBytes: number | undefined;
  readonly includedBodyRecords: number;
  readonly omittedBodyRecords: number;
}): AuditRecord {
  return {
    schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
    traceSequence: 1,
    type: "trace.header",
    candidateId: options.candidateId,
    generatedAt: options.generatedAt,
    byteCap: HARNESS_AUDIT_MAX_BYTES,
    turns: options.turns,
    truncated: options.truncated,
    originalBytes: options.originalBytes,
    includedBodyRecords: options.includedBodyRecords,
    omittedBodyRecords: options.omittedBodyRecords,
  };
}

function makeProvenance(options: {
  readonly candidateId: string;
  readonly traceSequence: number;
  readonly provenance: CandidateAuditProvenance;
}): AuditRecord {
  return {
    schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
    traceSequence: options.traceSequence,
    type: "candidate.snapshot_provenance",
    candidateId: options.candidateId,
    artifactId: options.provenance.artifactId,
    digest: options.provenance.artifactDigest,
    evaluation: evaluationRecord(options.provenance.evaluation),
  };
}

function buildTraceSource(options: {
  readonly candidateId: string;
  readonly turns: ReadonlyArray<CandidateTurnTrace>;
  readonly provenance: CandidateAuditProvenance;
}): {
  readonly source: string;
  readonly truncated: boolean;
  readonly includedRecords: number;
  readonly omittedRecords: number;
} {
  const generatedAt = new Date().toISOString();
  const body = traceBody(options.candidateId, options.turns);
  const completeHeader = makeHeader({
    candidateId: options.candidateId,
    generatedAt,
    turns: options.turns.length,
    truncated: false,
    originalBytes: undefined,
    includedBodyRecords: body.length,
    omittedBodyRecords: 0,
  });
  const completeProvenance = makeProvenance({
    candidateId: options.candidateId,
    traceSequence: body.length + 2,
    provenance: options.provenance,
  });
  const completeSource = serializeRecords([completeHeader, ...body, completeProvenance]);
  const originalBytes = Buffer.byteLength(completeSource, "utf8");
  if (originalBytes <= HARNESS_AUDIT_MAX_BYTES) {
    return {
      source: completeSource,
      truncated: false,
      includedRecords: body.length + 2,
      omittedRecords: 0,
    };
  }

  const bodyLineBytes = body.map((record) =>
    Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
  );
  let prefixBytes = 0;
  let includedBodyRecords = -1;
  for (let bodyCount = 0; bodyCount <= body.length; bodyCount += 1) {
    const omittedBodyRecords = body.length - bodyCount;
    const firstOmitted = body[bodyCount];
    const lastOmitted = body.at(-1);
    const header = makeHeader({
      candidateId: options.candidateId,
      generatedAt,
      turns: options.turns.length,
      truncated: true,
      originalBytes,
      includedBodyRecords: bodyCount,
      omittedBodyRecords,
    });
    const truncation: AuditRecord = {
      schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
      traceSequence: body.length + 2,
      type: "trace.truncation",
      candidateId: options.candidateId,
      byteCap: HARNESS_AUDIT_MAX_BYTES,
      originalBytes,
      includedBodyRecords: bodyCount,
      omittedBodyRecords,
      firstOmittedTraceSequence: firstOmitted?.traceSequence,
      lastOmittedTraceSequence: lastOmitted?.traceSequence,
    };
    const provenance = makeProvenance({
      candidateId: options.candidateId,
      traceSequence: body.length + 3,
      provenance: options.provenance,
    });
    const metadataBytes = Buffer.byteLength(
      serializeRecords([header, truncation, provenance]),
      "utf8",
    );
    if (metadataBytes + prefixBytes > HARNESS_AUDIT_MAX_BYTES) break;
    includedBodyRecords = bodyCount;
    prefixBytes += bodyLineBytes[bodyCount] ?? 0;
  }

  if (includedBodyRecords < 0) {
    throw new Error("Audit trace provenance exceeds the fixed trace byte cap");
  }
  const omittedBodyRecords = body.length - includedBodyRecords;
  const firstOmitted = body[includedBodyRecords];
  const finalHeader = makeHeader({
    candidateId: options.candidateId,
    generatedAt,
    turns: options.turns.length,
    truncated: true,
    originalBytes,
    includedBodyRecords,
    omittedBodyRecords,
  });
  const finalTruncation: AuditRecord = {
    schemaVersion: HARNESS_AUDIT_SCHEMA_VERSION,
    traceSequence: body.length + 2,
    type: "trace.truncation",
    candidateId: options.candidateId,
    byteCap: HARNESS_AUDIT_MAX_BYTES,
    originalBytes,
    includedBodyRecords,
    omittedBodyRecords,
    firstOmittedTraceSequence: firstOmitted?.traceSequence,
    lastOmittedTraceSequence: body.at(-1)?.traceSequence,
  };
  const finalProvenance = makeProvenance({
    candidateId: options.candidateId,
    traceSequence: body.length + 3,
    provenance: options.provenance,
  });
  const boundedSource = serializeRecords([
    finalHeader,
    ...body.slice(0, includedBodyRecords),
    finalTruncation,
    finalProvenance,
  ]);
  return {
    source: boundedSource,
    truncated: true,
    includedRecords: includedBodyRecords + 3,
    omittedRecords: body.length - includedBodyRecords,
  };
}

function auditDirectory(worktreePath: string): string {
  return path.join(worktreePath, HARNESS_AUDIT_DIRECTORY);
}

export function resetCandidateAuditDirectory(
  worktreePath: string,
): Effect.Effect<void, WorkspaceError> {
  const directory = auditDirectory(worktreePath);
  return Effect.tryPromise({
    try: async () => {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { mode: 0o700 });
    },
    catch: (cause) =>
      new WorkspaceError({
        message: `Unable to reset reserved candidate audit state: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

export function assertCandidateAuditDirectoryUntouched(
  worktreePath: string,
): Effect.Effect<void, WorkspaceError> {
  const directory = auditDirectory(worktreePath);
  return Effect.tryPromise({
    try: async () => {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("reserved audit path is not the harness-created directory");
      }
      const entries = await readdir(directory);
      if (entries.length > 0) {
        throw new Error(
          `reserved audit directory contains candidate-created entries: ${entries.join(", ")}`,
        );
      }
    },
    catch: (cause) =>
      new WorkspaceError({
        message: `Candidate modified or spoofed reserved audit state: ${errorMessage(cause)}`,
        cause,
      }),
  });
}

export function materializeCandidateAuditTrace(options: {
  readonly worktreePath: string;
  readonly candidateId: string;
  readonly turns: ReadonlyArray<CandidateTurnTrace>;
  readonly provenance: CandidateAuditProvenance;
}): Effect.Effect<MaterializedAuditTrace, WorkspaceError> {
  return Effect.gen(function* () {
    const built = yield* Effect.try({
      try: () => buildTraceSource(options),
      catch: (cause) =>
        new WorkspaceError({
          message: `Unable to construct candidate audit trace: ${errorMessage(cause)}`,
          cause,
        }),
    });
    yield* resetCandidateAuditDirectory(options.worktreePath);
    const tracePath = path.join(options.worktreePath, HARNESS_AUDIT_TRACE_PATH);
    yield* Effect.tryPromise({
      try: () => writeFile(tracePath, built.source, { encoding: "utf8", flag: "wx", mode: 0o600 }),
      catch: (cause) =>
        new WorkspaceError({
          message: `Unable to materialize candidate audit trace: ${errorMessage(cause)}`,
          cause,
        }),
    });
    return {
      path: tracePath,
      relativePath: HARNESS_AUDIT_TRACE_PATH,
      bytes: Buffer.byteLength(built.source, "utf8"),
      truncated: built.truncated,
      includedRecords: built.includedRecords,
      omittedRecords: built.omittedRecords,
    };
  });
}
