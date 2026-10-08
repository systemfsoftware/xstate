import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { getCurrentScheduler, propertyTest, withScheduledSut } from '../src/index.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

function fetchMachine() {
  return createMachine({
    id: 'fetch',
    initial: 'idle',
    schemas: { events: { FETCH: types<{}>() } },
    states: {
      idle: { on: { FETCH: { target: 'loading' } } },
      loading: {
        invoke: {
          src: 'fetcher',
          onDone: { target: 'success' },
          onError: { target: 'failure' },
        },
      },
      success: {},
      failure: {},
    },
  })
}

describe('concurrent campaigns', () => {
  it('keeps the scheduler of one campaign out of a concurrent campaign’s SUT', function*({ expect }) {
    const scheduledReached = Promise.withResolvers<void>()
    const releaseScheduled = Promise.withResolvers<void>()
    let scheduledSeen: unknown
    const scheduledRun = propertyTest(counterMachine, {
      seed: 7,
      numRuns: 5,
      maxCommands: 3,
      scheduler: true,
      events: { INC: fc.constant({}) },
      sut: withScheduledSut({
        create: () => {
          scheduledSeen = getCurrentScheduler()
          scheduledReached.resolve()
          return releaseScheduled.promise.then(() => ({ send: () => {} }))
        },
      }),
      invariant: () => {},
    })
    yield* Effect.promise(() => scheduledReached.promise)

    let unscheduledSeen: unknown
    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 7,
        numRuns: 1,
        maxCommands: 3,
        events: { INC: fc.constant({}) },
        sut: {
          create: () => {
            unscheduledSeen = getCurrentScheduler()
            return { send: () => {} }
          },
        },
        invariant: () => {},
      })
    )

    releaseScheduled.resolve()
    yield* Effect.promise(() => scheduledRun)

    yield* expect({
      scheduledInstalled: scheduledSeen !== undefined,
      unscheduledSeen,
    }).toEqual({
      scheduledInstalled: true,
      unscheduledSeen: undefined,
    })
  })

  it('resolves outcome stubs only from the campaign that queued the outcomes', function*({ expect }) {
    const okOnly = fc.record({
      ok: fc.constant(true as const),
      output: fc.constant('ok'),
    })
    const errorOnly = fc.record({
      ok: fc.constant(false as const),
      error: fc.constant('boom'),
    })
    const okReached = Promise.withResolvers<void>()
    const releaseOk = Promise.withResolvers<void>()

    const okRun = propertyTest(fetchMachine(), {
      seed: 1,
      numRuns: 60,
      maxCommands: 4,
      mode: 'executed',
      outcomes: { fetcher: okOnly },
      events: { FETCH: fc.constant({}) },
      sut: {
        create: () => {
          okReached.resolve()
          return releaseOk.promise.then(() => ({ send: () => {} }))
        },
      },
      invariant: () => {},
    })
    yield* Effect.promise(() => okReached.promise)

    const errorResult = yield* Effect.promise(() =>
      propertyTest(fetchMachine(), {
        seed: 5,
        numRuns: 60,
        maxCommands: 4,
        mode: 'executed',
        outcomes: { fetcher: errorOnly },
        events: { FETCH: fc.constant({}) },
        invariant: () => {},
      })
    )

    releaseOk.resolve()
    const okResult = yield* Effect.promise(() => okRun)

    yield* expect({
      okCoversFailure: okResult.coverage.stateNodes.covered.includes(
        'fetch.failure',
      ),
      okCoversSuccess: okResult.coverage.stateNodes.covered.includes(
        'fetch.success',
      ),
      errorCoversFailure: errorResult.coverage.stateNodes.covered.includes(
        'fetch.failure',
      ),
      errorCoversSuccess: errorResult.coverage.stateNodes.covered.includes(
        'fetch.success',
      ),
    }).toEqual({
      okCoversFailure: false,
      okCoversSuccess: true,
      errorCoversFailure: true,
      errorCoversSuccess: false,
    })
  })
})
