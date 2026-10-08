import { describe, it } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { ModelTestFailure, propertyTest, replayTest, type TestCoverage, testPaths, type TestSut } from '../src/index.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    meta: types<{ test: (session: { metaCalls?: string[] }) => void }>(),
    events: {
      INC: types<{ value: number }>(),
      RESET: types<{}>(),
    },
  },
  context: { count: 0 },
  initial: 'counting',
  states: {
    counting: {
      meta: {
        test: (session: { metaCalls?: string[] }) => {
          session?.metaCalls?.push('counting')
        },
      },
      on: {
        INC: ({ context, event }) => ({
          context: { count: Math.min(3, context.count + event.value) },
        }),
        RESET: { target: 'done' },
      },
    },
    done: {
      meta: {
        test: (session: { metaCalls?: string[] }) => {
          session?.metaCalls?.push('done')
        },
      },
      type: 'final',
    },
  },
})

const events = {
  INC: fc.record({ value: fc.constant(1) }),
  RESET: fc.constant({}),
}

interface Recorder {
  stateCalls: string[]
  metaCalls: string[]
}

function createSut(recorder: Recorder, bugAt?: number): TestSut<any, any> {
  return {
    projectModel: (snapshot) => snapshot.context.count,
    create: () => {
      let count = 0
      return {
        metaCalls: recorder.metaCalls,
        send: (event) => {
          if (event.type === 'INC') {
            if (bugAt !== undefined && count >= bugAt) {
              return
            }
            count = Math.min(3, count + event.value)
          }
        },
        read: () => count,
        states: {
          '*': (snapshot) => {
            recorder.stateCalls.push(String(snapshot.value))
          },
        },
      }
    },
  }
}

function transitionUniverse(coverage: TestCoverage) {
  return [
    ...coverage.transitions.covered,
    ...coverage.transitions.uncovered,
    ...coverage.transitions.unreachable,
    ...coverage.transitions.unknown,
  ].sort()
}

function failureTraits(failure: ModelTestFailure, replayError: unknown) {
  return {
    isFailure: failure instanceof ModelTestFailure,
    fixtureFormatVersion: failure.fixture?.formatVersion,
    traceTimelineIsArray: Array.isArray(failure.trace.timeline),
    hasCoverage: failure.coverage !== undefined,
    replayIsFailure: replayError instanceof ModelTestFailure,
  }
}

describe('testPaths / propertyTest symmetry', () => {
  it('produces the same coverage shape from both strategies', function*({ expect }) {
    const pathRecorder: Recorder = { stateCalls: [], metaCalls: [] }
    const propertyRecorder: Recorder = { stateCalls: [], metaCalls: [] }
    const observedCounts: number[] = []
    const invariant = ({ snapshot }: {
      snapshot: { context: { count: number } }
    }) => {
      observedCounts.push(snapshot.context.count)
    }

    const pathRun = yield* Effect.promise(() =>
      testPaths(counterMachine, {
        events,
        sut: createSut(pathRecorder),
        invariant,
      })
    )

    yield* expect({
      strategy: pathRun.coverage.exploration.strategy,
      pathGenerator: pathRun.coverage.exploration.pathGenerator,
      pathCount: pathRun.coverage.exploration.pathCount,
      resultCount: pathRun.results.length,
      stateCallsObserved: pathRecorder.stateCalls.length > 0,
      metaCallsObserved: pathRecorder.metaCalls.length > 0,
    }).toEqual({
      strategy: 'paths',
      pathGenerator: 'shortest',
      pathCount: pathRun.results.length,
      resultCount: pathRun.results.length,
      stateCallsObserved: true,
      metaCallsObserved: true,
    })

    const propertyRun = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 4,
        numRuns: 20,
        maxCommands: 5,
        events,
        sut: createSut(propertyRecorder),
        invariant,
      })
    )

    yield* expect({
      pathKeys: Object.keys(pathRun.coverage).sort(),
      propertyKeys: Object.keys(propertyRun.coverage).sort(),
      pathUniverse: transitionUniverse(pathRun.coverage),
      propertyUniverse: transitionUniverse(propertyRun.coverage),
      coveredMissingFromProperty: pathRun.coverage.transitions.covered.filter(
        (id) => !transitionUniverse(propertyRun.coverage).includes(id),
      ),
      propertyStrategy: propertyRun.coverage.exploration.strategy,
      propertyStateCallsObserved: propertyRecorder.stateCalls.length > 0,
      propertyMetaCallsObserved: propertyRecorder.metaCalls.length > 0,
      observedSomething: observedCounts.length > 0,
      observedWithinBound: observedCounts.every((count) => count <= 3),
    }).toEqual({
      pathKeys: Object.keys(propertyRun.coverage).sort(),
      propertyKeys: Object.keys(propertyRun.coverage).sort(),
      pathUniverse: transitionUniverse(propertyRun.coverage),
      propertyUniverse: transitionUniverse(propertyRun.coverage),
      coveredMissingFromProperty: [],
      propertyStrategy: 'property',
      propertyStateCallsObserved: true,
      propertyMetaCallsObserved: true,
      observedSomething: true,
      observedWithinBound: true,
    })
  })

  it('fails the same way and replays from either fixture', function*({ expect }) {
    const recorder: Recorder = { stateCalls: [], metaCalls: [] }

    const pathFailure = (yield* Effect.promise(() =>
      testPaths(counterMachine, {
        events,
        samples: 1,
        sut: createSut(recorder, 1),
      }).catch((error) => error)
    )) as ModelTestFailure
    const propertyFailure = (yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 9,
        numRuns: 50,
        maxCommands: 6,
        events,
        sut: createSut(recorder, 1),
      }).catch((error) => error)
    )) as ModelTestFailure

    const replayErrors = yield* Effect.promise(() =>
      Promise.all(
        [pathFailure, propertyFailure].map((failure) =>
          replayTest(counterMachine, failure.fixture!, {
            sut: createSut({ stateCalls: [], metaCalls: [] }, 1),
          }).then(
            () => undefined,
            (cause: unknown) => cause,
          )
        ),
      )
    )

    yield* expect({
      path: failureTraits(pathFailure, replayErrors[0]),
      property: failureTraits(propertyFailure, replayErrors[1]),
    }).toEqual({
      path: {
        isFailure: true,
        fixtureFormatVersion: 2,
        traceTimelineIsArray: true,
        hasCoverage: true,
        replayIsFailure: true,
      },
      property: {
        isFailure: true,
        fixtureFormatVersion: 2,
        traceTimelineIsArray: true,
        hasCoverage: true,
        replayIsFailure: true,
      },
    })
  })
})

