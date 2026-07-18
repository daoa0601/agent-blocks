# Agent Blocks

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm agent-blocks scoped-worktree doctor
```

## Architecture

The root package is domain-neutral. `src/core.ts` defines generic agents, runtimes, templates, and
composition helpers. Do not add Codex, Git, candidate, reviewer, or evaluator semantics to the root
entrypoint.

The existing deterministic coding harness is the `scoped-worktree` template. Within that template:

- `domain.ts` defines trusted workflow schemas and state;
- `codex-runtime.ts` adapts the authenticated local Codex CLI;
- `orchestrator.ts` owns the bounded supervisor/worker/evaluator loop;
- `workspace.ts` owns Git worktree isolation and patch transport;
- `journal.ts` stores the append-only durable event stream.

Template scope rules remain strict: research roles are read-only, candidates write only in detached
worktrees, reviews inspect one candidate read-only, and an agent ID keeps one role, workspace, and
resumable thread.

## Conventions

- Use strict TypeScript and Effect for typed failures, scopes, cancellation, and concurrency.
- Keep reusable primitives domain-neutral; put opinionated behavior behind a named template or
  adapter subpath.
- Never invoke user- or model-provided commands through a shell; use argument arrays and stdin.
- Preserve raw Codex JSONL in the private run journal.
- Default to read-only and never use Codex sandbox-bypass flags.
- Hard-bound concurrency, turns, rounds, wall time, output, and optional token use.
- Never read or copy Codex/ChatGPT credentials; reuse the local `codex` login.
- Tests use fake runtimes and must not consume ChatGPT usage.
- Keep local dependencies on `workspace:*`; this package is private and is not published.
- Use the pinned toolchain and run `pnpm preflight` before handoff.
