import { spawn } from "node:child_process";

import { Effect } from "effect";

import { ProcessError } from "./errors.js";

export interface ProcessRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeoutSeconds: number;
  readonly maxOutputBytes: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

function commandLabel(request: ProcessRequest): string {
  return [request.command, ...request.args].join(" ");
}

export function runProcess(request: ProcessRequest): Effect.Effect<ProcessResult, ProcessError> {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<ProcessResult>((resolve, reject) => {
        const startedAt = performance.now();
        const child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: request.env ?? process.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let timeout: NodeJS.Timeout;

        const terminate = (): void => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          forceKillTimer ??= setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 2_000);
          forceKillTimer.unref();
        };

        const fail = (message: string, cause: unknown, exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          reject(
            new ProcessError({
              message,
              command: commandLabel(request),
              exitCode,
              stderr,
              timedOut,
              cause,
            }),
          );
        };

        const abort = (): void => {
          if (settled) return;
          terminate();
        };

        const enforceLimit = (): void => {
          if (
            Buffer.byteLength(stdout) > request.maxOutputBytes ||
            Buffer.byteLength(stderr) > request.maxOutputBytes
          ) {
            terminate();
            fail(`Process output exceeded ${request.maxOutputBytes} bytes`, undefined, null);
          }
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          enforceLimit();
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          enforceLimit();
        });

        child.once("error", (cause) => {
          fail(`Unable to start ${request.command}`, cause, null);
        });
        child.once("close", (exitCode, signalName) => {
          if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          resolve({
            exitCode: exitCode ?? (signalName === null ? 1 : 128),
            stdout,
            stderr,
            durationMs: Math.round(performance.now() - startedAt),
          });
        });

        signal.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => {
          timedOut = true;
          terminate();
          fail(`Process timed out after ${request.timeoutSeconds} seconds`, undefined, null);
        }, request.timeoutSeconds * 1_000);

        child.stdin.on("error", () => {
          // The child may close stdin before reading it; the exit event remains authoritative.
        });
        child.stdin.end(request.stdin ?? "");
      }),
    catch: (cause) =>
      cause instanceof ProcessError
        ? cause
        : new ProcessError({
            message: `Process failed: ${commandLabel(request)}`,
            command: commandLabel(request),
            exitCode: null,
            stderr: "",
            timedOut: false,
            cause,
          }),
  });
}
