# Aiur Orchestrator

A personal TypeScript/Effect v4 harness for explicit, scoped subagent loops. Aiur owns the
control plane; the locally installed Codex CLI supplies model turns using your existing ChatGPT
login.

There is no API key, provider abstraction, or free-form nested delegation in the initial runtime.

## What it does

- Runs a resumable read-only supervisor loop with schema-constrained decisions.
- Allows the supervisor to instantiate only roles declared in workflow YAML.
- Pins every logical agent ID to one role, Codex thread, scope, and turn budget.
- Gives research agents the base repository read-only.
- Gives candidate agents separate detached Git worktrees with write access.
- Pins review agents read-only to one named candidate worktree.
- Executes independent assignments concurrently with an Effect semaphore and scoped fibers.
- Runs a deterministic evaluator after every candidate turn.
- Gives candidates the declared evaluator argv for local checks, then independently evaluates their
  snapshots in the harness.
- Rebuilds a bounded candidate-only trace for pinned read-only reviewers to audit and empirically
  rerun the declared evaluator.
- Stores normalized events, raw Codex JSONL, reports, evaluations, and binary-safe patches.
- Applies a selected patch only when `--apply` is explicit and the base repository is still clean.

## Requirements

- Node.js 22.22.2+, 24.15.0+, or 26+
- Git
- A recent `codex` CLI authenticated through ChatGPT

```bash
codex login
codex login status
```

The harness starts `codex exec --json` as a child process. Prompts go through stdin, and Codex
reuses its own saved authentication. The harness never reads, copies, or stores credentials.

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm aiur doctor --cwd /path/to/target-git-repo
cp examples/explicit-subagents.yaml my-workflow.yaml
# Edit workspace/objective/roles/evaluation first.
pnpm aiur run my-workflow.yaml
```

The default is safe comparison mode: candidate worktrees are cleaned after their patches are
captured, and the base repository is untouched.

```bash
# Retain candidate worktrees for manual inspection.
pnpm aiur run my-workflow.yaml --keep-worktrees

# Apply only the accepted patch; this refuses a dirty or changed base repository.
pnpm aiur run my-workflow.yaml --apply

# Inspect a completed run.
pnpm aiur inspect RUN_ID
```

Run artifacts live under `$AIUR_HOME/runs`, or `~/.aiur-orchestrator/runs` by default.

## Workflow shape

```yaml
version: 1
name: focused-change
objective: Add a validated feature without broad refactoring.
workspace: /absolute/path/to/a/git/repository

supervisor:
  instructions: Require evidence, a passing evaluation, and an independent review.

roles:
  - id: investigator
    kind: research
    description: Locates relevant code and constraints.
    instructions: Report evidence; never edit files.
    maxInstances: 1
    maxTurns: 2

  - id: implementer
    kind: candidate
    description: Owns one isolated implementation candidate.
    instructions: Make focused edits and verify them.
    maxInstances: 2
    maxTurns: 3

  - id: reviewer
    kind: review
    description: Reviews exactly one candidate read-only.
    instructions: Check correctness, scope, and regressions.
    maxInstances: 2
    maxTurns: 2

evaluation:
  command: ["pnpm", "test"]
  timeoutSeconds: 600

limits:
  maxRounds: 6
  maxConcurrentAgents: 2
  maxTotalAgents: 6
  maxTotalAgentTurns: 12
  maxWallClockSeconds: 1800
  turnTimeoutSeconds: 600
  maxTotalTokens: 120000
```

Paths are resolved relative to the workflow YAML. See [the workflow reference](docs/workflows.md)
and [architecture](docs/architecture.md) for the full contract.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm preflight
```

The enforced formatting, coverage, package, dependency, secret, and hook policies are documented in
[QUALITY.md](QUALITY.md).

Tests use a fake runtime and temporary Git repositories. They do not consume ChatGPT usage.

Effect v4 is currently a beta line, so the exact package version is pinned. Upgrade it
intentionally and rerun the complete check suite.

## Boundaries

This is a personal local harness, not a multi-tenant security boundary. Codex sandboxing limits
model-issued commands, while the configured deterministic evaluator is trusted local code. Run
archives may contain source snippets and command output; protect `$AIUR_HOME` accordingly. See
[security](docs/security.md).

Implementation references: [Effect v4](https://github.com/Effect-TS/effect-smol) and
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).
