import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, initialTransition, SimulatedClock, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { getPathsFromEvents } from '@systemfsoftware/xstate/graph'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { ModelTestFailure, propertyTest, replayTest } from '../src/index.js'

const counterMachine = createMachine({
  schemas: {
    context: types<{ count: number }>(),
    events: {
      INC: types<{ value: number }>(),
      RESET: types<{}>(),
    },
  },
  context: { count: 0 },
  on: {
    INC: ({ context, event }) => ({
      context: { count: context.count + event.value },
    }),
    RESET: () => ({ context: { count: 0 } }),
  },
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>

function requireEqual(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, observed ${actual}`)
  }
}

function requireBelow(actual: number, bound: number): void {
  if (!(actual < bound)) {
    throw new Error(`expected a value below ${bound}, observed ${actual}`)
  }
}

const awaited = <A>(call: () => A | Promise<A>): Effect.Effect<A> => Effect.promise(() => Promise.resolve().then(call))

const failureOf = <A>(call: () => A | Promise<A>): Effect.Effect<unknown> =>
  Effect.promise(() =>
    Promise.resolve()
      .then(call)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
  )

describe('propertyTest with FastCheck', () => {
  it('accepts machines and checks every macrostep', function*({ expect }) {
    const observed: {
      runs: number
      checkedAtLeastFive: boolean
      invariantChecks: number
      activePositive: boolean
    }[] = []
    const checked: number[] = []
    for (const source of [counterMachine]) {
      const result = yield* awaited(() =>
        propertyTest(source, {
          seed: 42,
          numRuns: 5,
          maxCommands: 3,
          events: {
            INC: fc.record({ value: fc.integer({ min: 0, max: 2 }) }),
            RESET: fc.constant({}),
          },
          invariant: ({ snapshot }) => {
            checked.push(snapshot.context.count)
          },
        })
      )

      observed.push({
        runs: result.coverage.runs,
        checkedAtLeastFive: checked.length >= 5,
        invariantChecks: result.coverage.invariantChecks,
        activePositive: (result.coverage.statuses.counts['active'] ?? 0) > 0,
      })
    }

    yield* expect(observed).toEqual([
      {
        runs: 5,
        checkedAtLeastFive: true,
        invariantChecks: checked.length,
        activePositive: true,
      },
    ])
  })

  it('reuses sut executors and state assertions with a fresh session per run', function*({ expect }) {
    const model = counterMachine
    let created = 0
    let disposed = 0
    let active = 0
    let eventExecutions = 0
    const sutCounts: number[] = []
    const modelCounts: number[] = []

    yield* awaited(() =>
      propertyTest(model, {
        seed: 42,
        numRuns: 5,
        maxCommands: 3,
        events: {
          INC: fc.constant({ value: 1 }),
        },
        sut: {
          create: () => {
            created++
            active++
            let count = 0
            return {
              send: (event) => {
                eventExecutions++
                if (event.type === 'INC') {
                  count += event.value
                }
              },
              states: {
                '*': (snapshot: CounterSnapshot) => {
                  sutCounts.push(count)
                  modelCounts.push(snapshot.context.count)
                },
              },
              dispose: () => {
                disposed++
                active--
              },
            }
          },
        },
        invariant: () => {},
      })
    )

    yield* expect({
      created,
      disposed,
      active,
      eventExecutionsPositive: eventExecutions > 0,
      sutCounts,
      assertions: sutCounts.length,
    }).toEqual({
      created: 5,
      disposed: 5,
      active: 0,
      eventExecutionsPositive: true,
      sutCounts: modelCounts,
      assertions: eventExecutions + created,
    })
  })

  it('disposes sut sessions across failure shrinking', function*({ expect }) {
    const model = counterMachine
    let created = 0
    let disposed = 0
    const observed: { sut: number; model: number }[] = []

    const failure = (yield* failureOf(() =>
      propertyTest(model, {
        seed: 12,
        numRuns: 20,
        maxCommands: 5,
        events: { INC: fc.constant({ value: 1 }) },
        sut: {
          create: () => {
            created++
            let count = 0
            return {
              send: () => {},
              states: {
                '*': (snapshot: CounterSnapshot) => {
                  observed.push({
                    sut: count,
                    model: snapshot.context.count,
                  })
                  requireEqual(count, snapshot.context.count)
                },
              },
              dispose: () => {
                disposed++
              },
            }
          },
        },
        invariant: () => {},
      })
    )) as ModelTestFailure

    yield* expect({
      failureClass: failure.constructor,
      traceEvents: failure.trace.events,
      sawDivergence: observed.some((entry) => entry.sut !== entry.model),
      createdMoreThanOne: created > 1,
      disposed,
    }).toEqual({
      failureClass: ModelTestFailure,
      traceEvents: [{ type: 'INC', value: 1 }],
      sawDivergence: true,
      createdMoreThanOne: true,
      disposed: created,
    })
  })

  it('shrinks failures and exposes replay metadata', function*({ expect }) {
    const counts: number[] = []
    const run = () =>
      propertyTest(counterMachine, {
        seed: 123,
        numRuns: 20,
        maxCommands: 10,
        events: {
          INC: fc.record({ value: fc.integer({ min: 1, max: 1_000 }) }),
        },
        invariant: ({ snapshot }) => {
          counts.push(snapshot.context.count)
          requireBelow(snapshot.context.count, 10)
        },
      })

    const error = (yield* failureOf(run)) as ModelTestFailure

    yield* expect({
      failureClass: error.constructor,
      traceStepsPositive: error.trace.steps.length > 0,
      replayEngine: error.replay?.engine,
      replaySeed: error.replay?.seed,
      replayPath: error.replay?.path,
      invariantSawOverBound: counts.some((count) => count >= 10),
    }).toEqual({
      failureClass: ModelTestFailure,
      traceStepsPositive: true,
      replayEngine: 'fast-check',
      replaySeed: expect.any(Number),
      replayPath: expect.any(String),
      invariantSawOverBound: true,
    })
  })

  it('does not execute returned effects', function*({ expect }) {
    let executed = 0
    const machine = createMachine({
      on: {
        GO: (_, enq) => enq(() => executed++),
      },
    })

    yield* awaited(() =>
      propertyTest(machine, {
        seed: 1,
        numRuns: 5,
        maxCommands: 5,
        events: { GO: fc.constant({}) },
        invariant: () => {},
      })
    )

    yield* expect(executed).toBe(0)
  })

  it('creates portable fixtures that replay without FastCheck', function*({ expect }) {
    const error = (yield* failureOf(() =>
      propertyTest(counterMachine, {
        seed: 123,
        numRuns: 20,
        maxCommands: 10,
        events: {
          INC: fc.record({ value: fc.integer({ min: 1, max: 1_000 }) }),
        },
        invariant: ({ snapshot }) => {
          requireBelow(snapshot.context.count, 10)
        },
      })
    )) as ModelTestFailure

    const replayed = (yield* failureOf(() =>
      replayTest(counterMachine, error.fixture!, {
        invariant: ({ snapshot }) => {
          requireBelow(snapshot.context.count, 10)
        },
      })
    )) as ModelTestFailure

    yield* expect({
      fixtureFormatVersion: error.fixture?.formatVersion,
      fixtureFailedAt: error.fixture?.failedAt,
      replayedClass: replayed.constructor,
      replayedSteps: replayed.trace.steps.length,
    }).toEqual({
      fixtureFormatVersion: 2,
      fixtureFailedAt: 1,
      replayedClass: ModelTestFailure,
      replayedSteps: error.trace.steps.length,
    })
  })

  it('starts from an explicitly serializable snapshot', function*({ expect }) {
    const [snapshot] = initialTransition(counterMachine)
    const seen: number[] = []

    yield* awaited(() =>
      propertyTest(counterMachine, {
        seed: 4,
        numRuns: 2,
        maxCommands: 1,
        start: {
          snapshot,
          serializeSnapshot: (value) => value.toJSON(),
        },
        events: { INC: fc.constant({ value: 1 }) },
        invariant: ({ snapshot: value }) => {
          seen.push(value.context.count)
        },
      })
    )

    yield* expect(seen).toContain(0)
  })

  it('generates shrinkable continuations from graph frontiers', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: types<{ count: number }>(),
        events: {
          GO: types<{}>(),
          INC: types<{ value: number }>(),
        },
      },
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: { on: { GO: { target: 'active' } } },
        active: {
          on: {
            INC: ({ context, event }) => ({
              context: { count: context.count + event.value },
            }),
          },
        },
      },
    })
    const model = machine
    const frontier = getPathsFromEvents(machine, [{ type: 'GO' }])[0]
    if (frontier === undefined) {
      throw new Error('expected a frontier path')
    }
    const counts: number[] = []

    const failure = (yield* failureOf(() =>
      propertyTest(model, {
        seed: 123,
        numRuns: 100,
        maxCommands: 5,
        frontiers: [frontier],
        events: {
          INC: fc.constant({ value: 10 }),
        },
        invariant: ({ snapshot }) => {
          counts.push(snapshot.context.count)
          requireBelow(snapshot.context.count, 10)
        },
      })
    )) as ModelTestFailure

    yield* expect({
      frontierEventTypes: frontier.steps.map((step) => step.event.type),
      invariantSawOverBound: counts.some((count) => count >= 10),
      timelineCommands: failure.fixture?.timeline
        .filter((entry) => entry.kind === 'event')
        .map((entry) => entry.command),
      firstStep: failure.trace.steps[0],
    }).toEqual({
      frontierEventTypes: ['@xstate.init', 'GO'],
      invariantSawOverBound: true,
      timelineCommands: [
        expect.objectContaining({
          phase: 'prefix',
          event: { type: 'GO' },
        }),
        expect.objectContaining({ phase: 'generated' }),
      ],
      firstStep: expect.objectContaining({
        phase: 'prefix',
        event: { type: 'GO' },
      }),
    })
  })

  it('shrinks SUT divergence and disposes every run', function*({ expect }) {
    let active = 0

    const failure = (yield* failureOf(() =>
      propertyTest(counterMachine, {
        seed: 8,
        numRuns: 10,
        maxCommands: 5,
        events: { INC: fc.constant({ value: 1 }) },
        sut: {
          create: () => {
            active++
            let count = 0
            return {
              send: (event) => {
                if (event.type === 'INC') {
                  count += event.value + 1
                }
              },
              read: () => count,
              dispose: () => {
                active--
              },
            }
          },
          projectModel: (snapshot) => snapshot.context.count,
          projectSut: (count) => count,
        },
        invariant: () => {},
      })
    )) as ModelTestFailure

    yield* expect({
      failureClass: failure.constructor,
      message: failure.message,
      traceEvents: failure.trace.events,
      active,
    }).toEqual({
      failureClass: ModelTestFailure,
      message: expect.stringMatching(/observation diverged/),
      traceEvents: [{ type: 'INC', value: 1 }],
      active: 0,
    })
  })

  it('composes shrinkable clock commands with a fresh SimulatedClock', function*({ expect }) {
    const timerMachine = createMachine({
      schemas: {
        context: types<{ ticks: number }>(),
        events: { TICK: types<{}>() },
      },
      context: { ticks: 0 },
      on: {
        TICK: ({ context }) => ({ context: { ticks: context.ticks + 1 } }),
      },
    })
    let created = 0
    let disposed = 0
    const result = yield* awaited(() =>
      propertyTest(timerMachine, {
        seed: 17,
        numRuns: 10,
        maxCommands: 3,
        events: {},
        commands: { advance: fc.constant(1) },
        sut: {
          create: () => {
            created++
            const clock = new SimulatedClock()
            const value = { ticks: 0 }
            const events: { type: 'TICK' }[] = []
            clock.setTimeout(() => {
              value.ticks++
              events.push({ type: 'TICK' })
            }, 1)
            return {
              send: () => {},
              read: () => value,
              advance: (milliseconds) => {
                clock.increment(milliseconds)
                return events.splice(0)
              },
              dispose: () => {
                disposed++
              },
            }
          },
          projectModel: (snapshot) => snapshot.context.ticks,
          projectSut: (value) => {
            if (
              typeof value !== 'object' ||
              value === null ||
              !('ticks' in value) ||
              typeof value.ticks !== 'number'
            ) {
              throw new Error('expected the simulated clock to carry ticks')
            }
            return value.ticks
          },
          equivalent: (model, sut) => model === sut,
        },
        invariant: () => {},
      })
    )

    yield* expect({
      clockAdvancesPositive: result.coverage.clockAdvances > 0,
      sutComparisonsPositive: result.coverage.sutComparisons > 0,
      created,
      disposed,
    }).toEqual({
      clockAdvancesPositive: true,
      sutComparisonsPositive: true,
      created: result.coverage.runs,
      disposed: result.coverage.runs,
    })
  })
})
