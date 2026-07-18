# Agent Blocks

Unpublished TypeScript/Effect building blocks for composing agents, runtime adapters, persistence, and
opinionated orchestrator templates. The package root is deliberately small and domain-neutral;
Git, Codex, evaluator, and candidate-selection behavior lives under the `scoped-worktree`
template.

This repository is a local workspace module. It is not intended for npm publication.

## Public boundaries

| Import                                                                       | Owns                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@agentic-orch/agent-blocks`                                                 | Generic agents, templates, members, teams, organizations, and composition helpers.                 |
| `@agentic-orch/agent-blocks/persistence`                                     | Validated append-only run journals and safe run IDs.                                               |
| `@agentic-orch/agent-blocks/templates/scoped-worktree`                       | The existing bounded supervisor, Codex runtime, Git worktrees, evaluation, and selection workflow. |
| `@agentic-orch/agent-blocks/templates/scoped-worktree/control-plane`         | Redacted queries over scoped-worktree run state and events.                                        |
| `@agentic-orch/agent-blocks/templates/scoped-worktree/adapters/codex-cli`    | The Codex CLI adapter used by that template.                                                       |
| `@agentic-orch/agent-blocks/templates/scoped-worktree/adapters/opencode-cli` | A deny-by-default OpenCode CLI adapter for explicit provider/model runtimes.                       |

The root does not export scoped-worktree types. Consumers must opt into that template explicitly,
which prevents a generic research agent from accidentally inheriting Git-worktree or candidate
semantics.

## Generic building blocks

```ts
import { Effect } from "effect";
import { defineAgentTemplate, instantiateTemplate } from "@agentic-orch/agent-blocks";

const multiplier = defineAgentTemplate({
  id: "multiplier",
  create: (factor: number) => ({
    id: `multiply-by-${factor}`,
    run: (input: number, context) =>
      context.emit({ type: "number.multiplied", factor }).pipe(Effect.as(input * factor)),
  }),
});

const triple = instantiateTemplate(multiplier, 3);
```

An orchestrator supplies the `AgentContext`, owns scheduling and policy, and decides how emitted
events are persisted. Templates are ordinary factories, so projects can start from a local recipe
and extend it without modifying this package.

### Members, teams, and organizations

Agent Blocks also provides a domain-neutral ownership hierarchy for larger systems. A block belongs
to one explicit member, a member belongs to one team, and teams form an organization. Domain
packages decide what those names mean; Agent Blocks only validates unambiguous ownership.

```ts
import {
  agentBlockAssignments,
  defineAgentMember,
  defineAgentOrganization,
  defineAgentTeam,
} from "@agentic-orch/agent-blocks";

const security = defineAgentOrganization({
  id: "security",
  teams: [
    defineAgentTeam({
      id: "review",
      members: [
        defineAgentMember({
          id: "evidence-specialist",
          blocks: [{ id: "collect-evidence" }],
        }),
      ],
    }),
  ],
});

const assignments = agentBlockAssignments(security);
```

Block IDs are unique across an organization, member IDs are unique within a team, and team IDs are
unique within the organization. The returned roster snapshots its arrays so later configuration
mutation cannot silently change ownership.

## Scoped-worktree template

The included template retains the original, security-conscious coding workflow:

- a schema-constrained, resumable supervisor can instantiate only declared roles;
- research agents inspect the base repository read-only;
- candidate agents edit separate detached Git worktrees;
- reviewers are pinned read-only to one candidate;
- concurrency, turns, rounds, wall time, output, and optional token use are bounded;
- a trusted local evaluator runs independently of candidate claims;
- normalized events, raw runtime events, reports, evaluations, and binary-safe patches are durable;
- a selected patch reaches the base repository only when `--apply` is explicit and the base is
  still clean.

The Codex adapter uses the locally authenticated Codex CLI. Prompts travel over stdin and this
package never reads, copies, or stores ChatGPT credentials.

The optional OpenCode adapter is programmatic rather than a workflow-YAML setting. It requires an
explicit qualified provider/model ID, uses OpenCode's existing local provider authentication, and
does not read or copy that credential. It isolates authored configuration, disables sharing and
ambient plugins, strips unrelated environment values, and supplies a deny-by-default tool policy.
Read-only turns can inspect/search the assigned workspace except common environment, credential,
private-key, and OpenCode configuration files; writable turns may edit only inside the candidate
worktree and run a very small fixed command allowlist. Web access, subagents, skills, LSP, questions,
and external-directory access are denied. Raw events and non-secret runtime metadata are retained in
the private journal.

These are OpenCode application permissions, not an OS containment boundary. Use an independently
enforced sandbox, container, or VM whenever the workspace itself may contain hostile executable
content.

### Local checkout

Keep the unpublished dependencies as siblings:

```text
agentic-orch/
├── agent-blocks/
├── node-guardrails/
└── ts-quality/
```

Then use the repository-pinned Node and pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm agent-blocks scoped-worktree doctor --cwd /path/to/target-git-repo
cp examples/explicit-subagents.yaml my-workflow.yaml
pnpm agent-blocks scoped-worktree run my-workflow.yaml
```

The manifest uses `workspace:*`, and the lockfile records explicit `link:../...` resolutions. A
missing sibling is therefore an installation error, not a silent registry fallback.

```bash
# Retain candidate worktrees for manual inspection.
pnpm agent-blocks scoped-worktree run my-workflow.yaml --keep-worktrees

# Apply only the accepted patch.
pnpm agent-blocks scoped-worktree run my-workflow.yaml --apply

# Inspect a completed run.
pnpm agent-blocks scoped-worktree inspect RUN_ID
```

Run artifacts live under `$AGENT_BLOCKS_HOME/runs`, or `~/.agent-blocks/runs` by default.

See [the workflow reference](docs/workflows.md), [architecture](docs/architecture.md), and
[consumer guide](docs/consuming.md) for the detailed contracts.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm preflight
```

Tests use fake runtimes and temporary Git repositories; they do not consume ChatGPT usage. Effect
is an exact peer because its types occur in the public API. The local packaging check remains useful
as an export-boundary test even though the module is not published.

## Security boundary

The scoped-worktree template is a personal local harness, not a multi-tenant containment boundary.
The configured evaluator is trusted local code, and run archives can contain source snippets and
command output. On POSIX, cancellation targets an isolated child process group; portable Windows
cleanup cannot guarantee descendant termination. Put hostile workloads behind an independently
enforced OS sandbox, container, or VM. See [security](docs/security.md).
