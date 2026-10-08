import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { propertyTest } from '../src/index.js'

const lightMachine = createMachine({
  id: 'p1-light',
  schemas: {
    events: {
      NEXT: types<{}>(),
      RESET: types<{}>(),
    },
  },
  initial: 'green',
  states: {
    green: { on: { NEXT: { target: 'yellow' } } },
    yellow: { on: { NEXT: { target: 'red' } } },
    red: {
      on: {
        NEXT: { target: 'green' },
        RESET: { target: 'green' },
      },
    },
  },
})

describe('transition pair coverage', () => {
  it('declares the statically possible pairs and reports which ran', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(lightMachine, {
        seed: 7,
        numRuns: 40,
        maxCommands: 4,
        events: { NEXT: fc.constant({}) },
        invariant: () => {},
      })
    )

    const pairs = coverage.transitionPairs
    const greenNext = JSON.stringify([
      'transition',
      'p1-light.green',
      'NEXT',
      0,
    ])
    const yellowNext = JSON.stringify([
      'transition',
      'p1-light.yellow',
      'NEXT',
      0,
    ])
    const redReset = JSON.stringify(['transition', 'p1-light.red', 'RESET', 0])
    const all = [
      ...pairs.covered,
      ...pairs.uncovered,
      ...pairs.unreachable,
      ...pairs.unknown,
    ]

    yield* expect({
      truncated: pairs.truncated,
      coveredGreenToYellow: pairs.covered.includes(
        `${greenNext} -> ${yellowNext}`,
      ),
      coveredRedReset: pairs.covered.filter((id) => id.includes(redReset)),
      uncoveredRedReset: pairs.uncovered.some((id) => id.includes(redReset)),
      selfPair: all.filter((id) => id === `${greenNext} -> ${greenNext}`),
      nonPairIds: all.filter((id) => !id.includes(' -> ')),
    }).toEqual({
      truncated: false,
      coveredGreenToYellow: true,
      coveredRedReset: [],
      uncoveredRedReset: true,
      selfPair: [],
      nonPairIds: [],
    })
  })

  it('counts pairs within a run only', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(lightMachine, {
        seed: 3,
        numRuns: 5,
        maxCommands: 1,
        events: { NEXT: fc.constant({}) },
        invariant: () => {},
      })
    )

    const greenNext = JSON.stringify([
      'transition',
      'p1-light.green',
      'NEXT',
      0,
    ])
    const yellowNext = JSON.stringify([
      'transition',
      'p1-light.yellow',
      'NEXT',
      0,
    ])
    yield* expect({
      count: coverage.transitionPairs.counts[
        `${greenNext} -> ${yellowNext}`
      ],
    }).toEqual({ count: undefined })
  })
})

describe('requirement coverage', () => {
  const requirementMachine = createMachine({
    id: 'p1-req',
    schemas: {
      events: { GO: types<{}>(), SKIP: types<{}>() },
      meta: types<{ requirements: string | string[] }>(),
    },
    initial: 'idle',
    states: {
      idle: {
        meta: { requirements: 'REQ-START' },
        on: {
          GO: {
            target: 'active',
            meta: { requirements: ['REQ-GO', 'REQ-ANY'] },
          },
          SKIP: { target: 'done', meta: { requirements: 'REQ-SKIP' } },
        },
      },
      active: { meta: { requirements: ['REQ-ACTIVE'] } },
      done: {},
    },
  })

  it('declares requirements from state node and transition meta', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(requirementMachine, {
        seed: 11,
        numRuns: 20,
        maxCommands: 2,
        events: { GO: fc.constant({}) },
        invariant: () => {},
      })
    )

    const requirements = coverage.requirements
    yield* expect({
      universe: [
        ...requirements.covered,
        ...requirements.uncovered,
        ...requirements.unreachable,
        ...requirements.unknown,
      ].sort(),
      covered: [...requirements.covered].sort(),
      uncoveredSkip: requirements.uncovered.includes('REQ-SKIP'),
      startSource: requirements.sources['REQ-START'],
      goSource: requirements.sources['REQ-GO'],
    }).toEqual({
      universe: ['REQ-ACTIVE', 'REQ-ANY', 'REQ-GO', 'REQ-SKIP', 'REQ-START'],
      covered: ['REQ-ACTIVE', 'REQ-ANY', 'REQ-GO', 'REQ-START'],
      uncoveredSkip: true,
      startSource: ['stateNode:p1-req.idle'],
      goSource: [
        `transition:${JSON.stringify(['transition', 'p1-req.idle', 'GO', 0])}`,
      ],
    })
  })
})

describe('event weights', () => {
  const weightMachine = createMachine({
    id: 'p1-weight',
    schemas: {
      context: types<{ a: number; b: number }>(),
      events: { A: types<{}>(), B: types<{}>() },
    },
    context: { a: 0, b: 0 },
    on: {
      A: ({ context }) => ({ context: { ...context, a: context.a + 1 } }),
      B: ({ context }) => ({ context: { ...context, b: context.b + 1 } }),
    },
  })

  it('skews generation toward heavier cases', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(weightMachine, {
        seed: 99,
        numRuns: 50,
        maxCommands: 20,
        events: {
          A: { generate: fc.constant({}), weight: 0.01 },
          B: { generate: fc.constant({}), weight: 100 },
        },
        invariant: () => {},
      })
    )

    const a = coverage.eventCases[
      JSON.stringify(['event-case', 'A', 'default'])
    ]!
    const b = coverage.eventCases[
      JSON.stringify(['event-case', 'B', 'default'])
    ]!
    yield* expect({
      aWeight: a.weight,
      bWeight: b.weight,
      bGeneratedOverTenTimesA: b.generated > a.generated * 10,
    }).toEqual({
      aWeight: 0.01,
      bWeight: 100,
      bGeneratedOverTenTimesA: true,
    })
  })

  it('defaults to weight 1 and keeps the unweighted generation path', function*({ expect }) {
    const bare = yield* Effect.promise(() =>
      propertyTest(weightMachine, {
        seed: 5,
        numRuns: 25,
        maxCommands: 10,
        events: { A: fc.constant({}), B: fc.constant({}) },
        invariant: () => {},
      })
    )
    const explicit = yield* Effect.promise(() =>
      propertyTest(weightMachine, {
        seed: 5,
        numRuns: 25,
        maxCommands: 10,
        events: {
          A: { generate: fc.constant({}), weight: 1 },
          B: { generate: fc.constant({}), weight: 1 },
        },
        invariant: () => {},
      })
    )

    yield* expect({
      eventCases: bare.coverage.eventCases,
      steps: bare.coverage.steps,
    }).toEqual({
      eventCases: explicit.coverage.eventCases,
      steps: explicit.coverage.steps,
    })
  })

  it('rejects non-positive weights', function*({ expect }) {
    const error = yield* Effect.promise(() =>
      propertyTest(weightMachine, {
        seed: 1,
        numRuns: 1,
        events: { A: { generate: fc.constant({}), weight: 0 } },
        invariant: () => {},
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      )
    )

    yield* expect({
      message: error instanceof Error ? error.message : undefined,
    }).toEqual({
      message:
        'Property event case "default" for "A" has an invalid `weight` (0). Weights must be positive, finite numbers.',
    })
  })
})
