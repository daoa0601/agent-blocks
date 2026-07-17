import { readFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { parse as parseYaml } from "yaml";

import type {
  CodexDefinition,
  EvaluationDefinition,
  HarnessLimits,
  RoleDefinition,
  WorkflowDefinition,
  WorkflowInput,
} from "./domain.js";
import { decodeWorkflowInput } from "./domain.js";
import { ConfigError, errorMessage } from "./errors.js";

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return trimmed;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, value, label);
}

function normalizeRole(input: WorkflowInput["roles"][number], index: number): RoleDefinition {
  const prefix = `roles[${index}]`;
  const id = nonEmpty(input.id, `${prefix}.id`);
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) {
    throw new Error(`${prefix}.id must match ^[a-z][a-z0-9_-]{0,63}$`);
  }
  return {
    id,
    kind: input.kind,
    description: nonEmpty(input.description, `${prefix}.description`),
    instructions: nonEmpty(input.instructions, `${prefix}.instructions`),
    maxInstances: positiveInteger(input.maxInstances, 1, `${prefix}.maxInstances`),
    maxTurns: positiveInteger(input.maxTurns, 2, `${prefix}.maxTurns`),
    model: input.model === undefined ? undefined : nonEmpty(input.model, `${prefix}.model`),
  };
}

function normalizeLimits(input: WorkflowInput["limits"]): HarnessLimits {
  return {
    maxRounds: positiveInteger(input?.maxRounds, 4, "limits.maxRounds"),
    maxConcurrentAgents: positiveInteger(
      input?.maxConcurrentAgents,
      2,
      "limits.maxConcurrentAgents",
    ),
    maxTotalAgents: positiveInteger(input?.maxTotalAgents, 8, "limits.maxTotalAgents"),
    maxTotalAgentTurns: positiveInteger(input?.maxTotalAgentTurns, 16, "limits.maxTotalAgentTurns"),
    maxWallClockSeconds: positiveInteger(
      input?.maxWallClockSeconds,
      1_800,
      "limits.maxWallClockSeconds",
    ),
    turnTimeoutSeconds: positiveInteger(
      input?.turnTimeoutSeconds,
      600,
      "limits.turnTimeoutSeconds",
    ),
    maxTotalTokens: optionalPositiveInteger(input?.maxTotalTokens, "limits.maxTotalTokens"),
  };
}

function normalizeEvaluation(input: WorkflowInput["evaluation"]): EvaluationDefinition | undefined {
  if (input === undefined) return undefined;
  if (input.command.length === 0) {
    throw new Error("evaluation.command must contain an executable");
  }
  return {
    command: input.command.map((part, index) => nonEmpty(part, `evaluation.command[${index}]`)),
    timeoutSeconds: positiveInteger(input.timeoutSeconds, 600, "evaluation.timeoutSeconds"),
  };
}

function normalizeCodex(input: WorkflowInput["codex"]): CodexDefinition {
  return {
    binary: input?.binary === undefined ? "codex" : nonEmpty(input.binary, "codex.binary"),
    ignoreUserConfig: input?.ignoreUserConfig ?? true,
    maxOutputBytes: positiveInteger(
      input?.maxOutputBytes,
      20 * 1024 * 1024,
      "codex.maxOutputBytes",
    ),
  };
}

function normalize(input: WorkflowInput, configPath: string): WorkflowDefinition {
  const roles = input.roles.map(normalizeRole);
  if (roles.length === 0) {
    throw new Error("roles must contain at least one explicit role");
  }
  const roleIds = new Set<string>();
  for (const role of roles) {
    if (roleIds.has(role.id)) {
      throw new Error(`Duplicate role id: ${role.id}`);
    }
    roleIds.add(role.id);
  }
  if (!roles.some((role) => role.kind === "candidate")) {
    throw new Error("At least one candidate role is required");
  }

  return {
    version: 1,
    name: nonEmpty(input.name, "name"),
    objective: nonEmpty(input.objective, "objective"),
    configPath,
    workspace: path.resolve(path.dirname(configPath), input.workspace),
    allowDirtyWorkspace: input.allowDirtyWorkspace ?? false,
    supervisor: {
      instructions: nonEmpty(input.supervisor.instructions, "supervisor.instructions"),
      model:
        input.supervisor.model === undefined
          ? undefined
          : nonEmpty(input.supervisor.model, "supervisor.model"),
    },
    roles,
    limits: normalizeLimits(input.limits),
    evaluation: normalizeEvaluation(input.evaluation),
    codex: normalizeCodex(input.codex),
  };
}

export function loadWorkflow(workflowPath: string): Effect.Effect<WorkflowDefinition, ConfigError> {
  const absolutePath = path.resolve(workflowPath);
  return Effect.tryPromise({
    try: async () => {
      const source = await readFile(absolutePath, "utf8");
      const input = decodeWorkflowInput(parseYaml(source));
      return normalize(input, absolutePath);
    },
    catch: (cause) =>
      new ConfigError({
        message: `Invalid workflow ${absolutePath}: ${errorMessage(cause)}`,
        cause,
      }),
  });
}
