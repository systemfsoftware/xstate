import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, type EventFrom, type SnapshotFrom } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import {
  describeTestSuite,
  fastCheckAdapter,
  generateTestSuite,
  parseTestSuite,
  replayTestSuite,
  serializeTestSuite,
} from '../src/index.js'

const trafficMachine = createMachine({
  id: 'traffic',
  initial: 'red',
  states: {
    red: { on: { NEXT: { target: 'green' }, STOP: { target: 'red' } } },
    green: { on: { NEXT: { target: 'yellow' }, STOP: { target: 'red' } } },
    yellow: { on: { NEXT: { target: 'red' }, STOP: { target: 'red' } } },
  },
})

const invariant = ({
  snapshot,
  event,
}: {
  snapshot: SnapshotFrom<typeof trafficMachine>
  event: EventFrom<typeof trafficMachine> | undefined
}) => {
  if (typeof snapshot.value !== 'string') {
    throw new Error(
      `expected snapshot.value to be a string, got ${typeof snapshot.value}`,
    )
  }
  if (event?.type === 'STOP' && snapshot.value !== 'red') {
    throw new Error(
      `expected STOP to park the light on red, got ${String(snapshot.value)}`,
    )
  }
}

const generate = () =>
  generateTestSuite(trafficMachine, {
    numRuns: 25,
    seed: 3,
    events: {
      NEXT: fc.constant({}),
      STOP: fc.constant({}),
    },
    invariant,
  })

describe('property suites with FastCheck', () => {
  it('exports a coverage-complete suite that replays offline', function*({
    expect,
  }) {
    const suite = yield* Effect.promise(() => generate())

    const transitionsDimension = suite.coverage.dimensions['transitions']
    if (transitionsDimension === undefined) {
      throw new Error('expected a transitions dimension')
    }
    yield* expect({
      machineId: suite.machineId,
      uncovered: transitionsDimension.uncovered,
      hasFixtures: suite.fixtures.length > 0,
    }).toEqual({ machineId: 'traffic', uncovered: [], hasFixtures: true })

    const replayed = parseTestSuite(serializeTestSuite(suite))
    const result = yield* Effect.promise(() =>
      replayTestSuite(trafficMachine, replayed, {
        invariant,
      })
    )

    yield* expect({ failed: result.failed, passed: result.passed }).toEqual({
      failed: [],
      passed: suite.fixtures.length,
    })
  })

  it('registers one test per fixture', function*({ expect }) {
    const suite = yield* Effect.promise(() => generate())
    const registered: string[] = []

    describeTestSuite(suite, trafficMachine, {
      invariant,
      describe: (_name, fn) => fn(),
      it: (name) => {
        registered.push(name)
      },
    })

    yield* expect(registered.length).toEqual(suite.fixtures.length)
  })
})
