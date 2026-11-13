# xstate

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/systemfsoftware/xstate/actions/workflows/ci.yml/badge.svg)](https://github.com/systemfsoftware/xstate/actions/workflows/ci.yml)

xstate holds the `@systemfsoftware/xstate*` packages: a fork of [XState](https://github.com/statelyai/xstate) v6, rebuilt on Effect 4. Use them in place of the npm `xstate` package. The goal is upstream's behaviour with an Effect runtime underneath.

## Packages

| Package                                                | What it is                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`@systemfsoftware/xstate`](packages/xstate/README.md) | Statecharts and actors as pure machine definitions and transitions.        |
| `@systemfsoftware/xstate-effect`                       | Effect 4 actors for XState machines: services, scopes, clocks and tracing. |
| `@systemfsoftware/xstate-react`                        | React hooks for XState actors.                                             |
| `@systemfsoftware/xstate-store`                        | Event-driven stores with selectors, undo, persistence and validation.      |
| `@systemfsoftware/xstate-store-react`                  | React hooks for XState stores.                                             |
| `@systemfsoftware/xstate-test`                         | Model-based testing for XState machines.                                   |

## Install

These packages are not on npm. They are distributed as Nix tarballs from [nix.systemfsoftware.com](https://nix.systemfsoftware.com), the registry for `@systemfsoftware` packages.

Add this repository as a flake input, and take its tarballs through [pnpm-release-management](https://github.com/systemfsoftware/pnpm-release-management#distribution-through-nix):

```nix
{
  nixConfig = {
    extra-substituters = "https://nix.systemfsoftware.com";
    extra-trusted-public-keys = "nix-cache-1:wXA8I4DayNW9q6enUyQA/P/nT38pGSTLt374t3gsn7M=";
    fallback = true;
  };

  inputs = {
    nixpkgs.follows = "xstate/nixpkgs";
    xstate.url = "github:systemfsoftware/xstate/<rev>";
    pnpm-release-management.url = "github:systemfsoftware/pnpm-release-management";
  };

  outputs = { self, nixpkgs, xstate, pnpm-release-management }:
    let
      lib = nixpkgs.lib;
      forEachSystem = fn: lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: fn nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (pkgs: rec {
        producer-tarballs = pnpm-release-management.lib.mkProducerTarballs {
          inherit pkgs;
          producers = { inherit xstate; };
        };
        pnpm-store = pnpm-release-management.lib.mkPnpmConsumerStore {
          inherit pkgs;
          src = self;
          files.".deps" = producer-tarballs;
        };
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          shellHook = self.packages.${pkgs.stdenv.hostPlatform.system}.producer-tarballs.shellHook;
        };
      });
    };
}
```

Replace `<rev>` with the commit you pin. Nix only applies `nixConfig` for trusted users or with `--accept-flake-config`.

Each package is a tarball named after its last segment, so `@systemfsoftware/xstate-store` is `xstate-store.tgz`. Point your `package.json` at the ones you use:

```json
{
  "dependencies": {
    "@systemfsoftware/xstate": "file:.deps/xstate.tgz"
  }
}
```

Add `.deps/` to `.gitignore`, then run `pnpm install` inside the dev shell. Third-party peers such as `effect`, `react`, `fast-check`, `vitest` and `zod` install from npm as usual, for the packages you use.

## Quick start

```ts
import { createActor, createMachine } from '@systemfsoftware/xstate'

const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'inactive',
  context: { count: 0 },
  states: {
    inactive: {
      on: { TOGGLE: { target: 'active' } },
    },
    active: {
      entry: ({ context }) => ({
        context: { count: context.count + 1 },
      }),
      on: { TOGGLE: { target: 'inactive' } },
    },
  },
})

const toggleActor = createActor(toggleMachine).start()
toggleActor.send({ type: 'TOGGLE' })

const { value, context } = toggleActor.getSnapshot()
console.log(value, context)
// active { count: 1 }
```

A machine is a plain definition. An actor is a running instance of it, and `send` moves it between states.

## Why a fork

Upstream XState at `2146ae26` is kept in [`subtrees.toml`](subtrees.toml) as reference material only. Nothing builds, tests or type-checks against it. Changes here are made in this repository.

## Contributing

Development setup, the toolchain and the verification gates are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE). XState is © Stately and its contributors, under the MIT License.
