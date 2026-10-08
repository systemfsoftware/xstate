import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createMachine, setup } from '../src/index.js'

function expectType<T>(_v: T) {}

describe('event descriptor keys in `on`', () => {
  const s = setup({
    schemas: {
      events: {
        go: z.object({ to: z.string() }),
        'user.login': z.object({}),
        'user.logout': z.object({}),
      },
      internalEvents: {
        tick: z.object({}),
      },
    },
  })

  it('rejects undeclared event keys when schemas.events is declared (setup)', function*({ expect }) {
    if (false) {
      s.createMachine({
        // @ts-expect-error - `TYPO` is not a declared event type
        on: { TYPO: () => {} },
      })

      s.createMachine({
        on: {
          go: {},
          // @ts-expect-error - `TYPO` is not a declared event type
          TYPO: {},
        },
      })

      s.createMachine({
        on: {
          '*': {},
          // @ts-expect-error - `TYPO` is not a declared event type
          TYPO: {},
        },
      })

      s.createMachine({
        initial: 'a',
        states: {
          a: {
            // @ts-expect-error - `TYPO` is not a declared event type
            on: { TYPO: { target: 'b' } },
          },
          b: {},
        },
      })

      s.createMachine({
        // @ts-expect-error - `oops.*` matches no declared event type
        on: { 'oops.*': {} },
      })
    }

    const machine = s.createMachine({ on: { go: {} } })

    yield* expect(machine.config.on).toEqual({ go: {} })
  })

  it('rejects undeclared event keys when schemas.events is declared (createMachine)', function*({ expect }) {
    if (false) {
      createMachine({
        schemas: { events: { go: z.object({}) } },
        on: {
          // @ts-expect-error - `TYPO` is not a declared event type
          TYPO: () => {},
        },
      })

      createMachine({
        schemas: { events: { go: z.object({}) } },
        on: {
          go: {},
          // @ts-expect-error - `TYPO` is not a declared event type
          TYPO: {},
        },
      })

      createMachine({
        schemas: { events: { go: z.object({}) } },
        initial: 'a',
        states: {
          a: {
            // @ts-expect-error - `TYPO` is not a declared event type
            on: { TYPO: {} },
          },
        },
      })
    }

    const machine = createMachine({
      schemas: { events: { go: z.object({}) } },
      on: { go: {} },
    })

    yield* expect(machine.config.on).toEqual({ go: {} })
  })

  it('accepts declared, internal, wildcard and xstate.* descriptors', function*({ expect }) {
    s.createMachine({
      on: {
        go: ({ event }) => {
          expectType<string>(event.to)
        },
        tick: {},
        'user.*': {},
        '*': {},
        'xstate.done.actor': {},
        'xstate.error.actor': {},
        'xstate.error.actor.*': ({ event }) => {
          expectType<`xstate.${string}`>(event.type)
        },
        'xstate.custom.*': {},
        'xstate.done.state': {},
        'xstate.after': {},
      },
    })

    const machine = createMachine({
      schemas: { events: { go: z.object({}) } },
      on: { go: {}, '*': {}, 'xstate.done.actor': {} },
    })

    yield* expect(machine.config.on).toEqual({ go: {}, '*': {}, 'xstate.done.actor': {} })
  })

  it('checks state configs without rejecting reserved descriptors', function*({ expect }) {
    const stateConfig = s.createStateConfig({
      on: {
        'xstate.error.actor.*': ({ event }) => {
          expectType<string>(event.type)
        },
      },
    })
    if (false) {
      s.createStateConfig({
        on: {
          go: {},
          // @ts-expect-error undeclared event beside a declared event
          TYPO: {},
        },
      })
    }

    yield* expect(Object.keys(stateConfig)).toEqual(['on'])
  })

  it('stays permissive without schemas.events', function*({ expect }) {
    setup({}).createMachine({ on: { anything: () => {} } })
    createMachine({
      on: {
        anything: () => {},
        'xstate.done.actor.child': ({ children, event }, enq) => {
          expectType<string>(event.type)
          expectType<unknown>(children)
          expectType<Function>(enq)
        },
      },
    })
    const machine = setup({
      schemas: { internalEvents: { tick: z.object({}) } },
    }).createMachine({ on: { anything: {} } })

    yield* expect(machine.config.on).toEqual({ anything: {} })
  })
})
