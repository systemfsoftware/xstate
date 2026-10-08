import { describe, it } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { ModelTestFailure, replayTest, type TestCoverage, testPaths } from '../../src/engine/index.js'
import { constant } from './propertyTestAdapter.js'

const pay = createAsyncLogic({
  run: () => Promise.reject(new Error('the real `pay` actor ran')),
})

const checkoutMachine = createMachine({
  id: 'checkout',
  schemas: {
    context: types<{ receipt: unknown; failure: string | null }>(),
    events: { CHECKOUT: types<{}>() },
  },
  actors: { pay },
  context: { receipt: null, failure: null },
  initial: 'shopping',
  states: {
    shopping: { on: { CHECKOUT: { target: 'paying' } } },
    paying: {
      invoke: {
        src: 'pay',
        onDone: ({ context, event }) => ({
          target: 'done',
          context: { ...context, receipt: event.output },
        }),
        onError: ({ context, event }) => ({
          target: 'shopping',
          context: { ...context, failure: String(event.error) },
        }),
      },
    },
    done: { type: 'final' },
  },
})

const timerMachine = createMachine({
  id: 'timer',
  initial: 'waiting',
  states: {
    waiting: { after: { 5000: { target: 'expired' } } },
    expired: {},
  },
})

const namedDelayMachine = createMachine({
  id: 'namedTimer',
  initial: 'waiting',
  delays: { long: 1000 },
  states: {
    waiting: { after: { long: { target: 'expired' } } },
    expired: {},
  },
})

const computedDelayMachine = createMachine({
  id: 'computedTimer',
  initial: 'waiting',
  delays: { later: () => 1000 },
  states: {
    waiting: { after: { later: { target: 'expired' } } },
    expired: {},
  },
})

const events = { CHECKOUT: constant({}) }

function covered(coverage: TestCoverage, fragment: string): boolean {
  return coverage.transitions.covered.some((id) => id.includes(fragment))
}

describe('testPaths with invoke and `after` branches', () => {
  it('covers both invoke branches in executed mode', function*({ expect }) {
    const { coverage, results } = yield* Effect.promise(() =>
      testPaths(checkoutMachine, {
        mode: 'executed',
        events,
      })
    )

    yield* expect({
      allPassed: results.every(({ passed }) => passed),
      doneActorCovered: covered(coverage, 'xstate.done.actor'),
      errorActorCovered: covered(coverage, 'xstate.error.actor'),
      uncovered: coverage.transitions.uncovered,
      clockAdvances: coverage.clockAdvances,
    }).toEqual({
      allPassed: true,
      doneActorCovered: true,
      errorActorCovered: true,
      uncovered: [],
      clockAdvances: 0,
    })
  })

  it('routes sampled `outcomes` through the branch that took them', function*({ expect }) {
    const receipts: unknown[] = []
    const failures: string[] = []
    const { coverage } = yield* Effect.promise(() =>
      testPaths(checkoutMachine, {
        mode: 'executed',
        samples: 1,
        events,
        outcomes: {
          pay: () => ({ ok: true, output: { receiptId: 'rcpt_1' } }),
        },
        invariant: ({ snapshot }) => {
          const { receipt, failure } = snapshot.context
          if (receipt !== null) {
            receipts.push(receipt)
          }
          if (failure !== null) {
            failures.push(failure)
          }
        },
      })
    )

    yield* expect({
      receipts,
      generatedFailure: failures.some((failure) => /generated failure/.test(failure)),
      uncovered: coverage.transitions.uncovered,
    }).toEqual({
      receipts: expect.arrayContaining([{ receiptId: 'rcpt_1' }]),
      generatedFailure: true,
      uncovered: [],
    })
  })

  it('sends the internal events directly in pure mode', function*({ expect }) {
    const sent: string[] = []
    const { coverage } = yield* Effect.promise(() =>
      testPaths(checkoutMachine, {
        events,
        outcomes: {
          pay: () => ({ ok: true, output: { receiptId: 'rcpt_2' } }),
        },
        sut: {
          create: () => ({
            send: (event) => {
              sent.push(event.type)
            },
          }),
        },
      })
    )

    yield* expect({
      sentDone: sent.includes('xstate.done.actor'),
      sentError: sent.includes('xstate.error.actor'),
      uncovered: coverage.transitions.uncovered,
      clockAdvances: coverage.clockAdvances,
    }).toEqual({
      sentDone: true,
      sentError: true,
      uncovered: [],
      clockAdvances: 0,
    })
  })

  it('rejects an `outcomes` generator that does not produce an outcome', function*({ expect }) {
    const error = yield* Effect.promise(() =>
      testPaths(checkoutMachine, {
        events,
        outcomes: { pay: () => ({ output: 1 }) },
      } as never).then(
        () => undefined,
        (cause: unknown) => cause,
      )
    )

    yield* expect({
      message: error instanceof Error ? error.message : undefined,
    }).toEqual({
      message:
        'The `outcomes` generator for "pay" produced {"output":1} instead of an actor outcome. Generate `{ ok: true, output }` or `{ ok: false, error }`.',
    })
  })

  it('reaches an `after` transition with a generated advance', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() => testPaths(timerMachine, { mode: 'executed' }))

    yield* expect({
      afterCovered: covered(coverage, 'xstate.after'),
      uncovered: coverage.transitions.uncovered,
      clockAdvances: coverage.clockAdvances,
    }).toEqual({ afterCovered: true, uncovered: [], clockAdvances: 1 })
  })

  it('resolves a named delay from the machine', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      testPaths(namedDelayMachine, {
        mode: 'executed',
      })
    )

    yield* expect({
      afterCovered: covered(coverage, 'xstate.after'),
      uncovered: coverage.transitions.uncovered,
    }).toEqual({ afterCovered: true, uncovered: [] })
  })

  it('advances to a delay computed at runtime', function*({ expect }) {
    const { coverage, results } = yield* Effect.promise(() =>
      testPaths(computedDelayMachine, {
        mode: 'executed',
      })
    )

    yield* expect({
      allPassed: results.every(({ passed }) => passed),
      afterCovered: covered(coverage, 'xstate.after'),
    }).toEqual({ allPassed: true, afterCovered: true })
  })

  it('replays an executed path fixture without the real service', function*({ expect }) {
    const failing = {
      mode: 'executed' as const,
      events,
      sut: {
        create: () => ({
          send: () => {},
          read: () => 'wrong',
        }),
        projectModel: () => 'right',
      },
    }
    const failure = (yield* Effect.promise(() =>
      testPaths(checkoutMachine, failing).catch((error) => error)
    )) as ModelTestFailure

    yield* expect({
      modelFailure: failure instanceof ModelTestFailure,
      fixtureFormatVersion: failure.fixture?.formatVersion,
      strategy: failure.coverage?.exploration.strategy,
    }).toEqual({
      modelFailure: true,
      fixtureFormatVersion: 2,
      strategy: 'paths',
    })

    const replayError = yield* Effect.promise(() =>
      replayTest(checkoutMachine, failure.fixture!, {
        sut: failing.sut,
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
    )

    yield* expect({
      replayFailedWithModelTestFailure: replayError instanceof ModelTestFailure,
    }).toEqual({ replayFailedWithModelTestFailure: true })
  })
})
