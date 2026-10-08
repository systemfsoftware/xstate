import { describe } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { propertyTest, replayTest } from '../../src/engine/propertyTest.js'
import type { TestFixture } from '../../src/engine/propertyTest.js'
import { ModelTestFailure } from '../../src/engine/propertyTest.js'
import { constant, integer, oneOf, randomAdapter, record } from './propertyTestAdapter.js'

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

describe('executed property mode', (it) => {
  it('runs invoked actors and reaches both onDone and onError', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(fetchMachine(), {
        adapter: randomAdapter({ seed: 7, numRuns: 30, maxCommands: 4 }),
        mode: 'executed',
        outcomes: {
          fetcher: oneOf<any>(
            { ok: true, output: { user: 'David' } },
            { ok: false, error: new Error('nope') },
          ),
        },
        events: { FETCH: constant({}) },
        invariant: () => {},
      })
    )

    const covered = coverage.transitions.covered.join('\n')
    yield* expect({
      mode: coverage.exploration.mode,
      coversOnDoneActor: covered.includes('xstate.done.actor'),
      coversOnErrorActor: covered.includes('xstate.error.actor'),
    }).toEqual({
      mode: 'executed',
      coversOnDoneActor: true,
      coversOnErrorActor: true,
    })
  })

  it('reaches a delayed transition through generated advance commands', function*({ expect }) {
    const machine = createMachine({
      id: 'timer',
      initial: 'idle',
      schemas: { events: { START: types<{}>() } },
      states: {
        idle: { on: { START: { target: 'waiting' } } },
        waiting: { after: { 500: { target: 'elapsed' } } },
        elapsed: {},
      },
    })

    let sawElapsed = false
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 3, numRuns: 40, maxCommands: 6 }),
        mode: 'executed',
        events: { START: constant({}) },
        commands: { advance: integer(400, 700) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'elapsed') {
            sawElapsed = true
          }
        },
      })
    )

    yield* expect({
      sawElapsed,
      coversElapsed: coverage.stateNodes.covered.includes('timer.elapsed'),
      clockAdvanced: coverage.clockAdvances > 0,
    }).toEqual({
      sawElapsed: true,
      coversElapsed: true,
      clockAdvanced: true,
    })
  })

  it('records child actor transitions in the timeline', function*({ expect }) {
    const machine = fetchMachine()
    const error = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 1, numRuns: 5, maxCommands: 3 }),
        mode: 'executed',
        actors: { fetcher: createAsyncLogic({ run: () => Promise.resolve(42) }) },
        events: { FETCH: constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'success') {
            throw new Error('reached success')
          }
        },
      }).then(
        (): never => {
          throw new Error('expected the campaign to fail')
        },
        (cause: unknown) => cause as ModelTestFailure,
      )
    )

    const entries = error.trace.timeline
    yield* expect({
      isModelTestFailure: error instanceof ModelTestFailure,
      timelineHasActorEvent: entries.some((entry) => entry.kind === 'actorEvent'),
      childActorRecorded: entries.some((entry) => entry.kind === 'actorEvent' && entry.source === 'child'),
    }).toEqual({
      isModelTestFailure: true,
      timelineHasActorEvent: true,
      childActorRecorded: true,
    })
  })

  it('replays an executed failure against stubbed actors', function*({ expect }) {
    const machine = fetchMachine()
    let realCalls = 0
    const real = createAsyncLogic({
      run: () => {
        realCalls++
        return Promise.resolve(42)
      },
    })

    const failure = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 5, numRuns: 5, maxCommands: 3 }),
        mode: 'executed',
        actors: { fetcher: real },
        events: { FETCH: constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'success') {
            throw new Error('reached success')
          }
        },
      }).then(
        (): never => {
          throw new Error('expected the campaign to fail')
        },
        (cause: unknown) => cause as ModelTestFailure,
      )
    )

    const fixture = failure.fixture as TestFixture
    realCalls = 0
    // No `actors` are provided: the recorded outcomes drive stub actors.
    const replayError = yield* Effect.promise(() =>
      replayTest(machine, fixture, {
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'success') {
            throw new Error('reached success')
          }
        },
      }).then(
        (): never => {
          throw new Error('expected the replay to fail')
        },
        (cause: unknown) => cause as Error,
      )
    )

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      fixtureMode: fixture.mode,
      fixtureOutcomes: fixture.outcomes,
      realCalls,
      replayIsModelTestFailure: replayError instanceof ModelTestFailure,
    }).toEqual({
      isModelTestFailure: true,
      fixtureMode: 'executed',
      fixtureOutcomes: [{ src: 'fetcher', occurrence: 0, outcome: { ok: true, output: 42 } }],
      realCalls: 0,
      replayIsModelTestFailure: true,
    })
  })

  it('produces the same trace twice for one seed', function*({ expect }) {
    const run = () => {
      const traces: string[] = []
      return propertyTest(fetchMachine(), {
        adapter: randomAdapter({ seed: 11, numRuns: 10, maxCommands: 4 }),
        mode: 'executed',
        outcomes: {
          fetcher: oneOf<any>(
            { ok: true, output: 1 },
            { ok: false, error: 'bad' },
          ),
        },
        events: { FETCH: constant({}) },
        invariant: ({ snapshot, step }) => {
          traces.push(`${step}:${JSON.stringify(snapshot.value)}`)
        },
      }).then(() => traces.join('|'))
    }

    const first = yield* Effect.promise(() => run())
    const second = yield* Effect.promise(() => run())

    yield* expect({ first, second }).toEqual({ first: second, second })
  })

  it('rejects actors and outcomes in pure mode', function*({ expect }) {
    const error = yield* Effect.promise(() =>
      propertyTest(fetchMachine(), {
        adapter: randomAdapter({ seed: 1, numRuns: 1 }),
        outcomes: { fetcher: constant({ ok: true, output: 1 }) },
        events: { FETCH: constant({}) },
        invariant: () => {},
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
    )

    yield* expect(error).toSatisfy(
      (cause: unknown) => cause instanceof Error && cause.message.includes("require `mode: 'executed'`"),
      "an Error naming the required `mode: 'executed'`",
    )
  })

  it('reports pure as the default exploration mode', function*({ expect }) {
    const machine = createMachine({
      id: 'plain',
      initial: 'idle',
      schemas: { events: { FETCH: types<{}>() } },
      states: { idle: { on: { FETCH: { target: 'done' } } }, done: {} },
    })
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter: randomAdapter({ seed: 1, numRuns: 2, maxCommands: 2 }),
        events: { FETCH: record({}) },
        invariant: () => {},
      })
    )
    yield* expect(coverage.exploration.mode).toBe('pure')
  })
})
