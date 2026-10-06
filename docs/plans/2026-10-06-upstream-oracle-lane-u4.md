---
title: Upstream Oracle Lane - Plan
type: feat
date: 2026-10-06
artifact_contract: ce-unified-plan/v1
product_contract_source: legacy-requirements
execution: code
---

# Upstream Oracle Lane - Plan

## Goal Capsule

**Objective:** Every case of upstream XState at the pinned commit runs unedited against the fork and is held or retired with a passing replacement Kiro ruled, reported through a disposition file with per-package parity counts.

**Means:** A flake input pins statelyai/xstate at `2146ae26ebfc7e6a624b3a1f237f9e6ddc30b9f5`, a derivation stages its tests into a store path, vitest projects per upstream package resolve fork imports through a committed specifier map, a reporter enforces the disposition against case outcomes, and two fork-owned tests replace cases the fork's toolchain refuses (KTD5).

**Authority:** Ryan owns scope; Kiro rules every oracle-lane retirement in review. Product Contract and sequencing follow fork plan U4 and KTD5.

**Execution profile:** This layer is an Evaluator surface. It is its own PR and receives Kiro's approval before any subsequent layer stacks on it. This layer adds the oracle lane, removes in-tree upstream tests and the vitest.shared.ts bypass (per KTD3 default), and enrolls the oracle package in mutation and lint gates. Modifications: `flake.nix`/`flake.lock` (xstate-upstream input), `packages/xstate-upstream-oracle/` (new), deletion of in-tree upstream test trees from all six packages, deletion of `vitest.shared.ts` upstream-verbatim project and CONST-W3 bypass, deletion of each package's `upstream-tests.json` and `tsconfig.upstream-test.json`.

**Finishes:** The oracle package is complete, enrolled in gates, and green. The lane is green with all cases held (per upstream-tests.json counts), per-package counts match baselines, sabotage breaks and reverts, and the two fork-owned replacement tests exist and pass.

---

## Product Contract

### Summary

Move the upstream test suite from in-tree copies (one per package under `packages/<pkg>/test/` and colocated source tests) into a single oracle lane (`packages/xstate-upstream-oracle/`). The suite runs unedited from a Nix flake input, with imports resolved through a committed map and outcomes enforced by a disposition file (3507 cases held, 2 retired with named replacements). The lane reports per-package pass/skip/todo/retired counts and fails on any held failure, unlisted case, or missing/failed replacement (R4, R5).

### Problem Frame

Upstream XState v6 sits at `2146ae26` with two test suites that conflict with the fork's gates: its verbatim `it()` registrations violate `@systemfsoftware/vitest/guard`, and a TypeScript 5 emission test (test/declarations.test.ts) and a vitest 3-era suite declaration (xstate-test's propertySuite.test.ts) fail under the fork's toolchain. Keeping them in-tree requires a CONST-W3 bypass comment (today in vitest.shared.ts) and makes every future rewrite carry the suite. The remedy is a private oracle lane that runs the suite unedited from a pinned input, reports mismatches, and carries named replacements for the two toolchain-blocked cases. This separates the fork's own gate compliance from upstream's contract and allows the rewrite layers to make the code theirs without editing the oracle.

### Requirements

**Upstream suite source and execution**

R1. The upstream test suite enters as a Nix flake input pinned to the exact rev and narHash of statelyai/xstate at `2146ae26ebfc7e6a624b3a1f237f9e6ddc30b9f5` (`flake = false` input, no build steps, fetched once).

R2. A flake derivation `packages.<system>.xstate-upstream-suite` stages each of the six upstream packages' `test/` directories and colocated `src/**/*.test.ts(x)` and fixture directories into `$out/packages/<upstream-dir>/`, excluding Vue and Solid test configs (xstate-store's vitest.config.vue.mts and vitest.config.solid.mts) and the files only they test.

R3. One vitest project per upstream package (upstream-core, upstream-xstate-effect, upstream-xstate-test, upstream-xstate-react, upstream-xstate-store, upstream-xstate-store-react) runs its suite from the flake output, resolving fork imports through a committed specifier map and fork surface exports.

R4. A reporter over vitest's JSON report enforces a disposition file: held cases must pass or skip/todo as declared, retired cases must have a named fork replacement that exists and passes, and any unlisted case or held failure exits non-zero and names the case.

R5. The lane reports per-package pass/skip/todo/retired counts and fails if they differ from baseline (computed from upstream-tests.json, set at landing and at each layer thereafter).

**Disposition and retirements**

R6. The disposition file (`packages/xstate-upstream-oracle/disposition.json`, 665KB in the WIP) records 3507 held cases by key, 2 retired cases with reasons and replacement file paths, and parity rows. Held cases default to held; retired entries carry upstream file and replacement file and are ruled by Kiro in review.

R7. The two retired cases are: (1) test/declarations.test.ts (upstream xstate core), replaced by `packages/xstate/tests/declaration-emit.test.ts` (fork-owned, TypeScript 7 emit replaces TypeScript 5 declaration-emit suite); (2) test/engine/propertySuite.test.ts (upstream xstate-test), replaced by a fork-owned test in `packages/xstate-test/tests/` (vitest 5 refuses a suite declared inside a running test; the fork declares it at collection).

