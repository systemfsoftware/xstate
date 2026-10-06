# xstate

The `@systemfsoftware/xstate*` packages: systemfsoftware's owned fork of XState v6 on Effect 4.

## Boundaries

| Surface            | Examples                                     | Limit                                                  |
| ------------------ | -------------------------------------------- | ------------------------------------------------------ |
| **Evaluator**      | `commitlint.config.ts`, `.github/workflows/` | Read-only; never edit the instrument that grades work. |
| **Doctrine**       | `CONSTITUTION.md`, `subtrees.toml`           | Project law; edit only on deliberate direction.        |
| **Vendored**       | `repos/**`                                   | Read-only; updated via git subtree, never hand-edited. |
| **Human approval** | Releases, publishing, external credentials   | User-confirmed only.                                   |
| **Editable**       | Workspace source, tests, documentation       | Edit freely.                                           |

## Definition of Done

| ID        | Rule                                                | Gate                |
| --------- | --------------------------------------------------- | ------------------- |
| `START-1` | Formatting passes dprint with no diffs              | `pnpm format:check` |
| `START-2` | Typechecking succeeds workspace-wide with no errors | `pnpm typecheck`    |
| `START-3` | All test suites pass                                | `pnpm test`         |
| `START-4` | Full CI validation passes before completion         | `pnpm check:ci`     |

Turbo declares `dist/**` as each package's build output; `pnpm gate:dist` runs
that build. `nix build .#workspace-tarballs` packs every package listed in
`release-set.json` through pnpm-release-management's `mkPnpmWorkspacePackages`.
Every workspace package is `"private": true`, since nothing here is published to
npm. Gate: the Changeset Check workflow's `scripts/check-changeset.ts` refuses a
workspace package that is not private.

## Working Rules

| ID           | Rule                                                                                                                                                                                                             | Gate                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **REPO-W10** | Clearing a lint diagnostic meets the rule's intent at that site. No hoisting code out of the rule's view, no type-only overloads the runtime cannot reach, and no keyword swaps that keep the same control flow. | `review` — wrong: a flagged `if` becomes a `?:` or moves into an unlinted helper; right: the branch becomes a dispatch over a closed type |

## CI

- Every job runs on GitHub-hosted runners: `ubuntu-latest`, and `macos-latest` for the macOS `check:ci` leg. This repository is public, and the org's self-hosted fleet runner group admits only private repositories (fork safety), so a `[self-hosted, systemfsoftware-runner, *]` job here queues forever. Gate: review of the workflow diff.
- Heavy suites split across parallel hosted jobs instead of a larger runner: Linux `check:ci` runs as one job per part (format, lint, typecheck, test, dist), and mutation on `main` runs one job per package. Gate: review of the workflow diff.

## End of Session

Commit changes using conventional commits (`<type>(<scope>): <subject>`). Ensure the working tree is clean and `pnpm check:ci` passes.
