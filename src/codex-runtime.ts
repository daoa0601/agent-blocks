import { Effect } from "effect";

import type { CodexDefinition, RuntimeTurnInput, RuntimeTurnResult, TokenUsage } from "./domain.js";
import { errorMessage, RuntimeError } from "./errors.js";
import { runProcess } from "./process-runner.js";
import type { AgentRuntime } from "./runtime.js";

interface CodexEvent {
  readonly type?: unknown;
  readonly thread_id?: unknown;
  readonly item?: unknown;
  readonly usage?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseCodexJsonl(stdout: string): {
  readonly events: ReadonlyArray<unknown>;
  readonly threadId: string | undefined;
  readonly finalText: string | undefined;
  readonly usage: TokenUsage;
} {
  const events: Array<unknown> = [];
  let threadId: string | undefined;
  let finalText: string | undefined;
  let usage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const event = JSON.parse(line) as CodexEvent;
    events.push(event);
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
    if (event.type === "item.completed") {
      const item = asRecord(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") {
        finalText = item.text;
      }
    }
    if (event.type === "turn.completed") {
      const raw = asRecord(event.usage);
      const inputTokens = numeric(raw?.input_tokens);
      const cachedInputTokens = numeric(raw?.cached_input_tokens);
      const outputTokens = numeric(raw?.output_tokens);
      usage = {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  return { events, threadId, finalText, usage };
}

export function buildCodexArgs(
  input: RuntimeTurnInput,
  definition: CodexDefinition,
): ReadonlyArray<string> {
  const common = [
    "--json",
    ...(definition.ignoreUserConfig ? ["--ignore-user-config"] : []),
    "--output-schema",
    input.outputSchemaPath,
    ...(input.model === undefined ? [] : ["--model", input.model]),
  ];

  if (input.threadId === undefined) {
    return [
      "exec",
      "--color",
      "never",
      ...common,
      "--sandbox",
      input.sandbox,
      "--cd",
      input.cwd,
      "-",
    ];
  }

  // `codex exec resume` retains the original thread's cwd and sandbox. It does not
  // accept --cd, --sandbox, or the parent exec command's --color flag, so the
  // harness treats the scoped fields as immutable and passes only resume options.
  return ["exec", "resume", ...common, input.threadId, "-"];
}

export function makeCodexRuntime(definition: CodexDefinition): AgentRuntime {
  return {
    runTurn: (input): Effect.Effect<RuntimeTurnResult, RuntimeError> =>
      Effect.gen(function* () {
        const result = yield* runProcess({
          command: definition.binary,
          args: buildCodexArgs(input, definition),
          cwd: input.cwd,
          stdin: input.prompt,
          timeoutSeconds: input.timeoutSeconds,
          maxOutputBytes: definition.maxOutputBytes,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new RuntimeError({
                message: `Codex turn failed for ${input.agentId}: ${cause.message}`,
                agentId: input.agentId,
                cause,
              }),
          ),
        );

        if (result.exitCode !== 0) {
          return yield* new RuntimeError({
            message: `Codex exited ${result.exitCode} for ${input.agentId}: ${result.stderr.slice(-4_000)}`,
            agentId: input.agentId,
            cause: result,
          });
        }

        let parsed: ReturnType<typeof parseCodexJsonl>;
        try {
          parsed = parseCodexJsonl(result.stdout);
        } catch (cause) {
          return yield* new RuntimeError({
            message: `Codex emitted invalid JSONL for ${input.agentId}: ${errorMessage(cause)}`,
            agentId: input.agentId,
            cause,
          });
        }

        const threadId = parsed.threadId ?? input.threadId;
        if (threadId === undefined) {
          return yield* new RuntimeError({
            message: `Codex did not emit a thread id for ${input.agentId}`,
            agentId: input.agentId,
            cause: parsed.events,
          });
        }
        if (parsed.finalText === undefined) {
          return yield* new RuntimeError({
            message: `Codex did not emit a final agent message for ${input.agentId}`,
            agentId: input.agentId,
            cause: parsed.events,
          });
        }

        return {
          threadId,
          finalText: parsed.finalText,
          usage: parsed.usage,
          events: parsed.events,
        };
      }),
  };
}