const fetchMachine = createMachine({
  id: 'fetch',
  schemas: {
    context: types<{ data: unknown; error: string | null }>(),
    events: { FETCH: types<{}>() },
  },
  actors: {
    fetchUser: createAsyncLogic({
      run: () => Promise.reject(new Error('the real `fetchUser` actor ran')),
    }),
  },
  context: { data: null, error: null },
  initial: 'idle',
  states: {
    idle: { on: { FETCH: { target: 'loading' } } },
    loading: {
      invoke: {
        src: 'fetchUser',
        onDone: ({ context, event }) => ({
          target: 'success',
          context: { ...context, data: event.output },
        }),
        onError: ({ context, event }) => ({
          target: 'failure',
          context: { ...context, error: String(event.error) },
        }),
      },
    },
    success: { after: { 1000: { target: 'idle' } } },
    failure: { on: { FETCH: { target: 'loading' } } },
  },
})

const fetchOutcomes = {
  fetchUser: fc.oneof(
    fc.constant({ ok: true, output: { id: 1 } }),
    fc.constant({ ok: false, error: new Error('offline') }),
  ),
}

describe('executed-mode symmetry', () => {
  it('leaves the same transitions uncovered from both strategies', function*({ expect }) {
    const pathRun = yield* Effect.promise(() =>
      testPaths(fetchMachine, {
        mode: 'executed',
        samples: 1,
        seed: 7,
        events: { FETCH: fc.constant({}) },
        outcomes: fetchOutcomes,
      })
    )
    const propertyRun = yield* Effect.promise(() =>
      propertyTest(fetchMachine, {
        mode: 'executed',
        seed: 7,
        numRuns: 60,
        maxCommands: 8,
        events: { FETCH: fc.constant({}) },
        outcomes: fetchOutcomes,
        commands: { advance: fc.constant(1000) },
      })
    )

    yield* expect({
      pathUniverse: transitionUniverse(pathRun.coverage),
      propertyUniverse: transitionUniverse(propertyRun.coverage),
      pathUncovered: pathRun.coverage.transitions.uncovered,
      propertyUncovered: propertyRun.coverage.transitions.uncovered,
      pathStrategy: pathRun.coverage.exploration.strategy,
      propertyStrategy: propertyRun.coverage.exploration.strategy,
    }).toEqual({
      pathUniverse: transitionUniverse(propertyRun.coverage),
      propertyUniverse: transitionUniverse(propertyRun.coverage),
      pathUncovered: [],
      propertyUncovered: [],
      pathStrategy: 'paths',
      propertyStrategy: 'property',
    })
  })
})
