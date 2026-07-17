import { Schema, SchemaParser } from "effect";

export const RoleKindSchema = Schema.Literals(["research", "candidate", "review"]);
export type RoleKind = typeof RoleKindSchema.Type;

const RoleInputSchema = Schema.Struct({
  id: Schema.String,
  kind: RoleKindSchema,
  description: Schema.String,
  instructions: Schema.String,
  maxInstances: Schema.optionalKey(Schema.Number),
  maxTurns: Schema.optionalKey(Schema.Number),
  model: Schema.optionalKey(Schema.String),
});

const SupervisorInputSchema = Schema.Struct({
  instructions: Schema.String,
  model: Schema.optionalKey(Schema.String),
});

const LimitsInputSchema = Schema.Struct({
  maxRounds: Schema.optionalKey(Schema.Number),
  maxConcurrentAgents: Schema.optionalKey(Schema.Number),
  maxTotalAgents: Schema.optionalKey(Schema.Number),
  maxTotalAgentTurns: Schema.optionalKey(Schema.Number),
  maxWallClockSeconds: Schema.optionalKey(Schema.Number),
  turnTimeoutSeconds: Schema.optionalKey(Schema.Number),
  maxTotalTokens: Schema.optionalKey(Schema.Number),
});

const EvaluationInputSchema = Schema.Struct({
  command: Schema.Array(Schema.String),
  timeoutSeconds: Schema.optionalKey(Schema.Number),
});

const CodexInputSchema = Schema.Struct({
  binary: Schema.optionalKey(Schema.String),
  ignoreUserConfig: Schema.optionalKey(Schema.Boolean),
  maxOutputBytes: Schema.optionalKey(Schema.Number),
});

export const WorkflowInputSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String,
  objective: Schema.String,
  workspace: Schema.String,
  allowDirtyWorkspace: Schema.optionalKey(Schema.Boolean),
  supervisor: SupervisorInputSchema,
  roles: Schema.Array(RoleInputSchema),
  limits: Schema.optionalKey(LimitsInputSchema),
  evaluation: Schema.optionalKey(EvaluationInputSchema),
  codex: Schema.optionalKey(CodexInputSchema),
});

export type WorkflowInput = typeof WorkflowInputSchema.Type;

export interface RoleDefinition {
  readonly id: string;
  readonly kind: RoleKind;
  readonly description: string;
  readonly instructions: string;
  readonly maxInstances: number;
  readonly maxTurns: number;
  readonly model: string | undefined;
}

export interface HarnessLimits {
  readonly maxRounds: number;
  readonly maxConcurrentAgents: number;
  readonly maxTotalAgents: number;
  readonly maxTotalAgentTurns: number;
  readonly maxWallClockSeconds: number;
  readonly turnTimeoutSeconds: number;
  readonly maxTotalTokens: number | undefined;
}

export interface EvaluationDefinition {
  readonly command: ReadonlyArray<string>;
  readonly timeoutSeconds: number;
}

export interface CodexDefinition {
  readonly binary: string;
  readonly ignoreUserConfig: boolean;
  readonly maxOutputBytes: number;
}

export interface WorkflowDefinition {
  readonly version: 1;
  readonly name: string;
  readonly objective: string;
  readonly configPath: string;
  readonly workspace: string;
  readonly allowDirtyWorkspace: boolean;
  readonly supervisor: {
    readonly instructions: string;
    readonly model: string | undefined;
  };
  readonly roles: ReadonlyArray<RoleDefinition>;
  readonly limits: HarnessLimits;
  readonly evaluation: EvaluationDefinition | undefined;
  readonly codex: CodexDefinition;
}

export const AssignmentSchema = Schema.Struct({
  agentId: Schema.String,
  roleId: Schema.String,
  task: Schema.String,
  targetCandidateId: Schema.NullOr(Schema.String),
});

export const SupervisorDecisionSchema = Schema.Struct({
  status: Schema.Literals(["continue", "accept", "stop"]),
  summary: Schema.String,
  assignments: Schema.Array(AssignmentSchema),
  selectedCandidateId: Schema.NullOr(Schema.String),
});

export type Assignment = typeof AssignmentSchema.Type;
export type SupervisorDecision = typeof SupervisorDecisionSchema.Type;

export const AgentReportSchema = Schema.Struct({
  status: Schema.Literals(["completed", "blocked", "failed"]),
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  nextSteps: Schema.Array(Schema.String),
});

export type AgentReport = typeof AgentReportSchema.Type;

export const SUPERVISOR_OUTPUT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "assignments", "selectedCandidateId"],
  properties: {
    status: { type: "string", enum: ["continue", "accept", "stop"] },
    summary: { type: "string" },
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "roleId", "task", "targetCandidateId"],
        properties: {
          agentId: { type: "string" },
          roleId: { type: "string" },
          task: { type: "string" },
          targetCandidateId: { type: ["string", "null"] },
        },
      },
    },
    selectedCandidateId: { type: ["string", "null"] },
  },
} as const;

export const AGENT_REPORT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "evidence", "risks", "nextSteps"],
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
} as const;

const strictDecodeOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

export const decodeWorkflowInput = SchemaParser.decodeUnknownSync(
  WorkflowInputSchema,
  strictDecodeOptions,
);

export const decodeSupervisorDecision = SchemaParser.decodeUnknownSync(
  SupervisorDecisionSchema,
  strictDecodeOptions,
);

export const decodeAgentReport = SchemaParser.decodeUnknownSync(
  AgentReportSchema,
  strictDecodeOptions,
);

export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface RuntimeTurnInput {
  readonly agentId: string;
  readonly cwd: string;
  readonly sandbox: "read-only" | "workspace-write";
  readonly prompt: string;
  readonly threadId: string | undefined;
  readonly model: string | undefined;
  readonly outputSchemaPath: string;
  readonly timeoutSeconds: number;
}

export interface RuntimeTurnResult {
  readonly threadId: string;
  readonly finalText: string;
  readonly usage: TokenUsage;
  readonly events: ReadonlyArray<unknown>;
}

export interface EvaluationResult {
  readonly candidateId: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface AgentObservation {
  readonly agentId: string;
  readonly roleId: string;
  readonly roleKind: RoleKind;
  readonly turn: number;
  readonly report: AgentReport | undefined;
  readonly runtimeError: string | undefined;
  readonly candidateId: string | undefined;
  readonly targetCandidateId: string | undefined;
}

export interface CandidateSnapshot {
  readonly candidateId: string;
  readonly diffStat: string;
  readonly patchPath: string;
  readonly retainedWorktree: string | undefined;
  readonly evaluation: EvaluationResult | undefined;
  readonly artifactId?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly workflow: string;
  readonly objective: string;
  readonly status: "accepted" | "stopped" | "budget_exhausted";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly rounds: number;
  readonly agentTurns: number;
  readonly totalAgents: number;
  readonly totalTokens: number;
  readonly selectedCandidateId: string | undefined;
  readonly applied: boolean;
  readonly runDirectory: string;
  readonly candidates: ReadonlyArray<CandidateSnapshot>;
}
