import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, type EventFromLogic, SimulatedClock, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { runParallelPropertyCommands } from '../../src/engine/propertyLinearizability.js'
import {
  ModelTestFailure,
  propertyTest,
  replayTest,
  type TestActorOutcome,
  type TestAdapter,
  type TestEventGenerators,
  type TestFixture,
} from '../../src/engine/propertyTest.js'
import { generateTestSuite, replayTestSuite } from '../../src/engine/suite.js'
import { constant, integer, oneOf, randomAdapter, type RandomGeneratorKind } from './propertyTestAdapter.js'

const rejection = (run: () => Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(() => run().then(() => undefined, (cause: unknown) => cause))

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
      success: { on: { FETCH: { target: 'loading' } } },
      failure: { on: { FETCH: { target: 'loading' } } },
    },
  })
}

const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'off',
  schemas: { events: { TOGGLE: types<{}>() } },
  states: {
    off: { on: { TOGGLE: { target: 'on' } } },
    on: { on: { TOGGLE: { target: 'off' } } },
  },
})

describe('executed replay seeding', () => {
  it('replays outcome commands without double-providing the seeded outcomes', function*({ expect }) {
    const machine = fetchMachine()
    const suite = yield* Effect.promise(() =>
      generateTestSuite(machine, {
        adapter: randomAdapter({ seed: 9, numRuns: 20, maxCommands: 10 }),
        mode: 'executed',
        outcomes: {
          fetcher: oneOf<TestActorOutcome>(
            { ok: true, output: 1 },
            { ok: false, error: 'nope' },
          ),
        },
        events: { FETCH: constant({}) },
        invariant: () => {},
      })
    )

    const withOutcomes = suite.fixtures.filter(
      (fixture) =>
        fixture.timeline.filter((entry) => entry.command.type === 'outcome')
          .length > 1,
    )
    const replayedOutcomes: unknown[] = []
    for (const fixture of withOutcomes) {
      const trace = yield* Effect.promise(() =>
        replayTest(machine, fixture, {
          invariant: () => {},
          expect: 'pass',
        })
      )
      replayedOutcomes.push(trace.outcomes)
    }

    yield* expect({
      fixturesFound: withOutcomes.length > 0,
      replayedOutcomes,
    }).toEqual({
      fixturesFound: true,
      replayedOutcomes: withOutcomes.map((fixture) => fixture.outcomes),
    })
  })

  it('rejects an executed fixture replayed in pure mode', function*({ expect }) {
    const machine = fetchMachine()
    const failure = (yield* rejection(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 5, numRuns: 20, maxCommands: 6 }),
        mode: 'executed',
        outcomes: { fetcher: constant({ ok: true, output: 1 }) },
        events: { FETCH: constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'success') {
            throw new Error('reached success')
          }
        },
      })
    )) as ModelTestFailure

    const fixture = failure.fixture as TestFixture
    const replayError = yield* rejection(() =>
      replayTest(machine, fixture, {
        mode: 'pure',
        invariant: () => {},
      })
    )

    yield* expect({ message: replayError instanceof Error ? replayError.message : undefined }).toEqual({
      message: expect.stringContaining("pass mode: 'executed'"),
    })
  })
})

describe('property suites', () => {
  it('carries the mode and outcomes of an executed campaign into its fixtures', function*({ expect }) {
    const machine = fetchMachine()
    const suite = yield* Effect.promise(() =>
      generateTestSuite(machine, {
        adapter: randomAdapter({ seed: 2, numRuns: 6, maxCommands: 4 }),
        mode: 'executed',
        outcomes: { fetcher: constant({ ok: true, output: 1 }) },
        events: { FETCH: constant({}) },
        invariant: () => {},
      })
    )
    const result = yield* Effect.promise(() => replayTestSuite(machine, suite, { invariant: () => {} }))

    yield* expect({
      fixturesFound: suite.fixtures.length > 0,
      everyFixtureExecuted: suite.fixtures.every((fixture) => fixture.mode === 'executed'),
      failed: result.failed,
      passed: result.passed,
    }).toEqual({
      fixturesFound: true,
      everyFixtureExecuted: true,
      failed: [],
      passed: suite.fixtures.length,
    })
  })

  it('titles outcome commands', function*({ expect }) {
    const machine = fetchMachine()
    const suite = yield* Effect.promise(() =>
      generateTestSuite(machine, {
        adapter: randomAdapter({ seed: 2, numRuns: 6, maxCommands: 4 }),
        mode: 'executed',
        outcomes: { fetcher: constant({ ok: true, output: 1 }) },
        events: { FETCH: constant({}) },
        invariant: () => {},
      })
    )
    const { formatTestSuiteFixtureTitle } = yield* Effect.promise(() => import('../../src/engine/suite.js'))
    const titles = suite.fixtures.map((fixture, index) => formatTestSuiteFixtureTitle(fixture, index))

    yield* expect({ titles }).toEqual({
      titles: expect.arrayContaining([expect.stringContaining('@outcome(fetcher)')]),
    })
  })
})

