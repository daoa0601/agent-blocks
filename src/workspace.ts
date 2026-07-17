import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect, Scope } from "effect";

import {
  HARNESS_AUDIT_DIRECTORY,
  assertCandidateAuditDirectoryUntouched,
  resetCandidateAuditDirectory,
} from "./audit.js";
import { errorMessage, WorkspaceError } from "./errors.js";
import { runProcess } from "./process-runner.js";

const GIT_OUTPUT_LIMIT = 20 * 1024 * 1024;

export interface BaseWorkspace {
  readonly root: string;
  readonly head: string;
  readonly initialStatus: string;
}

export interface CandidatePatch {
  readonly patchPath: string;
  readonly diffStat: string;
  readonly empty: boolean;
}

export function assertCandidateAuditPathUntracked(
  worktreePath: string,
): Effect.Effect<void, WorkspaceError> {
  return Effect.gen(function* () {
    const tracked = yield* runGit(worktreePath, [
      "ls-files",
      "--stage",
      "--",
      HARNESS_AUDIT_DIRECTORY,
    ]);
    if (tracked.length > 0) {
      return yield* new WorkspaceError({
        message: `Candidate attempted to track the reserved ${HARNESS_AUDIT_DIRECTORY}/ path`,
        cause: tracked,
      });
    }
  });
}

export function reserveCandidateAuditDirectory(
  worktreePath: string,
): Effect.Effect<void, WorkspaceError> {
  return Effect.gen(function* () {
    yield* assertCandidateAuditPathUntracked(worktreePath);
    yield* resetCandidateAuditDirectory(worktreePath);
  });
}

export function prepareCandidateAuditDirectoryForTurn(
  worktreePath: string,
): Effect.Effect<void, WorkspaceError> {
  return reserveCandidateAuditDirectory(worktreePath);
}

export function verifyCandidateAuditDirectoryAfterTurn(
  worktreePath: string,
): Effect.Effect<void, WorkspaceError> {
  return Effect.gen(function* () {
    yield* assertCandidateAuditPathUntracked(worktreePath);
    yield* assertCandidateAuditDirectoryUntouched(worktreePath);
  });
}

function runGit(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, WorkspaceError> {
  return Effect.gen(function* () {
    const result = yield* runProcess({
      command: "git",
      args,
      cwd,
      timeoutSeconds: 60,
      maxOutputBytes: GIT_OUTPUT_LIMIT,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceError({
            message: `Git failed in ${cwd}: ${cause.message}`,
            cause,
          }),
      ),
    );
    if (result.exitCode !== 0) {
      return yield* new WorkspaceError({
        message: `git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.slice(-4_000)}`,
        cause: result,
      });
    }
    return result.stdout;
  });
}

export function inspectBaseWorkspace(
  requestedPath: string,
  allowDirty: boolean,
): Effect.Effect<BaseWorkspace, WorkspaceError> {
  return Effect.gen(function* () {
    const resolved = yield* Effect.tryPromise({
      try: () => realpath(requestedPath),
      catch: (cause) =>
        new WorkspaceError({
          message: `Workspace does not exist: ${requestedPath}`,
          cause,
        }),
    });
    const root = (yield* runGit(resolved, ["rev-parse", "--show-toplevel"])).trim();
    const head = (yield* runGit(root, ["rev-parse", "HEAD"])).trim();
    const initialStatus = yield* runGit(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (!allowDirty && initialStatus.trim().length > 0) {
      return yield* new WorkspaceError({
        message:
          "Base workspace is dirty. Commit/stash changes or set allowDirtyWorkspace: true for read-only comparison runs.",
        cause: initialStatus,
      });
    }
    return { root, head, initialStatus };
  });
}

export function acquireCandidateWorktree(options: {
  readonly base: BaseWorkspace;
  readonly candidateId: string;
  readonly worktreesDirectory: string;
  readonly keep: boolean;
}): Effect.Effect<string, WorkspaceError, Scope.Scope> {
  const worktreePath = path.join(options.worktreesDirectory, options.candidateId);
  const acquire = Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(options.worktreesDirectory, { recursive: true }),
      catch: (cause) =>
        new WorkspaceError({
          message: `Unable to create ${options.worktreesDirectory}`,
          cause,
        }),
    });
    yield* runGit(options.base.root, [
      "worktree",
      "add",
      "--detach",
      worktreePath,
      options.base.head,
    ]);
    return worktreePath;
  });

  return Effect.acquireRelease(acquire, () => {
    if (options.keep) return Effect.void;
    return runGit(options.base.root, ["worktree", "remove", "--force", worktreePath]).pipe(
      Effect.ignore,
    );
  });
}

export function captureCandidatePatch(options: {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly candidatesDirectory: string;
}): Effect.Effect<CandidatePatch, WorkspaceError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(options.candidatesDirectory, { recursive: true }),
      catch: (cause) =>
        new WorkspaceError({
          message: `Unable to create ${options.candidatesDirectory}`,
          cause,
        }),
    });

    const capture = Effect.gen(function* () {
      yield* assertCandidateAuditPathUntracked(options.worktreePath);
      yield* runGit(options.worktreePath, [
        "add",
        "--all",
        "--",
        ".",
        `:(exclude)${HARNESS_AUDIT_DIRECTORY}`,
        `:(exclude)${HARNESS_AUDIT_DIRECTORY}/**`,
      ]);
      yield* assertCandidateAuditPathUntracked(options.worktreePath);
      const patch = yield* runGit(options.worktreePath, [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "HEAD",
      ]);
      const rawStat = yield* runGit(options.worktreePath, ["diff", "--cached", "--stat", "HEAD"]);
      const patchPath = path.join(options.candidatesDirectory, `${options.candidateId}.patch`);
      yield* Effect.tryPromise({
        try: () => writeFile(patchPath, patch, "utf8"),
        catch: (cause) =>
          new WorkspaceError({
            message: `Unable to write candidate patch ${patchPath}`,
            cause,
          }),
      });
      return {
        patchPath,
        diffStat: rawStat.trim() || "(no changes)",
        empty: patch.length === 0,
      };
    });

    return yield* capture.pipe(
      Effect.ensuring(
        runGit(options.worktreePath, ["reset", "--mixed", "HEAD"]).pipe(Effect.ignore),
      ),
    );
  });
}

export function applyCandidatePatch(options: {
  readonly base: BaseWorkspace;
  readonly patchPath: string;
}): Effect.Effect<boolean, WorkspaceError> {
  return Effect.gen(function* () {
    const currentHead = (yield* runGit(options.base.root, ["rev-parse", "HEAD"])).trim();
    if (currentHead !== options.base.head) {
      return yield* new WorkspaceError({
        message: "Base HEAD changed during the run; refusing to apply the candidate patch.",
        cause: { before: options.base.head, after: currentHead },
      });
    }
    const status = yield* runGit(options.base.root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.trim().length > 0) {
      return yield* new WorkspaceError({
        message: "Base workspace is not clean; refusing to apply the candidate patch.",
        cause: status,
      });
    }
    const patch = yield* Effect.tryPromise({
      try: () => readFile(options.patchPath, "utf8"),
      catch: (cause) =>
        new WorkspaceError({
          message: `Unable to read ${options.patchPath}`,
          cause,
        }),
    });
    if (patch.length === 0) return false;
    yield* runGit(options.base.root, ["apply", "--check", options.patchPath]);
    yield* runGit(options.base.root, ["apply", options.patchPath]);
    return true;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof WorkspaceError
        ? cause
        : new WorkspaceError({ message: errorMessage(cause), cause }),
    ),
  );
}
