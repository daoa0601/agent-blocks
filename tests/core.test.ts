import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  agentBlockAssignments,
  agentFromRuntime,
  defineAgentMember,
  defineAgentOrganization,
  defineAgentTemplate,
  defineAgentTeam,
  instantiateTemplate,
  mapAgent,
} from "../src/index.js";
import type { AgentBlock, AgentContext, AgentEvent, AgentRuntime } from "../src/index.js";

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

  it("assigns identified blocks to explicit members, teams, and an organization", () => {
    const source: Array<AgentBlock> = [{ id: "surface-map", description: "Inventory the target." }];
    const organization = defineAgentOrganization<AgentBlock>({
      id: "security",
      description: "A bounded security organization.",
      teams: [
        defineAgentTeam({
          id: "red",
          description: "Find plausible weaknesses.",
          members: [
            defineAgentMember({
              id: "recon",
              description: "Map the attack surface.",
              blocks: source,
            }),
          ],
        }),
        defineAgentTeam({
          id: "blue",
          members: [
            defineAgentMember({
              id: "falsifier",
              blocks: [{ id: "disprove-findings" }],
            }),
          ],
        }),
      ],
    });
    source.push({ id: "late-mutation" });

    expect(agentBlockAssignments(organization)).toEqual([
      {
        organizationId: "security",
        teamId: "red",
        memberId: "recon",
        block: { id: "surface-map", description: "Inventory the target." },
      },
      {
        organizationId: "security",
        teamId: "blue",
        memberId: "falsifier",
        block: { id: "disprove-findings" },
      },
    ]);
  });

  it("rejects ambiguous or empty organization ownership", () => {
    expect(() => defineAgentMember({ id: " ", blocks: [{ id: "block" }] })).toThrow(
      /surrounding whitespace/u,
    );
    expect(() => defineAgentMember({ id: "empty", blocks: [] })).toThrow(/at least one block/u);
    expect(() =>
      defineAgentMember({ id: "duplicate", blocks: [{ id: "block" }, { id: "block" }] }),
    ).toThrow(/duplicate block id/u);
    expect(() => defineAgentTeam({ id: "empty", members: [] })).toThrow(/at least one member/u);
    expect(() =>
      defineAgentTeam({
        id: "duplicate-members",
        members: [
          { id: "member", blocks: [{ id: "a" }] },
          { id: "member", blocks: [{ id: "b" }] },
        ],
      }),
    ).toThrow(/duplicate member id/u);
    expect(() =>
      defineAgentTeam({
        id: "duplicate-blocks",
        members: [
          { id: "first", blocks: [{ id: "shared" }] },
          { id: "second", blocks: [{ id: "shared" }] },
        ],
      }),
    ).toThrow(/assigns block shared to both/u);
    expect(() => defineAgentOrganization({ id: "empty", teams: [] })).toThrow(/at least one team/u);
    expect(() =>
      defineAgentOrganization({
        id: "duplicate-teams",
        teams: [
          { id: "team", members: [{ id: "first", blocks: [{ id: "a" }] }] },
          { id: "team", members: [{ id: "second", blocks: [{ id: "b" }] }] },
        ],
      }),
    ).toThrow(/duplicate team id/u);
    expect(() =>
      defineAgentOrganization({
        id: "duplicate-organization-block",
        teams: [
          { id: "red", members: [{ id: "first", blocks: [{ id: "shared" }] }] },
          { id: "blue", members: [{ id: "second", blocks: [{ id: "shared" }] }] },
        ],
      }),
    ).toThrow(/red\/first and blue\/second/u);
  });
});
