import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { HARNESS_AUDIT_TRACE_PATH } from "../src/audit.js";
import {
  acquireCandidateWorktree,
  applyCandidatePatch,
  captureCandidatePatch,
  inspectBaseWorkspace,
  reserveCandidateAuditDirectory,
} from "../src/workspace.js";
import { makeGitRepository, makeTempDirectory } from "./helpers.js";

describe("candidate patch transport", () => {
  it("captures a new file from an isolated worktree and applies it to an unchanged base", async () => {
    const repository = await makeGitRepository();
    const state = await makeTempDirectory("agent-blocks-workspace-");

    const applied = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = yield* inspectBaseWorkspace(repository, false);
          const worktree = yield* acquireCandidateWorktree({
            base,
            candidateId: "candidate-a",
            worktreesDirectory: path.join(state, "worktrees"),
            keep: false,
          });
          yield* Effect.promise(() =>
            writeFile(path.join(worktree, "new-file.txt"), "candidate output\n", "utf8"),
          );
          const patch = yield* captureCandidatePatch({
            candidateId: "candidate-a",
            worktreePath: worktree,
            candidatesDirectory: path.join(state, "patches"),
          });
          return yield* applyCandidatePatch({ base, patchPath: patch.patchPath });
        }),
      ),
    );

    expect(applied).toBe(true);
    expect(await readFile(path.join(repository, "new-file.txt"), "utf8")).toBe(
      "candidate output\n",
    );
  });

  it("never captures harness-owned audit state", async () => {
    const repository = await makeGitRepository();
    const state = await makeTempDirectory("agent-blocks-workspace-audit-");

    const patch = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = yield* inspectBaseWorkspace(repository, false);
          const worktree = yield* acquireCandidateWorktree({
            base,
            candidateId: "candidate-a",
            worktreesDirectory: path.join(state, "worktrees"),
            keep: false,
          });
          yield* reserveCandidateAuditDirectory(worktree);
          yield* Effect.promise(() =>
            Promise.all([
              writeFile(path.join(worktree, "new-file.txt"), "candidate output\n", "utf8"),
              writeFile(
                path.join(worktree, HARNESS_AUDIT_TRACE_PATH),
                "trusted harness trace\n",
                "utf8",
              ),
            ]),
          );
          return yield* captureCandidatePatch({
            candidateId: "candidate-a",
            worktreePath: worktree,
            candidatesDirectory: path.join(state, "patches"),
          });
        }),
      ),
    );

    const source = await readFile(patch.patchPath, "utf8");
    expect(source).toContain("new-file.txt");
    expect(source).not.toContain(".harness-audit");
    expect(source).not.toContain("trusted harness trace");
  });
});
