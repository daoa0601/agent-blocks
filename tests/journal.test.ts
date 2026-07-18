import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunJournal, readRunEventRecords, runDirectoryFor } from "../src/persistence.js";
import {
  inspectRunState,
  listRuns,
  readRunEvents,
} from "../src/templates/scoped-worktree-control-plane.js";
import { makeTempDirectory } from "./helpers.js";

const AT = "2026-07-17T12:00:00.000Z";

function record(runId: string, sequence: number, type: string, at = AT): string {
  return JSON.stringify({ schemaVersion: 1, runId, sequence, at, type });
}

async function writeJournal(harnessHome: string, runId: string, source: string): Promise<void> {
  const runDirectory = runDirectoryFor(harnessHome, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path.join(runDirectory, "events.jsonl"), source, "utf8");
}

describe("versioned run journal", () => {
  it("accepts legacy records and an incomplete final append, but rejects complete corruption", async () => {
    const harnessHome = await makeTempDirectory("agent-blocks-journal-");
    const runId = "truncated-run";
    await writeJournal(
      harnessHome,
      runId,
      `${record(runId, 1, "run.created")}\n{"schemaVersion":1,"runId":"truncated-run"`,
    );
    const records = await Effect.runPromise(readRunEventRecords(harnessHome, runId));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ schemaVersion: 1, sequence: 1, type: "run.created" });
    expect((await Effect.runPromise(inspectRunState(harnessHome, runId))).status).toBe("queued");

    const legacyRunId = "legacy-run";
    await writeJournal(
      harnessHome,
      legacyRunId,
      `${JSON.stringify({ sequence: 1, at: AT, type: "run.started", workflow: "legacy" })}\n`,
    );
    expect(await Effect.runPromise(readRunEventRecords(harnessHome, legacyRunId))).toEqual([
      expect.objectContaining({
        schemaVersion: 0,
        runId: legacyRunId,
        sequence: 1,
        type: "run.started",
      }),
    ]);

    const corruptRunId = "corrupt-run";
    await writeJournal(
      harnessHome,
      corruptRunId,
      `${record(corruptRunId, 1, "run.created")}\n{not-json}\n`,
    );
    await expect(Effect.runPromise(readRunEventRecords(harnessHome, corruptRunId))).rejects.toThrow(
      /Invalid JSON/u,
    );

    const corruptFinalRunId = "corrupt-final-run";
    await writeJournal(harnessHome, corruptFinalRunId, "{not-json");
    await expect(
      Effect.runPromise(readRunEventRecords(harnessHome, corruptFinalRunId)),
    ).rejects.toThrow(/Invalid JSON/u);

    const gapRunId = "gap-run";
    await writeJournal(
      harnessHome,
      gapRunId,
      `${record(gapRunId, 1, "run.created")}\n${record(gapRunId, 3, "run.started")}\n`,
    );
    expect(
      (await Effect.runPromise(readRunEventRecords(harnessHome, gapRunId))).map(
        (event) => event.sequence,
      ),
    ).toEqual([1, 3]);

    const duplicateRunId = "duplicate-run";
    await writeJournal(
      harnessHome,
      duplicateRunId,
      `${record(duplicateRunId, 1, "run.created")}\n${record(duplicateRunId, 1, "run.started")}\n`,
    );
    await expect(
      Effect.runPromise(readRunEventRecords(harnessHome, duplicateRunId)),
    ).rejects.toThrow(/strictly increasing/u);

    const futureRunId = "future-run";
    await writeJournal(
      harnessHome,
      futureRunId,
      `${JSON.stringify({ schemaVersion: 99, runId: futureRunId, sequence: 1, at: AT, type: "run.created" })}\n`,
    );
    await expect(Effect.runPromise(readRunEventRecords(harnessHome, futureRunId))).rejects.toThrow(
      /unsupported schemaVersion/u,
    );
  });

  it("redacts recursively, omits raw runtime records, and advances by canonical sequence", async () => {
    const harnessHome = await makeTempDirectory("agent-blocks-redaction-");
    const runId = "redaction-run";
    const journal = await Effect.runPromise(
      makeRunJournal(runDirectoryFor(harnessHome, runId), runId),
    );
    await Effect.runPromise(
      journal.append({
        type: "run.created",
        workflow: "redaction-fixture",
        workspace: "/private/workspace",
      }),
    );
    await Effect.runPromise(
      journal.append({
        type: "agent.turn_completed",
        agentId: "builder-1",
        threadId: "private-thread",
        prompt: "private-prompt",
        usage: { totalTokens: 2 },
        nested: {
          configPath: "/private/workflow.yaml",
          retainedWorktree: "/private/worktree",
          evaluation: { stderr: "private-stderr", passed: false },
          safe: "visible",
        },
      }),
    );
    await Effect.runPromise(
      journal.append({
        type: "codex.raw_event",
        rawEvent: { secret: "private-raw-event" },
        sessionId: "private-session",
      }),
    );
    await Effect.runPromise(
      journal.append({
        type: "run.failed",
        message: "Failure beneath /private/host/path",
        errorTag: "FixtureError",
      }),
    );

    const firstPage = await Effect.runPromise(
      readRunEvents(harnessHome, runId, { afterSequence: 1, limit: 1 }),
    );
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]).toMatchObject({ sequence: 2, type: "agent.turn_completed" });
    const firstJson = JSON.stringify(firstPage);
    expect(firstJson).toContain("visible");
    expect(firstJson).not.toContain("private-thread");
    expect(firstJson).not.toContain("private-prompt");
    expect(firstJson).not.toContain("private/workflow.yaml");
    expect(firstJson).not.toContain("private/worktree");
    expect(firstJson).not.toContain("private-stderr");

    const secondPage = await Effect.runPromise(
      readRunEvents(harnessHome, runId, { afterSequence: 2, limit: 1 }),
    );
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]).toMatchObject({ sequence: 4, type: "run.failed" });
    expect(JSON.stringify(secondPage)).not.toContain("/private/host/path");
    expect(
      JSON.stringify(await Effect.runPromise(readRunEvents(harnessHome, runId))),
    ).not.toContain("private-raw-event");
  });

  it("lists newest-first with a deterministic run-ID tie break and skips empty allocations", async () => {
    const harnessHome = await makeTempDirectory("agent-blocks-order-");
    await writeJournal(
      harnessHome,
      "run-a",
      `${record("run-a", 1, "run.created", "2026-07-17T10:00:00.000Z")}\n`,
    );
    await writeJournal(
      harnessHome,
      "run-b",
      `${record("run-b", 1, "run.created", "2026-07-17T11:00:00.000Z")}\n`,
    );
    await writeJournal(
      harnessHome,
      "run-c",
      `${record("run-c", 1, "run.created", "2026-07-17T11:00:00.000Z")}\n`,
    );
    await mkdir(runDirectoryFor(harnessHome, "empty-run"), { recursive: true });
    await writeJournal(harnessHome, "partial-run", '{"schemaVersion":1');

    const first = await Effect.runPromise(listRuns(harnessHome));
    const second = await Effect.runPromise(listRuns(harnessHome));
    expect(first.map((run) => run.runId)).toEqual(["run-c", "run-b", "run-a"]);
    expect(second).toEqual(first);
  });
});
