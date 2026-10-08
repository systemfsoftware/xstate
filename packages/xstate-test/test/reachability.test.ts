import { describe } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { fastCheckAdapter, propertyTest } from '../src/index.js'

const adapter = () => fastCheckAdapter({ seed: 42, numRuns: 25, maxCommands: 6 })

const noop = () => {}

describe('static reachability of property coverage', (it) => {
  const historyMachine = createMachine({
    id: 'hist',
    initial: 'outside',
    states: {
      outside: {
        on: {
          ENTER: { target: 'group' },
          RESUME: { target: 'group.recall' },
        },
      },
      group: {
        initial: 'entry',
        states: {
          entry: { on: { LEAVE: { target: '#hist.outside' } } },
          restored: {},
          recall: { type: 'history', target: 'restored' },
        },
      },
    },
  })

  it('treats history default targets as reachable when never entered', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(historyMachine, {
        adapter: adapter(),
        events: { ENTER: fc.constant({}), LEAVE: fc.constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      unreachable: coverage.stateNodes.unreachable,
      uncovered: coverage.stateNodes.uncovered,
    }).toEqual({
      unreachable: expect.not.arrayContaining(['hist.group.restored']),
      uncovered: expect.arrayContaining(['hist.group.restored']),
    })
  })

  it('covers history default targets once the history node is entered', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(historyMachine, {
        adapter: adapter(),
        events: {
          ENTER: fc.constant({}),
          LEAVE: fc.constant({}),
          RESUME: fc.constant({}),
        },
        invariant: noop,
      })
    )

    yield* expect(coverage.stateNodes.covered).toContain('hist.group.restored')
  })

  it('treats invoke onDone/onError targets as reachable', function*({ expect }) {
    const machine = createMachine({
      id: 'inv',
      initial: 'loading',
      states: {
        loading: {
          on: { PING: { target: 'loading' } },
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve(1) }),
            onDone: { target: 'success' },
            onError: { target: 'failure' },
          },
        },
        success: {},
        failure: {},
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: adapter(),
        events: { PING: fc.constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      unreachable: coverage.stateNodes.unreachable,
      uncovered: coverage.stateNodes.uncovered,
    }).toEqual({
      unreachable: [],
      uncovered: expect.arrayContaining(['inv.failure', 'inv.success']),
    })
  })

  it('treats compound onDone targets as reachable', function*({ expect }) {
    const machine = createMachine({
      id: 'done',
      initial: 'work',
      states: {
        work: {
          initial: 'step',
          states: {
            step: { on: { FINISH: { target: 'complete' } } },
            complete: { type: 'final' },
          },
          onDone: { target: 'wrapUp' },
        },
        wrapUp: {},
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: adapter(),
        events: { FINISH: fc.constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      unreachable: coverage.stateNodes.unreachable,
      covered: coverage.stateNodes.covered,
    }).toEqual({
      unreachable: [],
      covered: expect.arrayContaining(['done.wrapUp']),
    })
  })

  it('treats `after` delayed transition targets as reachable', function*({ expect }) {
    const machine = createMachine({
      id: 'delay',
      initial: 'waiting',
      states: {
        waiting: {
          on: { PING: { target: 'waiting' } },
          after: { 1000: { target: 'timedOut' } },
        },
        timedOut: {},
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: adapter(),
        events: { PING: fc.constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      unreachable: coverage.stateNodes.unreachable,
      uncovered: coverage.stateNodes.uncovered,
    }).toEqual({
      unreachable: [],
      uncovered: expect.arrayContaining(['delay.timedOut']),
    })
  })

  it('treats parallel regions and `always` targets as reachable', function*({ expect }) {
    const machine = createMachine({
      id: 'par',
      type: 'parallel',
      states: {
        left: {
          initial: 'idle',
          states: {
            idle: { on: { GO: { target: 'gate' } } },
            gate: { always: { target: 'settled' } },
            settled: {},
          },
        },
        right: {
          initial: 'watching',
          states: { watching: {} },
        },
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: adapter(),
        events: { GO: fc.constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      unreachable: coverage.stateNodes.unreachable,
      covered: coverage.stateNodes.covered,
    }).toEqual({
      unreachable: [],
      covered: expect.arrayContaining(['par.right.watching', 'par.left.settled']),
    })
  })

  it('still reports genuinely orphaned state nodes as unreachable', function*({ expect }) {
    const machine = createMachine({
      id: 'orphan',
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b' } } },
        b: {},
        island: {},
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: adapter(),
        events: { GO: fc.constant({}) },
        invariant: noop,
      })
    )

    yield* expect(coverage.stateNodes.unreachable).toEqual(['orphan.island'])
  })
})