R8. The specifier map (`packages/xstate-upstream-oracle/src/specifier-map.ts`) records every xstate and @xstate/* import path upstream's six packages use, mapping them to `@systemfsoftware/xstate*` names and fork subpaths. The map is the single source of truth for resolver plugins and the type-pass tsconfig generator; a change to it is an Evaluator commit (KTD5.2).

R9. A case key is the suite-relative file path, the describe-title chain, the test title, and an occurrence counter (distinct for `it.each` collisions), deterministic over report order.

**Gate compliance**

R10. The oracle package itself (`@systemfsoftware/xstate-upstream-oracle`, version 0.0.0, private) enrolls in the unrelaxed `@systemfsoftware/oxlint-config-recommended` preset and `lint:tsgo` from birth; it is new first-party code, never upstream-sourced.

R11. The package declares `mutation` script and `stryker.config.ts` per the constitution's mutation doctrine; it carries two property suites on workflows (case-key assignment, verdict determination over outcomes, retirement matching) and one integration fixture test (reporter over a fixture report with an absent case); these prove the disposition logic, not the upstream behavior. The upstream behavior is held by the suite itself.

---

## Planning Contract

### Key Technical Decisions

KTD1. **Flake input or git-subtree inPlace kind for the suite's pinned entry point.**

- _Tension:_ systemfsoftware's @systemfsoftware/upstream-manifest (merged in #632) introduces an `inPlace` kind for a suite run straight from a read-only subtree (`repos/<name>`) pinned by its git-subtree-split trailer. That model is low-friction (no derivation, no separate fetch, no store) and integrates with the guard's --report workflow. A flake input model (this plan's KTD5.1) is a separate artifact fetch and a derivation build, but it is isolated (the input's narHash is the oracle lane's only dependency on the upstream snapshot) and explicit (the lock is in this repo's flake.lock, visible to every build).
- _Recommended default:_ Flake input. Rationale: The oracle lane is an Evaluator surface with narrow scope. A committed flake lock ties the lane's suite version to every build, making it verifiable without consulting systemfsoftware's state; a subtree under repos/ would require reading systemfsoftware's main to verify the split trailer, creating a run-time dependency on that repo's toolchain maturity. The flake input is isolated and simpler to reproduce and audit locally. If the flake approach proves costly, the inPlace model can follow in a later layer under KTD5.2 refinement.

KTD2. **Oracle package location within the workspace.**

- _Tension:_ The package lives in `packages/xstate-upstream-oracle/` as a direct workspace member (glob `packages/*`), which makes it listed as a package (private: true, so unpublishable). The release-gate automation skips unpublishable packages; however, the mutation doctrine and fork plan U4 step 6 require it to declare its own mutation script and stryker.config.ts for correctness measurement. An alternative would be to place it under a hidden path (not a workspace member), but that hides infrastructure from automation.
- _Recommended default:_ `packages/xstate-upstream-oracle/` as a workspace member with `private: true`, declaring both `mutation` script and `stryker.config.ts`. Rationale: The package is permanent, authored, production infrastructure; enrollment in the mutation gate fulfills the constitution's mutation doctrine and makes its correctness measurable. Being a workspace member keeps it discoverable and properly scoped.

KTD3. **Removal of the vitest.shared.ts upstream-verbatim project and the CONST-W3 bypass.**

- _Tension:_ Today, every package declares an `upstream-verbatim` project in its vitest config via vitest.shared.ts (lines 40-62). This project exists because upstream's tests register cases with vitest's `it`, which `@systemfsoftware/vitest/guard` refuses. The CONST-W3 bypass comment (vitest.shared.ts lines 40-43) explicitly declares "Removed by: U4, the oracle lane (PR 3)". Once the oracle lane owns the upstream suite, the in-tree upstream tests vanish, the `upstream-verbatim` project becomes dead, and the bypass is void. The fork plan U4 step 5 states deletions occur in the same layer.
- _Recommended default:_ Remove them in this layer (U4). Rationale: The bypass comment itself declares U4 as the removal unit. The fork plan U4 explicitly includes deletion of in-tree upstream tests in its scope. Removing in U4 closes the bypass immediately and fulfills its declared contract. The XS1 debt-ledger entries are unaffected (they name U9-U14). Deletions: in-tree upstream test trees (packages/xstate/test/, packages/xstate-effect/src/**, etc.), each package's upstream-tests.json and tsconfig.upstream-test.json, the upstreamSpecifiers aliases from vitest.shared.ts, the upstream-verbatim project definition, and the CONST-W3 bypass comment. Parity must be verified before deletion (the counts held by the upstream-tests.json files must match the lane's report after deletion).

### High-Level Technical Design

The oracle lane has six functional boundaries:

1. **Flake input and derivation** (flake.nix, flake.lock): Pins statelyai/xstate and builds the upstream-suite store path.
2. **Specifier map** (src/specifier-map.ts): Resolver plugin configuration and tsconfig generator input, mapping upstream `xstate`/`@xstate/*` to fork `@systemfsoftware/xstate*`.
3. **Vitest integration** (vitest.config.ts, six upstream-* projects): Resolves the store path, applies the specifier map, runs each package's suite in the correct environment (node or happy-dom).
4. **Reporter** (src/reporter.ts, bin/lane-report.ts): Decodes vitest JSON, flattens assertions into cases, reads disposition.json, judges each case, and reports per-package counts or failures.
5. **Disposition** (disposition.json, src/disposition.schema.ts): JSON record of 3507 held cases, 2 retired cases, and parity baseline; enforced by the reporter.
6. **Property and integration tests** (src/**tests**/*.property.test.ts, tests/lane.integration.test.ts): Prove case keys are stable and distinct, verdict logic is sound, and the reporter correctly refuses an unlisted case.

