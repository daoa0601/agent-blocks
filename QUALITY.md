# Aiur Orchestrator quality gates

This repository uses pnpm 11.13.1 exclusively. The exact version is pinned in `package.json`; installs made with npm, Yarn, Bun, or a different pnpm version fail at the repository boundary.

## Setup

```bash
pnpm --version
pnpm install --frozen-lockfile
pnpm hooks:install
```

Use a supported Node.js release from `package.json`. CI and clean-room verification must always use `pnpm install --frozen-lockfile`.

## Gate ladder

| Command                | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm quality:quick`   | Prettier check, warning-free Oxlint, strict TypeScript, and repository secret scan.                       |
| `pnpm check`           | Quick gate plus the deterministic unit/integration test suite.                                            |
| `pnpm quality:offline` | Quick gate, coverage thresholds, production build, and dry-run package manifest inspection.               |
| `pnpm deps:check`      | Production advisory audit at high severity and registry-signature verification. Requires registry access. |
| `pnpm preflight`       | Complete offline and online gate; this is the handoff/release command.                                    |

Coverage is measured over all `src/**/*.ts` files, including currently untested entrypoints. The enforced global floor is 70% statements, 55% branches, 70% functions, and 70% lines. Raising a floor is welcome; lowering one requires an explicit rationale.

`pnpm hooks:install` configures this checkout to use the committed hooks:

- pre-commit runs `pnpm quality:quick`;
- pre-push runs `pnpm quality:offline`.

The hooks are a fast local feedback layer, not the source of truth. Automation should repeat the frozen install and `pnpm preflight`.

## Dependency and supply-chain policy

`pnpm-workspace.yaml` enforces:

- exact dependency saves and an exact pnpm version;
- Node engine and peer-dependency compatibility;
- frozen lockfiles in CI;
- a strict 24-hour minimum package release age;
- rejection of transitive Git/tarball dependencies;
- explicit review of every dependency lifecycle script;
- dependency-state verification before scripts run.

Only `esbuild` is approved to execute a third-party install script. Optional native acceleration from `msgpackr-extract` is explicitly denied. Any new lifecycle script makes installation fail until it is reviewed and recorded in `allowBuilds`.

## Secret scan scope

The local scanner examines tracked and unignored files for secret-bearing filenames, private keys, common provider token formats, and non-placeholder secret assignments in configuration files. It reports only file and line metadata, never the matched value. This supplements host and repository secret-scanning controls; it does not replace them.
