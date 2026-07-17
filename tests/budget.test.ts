import { describe, expect, it } from "vitest";

import { tokenBudgetCharge } from "../src/budget.js";

describe("token budget accounting", () => {
  it("charges uncached input and output while preserving cached context as a separate metric", () => {
    expect(
      tokenBudgetCharge({
        inputTokens: 12,
        cachedInputTokens: 4,
        outputTokens: 3,
        totalTokens: 15,
      }),
    ).toBe(11);
  });

  it("clamps malformed cached counts instead of producing a negative charge", () => {
    expect(
      tokenBudgetCharge({
        inputTokens: 5,
        cachedInputTokens: 20,
        outputTokens: 2,
        totalTokens: 7,
      }),
    ).toBe(2);
  });
});