describe('end-of-run temporal failures', () => {
  it('reports the run that failed at finish() as not passed', function*({ expect }) {
    const collected: boolean[] = []
    const error = yield* rejection(() =>
      propertyTest(toggleMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 1, maxCommands: 2 }),
        events: { TOGGLE: constant({}) },
        invariant: () => {},
        temporal: [
          {
            type: 'eventually',
            id: 'never-holds',
            predicate: () => false,
          },
        ],
        collect: (_trace, info) => {
          collected.push(info.passed)
        },
      })
    )

    yield* expect({ error, collected }).toEqual({ error: expect.any(ModelTestFailure), collected: [false] })
  })

  it('does not record an end-of-run temporal failure in a suite', function*({ expect }) {
    const error = yield* rejection(() =>
      generateTestSuite(toggleMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 1, maxCommands: 2 }),
        events: { TOGGLE: constant({}) },
        invariant: () => {},
        temporal: [
          { type: 'eventually', id: 'never-holds', predicate: () => false },
        ],
      })
    )

    yield* expect({ error }).toEqual({ error: expect.any(ModelTestFailure) })
  })
})

describe('pure-mode advance', () => {
  it('records a runtime entry when no SUT owns a clock', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(toggleMachine, {
        adapter: randomAdapter({ seed: 4, numRuns: 3, maxCommands: 6 }),
        events: { TOGGLE: constant({}) },
        commands: { advance: integer(1, 10) },
        invariant: () => {},
      })
    )

    yield* expect(coverage.clockAdvances).toBeGreaterThan(0)
  })
})

describe('batch exploration', () => {
  it('stops when the adapter makes no progress', function*({ expect }) {
    const stalled: TestAdapter = {
      run: () =>
        Promise.resolve({
          runs: 0,
          exploration: { configuredRuns: 1, maximumSequenceLength: 1 },
        }),
    }
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(toggleMachine, {
        adapter: stalled,
        events: { TOGGLE: constant({}) },
        invariant: () => {},
        until: { runs: 50 },
        maxRuns: 100,
        batchRuns: 5,
      })
    )

    yield* expect(coverage.exploration.truncationReasons).toContain('adapter made no progress')
  })
})

describe('linearizability', () => {
  it('does not prune states that share a projection', function*({ expect }) {
    const machine = createMachine({
      id: 'projection',
      schemas: {
        context: types<{ count: number; toggles: number }>(),
        events: { INC: types<{}>(), TOGGLE: types<{}>() },
      },
      context: { count: 0, toggles: 0 },
      on: {
        INC: ({ context }) => ({
          context: { ...context, count: context.count + 1 },
        }),
        TOGGLE: ({ context }) => ({
          context: { ...context, toggles: context.toggles + 1 },
        }),
      },
    })

    let count = 0
    const result = yield* Effect.promise(() =>
      runParallelPropertyCommands(machine, {
        branches: [[{ type: 'INC' }], [{ type: 'TOGGLE' }]],
        sut: {
          create: () => ({
            send: (event) => {
              if (event.type === 'INC') {
                count++
              }
              return count
            },
          }),
          projectModel: (snapshot) => snapshot.context.count,
        },
      })
    )

    yield* expect({ linearizable: result.linearizable }).toEqual({ linearizable: true })
  })

  it('passes a usable label recorder context to the SUT', function*({ expect }) {
    let classified = false
    const result = yield* Effect.promise(() =>
      runParallelPropertyCommands(toggleMachine, {
        branches: [[{ type: 'TOGGLE' }]],
        sut: {
          create: (context) => {
            context.classify(true, 'created')
            context.label('created')
            context.target(1)
            classified = true
            return { send: () => undefined, read: () => 'on' }
          },
          projectModel: (snapshot) => snapshot.value,
        },
      })
    )

    yield* expect({ classified, linearizable: result.linearizable }).toEqual({ classified: true, linearizable: true })
  })
})

describe('event descriptors', () => {
  it('treats `{ generate }` with no other key as a descriptor', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(toggleMachine, {
        adapter: randomAdapter({ seed: 11, numRuns: 5, maxCommands: 4 }),
        events: { TOGGLE: { generate: constant({}) } },
        invariant: () => {},
      })
    )

    yield* expect({
      generatedSteps: coverage.generatedSteps > 0,
      executedForDefaultCase: (coverage.eventCases['["event-case","TOGGLE","default"]']?.executed ?? 0) > 0,
    }).toEqual({ generatedSteps: true, executedForDefaultCase: true })
  })

  it('treats an object with a `generate` method as a bare generator', function*({ expect }) {
    const generatorWithCallableGenerate = { generate: () => ({}), sample: () => ({}) } as unknown as NonNullable<
      TestEventGenerators<
        SnapshotFrom<typeof toggleMachine>,
        EventFromLogic<typeof toggleMachine>,
        RandomGeneratorKind
      >['TOGGLE']
    >

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(toggleMachine, {
        adapter: randomAdapter({ seed: 11, numRuns: 5, maxCommands: 4 }),
        events: { TOGGLE: generatorWithCallableGenerate },
        invariant: () => {},
      })
    )

    yield* expect(coverage.generatedSteps).toBeGreaterThan(0)
  })
})