### Sequencing and Phases

U4 introduces the oracle lane as a complete, working Evaluator surface. No earlier unit touches the lane's files; later units will update the specifier map and the replacement-test references when public surfaces move or test names change. Because the oracle lane carries the upstream suite's only copy in this repo, every transition to a new layer must:

- Run the lane to confirm it is green.
- Commit any disposition or specifier-map changes.
- Confirm the two replacement tests still exist and pass in the fork's native vitest run.

### Assumptions

- The upstream clone at the research reference is a read-only reference for inspecting upstream's test structure; the flake input is the actual fetched source.
- The six upstream packages in the import target the `next` branch at the pinned rev, and their pinned versions (xstate@6.0.0-alpha.64, @xstate/effect@0.1.0-alpha.6, etc.) do not change until the fork rebases upstream (outside this plan's scope).
- Replacement tests are fork-owned and not edited by the oracle lane; they are owned by xstate and xstate-test's rewrite layers respectively.

### Risks & Dependencies

**No dependency on systemfsoftware#606 for suite build:** The statelyai/xstate flake input (`flake = false`) and the xstate-upstream-suite derivation do not depend on #606. This repo already pins the systemfsoftware input at bb5956b3 (PR #606 head) which exports `workspace-tarballs`. The pnpm install step reads tarballs from there, copied into `.sfs-deps` by the dev shell. Build succeeds today.

**What waits on systemfsoftware#606 to merge to main:**

- Re-pinning the systemfsoftware input from bb5956b3 (current #606 head) to main, after #606 lands.
- Consuming @systemfsoftware/upstream-manifest as an alternative oracle mechanism (merged in systemfsoftware#632 on main; main's flake has no tarball output until #606 merges).

**Risk:** The `xstate-upstream-suite` derivation excludes Vue and Solid test files from xstate-store (vitest.config.vue.mts, vitest.config.solid.mts, and the test files only they exercise). If upstream's test names or structure change, the exclusion logic may miss files or exclude too much. The derivation is in this repo (flake.nix), so any upstream schema change requires a PR; this is transparent and catchable at build time.

**Risk:** The specifier map is hand-authored. If an upstream import path is missed or a fork re-export is misnamed, the lane will fail at collection time (before test execution) when vitest cannot resolve an import. The integration test and local builds catch this, but CI failures in later layers could expose missed mappings.

---

## Implementation Units

### Unit Index

| U-ID | Title                               | Key Files                                                                                                                                             | Depends on |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| U4.1 | Flake input and suite derivation    | `flake.nix`, `flake.lock`                                                                                                                             | U3         |
| U4.2 | Oracle package scaffolding          | `packages/xstate-upstream-oracle/{package.json,tsconfig*.json,vitest.config.ts,oxlint.config.ts,stryker.config.ts}`                                   | U4.1       |
| U4.3 | Specifier map and surface exports   | `packages/xstate-upstream-oracle/src/specifier-map.ts`, `src/surface/*.ts`                                                                            | U4.2       |
| U4.4 | Disposition schema and data         | `packages/xstate-upstream-oracle/src/disposition.schema.ts`, `disposition.json`                                                                       | U4.3       |
| U4.5 | Reporter and verdict workflow       | `packages/xstate-upstream-oracle/src/reporter.ts`, `src/lane-verdict.workflow.ts`, `bin/lane-report.ts`                                               | U4.4       |
| U4.6 | Case-key workflow and tests         | `packages/xstate-upstream-oracle/src/assign-case-keys.workflow.ts`, `src/__tests__/assign-case-keys.workflow.property.test.ts`                        | U4.5       |
| U4.7 | Verdict workflow tests and fixtures | `packages/xstate-upstream-oracle/src/__tests__/lane-verdict.workflow.property.test.ts`, `tests/lane.integration.test.ts`, `tests/__fixtures__/*.json` | U4.6       |

### U4.1. Flake input and suite derivation

**Goal:** Pin the upstream XState snapshot and derive its test tree into a store path the lane can consume.

**Requirements:** R1, R2.

**Dependencies:** U3 (U4 depends on U3 completing upstream repairs and fixing gate failures).

**Files:** `flake.nix`, `flake.lock`.

**Approach:**

1. Add the `xstate-upstream` flake input with `flake = false` and the exact URL, rev, and narHash from fork plan KTD5 (R1). Commit the lock entry generated by `nix flake update --specific-flake xstate-upstream`.
2. Implement the `xstate-upstream-suite` derivation in the `packages` function, using `pkgs.stdenvNoCC.mkDerivation` to stage the six upstream packages' test and fixture files (R2). The derivation:
   - Sources from the `xstate-upstream` input (flake = false).
   - Copies each package's `test/` tree and `src/**/*.test.ts(x)` paths to `$out/packages/<upstream-name>/` using `cp --parents`.
   - Excludes Vue and Solid configs and their test files (xstate-store's vitest.config.{vue,solid}.mts).
   - Outputs the store path; the lane's vitest config resolves it via `bin/upstream-suite` (see U4.2).

**Test scenarios:**

- `nix flake update` resolves the xstate-upstream input without error.
- `nix build .#xstate-upstream-suite` succeeds and produces a store path with the expected file layout.
- The store path contains each package's test/ and colocated *.test.ts(x) files; Vue/Solid test files are absent.

**Verification:**

- `nix build --rebuild .#xstate-upstream-suite` produces bit-for-bit identical output (reproducibility test).
- The flake lock entry is committed verbatim.
- `bin/upstream-suite` resolves the store path by consulting `nix build … --print-out-paths` (shell script stub; tested by U4.2).

---

### U4.2. Oracle package scaffolding

**Goal:** Create the oracle package structure, wire it as a pnpm workspace member, and enroll it in mutation and lint gates.

**Requirements:** R10, R11.

**Dependencies:** U4.1.

**Files:**

- `packages/xstate-upstream-oracle/package.json`
- `packages/xstate-upstream-oracle/tsconfig.{json,app.json}`
- `packages/xstate-upstream-oracle/vitest.config.ts`
- `packages/xstate-upstream-oracle/oxlint.config.ts`
- `packages/xstate-upstream-oracle/stryker.config.ts` (mutation gate enrollment per R11)
- `packages/xstate-upstream-oracle/bin/upstream-suite` (shell wrapper)

**Approach:**

1. Create `packages/xstate-upstream-oracle/` with `package.json`:
   - Name: `@systemfsoftware/xstate-upstream-oracle`, version 0.0.0, private true, type module.
   - No exports (internal package).
   - Scripts: `build` (tsc -b tsconfig.app.json), `typecheck`, `test` (vitest run), `lint` (oxlint), `lint:tsgo` (effect-tsgo), `mutation` (stryker run), and a `reports` script to invoke bin/lane-report.ts.
   - DevDeps: @systemfsoftware/{vitest-config,oxlint-config-recommended,tsconfig,effect-tsgo}, ajv, esbuild, fast-check, zod, stryker-cli.
2. Copy `tsconfig.json` and `tsconfig.app.json` from packages/discern pattern; adjust paths and the `@systemfsoftware/source` condition.
3. Create `vitest.config.ts`:
   - Six upstream-* projects, one per package (upstream-core, upstream-xstate-effect, etc.), with the correct environment (node or happy-dom) and include globs from the derivation output.
   - One `own` project for the oracle's own tests (src/**/*.test.ts + tests/**/*.test.ts) with `@systemfsoftware/vitest/guard` setup.
   - Apply upstreamSpecifiers resolver alias (see U4.3).
   - Resolve `XSTATE_UPSTREAM_SUITE` env var or call bin/upstream-suite to find the store path.
4. Create `oxlint.config.ts`: `extends: ["@systemfsoftware/oxlint-config-recommended"]`, no overrides.
5. Create `stryker.config.ts`: Declare `mutate` set to cover `src/**` with exclusions for any scaffolding or non-core code.
6. Create `bin/upstream-suite` (720B shell script): Check `$XSTATE_UPSTREAM_SUITE`, else `nix build --no-link --print-out-paths --no-write-lock-file $ROOT#xstate-upstream-suite`, else error.
7. The oracle package is automatically a workspace member via the `packages/*` glob in pnpm-workspace.yaml (no update needed).

**Test scenarios:**

- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle install` resolves and installs without error.
- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle build` exits 0.
- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle typecheck` exits 0.
- `bin/upstream-suite` resolves a valid store path (or returns the env var if set).
- `pnpm lint` over oxlint.config.ts finds no violations in the oracle package's own code (proves enrollment in the unrelaxed preset).

**Verification:**

- `pnpm install` from the repo root completes without lockfile changes (scaffold adds no dependencies).
- The oracle package is listed in `pnpm list --recursive` output.

---

### U4.3. Specifier map and surface exports

**Goal:** Record the import paths upstream's tests use and map them to fork entries; define the oracle's public surface (reporter).

**Requirements:** R3, R8.

**Dependencies:** U4.2.

**Files:**

- `packages/xstate-upstream-oracle/src/specifier-map.ts` (full mapping, ~5KB)
- `packages/xstate-upstream-oracle/src/surface/mod.ts` (barrel export of public APIs, minimal)

**Approach:**

1. In specifier-map.ts, record every xstate and @xstate/* import the six upstream packages' tests exercise. Source the list from a grep over the upstream clone at the pin. The map covers:
   - Relative imports (`../src/**`) within each upstream package → rewired to the fork's modules at the subpath.
   - `xstate` → `@systemfsoftware/xstate`
   - `xstate/<subpath>` (actors, durable, fsm, graph, validation) → `@systemfsoftware/xstate/<subpath>`
   - `@xstate/effect` → `@systemfsoftware/xstate-effect`
   - `@xstate/effect/atom` → `@systemfsoftware/xstate-effect/atom` (xstate-effect exports `./atom` itself; there is no separate atom package)
   - `@xstate/store` and subpaths (`./persist`, `./reset`, `./undo`, `./validate`) → `@systemfsoftware/xstate-store*`
   - `@xstate/test` and subpaths (`./effect-schema`, `./playwright`, `./vitest`) → `@systemfsoftware/xstate-test*`
   - `@xstate/react`, `@xstate/store-react` → `@systemfsoftware/xstate-react`, `@systemfsoftware/xstate-store-react`
   - Export the map as a const array of { find, replacement } for vitest resolver.alias configuration.
2. In surface/mod.ts, export the public API: reporter entry point (laneReport function from src/reporter.ts, though most callers use bin/lane-report.ts directly).
3. Document that the map is the single source of truth and changes to it are Evaluator commits (KTD5.2).

**Test scenarios:**

- The specifier map covers every import path used by the six upstream packages' test suites (integration test in U4.7 confirms this).
- Vitest can resolve each mapped import without error during test collection.
- Every fork export named in the map exists and is public (confirmed by U4.2's typecheck and U4.3's own typecheck).

**Verification:**

- `src/specifier-map.ts` is syntactically valid and exports a const array of { find: RegExp, replacement: string } objects.
- Vitest's resolver can apply the map without error; this is tested by attempting collection on one upstream project (see U4.2's test scenario).

---

### U4.4. Disposition schema and data

**Goal:** Define the disposition format and record the baseline 3507 held cases and 2 retired cases.

**Requirements:** R6, R7, R9.

**Dependencies:** U4.3.

**Files:**

- `packages/xstate-upstream-oracle/src/disposition.schema.ts` (~1.3KB)
- `packages/xstate-upstream-oracle/src/__tests__/disposition.schema.test.ts` (codec laws, colocated with schema per test-layer-selection matrix)
- `packages/xstate-upstream-oracle/disposition.json` (665KB)

**Approach:**

1. In disposition.schema.ts, define the disposition schema as Effect Schema TaggedClass variants:
   - `HeldCase = TaggedClass('HeldCase', { key: string, mode: 'passed' | 'skipped' | 'todo' })`
   - `RetiredCase = TaggedClass('RetiredCase', { file: string, package: string, replacementFile: string, reason: string })`
   - `ParityRow = TaggedClass('ParityRow', { package: string, files: number, passed: number, skipped: number, todo: number })`
   - `Disposition = TaggedClass('Disposition', { version: 1, held: HeldCase[], retired: RetiredCase[], parity: ParityRow[] })`
2. In src/**tests**/disposition.schema.test.ts (colocated codec laws, required by test-layer-selection matrix):
   - Property test: round-trip identity. Any disposition with the schema's data constructors encodes to JSON and decodes back equal to the original (via fast-check arbitrary generators).
   - Property test: encode stability. The same disposition encodes to identical JSON bytes on every encode.
   - Fixture test: decode the committed disposition.json without error (verifies the real data conforms).
3. In disposition.json, initialize with `version: 1`, the held array (3507 entries from the WIP), the retired array (2 entries: declarations.test.ts and propertySuite.test.ts replacements), and the parity baseline (per-package counts from upstream-tests.json).
4. The two retired entries (hardcoded, matching WIP src/parity.ts):
   ```json
   {
     "_tag": "RetiredCase",
     "file": "test/declarations.test.ts",
     "package": "xstate",
     "replacementFile": "packages/xstate/tests/declaration-emit.test.ts",
     "reason": "toolchain: TypeScript 7 emit replaces the TypeScript 5 declaration-emit suite"
   },
   {
     "_tag": "RetiredCase",
     "file": "test/engine/propertySuite.test.ts",
     "package": "xstate-test",
     "replacementFile": "packages/xstate-test/tests/[replacement TBD]",
     "reason": "toolchain: vitest 5 refuses a suite declared inside a running test"
   }
   ```

**Test scenarios:**

- (Codec laws) Round-trip identity: any disposition encodes and decodes to an equal value (property test).
- (Codec laws) Encode stability: the same disposition encodes to identical JSON bytes (property test).
- (Fixture) The committed disposition.json decodes without error.
- The held array has exactly 3507 entries, each with a string key and a valid mode.
- The retired array has exactly 2 entries, each with file, package, replacementFile, and reason.
- The parity rows name all six packages: xstate, xstate-effect, xstate-test, xstate-react, xstate-store, xstate-store-react.

**Verification:**

- `pnpm typecheck` over src/disposition.schema.ts succeeds.
- Codec-law property tests (round-trip identity, encode stability) pass with 1000+ generated dispositions using fast-check (required by test-layer-selection matrix).
- Fixture test: `schema.decode(JSON.parse(fs.readFileSync('./disposition.json')))` succeeds, verifying the committed JSON is valid against the schema.

---

### U4.5. Reporter and verdict workflow

**Goal:** Read vitest reports, judge outcomes against disposition, and report per-package counts or failures.

**Requirements:** R4, R5.

**Dependencies:** U4.4.

**Files:**

- `packages/xstate-upstream-oracle/src/reporter.ts` (~12.4KB)
- `packages/xstate-upstream-oracle/src/lane-verdict.workflow.ts` (~9.2KB)
- `packages/xstate-upstream-oracle/bin/lane-report.ts` (~1KB shell: reads .oracle/report.json, disposition.json, calls laneReport, exits with output.exitCode)

**Approach:**

1. In reporter.ts:
   - Decode a vitest JSON report using report.schema.ts (Effect Schema; mirrors vitest's JSON shape).
   - Flatten assertions into ObservedCase records: { key, file, package, outcome, message }.
   - Case keys are derived via the workflow in U4.6.
   - Map upstream package names (core → xstate, etc.) and file paths (/.suite/packages/* → /packages/<pkg>/*).
   - Distinguish replacement files (under /packages/<pkg>/tests/ in the fork) from upstream files.
   - Call laneVerdict (see U4.5.2) to judge the run.
2. In lane-verdict.workflow.ts (CC=1 workflow):
   - Decide: LaneHolds vs LaneRefused.
   - Held cases: outcome equals declared mode, and for *.types.test.ts, the type-pass tsc run shows no errors.
   - Retired cases: replacementFile exists in the fork's vitest report and has at least one passed assertion.
   - Violations (LaneRefused): UnlistedCase, ModeMismatch, ReplacementMissing, ReplacementFailed, TypeErrorInFile.
   - TriageCategory mapping: for each held failure, assign exactly one category (timing/order, async/error propagation, microstep count, persisted shape, internal member, react server snapshot) based on the failure message regex. Unmapped messages default to 'internal member'.
   - Output: LaneHolds{ passed, skipped, todo, retired, categories } or LaneRefused{ violations, categories }.
3. In bin/lane-report.ts:
   - Shell wrapper: reads .oracle/report.json and disposition.json from the worktree.
   - Calls laneReport(input): if report decoding fails, exit 1; otherwise judge and report.
   - Held verdict: print parity table (header + one row per package, highlighting mismatches); print "lane holds: X passed, Y skipped, Z todo, R retired"; exit 0 if parity matches, else 1.
   - Refused verdict: print each violation to stderr; exit 1.

**Test scenarios:**

- Reporter over a fixture report with all passed cases and matching declaration mode succeeds.
- Reporter over a fixture with an unlisted case exits 1 and names the case key in the error.
- Reporter over a fixture with a held failure exits 1 and names the failure's category.
- Reporter over a fixture with a missing replacement exits 1 and names the missing file.
- Reporter over a fixture with a failed replacement exits 1 and names the replacement file and failure count.
- The vitest project runs and generates a .oracle/report.json at each pnpm test invocation.

**Verification:**

- `bin/lane-report.ts` with a fixture report and disposition.json exits 0 for the "all held" case, 1 for each violation type.
- Parity table is printed to stdout; each mismatch row is marked " <-- parity mismatch".
- **Sabotage:** Modify disposition.json to mark a passed case as 'skipped'; rerun bin/lane-report.ts, and it exits 1 with a ModeMismatch violation. Revert.

---

### U4.6. Case-key workflow and tests

**Goal:** Assign deterministic keys to each case, proving they are stable across report ordering and collisions are resolved.

**Requirements:** R9.

**Dependencies:** U4.5.

**Files:**

- `packages/xstate-upstream-oracle/src/assign-case-keys.workflow.ts` (~2.5KB)
- `packages/xstate-upstream-oracle/src/__tests__/assign-case-keys.workflow.property.test.ts` (~1.1KB)

**Approach:**

1. In assign-case-keys.workflow.ts (CC=1 workflow):
   - Input: CaseIdentity[] (file, ancestors[], title; derived from vitest's ancestorTitles and title).
   - Decision: assign a case key to each identity at index i: `${file} > ${ancestors.join(' > ')} > ${title} :: ${count of identical full titles at indices < i}`.
   - Independent of report order: two reports with the same cases in different orders produce the same keys for each case.
   - Handles `it.each` collisions: identical full titles get distinct occurrence counters.
   - Workflow: fold over identities, track seen full titles by a map<fullText, count>, increment count for each new identity and append the count to the key.
2. In assign-case-keys.workflow.property.test.ts (property test):
   - Generate case lists with potential collisions (multiple `it.each` cases, describe-block nesting).
   - Assert: (1) each key is distinct, (2) keys are stable when the list is shuffled, (3) occurrence counters match the collision count.

**Test scenarios:**

- A list of cases with no collisions generates keys with :: 0 counter for each.
- A list with two identical full titles generates keys with :: 0 and :: 1 counters.
- Shuffling the list does not change any key (stable).
- Keys are deterministic over many random shuffles.

**Verification:**

- Property test with 100+ generated case lists and shuffles passes (fast-check).
- **Sabotage:** Change the key format to include report order (e.g., append the index); the stability property fails. Revert.

---

### U4.7. Verdict workflow tests and fixtures

**Goal:** Prove verdict logic and case matching against fixture cases, and integration-test the full reporter pipeline.

**Requirements:** R11.

**Dependencies:** U4.6.

**Files:**

- `packages/xstate-upstream-oracle/src/__tests__/lane-verdict.workflow.property.test.ts` (~3.9KB)
- `packages/xstate-upstream-oracle/tests/lane.integration.test.ts` (~1.8KB, effect-gherkin-spec)
- `packages/xstate-upstream-oracle/tests/__fixtures__/report.absent-case.json` (~493B), `report.missing-replacement.json`, `report.all-held.json`

**Approach:**

1. In lane-verdict.workflow.property.test.ts (property tests):
   - it.prop: for any generated disposition and report, a held case passes the verdict only when outcome equals declared mode.
   - it.prop: a skipped or todo case declared as such stays held when observed as skipped/todo.
   - it.prop: a held case that now fails or is newly skipped is not held (violation).
   - it.prop: a retired case passes only when its replacementFile appears in the fork's report as passed.
   - it.prop: missing or failed replacements are distinct error variants (each tested via Match.exhaustive).
   - it.prop: every held failure is assigned exactly one category, and per-category counts sum to total failures.
   - it.prop: type errors in a *.types.test.ts file are failures even when runtime outcome is passed.
2. In lane.integration.test.ts (effect-gherkin-spec):
   - Scenario: Fixture report with an absent case in the disposition → reporter exits 1 and names the case key.
   - Scenario: Fixture report with a passed case, disposition marks it skipped → reporter exits 1 with ModeMismatch.
   - Scenario: Fixture report with all cases held as declared → reporter exits 0 and prints parity (no mismatches).
3. Fixture files:
   - report.absent-case.json: minimal vitest report with one case absent from disposition.json.
   - report.missing-replacement.json: report with a retired case whose replacement is not in fork's vitest report.
   - report.all-held.json: report where every case matches its disposition entry (success case).

**Test scenarios:**

- Property test: 1000+ generated disposition/report pairs all satisfy the verdict logic (properties pass).
- Integration: fixture with absent case fails and names the key.
- Integration: fixture with all held cases succeeds and prints parity.
- Integration: fixture with a mismatch fails with the correct violation.

**Verification:**

- Property tests pass with 1000+ shrinks (fast-check default).
- Integration tests run with vitest's default configuration and pass.
- **Sabotage (after all tests pass):** In lane-verdict.workflow.ts, change the mode check to allow any case to pass if it has _any_ passing or skipped state (not matching); the property test for mode-matching fails. Revert.
- **Sabotage (after all tests pass):** In lane-verdict.workflow.ts, drop the check for a retired case's replacement existence; the property for replacement presence fails. Revert.

---

## Verification Contract

### Commands and Quality Gates

**Build and typecheck:**

- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle build` — builds src files with tsc -b.
- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle typecheck` — type-checks the package.
- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle lint` — runs oxlint over the package's own code (must pass the unrelaxed preset).
- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle lint:tsgo` — runs effect-tsgo diagnostics.

**Test and report:**

- `XSTATE_UPSTREAM_SUITE=<nix-store-path> pnpm -r --filter @systemfsoftware/xstate-upstream-oracle test` — runs vitest over both upstream and own projects; outputs .oracle/report.json.
- `pnpm -r --filter @systemfsoftware/xstate-upstream-oracle reports` — invokes bin/lane-report.ts, reads .oracle/report.json and disposition.json, judges the run, prints parity or violations, exits 0 or 1.

**Full upstream-suite run (from CI or nix build):**

- `nix build --rebuild .#xstate-upstream-suite` — builds the suite derivation and verifies reproducibility.
- `nix build .#packages.x86_64-linux.@systemfsoftware/xstate-upstream-oracle` — builds the oracle package (workspace member).
- `pnpm check:local` — runs the full local gate including the oracle lane's tests; must pass before a PR is ready.

### Sabotage Proof

A plan is incomplete without proof that the verification can fail. After all tests pass:

1. **Break document-order conflict resolution in the fork's transition algorithm** (core's transition selection logic). Run the oracle lane; it must fail with held failures named as document-order violations (category 'timing/order'). Revert the break; run again and confirm green.

2. **Break the case-key stability property.** Modify assign-case-keys.workflow.ts to append the report index to each key. Run the property test; it must fail on the stability assertion. Revert.

3. **Break the verdict mode check.** Modify lane-verdict.workflow.ts to allow a passed case to satisfy a declared 'skipped' mode. Run the mode-matching property; it must fail. Revert.

### Exit Criteria

- All oracle package tests (properties, integration, own tests) pass.
- bin/lane-report.ts with the real .oracle/report.json (from the upstream-suite run) exits 0 and prints: "lane holds: 3507 passed, 29 skipped, 3 todo, 2 retired" (counts from upstream-tests.json baseline).
- Per-package parity rows match upstream-tests.json baselines (no " <-- parity mismatch" marks).
- Sabotage proof: each of three breaks is applied, verified to fail, and reverted.
- The two replacement tests (declaration-emit.test.ts at packages/xstate/tests/, propertySuite replacement in packages/xstate-test/tests/) exist in the fork and pass when run in native vitest.

---

## Definition of Done

### Global criteria

- The oracle package is a pnpm workspace member (via `packages/*` glob) and builds cleanly: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:tsgo`, `pnpm mutation` all exit 0.
- All oracle package tests pass: properties, integration, own. No test is skipped or marked xfail.
- The oracle lane runs the upstream suite from the pinned flake input and judges it against the disposition. The lane's output reports per-package counts and exits 0 when all held cases match their modes.
- The two replacement tests (declaration-emit.test.ts at packages/xstate/tests/, propertySuite replacement in packages/xstate-test/tests/) exist in the fork and pass their native vitest runs.
- In-tree upstream test trees are deleted from all six packages, along with each package's upstream-tests.json, tsconfig.upstream-test.json, and the vitest.shared.ts upstream-verbatim project definition and CONST-W3 bypass comment.
- Sabotage proof: three breaks are applied, confirmed to fail the gate, and reverted.
- The commit message cites R4, R5, KTD5, and KTD3 (removal of bypass).

### Per-unit criteria

**U4.1:** Flake builds; xstate-upstream-suite derivation outputs the correct file layout; reproducibility test (nix build --rebuild) passes.

**U4.2:** Oracle package structure exists and is a workspace member; typecheck, build, lint, lint:tsgo, and mutation all succeed; bin/upstream-suite resolves the store path.

**U4.3:** Specifier map covers every xstate and @xstate/* import used by upstream's tests; vitest can resolve each without error; surface exports are minimal and correct.

**U4.4:** Disposition schema encodes and decodes without error; codec-law property tests pass; disposition.json has 3507 held, 2 retired, and six parity rows; both retired entries reference valid files.

**U4.5:** Reporter decodes the vitest JSON report; verdict workflow (CC=1) judges held, retired, and violation cases correctly; bin/lane-report.ts prints parity or violations and exits appropriately.

**U4.6:** Case keys are deterministic and stable across report shuffles; property test passes with 1000+ cases.

**U4.7:** Verdict workflow properties pass; integration fixtures all succeed with the correct outputs; sabotage breaks fail as expected.

### Cleanup

This is an Evaluator surface and adds no dead code. The oracle package is permanent infrastructure. No scaffolding or experimental code is left.

---

## Appendix

### Research and Context

**Upstream pin:** statelyai/xstate `next` branch at `2146ae26ebfc7e6a624b3a1f237f9e6ddc30b9f5`. Upstream has 3507 held cases at the pin (per WIP disposition), plus 2 retired cases (test/declarations.test.ts and test/engine/propertySuite.test.ts).

**Parity baseline (computed from upstream-tests.json):** xstate 145 files / 2420 passed, 29 skipped, 3 todo; xstate-effect 7 files / 135 passed; xstate-test 38 files / 478 passed; xstate-react 8 files / 141 passed; xstate-store 9 files / 294 passed; xstate-store-react 2 files / 24 passed. Total 3471 held cases + 32 skipped + 3 todo (counts are upstream-tests.json only, excluding fork-owned tests).

**WIP reference:** systemfsoftware branch sfs/xstate-oracle-wip at 7bec3d9af1b1f3a (merge commit, lockfile conflict unresolved). Do not build from this branch; use it only to inspect oracle package structure and the disposition schema.

**systemfsoftware dependencies:** The upstream-test drift guard is @systemfsoftware/upstream-manifest (merged in systemfsoftware#632). This repo consumes it through the systemfsoftware flake input and never copies it. Main's flake exports no tarball for it until systemfsoftware#606 (open, head 7b8d8ab) merges. Every guard step in this layer therefore waits on #606: re-pinning the systemfsoftware input to main, adding the guard to the gate, and replacing `upstream-tests.json` with the guard's family record. The suite input, the derivation, the oracle package and the parity and sabotage runs do not wait on it, because the current pin (bb5956b) already serves every other tarball.

**Operator questions to be resolved in review:**

1. (KTD1) Flake input vs git-subtree inPlace kind for suite entry point. Recommended: Flake input. Decision: Operator (Kiro).
2. (KTD2) Oracle package location and mutation enrollment. Recommended: `packages/xstate-upstream-oracle/` with `private: true` and `stryker.config.ts`. Decision: Implicit (no variance expected).
3. (KTD3) Removal of vitest.shared.ts upstream-verbatim project and CONST-W3 bypass. Recommended: Remove in U4. Decision: Operator (Kiro).
