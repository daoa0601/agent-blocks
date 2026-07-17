# Aiur Orchestrator

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm aiur doctor
```

## Architecture

This package is a deterministic TypeScript/Effect v4 harness around explicitly scoped Codex
subagents. Codex supplies authenticated model turns; it is not the source of truth for lifecycle,
scope, budgets, persistence, evaluation, or candidate selection.

Enforced scopes:

- `research` roles inspect the base Git workspace with a read-only sandbox.
- `candidate` roles write only in harness-created detached Git worktrees.
- `review` roles inspect exactly one candidate worktree with a read-only sandbox.
- A logical agent ID keeps one immutable role, workspace, and resumable Codex thread.

Core boundaries:

- `domain.ts` defines trusted schemas and state.
- `codex-runtime.ts` is the ChatGPT-subscription-backed process adapter.
- `orchestrator.ts` owns the bounded supervisor/worker/evaluator loop.
- `workspace.ts` owns Git worktree isolation and patch transport.
- `journal.ts` stores the append-only durable event stream.

## Conventions

- Use strict TypeScript and Effect for typed failures, resource scopes, cancellation, and concurrency.
- Never invoke user- or model-provided commands through a shell; always use argument arrays.
- Send prompts over stdin, never process arguments.
- Preserve raw Codex JSONL events in the run journal.
- Default to read-only and never use Codex's sandbox-bypass flags.
- Keep concurrency, turns, rounds, wall time, and optional token budgets hard-bounded.
- Never store or copy Codex/ChatGPT credentials. Reuse the local `codex` login.
- Tests use fake runtimes and must not consume ChatGPT subscription usage.
- Use the pinned pnpm version and keep `pnpm-lock.yaml` frozen in automation.
- Run `pnpm preflight` before handing off changes; see `QUALITY.md` for the gate contract.
