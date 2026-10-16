# Consuming Agent Blocks locally

Agent Blocks is an ESM-only workspace package. Consumers link a sibling checkout with
`workspace:*`.

## Linking

A consumer lists `../agent-blocks`, `../node-guardrails`, and `../ts-quality` in its own
`pnpm-workspace.yaml` (with `linkWorkspacePackages: true` and `sharedWorkspaceLockfile: false`); the
sibling layout is described in the catalog README.

Declare only the boundary the consumer needs:

```json
{
  "dependencies": {
    "@agentic-orch/agent-blocks": "workspace:*",
    "effect": "4.0.0-beta.98"
  }
}
```

`workspace:*` makes the local relationship explicit. A frozen install fails if the sibling is
missing or carries the wrong package name instead of downloading an unrelated registry package.

## Generic API

```ts
import { agentFromRuntime, defineAgent, defineAgentTemplate } from "@agentic-orch/agent-blocks";
```

Use the root for domain-neutral agent definitions and templates. It intentionally contains no
Codex, Git, reviewer, or candidate vocabulary.

## Scoped-worktree API

Applications that want the bundled coding workflow must opt into its subpaths:

```ts
import { Effect } from "effect";
import {
  loadWorkflow,
  runOrchestration,
} from "@agentic-orch/agent-blocks/templates/scoped-worktree";
import {
  listRuns,
  readRunEvents,
} from "@agentic-orch/agent-blocks/templates/scoped-worktree/control-plane";
import { readRunEventRecords } from "@agentic-orch/agent-blocks/persistence";
import { makeOpenCodeRuntime } from "@agentic-orch/agent-blocks/templates/scoped-worktree/adapters/opencode-cli";

const program = Effect.gen(function* () {
  const workflow = yield* loadWorkflow("workflow.yaml");
  const runtime = makeOpenCodeRuntime({ binary: "opencode", maxOutputBytes: 12 * 1024 * 1024 });
  return yield* runOrchestration({
    workflow,
    runtime,
    apply: false,
    keepWorktrees: false,
  });
});
```

`runOrchestration` defaults to the scoped-worktree Codex adapter. A trusted local application may
inject `makeOpenCodeRuntime({ binary, maxOutputBytes })` through the `runtime` option and must provide
an explicit qualified provider/model such as `zai-coding-plan/glm-5.2` in the workflow roles and
supervisor. The adapter uses OpenCode's existing authentication store without reading or copying its
credential. It isolates authored configuration and applies a deny-by-default workspace policy; that
policy is not a substitute for an OS sandbox or VM.

Network-facing integrations should prefer the redacted control-plane projection. The private
journal reader exposes raw trusted records and belongs only in trusted local code.

## Build

Package exports resolve to the compiled `dist/`. Both Agent Blocks and Node Guardrails declare a
`prepare` script, and pnpm runs workspace projects' `prepare` scripts in dependency order during
`pnpm install`, so a consumer's ordinary install produces both `dist/` trees. After editing Agent
Blocks sources, run `pnpm build` here to refresh the output a consumer sees.
