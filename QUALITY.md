# Agent Blocks quality gates

This repository pins Node and pnpm in `package.json`. Use the coordinated sibling layout described
in the README: `@agentic-orch/node-guardrails` and `@agentic-orch/ts-quality` are private
`workspace:*` dependencies resolved from `../node-guardrails` and `../ts-quality`.

The checked-in GitHub workflow cannot recreate those unhosted sibling directories from an Agent
Blocks checkout alone. It is retained as future automation structure, but the coordinated local
checkout and the commands below are the current validation source of truth.

```bash
pnpm install --frozen-lockfile
pnpm hooks:install
```

## Gate ladder

| Command                | Purpose                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `pnpm quality:quick`   | Prettier, warning-free Oxlint, strict TypeScript, and secret scanning.       |
| `pnpm check`           | Quick gate plus deterministic unit and integration tests.                    |
| `pnpm quality:offline` | Quick gate, coverage, production build, and local package-boundary checks.   |
| `pnpm deps:check`      | Production advisory and registry-signature checks; requires registry access. |
| `pnpm preflight`       | Complete offline and online handoff gate.                                    |

The packaging gate checks the private module's executable, declarations, and subpath exports. It is
kept because consumers resolve those exact boundaries locally, not because the package is intended
for a registry.

Coverage includes all `src/**/*.ts`: 70% statements, 55% branches, 70% functions, and 70% lines.
Tests use fake runtimes and temporary repositories.

## Shared policy

`@agentic-orch/ts-quality` supplies the secret scanner, package-boundary inspection, hook templates,
strict Node TypeScript baseline, and Prettier defaults. Agent Blocks still owns its coverage floors,
test selection, build, public exports, and Effect peer contract.

The small `scripts/quality/require-pnpm.mjs` guard remains local because development dependencies
are unavailable when a clean install enters `preinstall`.

## Dependency policy

`pnpm-workspace.yaml` enforces exact external dependency saves, engine and peer compatibility,
frozen automation installs, a 24-hour release-age floor for third-party packages, rejection of
transitive Git/tarball dependencies, and explicit lifecycle-script review. The release-age policy
does not apply to the local `workspace:*` modules.

## Secret scan scope

The shared scanner examines staged blobs, current working-tree copies, and unignored untracked files
for secret-bearing filenames, private keys, common token formats, and non-placeholder assignments.
It bounds reads, never follows symlinks, and reports escaped file/line metadata without echoing the
matched value.
