import { BoundedProcessError, runBoundedProcess } from "@agentic-orch/node-guardrails/process";
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

function processError(request: ProcessRequest, cause: BoundedProcessError): ProcessError {
  return new ProcessError({
    message:
      cause.kind === "timed_out"
        ? `Process timed out after ${request.timeoutSeconds} seconds`
        : cause.kind === "stdout_limit" || cause.kind === "stderr_limit"
          ? `Process output exceeded ${request.maxOutputBytes} bytes`
          : cause.kind === "launch_failed"
            ? `Unable to start ${request.command}`
            : "Process was interrupted",
    command: commandLabel(request),
    exitCode: cause.exitCode,
    stderr: cause.stderr.toString("utf8"),
    timedOut: cause.kind === "timed_out",
    cause,
  });
}

export function runProcess(request: ProcessRequest): Effect.Effect<ProcessResult, ProcessError> {
  return Effect.tryPromise({
    try: async (signal) => {
      try {
        const result = await runBoundedProcess({
          executable: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env ?? process.env,
          stdin: request.stdin ?? "",
          timeoutMs: request.timeoutSeconds * 1_000,
          maxOutputBytes: request.maxOutputBytes,
          signal,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
          durationMs: result.durationMs,
        };
      } catch (cause) {
        if (cause instanceof BoundedProcessError) throw processError(request, cause);
        throw cause;
      }
    },
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