describe('replay disposal', () => {
  it('disposes sessions created before a later creator throws', function*({ expect }) {
    const failure = (yield* rejection(() =>
      propertyTest(toggleMachine, {
        adapter: randomAdapter({ seed: 7, numRuns: 1, maxCommands: 2 }),
        events: { TOGGLE: constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'on') {
            throw new Error('reached on')
          }
        },
      })
    )) as ModelTestFailure
    const fixture = failure.fixture as TestFixture

    let referenceDisposed = 0
    const error = yield* rejection(() =>
      replayTest(toggleMachine, fixture, {
        invariant: () => {},
        reference: {
          create: () => ({
            transition: () => {},
            read: () => 'off',
            dispose: () => {
              referenceDisposed++
            },
          }),
          projectModel: (snapshot) => snapshot.value,
          equivalent: () => true,
        },
        sut: {
          create: () => {
            throw new Error('test session creation failed')
          },
        },
      })
    )

    yield* expect({
      message: error instanceof Error ? error.message : undefined,
      referenceDisposed,
    }).toEqual({ message: expect.stringContaining('test session creation failed'), referenceDisposed: 1 })
  })
})

describe('clock-delivered events in fixtures', () => {
  it('replays a SUT-clock run identically', function*({ expect }) {
    const timerMachine = createMachine({
      id: 'timer',
      schemas: {
        context: types<{ ticks: number }>(),
        events: { TICK: types<{}>() },
      },
      context: { ticks: 0 },
      on: {
        TICK: ({ context }) => ({ context: { ticks: context.ticks + 1 } }),
      },
    })

    function createClockSut() {
      return {
        create: () => {
          const clock = new SimulatedClock()
          const value = { ticks: 0 }
          const pending: { type: 'TICK' }[] = []
          for (const delay of [1, 1, 1]) {
            clock.setTimeout(() => {
              value.ticks++
              pending.push({ type: 'TICK' })
            }, delay)
          }
          return {
            send: () => {},
            read: () => value.ticks,
            advance: (milliseconds: number) => {
              clock.increment(milliseconds)
              return pending.splice(0)
            },
          }
        },
        projectModel: (snapshot: SnapshotFrom<typeof timerMachine>) => snapshot.context.ticks,
        projectSut: (observed: unknown) => observed,
        equivalent: (model: unknown, sut: unknown) => model === sut,
      }
    }

    const failure = (yield* rejection(() =>
      propertyTest(timerMachine, {
        adapter: randomAdapter({ seed: 13, numRuns: 4, maxCommands: 4 }),
        events: {},
        commands: { advance: constant(1) },
        sut: createClockSut(),
        invariant: ({ snapshot }) => {
          if (snapshot.context.ticks >= 2) {
            throw new Error('too many ticks')
          }
        },
      })
    )) as ModelTestFailure
    const fixture = failure.fixture as TestFixture
    const advanceEntry = fixture.timeline.find(
      (entry) => entry.command.type === 'advance',
    )
    yield* expect({
      failure,
      hasAdvanceEntry: advanceEntry !== undefined,
      deliveredEvents: advanceEntry !== undefined && advanceEntry.command.type === 'advance'
        ? advanceEntry.command.deliveredEvents.length > 0
        : false,
      hasClockEvent: fixture.timeline.some(
        (entry) => entry.command.type === 'event' && entry.command.origin === 'clock',
      ),
    }).toEqual({
      failure: expect.any(ModelTestFailure),
      hasAdvanceEntry: true,
      deliveredEvents: true,
      hasClockEvent: true,
    })

    const replayed = (yield* rejection(() =>
      replayTest(timerMachine, fixture, {
        invariant: ({ snapshot }) => {
          if (snapshot.context.ticks >= 2) {
            throw new Error('too many ticks')
          }
        },
      })
    )) as ModelTestFailure

    yield* expect({
      replayed,
      timelineCommands: replayed.trace.timeline.flatMap((entry) => 'command' in entry ? [entry.command] : []),
    }).toEqual({
      replayed: expect.any(ModelTestFailure),
      timelineCommands: fixture.timeline
        .slice(0, replayed.trace.timeline.length)
        .flatMap((entry) => 'command' in entry ? [entry.command] : []),
    })
  })

  it('rejects a fixture whose clock-delivered events were dropped', function*({ expect }) {
    const fixture: TestFixture = {
      formatVersion: 2,
      start: { type: 'input', input: undefined },
      timeline: [
        {
          kind: 'command',
          command: {
            type: 'advance',
            milliseconds: 1,
            deliveredEvents: [{ type: 'TOGGLE' }],
          },
        },
        {
          kind: 'event',
          command: {
            type: 'event',
            event: { type: 'TOGGLE' },
            phase: 'generated',
            origin: 'generator',
          },
        },
      ],
      failedAt: 1,
    }

    const error = yield* rejection(() => replayTest(toggleMachine, fixture, { invariant: () => {} }))

    yield* expect({ message: error instanceof Error ? error.message : undefined }).toEqual({
      message: expect.stringContaining('is not a clock-delivered event'),
    })
  })
})
