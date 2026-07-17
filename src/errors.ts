import { Data } from "effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class ProcessError extends Data.TaggedError("ProcessError")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cause: unknown;
}> {}

export class RuntimeError extends Data.TaggedError("RuntimeError")<{
  readonly message: string;
  readonly agentId: string;
  readonly cause: unknown;
}> {}

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class JournalError extends Data.TaggedError("JournalError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class EvaluationError extends Data.TaggedError("EvaluationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class BudgetExceeded extends Data.TaggedError("BudgetExceeded")<{
  readonly budget: string;
  readonly limit: number;
  readonly attempted: number;
}> {}

export class DecisionError extends Data.TaggedError("DecisionError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export type HarnessError =
  | ConfigError
  | ProcessError
  | RuntimeError
  | WorkspaceError
  | JournalError
  | EvaluationError
  | BudgetExceeded
  | DecisionError;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
