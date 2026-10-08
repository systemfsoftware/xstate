import { describe, it } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { fastCheckAdapter, ModelTestFailure, propertyTest, replayTest } from '../src/index.js'
import type { TestFixture } from '../src/index.js'

const outcomeArbitrary = fc.oneof(
  fc.record({ ok: fc.constant(true as const), output: fc.integer() }),
  fc.record({ ok: fc.constant(false as const), error: fc.constant('boom') }),
)

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

function incrementedCount(args: unknown): number {
  if (args !== null && typeof args === 'object' && 'context' in args) {
    const context = args.context
    if (
      context !== null && typeof context === 'object' && 'count' in context &&
      typeof context.count === 'number'
    ) {
      return context.count + 1
    }
  }
  throw new Error('expected a context carrying a numeric count')
}

function observedCountOf(args: unknown): number {
  if (args !== null && typeof args === 'object' && 'event' in args) {
    const event = args.event
    if (event !== null && typeof event === 'object' && 'snapshot' in event) {
      const snapshot = event.snapshot
      if (
        snapshot !== null && typeof snapshot === 'object' && 'context' in snapshot
      ) {
        const context = snapshot.context
        if (
          context !== null && typeof context === 'object' && 'count' in context &&
          typeof context.count === 'number'
        ) {
          return context.count
        }
      }
    }
  }
  throw new Error('expected a snapshot event whose context carries a numeric count')
}

describe('executed mode', () => {
  it('covers both invoke branches through generated outcomes', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(fetchMachine(), {
        seed: 4,
        numRuns: 60,
        maxCommands: 4,
        mode: 'executed',
        outcomes: { fetcher: outcomeArbitrary },
        events: { FETCH: fc.constant({}) },
        invariant: () => {},
      })
    )

    yield* expect({
      mode: coverage.exploration.mode,
      covered: coverage.stateNodes.covered,
      uncovered: coverage.transitions.uncovered,
    }).toEqual({
      mode: 'executed',
      covered: expect.arrayContaining(['fetch.success', 'fetch.failure']),
      uncovered: [],
    })
  })

  it('reaches a delayed transition with generated advance commands', function*({ expect }) {
    const machine = createMachine({
      id: 'timeout',
      initial: 'idle',
      schemas: { events: { START: types<{}>() } },
      states: {
        idle: { on: { START: { target: 'waiting' } } },
        waiting: { after: { 500: { target: 'expired' } } },
        expired: {},
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 9,
        numRuns: 60,
        maxCommands: 4,
        mode: 'executed',
        events: { START: fc.constant({}) },
        commands: { advance: fc.integer({ min: 100, max: 900 }) },
        invariant: () => {},
      })
    )

    yield* expect(coverage.stateNodes.covered).toContain('timeout.expired')
  })

  it('runs an invoked child actor and reports its snapshots', function*({ expect }) {
    const ticker = createMachine({
      id: 'ticker',
      context: { count: 0 },
      initial: 'ticking',
      states: {
        ticking: {
          after: {
            100: (args: unknown) => ({
              target: 'ticking',
              context: { count: incrementedCount(args) },
            }),
          },
        },
      },
    })

    const machine = createMachine({
      id: 'parent',
      initial: 'running',
      context: { observed: 0 },
      schemas: { events: { NOOP: types<{}>() } },
      states: {
        running: {
          invoke: {
            id: 'ticker',
            src: 'ticker',
            onSnapshot: (args: unknown) => ({
              context: { observed: observedCountOf(args) },
            }),
          },
          on: { NOOP: {} },
        },
      },
    })

    let maxObserved = 0
    yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 2,
        numRuns: 20,
        maxCommands: 4,
        mode: 'executed',
        actors: { ticker },
        events: { NOOP: fc.constant({}) },
        commands: { advance: fc.integer({ min: 100, max: 300 }) },
        invariant: ({ snapshot }) => {
          maxObserved = Math.max(maxObserved, snapshot.context.observed)
        },
      })
    )

    yield* expect(maxObserved).toSatisfy(
      (value) => value > 0,
      'a child snapshot with a positive observed count was reported',
    )
  })

  it('replays an executed failure without the real service', function*({ expect }) {
    const machine = fetchMachine()
    let calls = 0

    const failure = (yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 6,
        numRuns: 20,
        maxCommands: 3,
        mode: 'executed',
        actors: {
          fetcher: createAsyncLogic({
            run: () => {
              calls++
              return Promise.resolve('ok')
            },
          }),
        },
        events: { FETCH: fc.constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'success') {
            throw new Error('reached success')
          }
        },
      }).catch((cause) => cause)
    )) as ModelTestFailure

    const fixture = failure.fixture as TestFixture
    yield* expect({
      isFailure: failure instanceof ModelTestFailure,
      fixtureMachineId: fixture.machine?.id,
      mode: fixture.mode,
      summaryMatchesInvariantFailure: /^Property invariant failed after \d+ steps?$/.test(failure.summary),
      hasOutcome: (fixture.outcomes?.length ?? 0) > 0,
    }).toEqual({
      isFailure: true,
      fixtureMachineId: 'fetch',
      mode: 'executed',
      summaryMatchesInvariantFailure: true,
      hasOutcome: true,
    })

    calls = 0
    const replayError = yield* Effect.promise(() =>
      replayTest(machine, fixture, {
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'success') {
            throw new Error('reached success')
          }
        },
      }).then(
        () => undefined,
        (error) => error,
      )
    )

    yield* expect({
      replayFailed: replayError instanceof ModelTestFailure,
      calls,
    }).toEqual({ replayFailed: true, calls: 0 })
  })

  it('is deterministic for one seed', function*({ expect }) {
    const run = (): Promise<unknown[]> => {
      const values: unknown[] = []
      return propertyTest(fetchMachine(), {
        seed: 13,
        numRuns: 25,
        maxCommands: 4,
        mode: 'executed',
        outcomes: { fetcher: outcomeArbitrary },
        events: { FETCH: fc.constant({}) },
        invariant: ({ snapshot }) => {
          values.push(snapshot.value)
        },
      }).then(() => values)
    }

    const first = yield* Effect.promise(() => run())
    const second = yield* Effect.promise(() => run())
    yield* expect({ first }).toEqual({ first: second })
  })
})
