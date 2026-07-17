import { Effect, Result } from "effect";

import { runProcess } from "./process-runner.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

function supportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major >= 26) return true;
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  return false;
}

function commandCheck(options: {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly validate?: (output: string) => boolean;
}): Effect.Effect<DoctorCheck> {
  return Effect.gen(function* () {
    const attempted = yield* Effect.result(
      runProcess({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        timeoutSeconds: 15,
        maxOutputBytes: 1024 * 1024,
      }),
    );
    if (Result.isFailure(attempted)) {
      return { name: options.name, ok: false, detail: attempted.failure.message };
    }
    const result = attempted.success;
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const ok = result.exitCode === 0 && (options.validate?.(output) ?? true);
    return {
      name: options.name,
      ok,
      detail: output.split(/\r?\n/u)[0] ?? `exit ${result.exitCode}`,
    };
  });
}

export function doctor(cwd: string): Effect.Effect<DoctorReport> {
  return Effect.gen(function* () {
    const checks = yield* Effect.all([
      Effect.succeed<DoctorCheck>({
        name: "node",
        ok: supportedNodeVersion(process.versions.node),
        detail: process.version,
      }),
      commandCheck({ name: "git", command: "git", args: ["--version"], cwd }),
      commandCheck({
        name: "git-workspace",
        command: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd,
      }),
      commandCheck({ name: "codex", command: "codex", args: ["--version"], cwd }),
      commandCheck({
        name: "chatgpt-login",
        command: "codex",
        args: ["login", "status"],
        cwd,
        validate: (output) => /logged in using chatgpt/iu.test(output),
      }),
    ]);
    return { ok: checks.every((check) => check.ok), checks };
  });
}
