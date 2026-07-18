# Workflow reference

Workflow files are strict YAML. Unknown fields are rejected, and relative paths resolve from the
workflow file's directory.

## Top level

| Field                 | Required | Meaning                                                                                           |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `version`             | yes      | Must be `1`.                                                                                      |
| `name`                | yes      | Human-readable run name.                                                                          |
| `objective`           | yes      | Stable objective visible to every agent.                                                          |
| `workspace`           | yes      | A Git repository or path inside one.                                                              |
| `allowDirtyWorkspace` | no       | Allows comparison runs from a dirty base; default `false`. `--apply` still requires a clean base. |
| `supervisor`          | yes      | Supervisor instructions and optional Codex model.                                                 |
| `roles`               | yes      | Explicit role catalog; at least one `candidate` role is required.                                 |
| `evaluation`          | no       | Trusted argv command run in touched candidate worktrees.                                          |
| `limits`              | no       | Hard run budgets.                                                                                 |
| `codex`               | no       | Local Codex adapter settings.                                                                     |

## Role kinds

| Kind        | Workspace              | Sandbox           | Target rule                                         |
| ----------- | ---------------------- | ----------------- | --------------------------------------------------- |
| `research`  | Base repository        | `read-only`       | `targetCandidateId` must be null.                   |
| `candidate` | Own detached worktree  | `workspace-write` | Candidate ID equals `agentId`; target must be null. |
| `review`    | One candidate worktree | `read-only`       | A known candidate ID is required and immutable.     |

Every role has `id`, `kind`, `description`, and `instructions`. Optional fields are:

- `maxInstances` — default `1`;
- `maxTurns` — default `2` per logical agent;
- `model` — an explicit runtime model override.

Role and agent IDs are separate. For example, role `implementer` may have candidate agents
`candidate-a` and `candidate-b` when `maxInstances` permits two.

## Limits

| Field                 | Default | Counted unit                                                                                                                                                               |
| --------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRounds`           |       4 | Supervisor decisions.                                                                                                                                                      |
| `maxConcurrentAgents` |       2 | Simultaneous worker child processes.                                                                                                                                       |
| `maxTotalAgents`      |       8 | Unique worker `agentId` values.                                                                                                                                            |
| `maxTotalAgentTurns`  |      16 | Worker turns, including failed attempts.                                                                                                                                   |
| `maxWallClockSeconds` |    1800 | Entire supervisor loop.                                                                                                                                                    |
| `turnTimeoutSeconds`  |     600 | One supervisor or worker runtime invocation.                                                                                                                               |
| `maxTotalTokens`      |   unset | Non-cached input plus output tokens across supervisor and workers. Raw and cached counts remain in runtime events; turn and wall-clock caps still bound cached tool loops. |

No prompt or model decision can change these limits.

## Evaluation

`evaluation.command` is an argv array, never a shell string:

```yaml
evaluation:
  command: ["pnpm", "test", "--", "--runInBand"]
  timeoutSeconds: 600
```

The evaluator receives `HARNESS_CANDIDATE_ID` and `CI=1` (unless `CI` is already set). Exit code
zero passes. Stdout and stderr tails are included in supervisor evidence and the durable run
summary.

Candidate prompts receive the exact configured argv for local checks, but the harness still runs its
own evaluation after every touched snapshot. A pinned review prompt receives the same argv plus the
trusted `.harness-audit/trace.jsonl` location and must rerun the evaluator independently. If the
bounded trace reports truncation, the reviewer must mark its audit coverage as degraded.

The evaluator is configuration supplied by you, not by the model. Treat it as trusted code.

## Codex adapter

```yaml
codex:
  binary: codex
  ignoreUserConfig: true
  maxOutputBytes: 20971520
```

`ignoreUserConfig: true` is the deterministic default. Codex still uses its local authentication,
but unrelated user configuration is not layered into agent runs. Set it to `false` intentionally if
you need your configured model/provider/features.

## OpenCode adapter

OpenCode is an explicit programmatic runtime, not a workflow-YAML field:

```ts
import { makeOpenCodeRuntime } from "@agentic-orch/agent-blocks/templates/scoped-worktree/adapters/opencode-cli";

const runtime = makeOpenCodeRuntime({
  binary: "opencode",
  maxOutputBytes: 12 * 1024 * 1024,
});
```

Pass `runtime` to `runOrchestration` and use qualified `provider/model` values in supervisor and role
definitions. The adapter keeps prompts off argv, uses the provider login already owned by OpenCode,
isolates authored configuration, disables ambient plugins and sharing, and applies a deny-by-default
workspace tool policy. It records non-secret adapter/model/sandbox metadata and raw runtime events in
the private journal. An empty-output startup `database is locked` failure may be retried twice; a
partially generated turn is never retried.

OpenCode permissions are an application-level boundary. Place hostile inputs behind an independent
OS sandbox, container, or VM, and enforce network policy outside the model CLI.
