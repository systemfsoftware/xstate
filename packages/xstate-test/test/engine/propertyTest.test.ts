import { describe, it } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, type Snapshot, types } from '@systemfsoftware/xstate'
import { getPathsFromEvents } from '@systemfsoftware/xstate/graph'
import { Effect } from 'effect'
import {
  formatTestTrace,
  ModelTestFailure,
  type PropertyScenarioRunner,
  propertyTest,
  serializeTestTrace,
  type TestAdapter,
  type TestAdapterResult,
} from '../../src/engine/index.js'
import { constant, integer, randomAdapter, type RandomGeneratorKind, record } from './propertyTestAdapter.js'

const counterMachine = createMachine({
  id: 'counter',
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

const noop = () => {}

const countMessage = (count: number) => `expected ${count} to be less than 5`

const captureFailure = (run: () => Promise<unknown>): Effect.Effect<ModelTestFailure> =>
  Effect.promise(() =>
    run().then(
      () => {
        throw new Error('Expected the property test to fail')
      },
      (error: unknown) => {
        if (error instanceof ModelTestFailure) {
          return error
        }
        throw error
      },
    )
  )

const withoutUndefinedKeys = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => withoutUndefinedKeys(entry)) as T
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, withoutUndefinedKeys(nested)]),
  ) as T
}

