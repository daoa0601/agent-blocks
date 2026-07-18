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

/** The smallest executable agent block. */
export interface Agent<Input, Output, Error = never, Requirements = never> {
  readonly id: string;
  readonly description?: string;
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
export interface AgentTemplate<Options, Input, Output, Error = never, Requirements = never> {
  readonly id: string;
  readonly description?: string;
  readonly create: (options: Options) => Agent<Input, Output, Error, Requirements>;
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
