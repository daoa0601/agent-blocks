# Agent Blocks quality gates

This repository pins Node and pnpm in `package.json`. `@agentic-orch/node-guardrails` and
`@agentic-orch/ts-quality` are `workspace:*` dependencies resolved from `../node-guardrails` and
`../ts-quality` (see the catalog README for the layout). Neither local development nor CI falls back
to a registry package. The GitHub workflow checks both siblings out at their default branch;
`pnpm install` builds `node-guardrails` and this package through their `prepare` scripts.

```bash
pnpm install --frozen-lockfile
pnpm hooks:install
```

## Gate ladder

| Command                | Purpose                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| `pnpm quality:quick`   | Prettier, warning-free Oxlint, strict TypeScript, and secret scanning.       |
| `pnpm check`           | Quick gate plus deterministic unit and integration tests.                    |
| `pnpm quality:offline` | Quick gate, coverage, and production build.                                  |
| `pnpm deps:check`      | Production advisory and registry-signature checks; requires registry access. |
| `pnpm preflight`       | Complete offline and online handoff gate.                                    |

Coverage includes all `src/**/*.ts`: 70% statements, 55% branches, 70% functions, and 70% lines.
Tests use fake runtimes and temporary repositories.

## Shared policy

`@agentic-orch/ts-quality` supplies the secret scanner, hook templates, strict Node TypeScript
baseline, and Prettier defaults. Agent Blocks still owns its coverage floors, test selection, build,
public exports, and Effect peer contract.

The pnpm version is enforced natively by `packageManager`, `engines.pnpm`, and `pmOnFail: error`
with `engineStrict` in `pnpm-workspace.yaml`.

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
