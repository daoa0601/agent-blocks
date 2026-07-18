import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  agentFromRuntime,
  defineAgentTemplate,
  instantiateTemplate,
  mapAgent,
} from "../src/index.js";
import type { AgentContext, AgentEvent, AgentRuntime } from "../src/index.js";

function context(events: Array<AgentEvent>): AgentContext {
  return {
    runId: "generic-run",
    agentId: "multiplier",
    metadata: { source: "test" },
    emit: (event) => Effect.sync(() => void events.push(event)),
  };
}

describe("generic agent blocks", () => {
  it("instantiates a custom template without Codex or Git dependencies", async () => {
    const events: Array<AgentEvent> = [];
    const multiplier = defineAgentTemplate({
      id: "multiplier-template",
      create: (factor: number) => ({
        id: "multiplier",
        run: (input: number, agentContext: AgentContext) =>
          agentContext.emit({ type: "number.multiplied", factor }).pipe(Effect.as(input * factor)),
      }),
    });

    const agent = instantiateTemplate(multiplier, 3);
    const result = await Effect.runPromise(agent.run(7, context(events)));

    expect(result).toBe(21);
    expect(events).toEqual([{ type: "number.multiplied", factor: 3 }]);
  });

  it("wraps runtimes and maps successful output", async () => {
    const runtime: AgentRuntime<string, number> = {
      run: (request) => Effect.succeed(request.length),
    };
    const length = agentFromRuntime("length", runtime);
    const labeled = mapAgent(length, (value) => `length:${value}`);

    expect(await Effect.runPromise(labeled.run("blocks", context([])))).toBe("length:6");
  });
});
