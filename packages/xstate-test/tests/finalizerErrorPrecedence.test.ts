import { it } from '@systemfsoftware/vitest'
import { createMachine, type EventObject, type Snapshot, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import {
  fastCheckAdapter,
  getCurrentScheduler,
  PropertyScenarioRunner,
  propertyTest,
  ReplayNotReproducedError,
  replayTest,
  runParallelPropertyCommands,
  type TestAdapter,
  type TestSut,
} from '@systemfsoftware/xstate-test'
import { createPlaywrightSut, type PlaywrightPage } from '@systemfsoftware/xstate-test/playwright'
import { Effect } from 'effect'
import fc from 'fast-check'

type AdapterRequest = Parameters<TestAdapter['run']>[0]

const counterMachine = createMachine({
  id: 'finalizer-counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>
type CounterEvent = { type: 'INC' }

const scenarioRunner = (
  start: () => Promise<void>,
  dispose: () => Promise<void>,
): PropertyScenarioRunner<Snapshot<unknown>, EventObject> => {
  const runner: PropertyScenarioRunner<Snapshot<unknown>, EventObject> = Object.create(
    PropertyScenarioRunner.prototype,
  )
  runner.start = start
  runner.dispose = dispose
  runner.finish = () => {}
  runner.canRunGenerated = () => false
  return runner
}

const adapterRequest = (
  createRunner: AdapterRequest['createRunner'],
): AdapterRequest => ({
  events: [{ type: 'PING', caseId: 'ping', generator: fc.constant({}), weight: 1 }],
  commands: [],
  runBudget: 1,
  createEvent: () => ({ type: 'PING' }),
  createRunner,
})

const surfacedError = (
  start: () => Promise<void>,
  dispose: () => Promise<void>,
): Promise<unknown> =>
  fastCheckAdapter({ numRuns: 1 })
    .run(adapterRequest(() => scenarioRunner(start, dispose)))
    .then((result) => result.error)

const aggregateSummary = (
  error: unknown,
): { readonly count: number; readonly first: unknown } => {
  const errors = error instanceof AggregateError ? error.errors : []
  return { count: errors.length, first: errors[0] }
}

const errorConstructor = (error: unknown): unknown => error instanceof Error ? error.constructor : undefined

it(
  'Should_SurfaceTheFinalizerError_When_TheScenarioAndTheDisposalBothFail',
  function*({ expect }) {
    const bodyError = new Error('the scenario failed')
    const finalizerError = new Error('the disposal failed')
    const error = yield* Effect.promise(() =>
      surfacedError(
        () => Promise.reject(bodyError),
        () => Promise.reject(finalizerError),
      )
    )
    yield* expect(error).toBe(finalizerError)
  },
)

it(
  'Should_SurfaceTheFinalizerError_When_OnlyTheDisposalFails',
  function*({ expect }) {
    const finalizerError = new Error('the disposal failed')
    const error = yield* Effect.promise(() =>
      surfacedError(
        () => Promise.resolve(),
        () => Promise.reject(finalizerError),
      )
    )
    yield* expect(error).toBe(finalizerError)
  },
)

it(
  'Should_SurfaceTheScenarioError_When_OnlyTheScenarioFails',
  function*({ expect }) {
    const bodyError = new Error('the scenario failed')
    const error = yield* Effect.promise(() =>
      surfacedError(
        () => Promise.reject(bodyError),
        () => Promise.resolve(),
      )
    )
    yield* expect(error).toBe(bodyError)
  },
)

const scenarioRunnerWithStalledSchedulerTask = (
  start: () => Promise<void>,
  dispose: () => Promise<void>,
): PropertyScenarioRunner<Snapshot<unknown>, EventObject> => {
  const runner = scenarioRunner(start, dispose)
  const scheduler = getCurrentScheduler()
  if (scheduler === undefined) {
    throw new Error('expected a scheduler inside a scheduled run')
  }
  void scheduler.scheduleFunction(() => Effect.runPromise(Effect.never))()
  return runner
}

it(
  'Should_SurfaceTheSchedulerIdleError_When_TheScheduledRunAndTheIdleWaitBothFail',
  function*({ expect }) {
    const bodyError = new Error('the scheduled run failed')
    const finalizerError = new Error('waiting for the scheduler to go idle failed')

    const both = yield* Effect.promise(() =>
      fastCheckAdapter({
        numRuns: 1,
        scheduler: { act: () => Promise.reject(finalizerError) },
      })
        .run(
          adapterRequest(() =>
            scenarioRunnerWithStalledSchedulerTask(
              () => Promise.reject(bodyError),
              () => Promise.resolve(),
            )
          ),
        )
        .then((result) => result.error)
    )
    yield* expect(both).toBe(finalizerError)

    const bodyOnly = yield* Effect.promise(() =>
      fastCheckAdapter({ numRuns: 1, scheduler: true })
        .run(
          adapterRequest(() =>
            scenarioRunner(
              () => Promise.reject(bodyError),
              () => Promise.resolve(),
            )
          ),
        )
        .then((result) => result.error)
    )
    yield* expect(bodyOnly).toBe(bodyError)
  },
)

const startAndDisposeAdapter: TestAdapter = {
  run: (request) => {
    const runner = request.createRunner()
    return runner.start()
      .then(() => runner.dispose())
      .then(() => ({
        runs: 1,
        exploration: {
          configuredRuns: 1,
          maximumSequenceLength: null,
          engine: 'start-and-dispose',
        },
      }))
  },
}

const teardownFailingPage = (off: () => unknown): PlaywrightPage => ({
  on: () => undefined,
  off,
  addInitScript: () => Promise.resolve(),
})

it(
  'Should_SurfaceTheConfiguredDisposeError_When_ThePlaywrightTeardownAndTheDisposeBothFail',
  function*({ expect }) {
    const teardownError = new Error('the page listener teardown failed')
    const disposeError = new Error('the configured page dispose failed')

    const failing = createPlaywrightSut<PlaywrightPage, CounterSnapshot, CounterEvent>(
      teardownFailingPage(() => {
        throw teardownError
      }),
      { events: {}, dispose: () => Promise.reject(disposeError) },
    )
    const both = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: startAndDisposeAdapter,
        events: { INC: fc.constant({}) },
        sut: failing,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(aggregateSummary(both)).toEqual({
      count: 1,
      first: disposeError,
    })

    const teardownOnly = createPlaywrightSut<
      PlaywrightPage,
      CounterSnapshot,
      CounterEvent
    >(
      teardownFailingPage(() => {
        throw teardownError
      }),
      { events: {} },
    )
    const bodyOnly = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: startAndDisposeAdapter,
        events: { INC: fc.constant({}) },
        sut: teardownOnly,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(aggregateSummary(bodyOnly)).toEqual({
      count: 1,
      first: teardownError,
    })
  },
)

it(
  'Should_SurfaceTheRecordError_When_TheRunnerDisposalAndTheRecordBothFail',
  function*({ expect }) {
    const disposeError = new Error('the runner disposal failed')
    const recordError = new Error('recording the run failed')

    const explodingSut: TestSut<CounterSnapshot, CounterEvent> = {
      create: () => ({
        send: () => undefined,
        dispose: () => Promise.reject(disposeError),
      }),
    }
    const both = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: startAndDisposeAdapter,
        events: { INC: fc.constant({}) },
        sut: explodingSut,
        collect: () => {
          throw recordError
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(both).toBe(recordError)

    const bodyOnly = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: startAndDisposeAdapter,
        events: { INC: fc.constant({}) },
        sut: explodingSut,
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(aggregateSummary(bodyOnly)).toEqual({
      count: 1,
      first: disposeError,
    })
  },
)

it(
  'Should_SurfaceTheSessionDisposeError_When_TheParallelRunAndTheDisposeBothFail',
  function*({ expect }) {
    const bodyError = new Error('the parallel run failed')
    const finalizerError = new Error('the session dispose failed')

    const both = yield* Effect.promise(() =>
      runParallelPropertyCommands(counterMachine, {
        branches: [[{ type: 'INC' }]],
        sut: {
          create: () => ({
            send: () => Promise.reject(bodyError),
            dispose: () => Promise.reject(finalizerError),
          }),
          projectModel: () => undefined,
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(both).toBe(finalizerError)

    const bodyOnly = yield* Effect.promise(() =>
      runParallelPropertyCommands(counterMachine, {
        branches: [[{ type: 'INC' }]],
        sut: {
          create: () => ({
            send: () => Promise.reject(bodyError),
            dispose: () => Promise.resolve(),
          }),
          projectModel: () => undefined,
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(bodyOnly).toBe(bodyError)
  },
)

const unreproducedFixture = {
  formatVersion: 1,
  machine: { id: 'finalizer-counter' },
  start: { type: 'input', input: undefined },
  prefixEvents: [],
  events: [{ type: 'INC' }],
  failedAt: 1,
} as const

it(
  'Should_SurfaceTheRunnerDisposeError_When_TheReplayAndTheDisposeBothFail',
  function*({ expect }) {
    const disposeError = new Error('the replay runner dispose failed')

    const both = yield* Effect.promise(() =>
      replayTest(counterMachine, unreproducedFixture, {
        sut: {
          create: () => ({
            send: () => undefined,
            dispose: () => Promise.reject(disposeError),
          }),
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(aggregateSummary(both)).toEqual({
      count: 1,
      first: disposeError,
    })

    const bodyOnly = yield* Effect.promise(() =>
      replayTest(counterMachine, unreproducedFixture, {
        sut: { create: () => ({ send: () => undefined }) },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
    )
    yield* expect(errorConstructor(bodyOnly)).toBe(ReplayNotReproducedError)
  },
)
