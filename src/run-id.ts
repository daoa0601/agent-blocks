import { randomUUID } from "node:crypto";
import path from "node:path";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Creates a sortable, filesystem-safe run identifier. */
export function createRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

/** Rejects IDs that could escape or ambiguously address the runs directory. */
export function assertRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `Invalid run ID: ${runId}. Expected 1-128 ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit.`,
    );
  }
}

/** Resolves a validated run ID beneath a harness home's runs directory. */
export function runDirectoryFor(harnessHome: string, runId: string): string {
  assertRunId(runId);
  return path.join(path.resolve(harnessHome), "runs", runId);
}
