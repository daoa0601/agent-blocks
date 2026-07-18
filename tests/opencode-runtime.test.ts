import { describe, expect, it } from "vitest";

import type { RuntimeTurnInput } from "../src/domain.js";
import {
  buildOpenCodeArgs,
  buildOpenCodeEnvironment,
  normalizeOpenCodeFinalText,
  openCodePermissions,
  parseOpenCodeJsonl,
  shouldRetryOpenCodeDatabaseLock,
} from "../src/opencode-runtime.js";

const input: RuntimeTurnInput = {
  agentId: "builder-1",
  cwd: "/tmp/candidate",
  sandbox: "workspace-write",
  prompt: "secret prompt that must stay on stdin",
  threadId: undefined,
  model: "zai-coding-plan/glm-5.2",
  outputSchemaPath: "/tmp/report.json",
  timeoutSeconds: 60,
};

describe("OpenCode runtime protocol", () => {
  it("keeps the prompt off argv and pins the provider/model", () => {
    const args = buildOpenCodeArgs(input);
    expect(args).toContain("zai-coding-plan/glm-5.2");
    expect(args).toContain("/tmp/candidate");
    expect(args).not.toContain(input.prompt);
    expect(args).not.toContain("--session");
  });

  it("resumes the same session and rejects an unqualified model", () => {
    expect(buildOpenCodeArgs({ ...input, threadId: "ses_123" })).toContain("ses_123");
    expect(() => buildOpenCodeArgs({ ...input, model: "glm-5.2" })).toThrow(/provider\/model/u);
  });

  it("applies deny-by-default permissions with scoped candidate edits", () => {
    const writable = openCodePermissions("workspace-write");
    expect(writable.external_directory).toBe("deny");
    expect(writable.webfetch).toBe("deny");
    expect(writable.task).toBe("deny");
    expect(writable.read).toMatchObject({ ".env": "deny", "credentials.json": "deny" });
    expect(writable.edit).toMatchObject({ "*": "allow", ".opencode/**": "deny" });
    expect(openCodePermissions("read-only").edit).toBe("deny");
  });

  it("isolates configuration, strips unrelated environment values, and repeats policy per agent", () => {
    const environment = buildOpenCodeEnvironment({
      sandbox: "read-only",
      isolatedConfigDirectory: "/tmp/isolated-config",
      base: { HOME: "/home/operator", PATH: "/bin", SECRET_TOKEN: "must-not-pass" },
    });
    expect(environment.SECRET_TOKEN).toBeUndefined();
    expect(environment.HOME).toBe("/home/operator");
    expect(environment.XDG_CONFIG_HOME).toBe("/tmp/isolated-config");
    const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT!) as {
      readonly share: string;
      readonly permission: Readonly<Record<string, unknown>>;
      readonly agent: {
        readonly build: { readonly permission: Readonly<Record<string, unknown>> };
      };
    };
    expect(config.share).toBe("disabled");
    expect(config.permission.external_directory).toBe("deny");
    expect(config.agent.build.permission.edit).toBe("deny");
  });

  it("extracts the final message, stable session, raw events, and fresh token usage", () => {
    const parsed = parseOpenCodeJsonl(
      [
        {
          type: "step_start",
          sessionID: "ses_123",
          part: { messageID: "msg_1", type: "step-start" },
        },
        {
          type: "text",
          sessionID: "ses_123",
          part: { messageID: "msg_1", text: '{"status":' },
        },
        {
          type: "text",
          sessionID: "ses_123",
          part: { messageID: "msg_1", text: '"completed"}' },
        },
        {
          type: "step_finish",
          sessionID: "ses_123",
          part: {
            messageID: "msg_1",
            tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4 } },
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    expect(parsed.threadId).toBe("ses_123");
    expect(parsed.finalText).toBe('{"status":"completed"}');
    expect(parsed.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 4,
      outputTokens: 5,
      totalTokens: 17,
    });
    expect(parsed.events).toHaveLength(4);
  });

  it("normalizes a prose-wrapped JSON value without accepting other extra fields", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string" } },
    };
    expect(
      normalizeOpenCodeFinalText(
        'I have finished.\n```json\n{"$schema":"https://json-schema.org/draft/2020-12/schema","status":"completed"}\n```',
        schema,
      ),
    ).toBe('{"status":"completed"}');
    expect(normalizeOpenCodeFinalText('{"status":"completed","unexpected":true}', schema)).toBe(
      '{"status":"completed","unexpected":true}',
    );
  });

  it("retries only an empty-output OpenCode startup database lock", () => {
    expect(
      shouldRetryOpenCodeDatabaseLock({
        exitCode: 1,
        stdout: "",
        stderr: "Unexpected error\n\ndatabase is locked\n",
      }),
    ).toBe(true);
    expect(
      shouldRetryOpenCodeDatabaseLock({
        exitCode: 1,
        stdout: '{"type":"text"}',
        stderr: "database is locked",
      }),
    ).toBe(false);
    expect(
      shouldRetryOpenCodeDatabaseLock({ exitCode: 1, stdout: "", stderr: "network failed" }),
    ).toBe(false);
  });
});
