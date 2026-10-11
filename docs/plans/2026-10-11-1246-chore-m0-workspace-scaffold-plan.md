---
title: Milestone 0 Workspace Scaffold - Plan
type: chore
date: 2026-10-11
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Milestone 0 Workspace Scaffold - Plan

## Goal Capsule

- **Objective:** A contributor (human or agent) can clone agentroom, run one install, and get a green build, typecheck, lint, and test across every package locally (including one run under Node 20), with a CI workflow that replays the same gates on Node 20 and 22 once a human pushes the repo, so Milestone 1 starts on a working toolchain instead of building one.
- **Means:** pnpm workspace with four skeleton packages sharing one TypeScript base config, Biome, vitest, and tsup, plus a GitHub Actions matrix (KTD1-KTD9).
- **Authority:** `CLAUDE.md` invariants and stack conventions, then `docs/PLAN.md` Milestone 0, then this plan. `docs/OPEN_QUESTIONS.md` items 1, 2, 3 and 15 are settled inputs.
- **Stop conditions:** Stop and report if a pinned tool cannot run on Node 20 (for example a dependency whose `engines` excludes Node 20), or if `pnpm install --frozen-lockfile` cannot be made to pass on a clean checkout.
- **Execution profile:** Configuration and packaging only. No protocol, relay, MCP, or CLI behavior.
- **Who finishes:** The implementing agent builds and verifies locally. The orchestrator ticks the Milestone 0 boxes in `docs/PLAN.md`; this work does not edit that file. Pushing and watching CI run on GitHub is a human step (no GitHub repo exists yet).

---

## Product Contract

### Summary

Scaffold the agentroom monorepo: root workspace and toolchain config, four buildable and tested skeleton packages (`protocol`, `relay-node`, `mcp`, `cli`), an Apache-2.0 license, and a CI workflow. Each package exports one real constant with a real test. Milestone 1 adds behavior.

### Problem Frame

The repo holds only design docs. `CLAUDE.md` fixes the stack (TypeScript strict, ES modules, pnpm workspaces, zod, the MCP SDK v2, ws, libsodium-wrappers, vitest, tsup, one lint tool) and requires every package to have tests and `pnpm -r test` to pass before any milestone is done. Milestone 1 then lands crypto, a relay, an MCP server, and a CLI at once. If the toolchain is assembled during Milestone 1, toolchain failures and product failures arrive together and are hard to separate. Milestone 0 isolates the toolchain so its acceptance (`pnpm -r build && pnpm -r test` green locally and in CI) proves the base before product code exists.

### Requirements

**Workspace and packages**

- R1. A pnpm workspace contains exactly four packages under `packages/`: `protocol`, `relay-node`, `mcp`, `cli`. `relay-cf` is not scaffolded (Milestone 4).
- R2. npm names are `agentroom` (the `cli` package, so `npx agentroom` resolves to it later), `@agentroom/protocol`, `@agentroom/relay-node`, `@agentroom/mcp`.
- R3. Every package is TypeScript with `strict: true`, ES modules (`"type": "module"`), `NodeNext` resolution, and a Node 20+ target.
- R4. Each package exports one real constant from `src/index.ts` and has at least one unit test that checks it. No test asserts a tautology.

**Toolchain and scripts**

- R5. Root scripts `build`, `test`, `typecheck`, `lint`, `format` exist. `pnpm -r build && pnpm -r test`, `pnpm typecheck`, and `pnpm lint` all pass on a clean checkout after `pnpm install`.
- R6. One lint and format tool (Biome) covers the repo.
- R7. Runtime dependencies are declared in the package whose code imports them, and only once such code exists; Milestone 0 packages import nothing, so they declare no runtime dependencies. Shared toolchain devDependencies (typescript, vitest, tsup, @biomejs/biome, @types/node) live at the workspace root (KTD6). Versions are verified with `npm view` at build time.

**CI**

- R8. `.github/workflows/ci.yml` runs install with a frozen lockfile, build, typecheck, lint, and test on Node 20 and Node 22.

**Repo hygiene**

