# Consuming Agent Blocks locally

Agent Blocks is an ESM-only private workspace package. Consumers should use a sibling checkout and
`workspace:*`; there is no registry release sequence.

## Workspace layout

```text
agentic-orch/
├── agent-blocks/
├── consuming-project/
├── node-guardrails/
└── ts-quality/
```

Add the sibling to the consumer's `pnpm-workspace.yaml`:

```yaml
packages:
  - "."
  - "../agent-blocks"
  - "../node-guardrails"
  - "../ts-quality"

linkWorkspacePackages: true
sharedWorkspaceLockfile: false
```

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

const program = Effect.gen(function* () {
  const workflow = yield* loadWorkflow("workflow.yaml");
  return yield* runOrchestration({
    workflow,
    apply: false,
    keepWorktrees: false,
  });
});
```

Network-facing integrations should prefer the redacted control-plane projection. The private
journal reader exposes raw trusted records and belongs only in trusted local code.

## Validation

Build Agent Blocks before typechecking a consumer that resolves package exports from `dist/`:

```bash
cd ../agent-blocks
pnpm build
pnpm check

cd ../consuming-project
pnpm install --frozen-lockfile
pnpm check
```

`pnpm pack` smoke tests remain export-contract checks; they do not imply publication intent.
