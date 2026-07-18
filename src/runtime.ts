import type { Effect } from "effect";

import type { RuntimeTurnInput, RuntimeTurnResult } from "./domain.js";
import type { RuntimeError } from "./errors.js";

export interface AgentRuntimeMetadata {
  /** Stable, non-secret adapter identifier retained in the private run journal. */
  readonly adapter: string;
  /** Executable name or path. Never include arguments or credentials. */
  readonly binary: string | null;
  /** Whether the adapter ignores or isolates user-authored runtime configuration. */
  readonly ignoreUserConfig: boolean | null;
  /** Adapter output cap, when the runtime owns one. */
  readonly maxOutputBytes: number | null;
  /** Short, non-secret description of the tool/sandbox policy applied by the adapter. */
  readonly toolPolicy: string;
}

export interface AgentRuntime {
  readonly metadata?: AgentRuntimeMetadata;
  readonly runTurn: (input: RuntimeTurnInput) => Effect.Effect<RuntimeTurnResult, RuntimeError>;
}
