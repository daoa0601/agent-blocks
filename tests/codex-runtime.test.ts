import { describe, expect, it } from "vitest";

import { buildCodexArgs, parseCodexJsonl } from "../src/codex-runtime.js";
import type { CodexDefinition, RuntimeTurnInput } from "../src/domain.js";

const definition: CodexDefinition = {
  binary: "codex",
  ignoreUserConfig: true,
  maxOutputBytes: 1024,
};

const input: RuntimeTurnInput = {
  agentId: "builder-1",
  cwd: "/tmp/candidate",
  sandbox: "workspace-write",
  prompt: "secret prompt that must stay on stdin",
  threadId: undefined,
  model: undefined,
  outputSchemaPath: "/tmp/report.json",
  timeoutSeconds: 60,
};

describe("Codex runtime protocol", () => {
  it("builds a new scoped turn without putting the prompt in argv", () => {
    const args = buildCodexArgs(input, definition);
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
    expect(args).toContain("--cd");
    expect(args).not.toContain(input.prompt);
    expect(args.at(-1)).toBe("-");
  });

  it("resumes the immutable thread without trying to change cwd or sandbox", () => {
    const args = buildCodexArgs({ ...input, threadId: "thread-123" }, definition);
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("--cd");
    expect(args).not.toContain("--color");
    expect(args).toContain("thread-123");
  });

  it("extracts the thread, final report, raw events, and token usage", () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: '{"status":"completed"}' },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 3 },
        }),
      ].join("\n"),
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.finalText).toBe('{"status":"completed"}');
    expect(parsed.usage.totalTokens).toBe(15);
    expect(parsed.events).toHaveLength(3);
  });
});
