import { Effect } from "effect";

/** A domain-neutral event emitted while an agent is running. */
export interface AgentEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Context supplied by an orchestrator when it invokes an agent. */
export interface AgentContext {
  readonly runId: string;
  readonly agentId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly emit: (event: AgentEvent) => Effect.Effect<void>;
}

/** The identity shared by executable and declarative agent building blocks. */
export interface AgentBlock {
  readonly id: string;
  readonly description?: string;
}

/** The smallest executable agent block. */
export interface Agent<Input, Output, Error = never, Requirements = never> extends AgentBlock {
  readonly run: (input: Input, context: AgentContext) => Effect.Effect<Output, Error, Requirements>;
}

/** A runtime adapter that can be wrapped as an Agent. */
export interface AgentRuntime<Request, Response, Error = never, Requirements = never> {
  readonly run: (
    request: Request,
    context: AgentContext,
  ) => Effect.Effect<Response, Error, Requirements>;
}

/** A reusable recipe that creates an agent for a set of options. */
export interface AgentTemplate<
  Options,
  Input,
  Output,
  Error = never,
  Requirements = never,
> extends AgentBlock {
  readonly create: (options: Options) => Agent<Input, Output, Error, Requirements>;
}

/** A durable member identity that owns one or more agent blocks. */
export interface AgentMember<Block extends AgentBlock = AgentBlock> {
  readonly id: string;
  readonly description?: string;
  readonly blocks: ReadonlyArray<Block>;
}

/** A named group of members that share one purpose or operating policy. */
export interface AgentTeam<Block extends AgentBlock = AgentBlock> {
  readonly id: string;
  readonly description?: string;
  readonly members: ReadonlyArray<AgentMember<Block>>;
}

/** A complete, domain-neutral roster of teams, members, and their owned blocks. */
export interface AgentOrganization<Block extends AgentBlock = AgentBlock> {
  readonly id: string;
  readonly description?: string;
  readonly teams: ReadonlyArray<AgentTeam<Block>>;
}

/** A flattened block assignment with its complete ownership path. */
export interface AgentBlockAssignment<Block extends AgentBlock = AgentBlock> {
  readonly organizationId: string;
  readonly teamId: string;
  readonly memberId: string;
  readonly block: Block;
}

function assertIdentifier(kind: string, id: string): void {
  if (id.length === 0 || id !== id.trim()) {
    throw new Error(`${kind} id must be non-empty and must not have surrounding whitespace`);
  }
}

function optionalDescription(description: string | undefined): { readonly description?: string } {
  return description === undefined ? {} : { description };
}

export function defineAgentMember<Block extends AgentBlock>(
  member: AgentMember<Block>,
): AgentMember<Block> {
  assertIdentifier("Agent member", member.id);
  if (member.blocks.length === 0) {
    throw new Error(`Agent member ${member.id} must own at least one block`);
  }

  const blockIds = new Set<string>();
  for (const block of member.blocks) {
    assertIdentifier("Agent block", block.id);
    if (blockIds.has(block.id)) {
      throw new Error(`Agent member ${member.id} owns duplicate block id: ${block.id}`);
    }
    blockIds.add(block.id);
  }

  return {
    id: member.id,
    ...optionalDescription(member.description),
    blocks: [...member.blocks],
  };
}

export function defineAgentTeam<Block extends AgentBlock>(
  team: AgentTeam<Block>,
): AgentTeam<Block> {
  assertIdentifier("Agent team", team.id);
  if (team.members.length === 0) {
    throw new Error(`Agent team ${team.id} must contain at least one member`);
  }

  const memberIds = new Set<string>();
  const blockOwners = new Map<string, string>();
  const members = team.members.map((member) => {
    const defined = defineAgentMember(member);
    if (memberIds.has(defined.id)) {
      throw new Error(`Agent team ${team.id} contains duplicate member id: ${defined.id}`);
    }
    memberIds.add(defined.id);
    for (const block of defined.blocks) {
      const owner = blockOwners.get(block.id);
      if (owner !== undefined) {
        throw new Error(
          `Agent team ${team.id} assigns block ${block.id} to both ${owner} and ${defined.id}`,
        );
      }
      blockOwners.set(block.id, defined.id);
    }
    return defined;
  });

  return {
    id: team.id,
    ...optionalDescription(team.description),
    members,
  };
}

export function defineAgentOrganization<Block extends AgentBlock>(
  organization: AgentOrganization<Block>,
): AgentOrganization<Block> {
  assertIdentifier("Agent organization", organization.id);
  if (organization.teams.length === 0) {
    throw new Error(`Agent organization ${organization.id} must contain at least one team`);
  }

  const teamIds = new Set<string>();
  const blockOwners = new Map<string, string>();
  const teams = organization.teams.map((team) => {
    const defined = defineAgentTeam(team);
    if (teamIds.has(defined.id)) {
      throw new Error(
        `Agent organization ${organization.id} contains duplicate team id: ${defined.id}`,
      );
    }
    teamIds.add(defined.id);
    for (const member of defined.members) {
      for (const block of member.blocks) {
        const owner = blockOwners.get(block.id);
        const qualifiedMember = `${defined.id}/${member.id}`;
        if (owner !== undefined) {
          throw new Error(
            `Agent organization ${organization.id} assigns block ${block.id} to both ${owner} and ${qualifiedMember}`,
          );
        }
        blockOwners.set(block.id, qualifiedMember);
      }
    }
    return defined;
  });

  return {
    id: organization.id,
    ...optionalDescription(organization.description),
    teams,
  };
}

export function agentBlockAssignments<Block extends AgentBlock>(
  organization: AgentOrganization<Block>,
): ReadonlyArray<AgentBlockAssignment<Block>> {
  return organization.teams.flatMap((team) =>
    team.members.flatMap((member) =>
      member.blocks.map((block) => ({
        organizationId: organization.id,
        teamId: team.id,
        memberId: member.id,
        block,
      })),
    ),
  );
}

export function defineAgent<Input, Output, Error = never, Requirements = never>(
  agent: Agent<Input, Output, Error, Requirements>,
): Agent<Input, Output, Error, Requirements> {
  return agent;
}

export function defineAgentTemplate<Options, Input, Output, Error = never, Requirements = never>(
  template: AgentTemplate<Options, Input, Output, Error, Requirements>,
): AgentTemplate<Options, Input, Output, Error, Requirements> {
  return template;
}

export function instantiateTemplate<Options, Input, Output, Error = never, Requirements = never>(
  template: AgentTemplate<Options, Input, Output, Error, Requirements>,
  options: Options,
): Agent<Input, Output, Error, Requirements> {
  return template.create(options);
}

export function agentFromRuntime<Request, Response, Error = never, Requirements = never>(
  id: string,
  runtime: AgentRuntime<Request, Response, Error, Requirements>,
  description?: string,
): Agent<Request, Response, Error, Requirements> {
  return defineAgent({
    id,
    ...(description === undefined ? {} : { description }),
    run: (request, context) => runtime.run(request, context),
  });
}

/** Transform an agent's successful output without changing how it is executed. */
export function mapAgent<Input, Output, Mapped, Error = never, Requirements = never>(
  agent: Agent<Input, Output, Error, Requirements>,
  map: (output: Output) => Mapped,
): Agent<Input, Mapped, Error, Requirements> {
  return defineAgent({
    id: agent.id,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    run: (input, context) => agent.run(input, context).pipe(Effect.map(map)),
  });
}
