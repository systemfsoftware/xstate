import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, type EventFrom, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import {
  ModelTestFailure,
  propertyTest,
  replayTest,
  type TestCoverage,
  testPaths,
  type TestSut,
} from '../../src/engine/index.js'
import { constant, randomAdapter, record } from './propertyTestAdapter.js'

interface MetaSession {
  metaCalls?: string[]
}

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    meta: types<{ test: (session: MetaSession) => void }>(),
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
        test: (session: MetaSession) => {
          session?.metaCalls?.push('counting')
        },
      },
      on: {
        INC: ({ context, event }) => ({
          context: {
            count: Math.min(3, context.count + event.value),
          },
        }),
        RESET: { target: 'done' },
      },
    },
    done: {
      meta: {
        test: (session: MetaSession) => {
          session?.metaCalls?.push('done')
        },
      },
      type: 'final',
    },
  },
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>
type CounterEvent = EventFrom<typeof counterMachine>

const events = {
  INC: record({ value: constant(1) }),
  RESET: constant({}),
}

interface Recorder {
  stateCalls: string[]
  metaCalls: string[]
}

function createSut(
  recorder: Recorder,
  bugAt?: number,
): TestSut<CounterSnapshot, CounterEvent> {
  return {
    projectModel: (snapshot) => snapshot.context.count,
    create: () => {
      let count = 0
      const session = {
        metaCalls: recorder.metaCalls,
        send: (event: CounterEvent) => {
          if (event.type === 'INC') {
            if (bugAt !== undefined && count >= bugAt) {
              return
            }
            count = Math.min(3, count + event.value)
          }
        },
        read: () => count,
        states: {
          '*': (snapshot: CounterSnapshot) => {
            recorder.stateCalls.push(String(snapshot.value))
          },
        },
      }
      return session
    },
  }
}

function dimensionUniverse(coverage: TestCoverage, key: 'transitions') {
  return [
    ...coverage[key].covered,
    ...coverage[key].uncovered,
    ...coverage[key].unreachable,
    ...coverage[key].unknown,
  ].sort()
}

describe('path and property symmetry', () => {
  it('produces the same coverage shape from both strategies', function*({ expect }) {
    const pathRecorder: Recorder = { stateCalls: [], metaCalls: [] }
    const propertyRecorder: Recorder = { stateCalls: [], metaCalls: [] }
    const pathCounts: number[] = []
    const propertyCounts: number[] = []

    const pathRun = yield* Effect.promise(() =>
      testPaths(counterMachine, {
        events,
        sut: createSut(pathRecorder),
        invariant: ({ snapshot }) => {
          pathCounts.push(snapshot.context.count)
        },
      })
    )
    const propertyRun = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 5, numRuns: 20, maxCommands: 5 }),
        events,
        sut: createSut(propertyRecorder),
        invariant: ({ snapshot }) => {
          propertyCounts.push(snapshot.context.count)
        },
      })
    )

    const pathKeys = Object.keys(pathRun.coverage).sort()
    const propertyKeys = Object.keys(propertyRun.coverage).sort()
    const pathUniverse = dimensionUniverse(pathRun.coverage, 'transitions')
    const propertyUniverse = dimensionUniverse(propertyRun.coverage, 'transitions')

    yield* expect({
      pathKeys,
      pathUniverse,
      pathCount: pathRun.coverage.exploration.pathCount,
      coveredByPropertyUniverse: propertyUniverse,
      pathStrategy: pathRun.coverage.exploration.strategy,
      pathGenerator: pathRun.coverage.exploration.pathGenerator,
      propertyStrategy: propertyRun.coverage.exploration.strategy,
      pathStateCallsPositive: pathRecorder.stateCalls.length > 0,
      pathMetaCallsPositive: pathRecorder.metaCalls.length > 0,
      propertyStateCallsPositive: propertyRecorder.stateCalls.length > 0,
      propertyMetaCallsPositive: propertyRecorder.metaCalls.length > 0,
      pathCountsNonNegative: pathCounts.every((count) => count >= 0),
      propertyCountsNonNegative: propertyCounts.every((count) => count >= 0),
    }).toEqual({
      pathKeys: propertyKeys,
      pathUniverse: propertyUniverse,
      pathCount: pathRun.results.length,
      coveredByPropertyUniverse: expect.arrayContaining([
        ...pathRun.coverage.transitions.covered,
      ]),
      pathStrategy: 'paths',
      pathGenerator: 'shortest',
      propertyStrategy: 'property',
      pathStateCallsPositive: true,
      pathMetaCallsPositive: true,
      propertyStateCallsPositive: true,
      propertyMetaCallsPositive: true,
      pathCountsNonNegative: true,
      propertyCountsNonNegative: true,
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
        adapter: randomAdapter({ seed: 11, numRuns: 50, maxCommands: 6 }),
        events,
        sut: createSut(recorder, 1),
      }).catch((error) => error)
    )) as ModelTestFailure

    const replayFailures: unknown[] = []
    for (const failure of [pathFailure, propertyFailure]) {
      const error = yield* Effect.promise(() =>
        replayTest(counterMachine, failure.fixture!, {
          sut: createSut({ stateCalls: [], metaCalls: [] }, 1),
        }).then(
          () => undefined,
          (cause) => cause,
        )
      )
      replayFailures.push(error)
    }

    yield* expect({
      pathIsFailure: pathFailure instanceof ModelTestFailure,
      propertyIsFailure: propertyFailure instanceof ModelTestFailure,
      pathFixtureMachineId: pathFailure.fixture?.machine?.id,
      propertyFixtureMachineId: propertyFailure.fixture?.machine?.id,
      pathFixtureFormatVersion: pathFailure.fixture?.formatVersion,
      propertyFixtureFormatVersion: propertyFailure.fixture?.formatVersion,
      pathTraceHasTimeline: Array.isArray(pathFailure.trace.timeline),
      propertyTraceHasTimeline: Array.isArray(propertyFailure.trace.timeline),
      pathStrategy: pathFailure.coverage!.exploration.strategy,
      propertyStrategy: propertyFailure.coverage!.exploration.strategy,
      pathReplayFailed: replayFailures[0] instanceof ModelTestFailure,
      propertyReplayFailed: replayFailures[1] instanceof ModelTestFailure,
    }).toEqual({
      pathIsFailure: true,
      propertyIsFailure: true,
      pathFixtureMachineId: 'counter',
      propertyFixtureMachineId: 'counter',
      pathFixtureFormatVersion: 2,
      propertyFixtureFormatVersion: 2,
      pathTraceHasTimeline: true,
      propertyTraceHasTimeline: true,
      pathStrategy: 'paths',
      propertyStrategy: 'property',
      pathReplayFailed: true,
      propertyReplayFailed: true,
    })
  })
})
