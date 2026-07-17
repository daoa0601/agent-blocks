import { Effect } from "effect";

import type { EvaluationDefinition, EvaluationResult } from "./domain.js";
import { EvaluationError } from "./errors.js";
import { runProcess } from "./process-runner.js";

const EVALUATION_OUTPUT_LIMIT = 2 * 1024 * 1024;

export function evaluateCandidate(options: {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly definition: EvaluationDefinition;
}): Effect.Effect<EvaluationResult, EvaluationError> {
  const [command, ...args] = options.definition.command;
  if (command === undefined) {
    return Effect.fail(
      new EvaluationError({
        message: "Evaluation command has no executable",
        cause: options.definition,
      }),
    );
  }
  return runProcess({
    command,
    args,
    cwd: options.worktreePath,
    timeoutSeconds: options.definition.timeoutSeconds,
    maxOutputBytes: EVALUATION_OUTPUT_LIMIT,
    env: {
      ...process.env,
      HARNESS_CANDIDATE_ID: options.candidateId,
      CI: process.env.CI ?? "1",
    },
  }).pipe(
    Effect.map((result): EvaluationResult => ({
      candidateId: options.candidateId,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-64_000),
      stderr: result.stderr.slice(-64_000),
      durationMs: result.durationMs,
    })),
    Effect.mapError(
      (cause) =>
        new EvaluationError({
          message: `Evaluator could not run for ${options.candidateId}: ${cause.message}`,
          cause,
        }),
    ),
  );
}