- R9. `LICENSE` holds the Apache-2.0 text, and every `package.json` (root included) declares `"license": "Apache-2.0"`.
- R10. Existing `.gitignore` and `.env.example` are kept. No secrets, no telemetry, and no network calls are added.

### Scope Boundaries

- No protocol schemas, crypto, relay, MCP tools, or CLI commands. Packages are skeletons.
- No `bin` entry on the `cli` package yet; the `agentroom` executable arrives with the first command in Milestone 1. A `bin` pointing at a file that does nothing would be a broken contract on day one.
- No `plugins/`, `adapters/`, or `examples/` directories (later milestones).
- No npm publishing config (`publishConfig`, release workflow) and no changesets. Publishing is Milestone 4.
- No edits to `docs/PLAN.md`.

#### Deferred to Follow-Up Work

- `.gitignore` still ignores `.agentsync/` (pre-rename name). The state dir is `~/.agentroom` in the home directory, so the entry is harmless; rename it when Milestone 1 introduces any repo-local state.
- Cross-package workspace dependencies (`@agentroom/protocol` as `workspace:*` in `relay-node`, `mcp`, `cli`) and the external stack dependencies (zod, libsodium-wrappers, ws, the MCP SDK packages) are added in Milestone 1 when code first imports them (KTD2, KTD6). The pins in KTD6 are recorded now so the Milestone 1 builder does not re-derive them.

### Sources

