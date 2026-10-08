import { describe } from '@systemfsoftware/vitest'
import { createMachine } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import {
  describeTestSuite,
  generateTestSuite,
  parseTestSuite,
  replayTestSuite,
  serializeTestSuite,
} from '../../src/engine/index.js'
import { constant, randomAdapter } from './propertyTestAdapter.js'

const trafficMachine = createMachine({
  id: 'traffic',
  initial: 'red',
  states: {
    red: { on: { NEXT: { target: 'green' }, STOP: { target: 'red' } } },
    green: { on: { NEXT: { target: 'yellow' }, STOP: { target: 'red' } } },
    yellow: { on: { NEXT: { target: 'red' }, STOP: { target: 'red' } } },
  },
})

const mutatedMachine = createMachine({
  id: 'traffic',
  initial: 'red',
  states: {
    red: { on: { NEXT: { target: 'green' }, STOP: { target: 'red' } } },
    green: { on: { NEXT: { target: 'yellow' } } },
    yellow: { on: { NEXT: { target: 'red' }, STOP: { target: 'red' } } },
  },
})

const invariant = (
  { snapshot, event }: { snapshot: { value: unknown }; event: { type?: string } | undefined },
) => {
  if (typeof snapshot.value !== 'string') {
    throw new Error(`expected a string state value, got ${String(snapshot.value)}`)
  }
  if (event?.type === 'STOP' && snapshot.value !== 'red') {
    throw new Error(`STOP must park the light on red, got ${snapshot.value}`)
  }
}

const generate = () =>
  generateTestSuite(trafficMachine, {
    adapter: randomAdapter({ seed: 7, numRuns: 20, maxCommands: 6 }),
    events: {
      NEXT: constant({}),
      STOP: constant({}),
    },
    invariant,
  })

describe('generateTestSuite', (it) => {
  it('covers every reachable transition with few fixtures', function*({ expect }) {
    const suite = yield* Effect.promise(() => generate())

    const transitionsDimension = suite.coverage.dimensions['transitions']
    if (transitionsDimension === undefined) {
      throw new Error('expected a transitions dimension')
    }
    const eventTypes = new Set(
      suite.fixtures.flatMap((fixture) =>
        fixture.timeline.map((entry) => entry.command.type === 'event' ? entry.command.event.type : '')
      ),
    )
    yield* expect({
      formatVersion: suite.formatVersion,
      machineId: suite.machineId,
      generatedAt: suite.generatedAt,
      uncovered: transitionsDimension.uncovered,
      fixtureCountInRange: suite.fixtures.length >= 1 && suite.fixtures.length <= 4,
      eventTypes: [...eventTypes].sort(),
    }).toEqual({
      formatVersion: 1,
      machineId: 'traffic',
      generatedAt: undefined,
      uncovered: [],
      fixtureCountInRange: true,
      eventTypes: ['NEXT', 'STOP'],
    })
  })

  it('is deterministic', function*({ expect }) {
    const first = yield* Effect.promise(() => generate())
    const second = yield* Effect.promise(() => generate())

    yield* expect(serializeTestSuite(first)).toBe(serializeTestSuite(second))
  })

  it('keeps every distinct trace with `select: "all"`', function*({ expect }) {
    const minimal = yield* Effect.promise(() => generate())
    const all = yield* Effect.promise(() =>
      generateTestSuite(trafficMachine, {
        adapter: randomAdapter({ seed: 7, numRuns: 20, maxCommands: 6 }),
        events: { NEXT: constant({}), STOP: constant({}) },
        invariant,
        select: 'all',
      })
    )

    yield* expect(all.fixtures.length).toBeGreaterThan(minimal.fixtures.length)
  })

  it('respects `maxFixtures`', function*({ expect }) {
    const suite = yield* Effect.promise(() =>
      generateTestSuite(trafficMachine, {
        adapter: randomAdapter({ seed: 7, numRuns: 20, maxCommands: 6 }),
        events: { NEXT: constant({}), STOP: constant({}) },
        invariant,
        maxFixtures: 1,
      })
    )

    yield* expect(suite.fixtures.length).toBe(1)
  })

  it('records `generatedAt` when supplied', function*({ expect }) {
    const suite = yield* Effect.promise(() =>
      generateTestSuite(trafficMachine, {
        adapter: randomAdapter({ seed: 7, numRuns: 5, maxCommands: 4 }),
        events: { NEXT: constant({}) },
        invariant,
        generatedAt: '2026-01-01T00:00:00.000Z',
      })
    )

    yield* expect(suite.generatedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('replayTestSuite', (it) => {
  it('passes against the machine it was generated from', function*({ expect }) {
    const suite = yield* Effect.promise(() => generate())
    const result = yield* Effect.promise(() =>
      replayTestSuite(trafficMachine, suite, {
        invariant,
      })
    )

    yield* expect(result).toEqual({ failed: [], passed: suite.fixtures.length })
  })

  it('reports failures naming the fixture when the machine changes', function*({ expect }) {
    const suite = yield* Effect.promise(() => generate())
    const result = yield* Effect.promise(() =>
      replayTestSuite(mutatedMachine, suite, {
        invariant,
      })
    )

    const firstFailure = result.failed[0]
    if (firstFailure === undefined) {
      throw new Error('expected a failed fixture')
    }
    const failingFixture = suite.fixtures[firstFailure.index]
    if (failingFixture === undefined) {
      throw new Error('expected the failing fixture')
    }
    yield* expect({
      failedCountAboveZero: result.failed.length > 0,
      total: result.passed + result.failed.length,
      fixtureCount: suite.fixtures.length,
      titleNamesFixture: /^fixture \d+: /.test(firstFailure.title),
      sameFixture: firstFailure.fixture === failingFixture,
    }).toEqual({
      failedCountAboveZero: true,
      total: suite.fixtures.length,
      fixtureCount: suite.fixtures.length,
      titleNamesFixture: true,
      sameFixture: true,
    })
  })
})

describe('serializeTestSuite', (it) => {
  it('round-trips through JSON', function*({ expect }) {
    const suite = yield* Effect.promise(() => generate())
    const parsed = parseTestSuite(serializeTestSuite(suite))

    yield* expect({ fixtures: parsed.fixtures, machineId: parsed.machineId }).toEqual({
      fixtures: suite.fixtures,
      machineId: 'traffic',
    })

    const result = yield* Effect.promise(() =>
      replayTestSuite(trafficMachine, parsed, {
        invariant,
      })
    )
    yield* expect(result.failed).toEqual([])
  })

  it('rejects unknown format versions', function*({ expect }) {
    yield* expect(() => parseTestSuite(JSON.stringify({ formatVersion: 99, fixtures: [] }))).toThrow(
      /Unsupported property suite format version: 99/,
    )
  })
})

describe('describeTestSuite', (it) => {
  it('registers one test per fixture', function*({ expect }) {
    const suite = yield* Effect.promise(() => generate())
    const registered: string[] = []
    const blocks: string[] = []

    describeTestSuite(suite, trafficMachine, {
      invariant,
      describe: (name, fn) => {
        blocks.push(name)
        fn()
      },
      it: (name) => {
        registered.push(name)
      },
    })

    yield* expect({
      blocks,
      registeredCount: registered.length,
      firstTitle: registered[0],
    }).toEqual({
      blocks: ['property suite (traffic)'],
      registeredCount: suite.fixtures.length,
      firstTitle: expect.stringMatching(/^fixture 1: /),
    })
  })
})