const rejection = (run: () => Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(() => run().then(() => undefined, (cause: unknown) => cause))

describe('propertyTest with the in-repo random adapter', () => {
  it('checks the invariant on every macrostep of a passing run', function*({ expect }) {
    const checked: number[] = []

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 7, numRuns: 5, maxCommands: 3 }),
        events: {
          INC: record({ value: integer(0, 2) }),
          RESET: constant({}),
        },
        invariant: ({ snapshot }) => {
          checked.push(snapshot.context.count)
        },
      })
    )

    yield* expect({
      runs: coverage.runs,
      invariantChecks: coverage.invariantChecks,
      checkedAtLeastFive: checked.length >= 5,
      activeStatusesPresent: (coverage.statuses.counts['active'] ?? 0) > 0,
      configuredRuns: coverage.exploration.configuredRuns,
      maximumSequenceLength: coverage.exploration.maximumSequenceLength,
    }).toEqual({
      runs: 5,
      invariantChecks: checked.length,
      checkedAtLeastFive: true,
      activeStatusesPresent: true,
      configuredRuns: 5,
      maximumSequenceLength: 3,
    })
  })

  it('reports a ModelTestFailure with trace, fixture, coverage and replay', function*({ expect }) {
    const failure = yield* captureFailure(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 10, maxCommands: 5 }),
        events: { INC: constant({ value: 5 }) },
        invariant: ({ snapshot }) => {
          if (snapshot.context.count >= 5) {
            throw new Error(countMessage(snapshot.context.count))
          }
        },
      })
    )

    yield* expect({
      failure,
      stepsPresent: failure.trace.steps.length > 0,
      events: failure.trace.events,
      fixtureFormatVersion: failure.fixture?.formatVersion,
      fixtureFailedAt: failure.fixture?.failedAt,
      fixtureMachineId: failure.fixture?.machine?.id,
      replayEngine: failure.replay?.engine,
      coverageRunsPresent: (failure.coverage?.runs ?? 0) > 0,
      cause: failure.cause,
      causeMessage: failure.cause instanceof Error ? failure.cause.message : undefined,
    }).toEqual({
      failure: expect.any(ModelTestFailure),
      stepsPresent: true,
      events: [{ type: 'INC', value: 5 }],
      fixtureFormatVersion: 2,
      fixtureFailedAt: 1,
      fixtureMachineId: 'counter',
      replayEngine: 'random',
      coverageRunsPresent: true,
      cause: expect.any(Error),
      causeMessage: 'expected 5 to be less than 5',
    })
  })

  it('keeps the failure message stable after the stack is captured', function*({ expect }) {
    const failure = yield* captureFailure(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 5, maxCommands: 2 }),
        events: { INC: constant({ value: 5 }) },
        invariant: ({ snapshot }) => {
          if (snapshot.context.count >= 5) {
            throw new Error(countMessage(snapshot.context.count))
          }
        },
      })
    )

    const causeMessage = failure.cause instanceof Error ? failure.cause.message : undefined

    yield* expect({
      summary: failure.summary,
      causeMessage,
      message: failure.message,
      stackStartsWithMessage: failure.stack?.startsWith(`ModelTestFailure: ${failure.message}`) ?? false,
    }).toEqual({
      summary: 'Property invariant failed after 1 step',
      causeMessage: 'expected 5 to be less than 5',
      message: [
        `${failure.summary}: ${causeMessage}`,
        'Reproduce: seed 1',
        'Fixture: failure.fixture (replayTest)',
        '',
        formatTestTrace(failure.trace),
      ].join('\n'),
      stackStartsWithMessage: true,
    })
  })

  it('does not execute effects returned by transitions', function*({ expect }) {
    let executed = 0
    const machine = createMachine({
      on: {
        GO: (_, enq) => enq(() => executed++),
      },
    })
    const effectCounts: number[] = []

    yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 2, numRuns: 3, maxCommands: 4 }),
        events: { GO: constant({}) },
        invariant: ({ effects }) => {
          effectCounts.push(effects.length)
        },
      })
    )

    yield* expect({ executed, maxEffectsPositive: Math.max(...effectCounts) > 0 }).toEqual({
      executed: 0,
      maxEffectsPositive: true,
    })
  })

  it('collects invoked actor effects without running them', function*({ expect }) {
    let ran = 0
    const machine = createMachine({
      id: 'inv',
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: createAsyncLogic({
              run: () => {
                ran++
                return Promise.resolve(1)
              },
            }),
            onDone: { target: 'success' },
            onError: { target: 'failure' },
          },
          on: { PING: { target: 'loading' } },
        },
        success: {},
        failure: {},
      },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 5, numRuns: 3, maxCommands: 3 }),
        events: { PING: constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      ran,
      unreachable: coverage.stateNodes.unreachable,
      uncovered: coverage.stateNodes.uncovered,
    }).toEqual({
      ran: 0,
      unreachable: [],
      uncovered: expect.arrayContaining(['inv.success', 'inv.failure']),
    })
  })

  it('covers history state default targets', function*({ expect }) {
    const machine = createMachine({
      id: 'hist',
      initial: 'outside',
      states: {
        outside: { on: { ENTER: { target: 'group' } } },
        group: {
          initial: 'entry',
          states: {
            entry: { on: { LEAVE: { target: '#hist.outside' } } },
            restored: {},
            recall: { type: 'history', target: 'restored' },
          },
        },
      },
      on: { RESUME: { target: '.group.recall' } },
    })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 11, numRuns: 20, maxCommands: 6 }),
        events: {
          ENTER: constant({}),
          LEAVE: constant({}),
          RESUME: constant({}),
        },
        invariant: noop,
      })
    )

    yield* expect({
      unreachable: coverage.stateNodes.unreachable,
      covered: coverage.stateNodes.covered,
    }).toEqual({ unreachable: [], covered: expect.arrayContaining(['hist.group.restored']) })
  })

  it('reaches compound onDone targets', function*({ expect }) {
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
        adapter: randomAdapter({ seed: 9, numRuns: 10, maxCommands: 4 }),
        events: { FINISH: constant({}) },
        invariant: noop,
      })
    )

    yield* expect(coverage.stateNodes.covered).toContain('done.wrapUp')
  })

  it('drives wildcard event descriptors (GH #3229)', function*({ expect }) {
    const seen: string[] = []
    const machine = createMachine({
      id: 'wildcard',
      initial: 'idle',
      states: {
        idle: {
          on: { '*': { target: 'touched' } },
        },
        touched: {},
      },
    })

    yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 4, numRuns: 3, maxCommands: 2 }),
        events: { WHATEVER: constant({}) },
        invariant: ({ snapshot }) => {
          seen.push(JSON.stringify(snapshot.value))
        },
      })
    )

    yield* expect(seen).toContain('"touched"')
  })

  it('runs a machine with no events using only the checkpoint command (GH #2495)', function*({ expect }) {
    const machine = createMachine({ id: 'inert' })

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 6, numRuns: 3, maxCommands: 3 }),
        events: {},
        commands: { checkpoint: constant({}) },
        invariant: noop,
      })
    )

    yield* expect({ runs: coverage.runs, checkpointsPositive: coverage.checkpoints > 0 }).toEqual({
      runs: 3,
      checkpointsPositive: true,
    })
  })

  it('rejects a configuration with no event or command generators', function*({ expect }) {
    const error = yield* rejection(() =>
      propertyTest(createMachine({ id: 'empty' }), {
        adapter: randomAdapter({ seed: 0, numRuns: 1 }),
        events: {},
        invariant: noop,
      })
    )

    yield* expect({ message: error instanceof Error ? error.message : undefined }).toEqual({
      message: expect.stringContaining('Property tests require at least one event or command generator'),
    })
  })

  it('rejects a non-positive runsPerFrontier', function*({ expect }) {
    const machine = createMachine({
      id: 'gate',
      initial: 'idle',
      states: {
        idle: { on: { GO: { target: 'active' } } },
        active: { on: { GO: { target: 'idle' } } },
      },
    })
    const model = machine
    const frontier = getPathsFromEvents(machine, [{ type: 'GO' }])[0]

    const error = yield* rejection(() =>
      propertyTest(model, {
        adapter: randomAdapter({ seed: 0, numRuns: 1 }),
        frontiers: { paths: frontier === undefined ? [] : [frontier], runsPerFrontier: 0 },
        events: { GO: constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      frontierFound: frontier !== undefined,
      message: error instanceof Error ? error.message : undefined,
    }).toEqual({
      frontierFound: true,
      message: expect.stringContaining('runsPerFrontier must return a positive integer'),
    })
  })

  it('exposes the non-generated `canRun` overload on the scenario runner', function*({ expect }) {
    const decisions: boolean[] = []
    const adapter: TestAdapter<RandomGeneratorKind> = {
      run(request): Promise<TestAdapterResult> {
        const runner = request.createRunner() as unknown as PropertyScenarioRunner<
          Snapshot<unknown>,
          { type: 'INC'; value: number }
        >
        const firstEvent = request.events[0]
        if (firstEvent === undefined) {
          throw new Error('expected a generated event')
        }
        const { caseId } = firstEvent
        return runner
          .start()
          .then(() => {
            decisions.push(runner.canRun({ type: 'INC', value: 1 }, caseId))
          })
          .then(() => runner.run({ type: 'INC', value: 1 }, caseId))
          .then(() => runner.stop())
          .then(() => {
            decisions.push(runner.canRun({ type: 'INC', value: 1 }, caseId))
          })
          .then(() => runner.dispose())
          .then(() => ({
            runs: 1,
            exploration: { configuredRuns: 1, maximumSequenceLength: 1 },
          }))
      },
    }

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter,
        events: { INC: constant({ value: 1 }) },
        invariant: noop,
      })
    )

    yield* expect({ decisions, stops: coverage.stops }).toEqual({ decisions: [true, false], stops: 1 })
  })
})

