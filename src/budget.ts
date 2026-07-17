import { Effect, Ref } from "effect";

import type { HarnessLimits, TokenUsage } from "./domain.js";
import { BudgetExceeded } from "./errors.js";

export interface BudgetUsage {
  readonly rounds: number;
  readonly totalAgents: number;
  readonly agentTurns: number;
  readonly totalTokens: number;
}

export interface RunBudget {
  readonly beginRound: () => Effect.Effect<number, BudgetExceeded>;
  readonly reserveAgentTurn: (isNewAgent: boolean) => Effect.Effect<BudgetUsage, BudgetExceeded>;
  readonly chargeTokens: (tokens: number) => Effect.Effect<BudgetUsage, BudgetExceeded>;
  readonly checkWallClock: () => Effect.Effect<void, BudgetExceeded>;
  readonly usage: Effect.Effect<BudgetUsage>;
}

function exceeded(budget: string, limit: number, attempted: number): BudgetExceeded {
  return new BudgetExceeded({ budget, limit, attempted });
}

/**
 * Charge fresh model work while retaining raw and cached token counts in the
 * durable runtime event. Wall-clock and turn caps still bound cached tool loops.
 */
export function tokenBudgetCharge(usage: TokenUsage): number {
  const inputTokens = Math.max(0, Math.floor(usage.inputTokens));
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Math.floor(usage.cachedInputTokens)));
  const outputTokens = Math.max(0, Math.floor(usage.outputTokens));
  return inputTokens - cachedInputTokens + outputTokens;
}

export function makeRunBudget(limits: HarnessLimits): Effect.Effect<RunBudget> {
  return Effect.gen(function* () {
    const startedAt = Date.now();
    const ref = yield* Ref.make<BudgetUsage>({
      rounds: 0,
      totalAgents: 0,
      agentTurns: 0,
      totalTokens: 0,
    });

    const beginRound = (): Effect.Effect<number, BudgetExceeded> =>
      Ref.modify(ref, (current): readonly [number | BudgetExceeded, BudgetUsage] => {
        const next = current.rounds + 1;
        return next > limits.maxRounds
          ? [exceeded("maxRounds", limits.maxRounds, next), current]
          : [next, { ...current, rounds: next }];
      }).pipe(
        Effect.flatMap((result) =>
          result instanceof BudgetExceeded ? Effect.fail(result) : Effect.succeed(result),
        ),
      );

    const reserveAgentTurn = (isNewAgent: boolean): Effect.Effect<BudgetUsage, BudgetExceeded> =>
      Ref.modify(ref, (current): readonly [BudgetUsage | BudgetExceeded, BudgetUsage] => {
        const totalAgents = current.totalAgents + (isNewAgent ? 1 : 0);
        const agentTurns = current.agentTurns + 1;
        if (totalAgents > limits.maxTotalAgents) {
          return [exceeded("maxTotalAgents", limits.maxTotalAgents, totalAgents), current];
        }
        if (agentTurns > limits.maxTotalAgentTurns) {
          return [exceeded("maxTotalAgentTurns", limits.maxTotalAgentTurns, agentTurns), current];
        }
        const next = { ...current, totalAgents, agentTurns };
        return [next, next];
      }).pipe(
        Effect.flatMap((result) =>
          result instanceof BudgetExceeded ? Effect.fail(result) : Effect.succeed(result),
        ),
      );

    const chargeTokens = (tokens: number): Effect.Effect<BudgetUsage, BudgetExceeded> =>
      Ref.modify(ref, (current): readonly [BudgetUsage | BudgetExceeded, BudgetUsage] => {
        const totalTokens = current.totalTokens + Math.max(0, Math.floor(tokens));
        const next = { ...current, totalTokens };
        const limit = limits.maxTotalTokens;
        return limit !== undefined && totalTokens > limit
          ? [exceeded("maxTotalTokens", limit, totalTokens), next]
          : [next, next];
      }).pipe(
        Effect.flatMap((result) =>
          result instanceof BudgetExceeded ? Effect.fail(result) : Effect.succeed(result),
        ),
      );

    const checkWallClock = (): Effect.Effect<void, BudgetExceeded> =>
      Effect.suspend(() => {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
        return elapsedSeconds >= limits.maxWallClockSeconds
          ? Effect.fail(exceeded("maxWallClockSeconds", limits.maxWallClockSeconds, elapsedSeconds))
          : Effect.void;
      });

    return {
      beginRound,
      reserveAgentTurn,
      chargeTokens,
      checkWallClock,
      usage: Ref.get(ref),
    };
  });
}