- `CLAUDE.md` (stack and conventions, definition of done), `docs/PLAN.md` Milestone 0, `docs/ARCHITECTURE.md` Repo layout, `docs/OPEN_QUESTIONS.md` items 1, 2, 3, 15.
- `npm view` results on 2026-10-11 (see KTD6).
- Latest GitHub release tags on 2026-10-11 via `gh release view`: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Biome 2 as the single lint and format tool.** `CLAUDE.md` allows Biome or ESLint plus Prettier. Biome is one dev dependency, one config file, no plugin graph, and runs fast. One root `biome.json` with VCS integration on (`vcs.enabled`, `useIgnoreFile`), so `.gitignore` excludes `node_modules/`, `dist/`, `coverage/` and `build-logs/`. `build-logs/` holds multi-megabyte JSONL files and must never be linted. Formatter: spaces, indent width 2, matching the code samples in `docs/`. `lint` runs Biome's check (lint, format check, import sorting) without writing, and `format` runs Biome's formatter with write.
- KTD2. **Typecheck with per-package `tsc --noEmit`, run by `pnpm -r typecheck`; no project references.** tsup owns emit, so `tsc` only checks types. Project references (`tsc -b`) would need `composite`, declaration emit and a references graph kept in sync by hand, with no benefit while packages do not import each other. Each package's `tsconfig.json` includes `src` and `test`, so test files are typechecked too, which tsup's build does not do. When Milestone 1 adds workspace imports, types resolve through the dependency's built `dist/*.d.ts`, so typecheck must run after build. CI already orders build before typecheck. Revisit project references only if that ordering becomes a problem.
- KTD3. **One root `tsconfig.base.json`, extended by each package.** Base settings: `strict`, `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `verbatimModuleSyntax`, `isolatedModules`, `noUncheckedIndexedAccess`, `skipLibCheck`, `types: ["node"]`. Package configs add only `include` and `noEmit`. `noUncheckedIndexedAccess` is chosen now because turning it on after Milestone 1's parsers exist means a retrofit across crypto and schema code.
- KTD4. **tsup per package, ESM only, with declarations.** Each package has a small `tsup.config.ts`: entry `src/index.ts`, format `esm`, `dts: true`, target `node20`, `clean: true`, `sourcemap: true`. ESM only because the project is ESM throughout and Node 20+ consumers can import ESM. `package.json` exposes `exports["."]` with `types` and `import` pointing into `dist/`, plus `files: ["dist"]`.
- KTD5. **vitest per package with no config file.** Each package's `test` script is `vitest run`. Tests live in `packages/<name>/test/*.test.ts`, outside `src/`, so they never enter the tsup entry graph or the published `dist/`. vitest defaults find them; add a config file only when a package needs one.
- KTD6. **Version pins, checked against `npm view` on 2026-10-11.** The builder re-runs `npm view <pkg> version` (and `engines` where noted) before pinning, but must hold these constraints, which the caller's suggested majors did not all account for:
  - `typescript@^5` (5.9.3), not the npm `latest` 7.0.2. TypeScript 7's package exports only `./lib/version.cjs` plus `unstable/*` entries, with no classic compiler API. tsup's `dts` build uses that API, so TypeScript 7 breaks declaration builds.
  - `vitest@^3` (3.2.7). vitest 5.0.3 (`latest`) declares `engines.node` `^22.12.0 || ^24.0.0 || >=26.0.0` and would fail the Node 20 CI leg. vitest 4.1.11 also supports Node 20 and is an acceptable upgrade; `^3` is kept because the caller named it and it meets every constraint.
  - `@types/node@^20`, matching the lowest supported runtime, so code written on the local Node 26 cannot typecheck against APIs Node 20 lacks.
  - Unchanged from the caller's list: `tsup@^8` (8.5.1), `@biomejs/biome@^2` (2.5.15).
  - Placement in Milestone 0: `typescript`, `vitest`, `tsup`, `@biomejs/biome`, `@types/node` as root devDependencies, which packages resolve from the workspace root (pnpm puts the root `node_modules/.bin` on the script PATH). No package declares a runtime dependency in Milestone 0 (R7).
  - Recorded for Milestone 1, not installed now (verified 2026-10-11): `zod@^4` (4.6.6) and `libsodium-wrappers@^0.8` (0.8.4; it bundles its own types through `exports`, so do not add the deprecated `@types/libsodium-wrappers` stub) in `protocol`; `ws@^8` (8.22.0, with `@types/ws@^8` dev) in `relay-node` and `mcp`; `@modelcontextprotocol/server@^2.3.1` in `mcp` dependencies and `@modelcontextprotocol/client@^2.3.1` in `mcp` devDependencies (both engines `node >=20`).
- KTD7. **pnpm 10.4.0 pinned through `packageManager`, with esbuild allowed to run its install script.** Root `package.json` carries `"packageManager": "pnpm@10.4.0"` (the locally installed version; npm `latest` is 12.x, and moving pnpm majors is out of scope) and `engines.node` `>=20.19` in the root and every package, because vitest 3 resolves vite 7, whose engines are `^20.19.0 || >=22.12.0`; the README Development section states the same floor. pnpm 10 skips dependency lifecycle scripts unless allow-listed. esbuild (pulled in by tsup) has a `postinstall`, so list it under `pnpm.onlyBuiltDependencies` in root `package.json` to avoid ignored-script warnings and a broken binary on platforms where the optional native package is missing. Biome ships its binary through optional dependencies and needs no script. `pnpm-workspace.yaml` lists `packages/*`. `pnpm-lock.yaml` is committed.
- KTD8. **CI: one job, Node matrix `[20, 22]`, `fail-fast: false`, read-only token.** Triggers on push to `main` and on pull requests. Steps: checkout, `pnpm/action-setup` (reads `packageManager`, so no version input), `actions/setup-node` with the matrix version and `cache: pnpm`, then install with frozen lockfile, build, typecheck, lint, test. `permissions: contents: read`. Use the latest major tags found on 2026-10-11 (`actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`); the builder re-checks with `gh release view -R <owner/repo>` before writing the file, and confirms each action's README still documents the inputs used. Lint runs once per matrix leg; it is cheap and keeps the job single-shaped.
- KTD9. **Smoke exports are real values with a reason to exist.** `protocol` exports `PROTOCOL_VERSION = 1`, the wire protocol version that `docs/ARCHITECTURE.md` sends as `proto: 1` in `hello`, so Milestone 1 builds on it. `relay-node`, `mcp`, and `cli` each export `VERSION`, a string that the test checks against the package's own `package.json` version. That test catches drift when a version bump misses the source.

### Assumptions

These are agent bets made without a human to confirm them.

- The `VERSION` constant is a hard-coded string kept equal to `package.json` by the test, rather than a JSON import. JSON import attributes under `NodeNext` plus tsup add moving parts for no Milestone 0 gain.
- No root `vitest.workspace`/`projects` config: `pnpm -r test` runs each package's own vitest, which is what the acceptance criterion names.
- Package versions start at `0.0.0`.
- README gets a short "Development" section naming the root scripts and Node 20+ / pnpm requirement, and its Status line changes from "Pre-code" to reflect the scaffold. `CLAUDE.md` definition of done asks for docs to follow interface changes, and the root scripts are a new contributor interface.
- Node 20 reached end of life in April 2026. The CI matrix keeps it because `docs/PLAN.md` and `CLAUDE.md` name Node 20+. Dropping Node 20 would be a docs decision, not a Milestone 0 one; it would also free vitest 5.

### Output Structure

```text
.github/workflows/ci.yml
LICENSE
README.md                  (modified: Development section, Status)
biome.json
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.base.json
packages/
  protocol/    package.json  tsconfig.json  tsup.config.ts  src/index.ts  test/index.test.ts
  relay-node/  package.json  tsconfig.json  tsup.config.ts  src/index.ts  test/index.test.ts
  mcp/         package.json  tsconfig.json  tsup.config.ts  src/index.ts  test/index.test.ts
  cli/         package.json  tsconfig.json  tsup.config.ts  src/index.ts  test/index.test.ts
```

### Risks

| Risk | Mitigation |
|---|---|
| A builder following "latest" pins TypeScript 7 or vitest 5 and breaks dts builds or Node 20 CI. | KTD6 states the constraint and the reason; Verification Contract requires a Node 20 run before calling the work done. |
| Local machine runs Node 26, so a Node-20-only failure is invisible locally. | Run the test suite once under Node 20 (for example via `npx -p node@20` or a version manager) before declaring done; `@types/node@^20` blocks newer APIs at typecheck. |
| pnpm 10 silently skips esbuild's install script. | KTD7 allow-lists esbuild; check `pnpm install` output for an "ignored build scripts" warning. |
| Biome walks into `build-logs/` or `dist/`. | KTD1 turns on VCS ignore-file integration; `pnpm lint` on a tree that contains `build-logs/` must stay fast and clean. |
| GitHub Action majors moved after 2026-10-11. | KTD8 has the builder re-check release tags before writing the workflow. |

---

## Implementation Units

### U1. Root workspace, toolchain config, and license

- **Goal:** A root that installs, knows its packages, and carries the shared TypeScript, Biome, and license setup.
- **Requirements:** R3, R5, R6, R7, R9, R10.
- **Dependencies:** None.
- **Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `LICENSE`, `README.md`, `pnpm-lock.yaml`.
- **Approach:**
  1. Root `package.json`: `private: true`, `type: module`, `license`, `packageManager`, `engines`, `pnpm.onlyBuiltDependencies` (KTD7), root devDependencies (KTD6), and scripts: `build` and `test` and `typecheck` delegate with `pnpm -r`, `lint` and `format` call Biome at the root (KTD1).
  2. `tsconfig.base.json` per KTD3.
  3. `biome.json` per KTD1, with `$schema` pointing at the installed Biome version.
  4. `LICENSE`: the unmodified Apache License 2.0 text from https://www.apache.org/licenses/LICENSE-2.0.txt. The appendix boilerplate notice is optional and not needed.
  5. README Development section and Status update (see Assumptions).
  6. Keep `.gitignore` and `.env.example` untouched.
- **Execution note:** Mostly config; prove it by running install and lint, not by unit tests.
- **Test expectation:** none -- pure configuration; U2 and U3 tests exercise it.
- **Verification:** `pnpm install` succeeds with no ignored-build-script warning for esbuild; `pnpm lint` passes and does not touch `build-logs/`.

### U2. `@agentroom/protocol` skeleton

- **Goal:** The first package, built, typechecked, and tested; it sets the shape U3 copies.
- **Requirements:** R1, R2, R3, R4, R7, R9.
- **Dependencies:** U1.
- **Files:** `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/tsup.config.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/index.test.ts`.
- **Approach:**
  1. `package.json`: name `@agentroom/protocol`, version `0.0.0`, `type`, `license`, `engines`, `exports`/`files` per KTD4, scripts `build` (tsup), `test` (vitest run), `typecheck` (tsc --noEmit). No dependencies (R7).
  2. `src/index.ts` exports `PROTOCOL_VERSION` (KTD9) and nothing else.
- **Patterns to follow:** KTD3, KTD4, KTD5.
- **Test scenarios:**
  - `PROTOCOL_VERSION` imported from the package source equals `1`, the `proto` value in the `hello` frame documented in `docs/ARCHITECTURE.md`.
- **Verification:** `dist/index.js` and `dist/index.d.ts` exist after build; package typecheck and tests pass.

### U3. `relay-node`, `mcp`, and `cli` skeletons

- **Goal:** The remaining three packages in the U2 shape.
- **Requirements:** R1, R2, R3, R4, R7, R9.
- **Dependencies:** U2.
- **Files:**
  - `packages/relay-node/package.json`, `packages/relay-node/tsconfig.json`, `packages/relay-node/tsup.config.ts`, `packages/relay-node/src/index.ts`, `packages/relay-node/test/index.test.ts`
  - `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/tsup.config.ts`, `packages/mcp/src/index.ts`, `packages/mcp/test/index.test.ts`
  - `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/tsup.config.ts`, `packages/cli/src/index.ts`, `packages/cli/test/index.test.ts`
- **Approach:**
  1. Names per R2: `@agentroom/relay-node`, `@agentroom/mcp`, and `agentroom` for `packages/cli`.
  2. No dependencies in any of the three (R7); Milestone 1 adds them on first import.
  3. Each `src/index.ts` exports `VERSION` (KTD9). No `bin` on `cli` (Scope Boundaries).
- **Patterns to follow:** U2's files.
- **Test scenarios:**
  - For each of the three packages, `VERSION` from source equals the `version` field read from that package's own `package.json` at test time.
- **Verification:** All four packages build to `dist/`; `pnpm -r build && pnpm -r test` runs four test files and passes.

### U4. GitHub Actions CI workflow

- **Goal:** Every push to `main` and every pull request runs the full gate on Node 20 and 22.
- **Requirements:** R8.
- **Dependencies:** U1, U3.
- **Files:** `.github/workflows/ci.yml`.
- **Approach:** Single job per KTD8. Re-check action release tags first.
- **Execution note:** Cannot run on GitHub until a human creates the repo and pushes; verify locally by YAML parse and by running the same command sequence the workflow runs.
- **Test expectation:** none -- CI configuration; verified by parse and by local replay of its steps.
- **Verification:** The file parses as YAML (for example with `node -e` and the `yaml` package via `npx`, or `python3 -c "import yaml"` if available); its step list matches R8 in order; the local replay of install, build, typecheck, lint, test passes.

---

## Verification Contract

| Gate | Command | Applies |
|---|---|---|
| Clean install | `pnpm install --frozen-lockfile` (after deleting `node_modules`) | U1-U3 |
| Build | `pnpm -r build` | U2, U3 |
| Typecheck | `pnpm typecheck` | U2, U3 |
| Lint and format check | `pnpm lint` | all |
| Tests | `pnpm -r test` (four test files, all passing) | U2, U3 |
| Node 20 run | Same build and test sequence under Node 20 | U2, U3 (KTD6 risk) |
| CI file validity | YAML parse of `.github/workflows/ci.yml` | U4 |

Milestone 0 acceptance from `docs/PLAN.md`: `pnpm -r build && pnpm -r test` green locally. "Green in CI" needs a GitHub repo and is a human step; record it as waiting on Andrew rather than claiming it.

## Definition of Done

- Every gate in the Verification Contract passes, with real command output reported, including the Node 20 run.
- R1-R10 hold; four packages exist, `relay-cf` does not.
- No placeholder tests, no unused files, no leftover experiment config (for example a `vitest.config.ts` or extra tsconfig that nothing uses).
- `docs/PLAN.md` is unchanged by this work.
- No secrets, `.env` remains untracked, and no new network calls or telemetry.