describe('property trace serialization', () => {
  const getFailureTrace = () =>
    captureFailure(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 5, maxCommands: 1 }),
        events: { INC: constant({ value: 5 }) },
        invariant: ({ snapshot }) => {
          if (snapshot.context.count >= 5) {
            throw new Error(countMessage(snapshot.context.count))
          }
        },
      })
    )

  it('serializes a trace to JSON-safe data', function*({ expect }) {
    const failure = yield* getFailureTrace()
    const initialSnapshotJson = failure.trace.initialSnapshot as unknown as { toJSON(): unknown }
    const serialized = serializeTestTrace(failure.trace) as {
      readonly initialSnapshot: unknown
      readonly finalSnapshot: { readonly context: unknown }
      readonly timeline: readonly unknown[]
    }

    const roundTripped = JSON.parse(JSON.stringify(serialized)) as {
      readonly initialSnapshot: unknown
      readonly finalSnapshot: { readonly context: unknown }
      readonly timeline: readonly unknown[]
    }
    const jsonVisible = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const firstTimelineEntry = expect.objectContaining({
      kind: 'event',
      index: 0,
      command: expect.objectContaining({
        type: 'event',
        event: { type: 'INC', value: 5 },
        phase: 'generated',
        origin: 'generator',
      }),
    })

    yield* expect({
      initialSnapshot: serialized.initialSnapshot,
      finalContext: serialized.finalSnapshot.context,
      firstTimelineEntry: serialized.timeline[0],
      roundTripInitialSnapshot: roundTripped.initialSnapshot,
      roundTripFinalContext: roundTripped.finalSnapshot.context,
      roundTripFirstTimelineEntry: roundTripped.timeline[0],
      roundTrip: JSON.parse(JSON.stringify(serialized)),
    }).toEqual({
      initialSnapshot: initialSnapshotJson.toJSON(),
      finalContext: { count: 5 },
      firstTimelineEntry,
      roundTripInitialSnapshot: jsonVisible(initialSnapshotJson.toJSON()),
      roundTripFinalContext: { count: 5 },
      roundTripFirstTimelineEntry: firstTimelineEntry,
      roundTrip: withoutUndefinedKeys(serialized),
    })
  })

  it('formats a trace for humans', function*({ expect }) {
    const failure = yield* getFailureTrace()
    const formatted = formatTestTrace(failure.trace)

    yield* expect({
      startsWithStart: formatted.startsWith('start '),
      secondLine: formatted.split('\n')[1],
      mentionsSummary: failure.message.includes('Property invariant failed after 1 step'),
      endsWithFormat: failure.message.endsWith(formatted),
      message: failure.message,
    }).toEqual({
      startsWithStart: true,
      secondLine: '1. generator INC {"value":5} -> {"value":{},"context":{"count":5}}',
      mentionsSummary: true,
      endsWithFormat: true,
      message: `Property invariant failed after 1 step: expected 5 to be less than 5
Reproduce: seed 1
Fixture: failure.fixture (replayTest)

start {"value":{},"context":{"count":0}}
1. generator INC {"value":5} -> {"value":{},"context":{"count":5}}`,
    })
  })
})
