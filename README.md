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

Install the packages you use from npm, with their peers:

```sh
pnpm add @systemfsoftware/xstate
pnpm add @systemfsoftware/xstate-effect @systemfsoftware/xstate 'effect@^4.1.0'
pnpm add @systemfsoftware/xstate-react @systemfsoftware/xstate 'react@^19.3.0'
pnpm add @systemfsoftware/xstate-store @systemfsoftware/xstate
pnpm add @systemfsoftware/xstate-store-react 'react@^19.3.0'
pnpm add -D @systemfsoftware/xstate-test @systemfsoftware/xstate 'effect@^4.1.0' 'fast-check@^4' 'vitest@^5' 'zod@^4'
```

The packages are published under the `latest` tag while the repository is in pre-release, so pnpm resolves their beta versions.

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
