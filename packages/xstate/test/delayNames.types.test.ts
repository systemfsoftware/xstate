import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, initialTransition, setup } from '../src/index.js'

describe('delay names in `after`', () => {
  it('rejects undeclared delay names when delays are declared', function*({ expect }) {
    if (false) {
      setup({ delays: { short: 100 } }).createMachine({
        initial: 'a',
        states: {
          a: {
            after: {
              // @ts-expect-error - `unknownDelay` is not a declared delay
              unknownDelay: { target: 'b' },
            },
          },
          b: {},
        },
      })

      createMachine({
        delays: { short: 100 },
        initial: 'a',
        states: {
          a: {
            after: {
              // @ts-expect-error - `unknownDelay` is not a declared delay
              unknownDelay: { target: 'b' },
            },
          },
          b: {},
        },
      })
    }

    const machine = setup({ delays: { short: 100 } }).createMachine({
      initial: 'a',
      states: { a: { after: { short: { target: 'b' } } }, b: {} },
    })

    yield* expect(initialTransition(machine)[0].value).toEqual('a')
  })

  it('accepts declared names, numbers and duration strings', function*({ expect }) {
    const machine = setup({ delays: { short: 100 } }).createMachine({
      initial: 'a',
      states: {
        a: {
          after: {
            short: { target: 'b' },
            1000: { target: 'b' },
            '250ms': { target: 'b' },
            '1.5s': { target: 'b' },
            PT1M30S: { target: 'b' },
          },
        },
        b: {},
      },
    })

    createMachine({
      delays: { short: 100 },
      initial: 'a',
      states: {
        a: { after: { short: { target: 'b' }, '5s': { target: 'b' } } },
        b: {},
      },
    })

    setup({ delays: { short: 100 } })
      .extend({ delays: { long: 500 } })
      .createMachine({
        initial: 'a',
        states: {
          a: { after: { short: { target: 'b' }, long: { target: 'b' } } },
          b: {},
        },
      })

    yield* expect(initialTransition(machine)[0].value).toEqual('a')
  })

  it('stays permissive without declared delays', function*({ expect }) {
    const machine = setup({}).createMachine({
      initial: 'a',
      states: { a: { after: { anything: { target: 'b' } } }, b: {} },
    })
    createMachine({
      initial: 'a',
      states: { a: { after: { anything: { target: 'b' } } }, b: {} },
    })

    yield* expect(Object.keys(machine.root.states)).toEqual(['a', 'b'])
  })

  it('rejects malformed duration strings', function*({ expect }) {
    if (false) {
      setup({ delays: { short: 100 } }).createMachine({
        initial: 'a',
        states: {
          a: {
            after: {
              // @ts-expect-error - not an ISO 8601 duration
              Pfoo: { target: 'b' },
            },
          },
          b: {},
        },
      })

      setup({ delays: { short: 100 } }).createMachine({
        initial: 'a',
        states: {
          a: {
            after: {
              // @ts-expect-error - milliseconds must be an integer
              '1.5ms': { target: 'b' },
            },
          },
          b: {},
        },
      })

      setup({ delays: { short: 100 } }).createMachine({
        initial: 'a',
        states: {
          a: {
            after: {
              // @ts-expect-error - exponents are not parsed
              '1e3s': { target: 'b' },
            },
          },
          b: {},
        },
      })
    }

    const machine = setup({ delays: { short: 100 } }).createMachine({
      initial: 'a',
      states: { a: { after: { short: { target: 'b' } } }, b: {} },
    })

    yield* expect(initialTransition(machine)[0].value).toEqual('a')
  })

  it('accepts the duration forms the runtime parses', function*({ expect }) {
    const machine = setup({ delays: { short: 100 } }).createMachine({
      initial: 'a',
      states: {
        a: {
          after: {
            '1000': { target: 'b' },
            '250MS': { target: 'b' },
            '1s': { target: 'b' },
            '1S': { target: 'b' },
            '1.05s': { target: 'b' },
            '.5s': { target: 'b' },
            PT1M30S: { target: 'b' },
            'PT0.5S': { target: 'b' },
            PT2H: { target: 'b' },
            P1D: { target: 'b' },
            P1W: { target: 'b' },
            P1DT12H: { target: 'b' },
            PT1H2M3S: { target: 'b' },
          },
        },
        b: {},
      },
    })

    yield* expect(initialTransition(machine)[0].value).toEqual('a')
  })
})
