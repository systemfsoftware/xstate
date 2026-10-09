# xstate

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Effect: 4.0](https://img.shields.io/badge/Effect-4.0-purple.svg)](https://effect.website)
[![CI](https://github.com/systemfsoftware/xstate/actions/workflows/ci.yml/badge.svg)](https://github.com/systemfsoftware/xstate/actions/workflows/ci.yml)

**xstate** holds the `@systemfsoftware/xstate*` packages: systemfsoftware's own fork of [XState](https://github.com/statelyai/xstate) v6, rebuilt on Effect 4. Systemfsoftware's projects install these packages in place of npm `xstate`.

## Why a fork

Upstream XState is the reference, not a dependency: the fork keeps upstream's observable behaviour while its runtime runs on Effect. Nothing here sends changes back to `statelyai/xstate`.

## Install

The packages are not published to a registry. Releases are git tags and GitHub Releases, and this repository's Nix flake builds each package's tarball:

```bash
# every public package, plus index.json mapping each name to its tarball
nix build github:systemfsoftware/xstate#workspace-tarballs
```

Each package is also its own flake attribute, named after the last segment of its package name, so `@systemfsoftware/xstate-store` builds as `#xstate-store`. Point a pnpm catalog entry at the tarball with a `file:` specifier.

## Toolchain

| Tool                    | Role                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| **Nix**                 | Pins Node.js 24, pnpm 12.9.0, Deno and dprint, and builds the package tarballs     |
| **Sandbox**             | pnpm-release-management's deny-by-default launcher; all dependency code runs in it |
| **pnpm + Turbo**        | Workspace catalog with exact pins, cached task graph                               |
| **TypeScript 7 (tsgo)** | Typechecking through `@effect/tsgo`                                                |
| **oxlint**              | The `@systemfsoftware/oxlint-config-recommended` preset, at error severity         |
| **Vitest**              | Unit and integration tests                                                         |
| **Stryker**             | Mutation testing at a break threshold of 100, on `main` only (the release gate)    |
| **dprint**              | Formatting for code and Markdown                                                   |

## Contributing

Development setup, the sandbox, and the verification gates are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache-2.0 License](LICENSE). XState is © Stately and its contributors, under the MIT License.
