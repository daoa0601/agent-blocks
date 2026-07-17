import type { Effect } from "effect";

import type { RuntimeTurnInput, RuntimeTurnResult } from "./domain.js";
import type { RuntimeError } from "./errors.js";

export interface AgentRuntime {
  readonly runTurn: (input: RuntimeTurnInput) => Effect.Effect<RuntimeTurnResult, RuntimeError>;
}
