# Security model

This prototype is intended for one trusted user on one local machine. It is not a containment
boundary for hostile tenants or hostile evaluator configuration.

## Enforced by the harness

- Model prompts are written to child-process stdin, not argv.
- Codex is never started with sandbox-bypass or approval-bypass flags.
- Base and review threads use `read-only`; candidates use `workspace-write` only in isolated Git
  worktrees.
- Role, workspace, and review-target bindings are immutable after an agent's first turn.
- The supervisor can select only configured roles and cannot supply executable evaluator commands.
- Child-process commands use argv arrays with `shell: false`.
- Concurrency, rounds, agents, turns, time, output bytes, and optional tokens are bounded.
- Candidate application is explicit and guarded by HEAD, cleanliness, and `git apply --check`.
- Credentials remain owned by the Codex CLI. The harness records only thread IDs and events.
- Caller-supplied run IDs use a bounded safe syntax and exclusive allocation; an existing run
  directory is never silently reused.
- Public run queries replay validated journal records and exclude raw Codex events while recursively
  removing prompts, thread/session IDs, absolute host paths, worktree locations, evaluator output,
  and other private transport fields.
- Candidate prompts reserve `.harness-audit/`; candidate turns start with an empty harness-created
  directory and fail if they track, replace, remove, or populate it. Patch capture excludes it again
  as defense in depth.
- Review bundles are rebuilt from candidate-scoped harness state immediately before pinned read-only
  review, capped at 1 MiB with explicit truncation records, and excluded from public projections and
  downloadable patch artifacts.

## Trusted inputs

The workflow author controls the evaluator argv, workspace path, Codex binary path, role prompts,
and whether user Codex configuration is enabled. A malicious workflow author already has local
code-execution authority through the evaluator.

Project instructions inside the target repository may influence Codex. The harness scope and
budgets remain authoritative even when instructions conflict.

## Sensitive artifacts

Raw Codex events, agent reports, evaluator output, and patches may contain proprietary source,
paths, or secrets already present in command output. Keep `$AIUR_HOME` private and apply your own
retention policy. Do not publish run archives automatically.

Candidate audit bundles are trusted-role inputs with the same sensitivity as the private journal.
Although their ephemeral worktree copy disappears with normal worktree cleanup, retained worktrees
keep it for local inspection. Never expose `.harness-audit/trace.jsonl` through a public file server.

Content-addressed patch storage provides immutable identity, not confidentiality or authorization.
The local public projection reports only artifact descriptors and exposes no path-based artifact
serving API. A future server that serves artifact bytes must resolve journal-published opaque IDs,
stay beneath the artifact directory, verify file type/size/digest, and authorize every read.

The root package retains broad low-level exports for compatibility, including trusted journal and
workspace primitives. Network-facing code should depend on the narrow `control-plane` subpath for
read-only projections and keep authentication/authorization outside browser-controlled input.

## Known prototype limitations

- Filesystem isolation relies on Codex's local sandbox and Git worktrees, not a VM or container.
- Network policy is whatever the selected Codex sandbox/runtime provides.
- Codex stores its resumable sessions in its own local state in addition to the harness journal.
- A force-killed process may leave tool-specific child processes if that tool ignores process
  termination; run inside a stronger external sandbox for hostile workloads.
- Journal serialization and active-run ownership are single-process. Cooperative Effect interruption
  writes a terminal interruption record, but `SIGKILL`, power loss, or storage failure can leave a
  queued/running orphan until a future lease-based recovery mechanism exists. Runs are never resumed
  from Codex prose or session state.
- There is no encrypted journal, multi-user authorization, remote worker protocol, or secret
  redaction guarantee for model-authored reports, evaluator output, or patch contents.
