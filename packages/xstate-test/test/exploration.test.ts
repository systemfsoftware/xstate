import { describe } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { fastCheckAdapter, ModelTestFailure, propertyTest } from '../src/index.js'
import type { TestCoverage } from '../src/index.js'

const ringMachine = createMachine({
  id: 'exploration-ring',
  schemas: { events: { NEXT: types<{}>() } },
  initial: 'a',
  states: {
    a: { on: { NEXT: { target: 'b' } } },
    b: { on: { NEXT: { target: 'c' } } },
    c: { on: { NEXT: { target: 'a' } } },
  },
})

const deepMachine = createMachine({
  id: 'exploration-deep',
  schemas: { events: { GO: types<{}>(), DEEP: types<{}>() } },
  initial: 's0',
  states: {
    s0: { on: { GO: { target: 's1' } } },
    s1: { on: { GO: { target: 's2' } } },
    s2: { on: { GO: { target: 's3' } } },
    s3: { on: { GO: { target: 's4' } } },
    s4: { on: { GO: { target: 's5' } } },
    s5: { on: { DEEP: { target: 'done' } } },
    done: {},
  },
})

const counterMachine = createMachine({
  id: 'exploration-counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

function transitionRatio(coverage: TestCoverage): number {
  const { covered, uncovered } = coverage.transitions
  return covered.length / (covered.length + uncovered.length)
}

describe('stop conditions', (it) => {
  it('stops as soon as every transition is covered', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        seed: 7,
        maxCommands: 6,
        events: { NEXT: fc.constant({}) },
        invariant: () => {},
        until: { transitions: 1 },
        batchRuns: 5,
        maxRuns: 500,
      })
    )

    yield* expect({
      ratio: transitionRatio(coverage),
      stoppedBecause: coverage.exploration.stoppedBecause,
      configuredRuns: coverage.exploration.configuredRuns,
      completedRunsBelowConfigured: coverage.exploration.completedRuns < 500,
    }).toEqual({
      ratio: 1,
      stoppedBecause: 'until',
      configuredRuns: 500,
      completedRunsBelowConfigured: true,
    })
  })

  it('stops on a predicate', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        seed: 7,
        maxCommands: 2,
        events: { NEXT: fc.constant({}) },
        invariant: () => {},
        until: (current) => current.stateNodes.covered.includes('exploration-ring.c'),
        batchRuns: 3,
        maxRuns: 60,
      })
    )

    yield* expect({
      covered: coverage.stateNodes.covered,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({
      covered: expect.arrayContaining(['exploration-ring.c']),
      stoppedBecause: 'until',
    })
  })

  it('keeps the single-campaign behavior when `until` is absent', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        seed: 7,
        numRuns: 12,
        maxCommands: 3,
        events: { NEXT: fc.constant({}) },
        invariant: () => {},
      })
    )

    yield* expect({
      configuredRuns: coverage.exploration.configuredRuns,
      completedRuns: coverage.exploration.completedRuns,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({
      configuredRuns: 12,
      completedRuns: 12,
      stoppedBecause: 'budget',
    })
  })
})

describe('coverage-guided frontiers', (it) => {
  it('covers a deep branch that unguided runs miss', function*({ expect }) {
    const guided = yield* Effect.promise(() =>
      propertyTest(deepMachine, {
        seed: 21,
        maxCommands: 4,
        events: { GO: fc.constant({}), DEEP: fc.constant({}) },
        invariant: () => {},
        frontiers: 'auto',
        until: { transitions: 1 },
        batchRuns: 10,
        maxRuns: 40,
      })
    )
    const unguided = yield* Effect.promise(() =>
      propertyTest(deepMachine, {
        seed: 21,
        maxCommands: 4,
        events: { GO: fc.constant({}), DEEP: fc.constant({}) },
        invariant: () => {},
        until: { transitions: 1 },
        batchRuns: 10,
        maxRuns: 40,
      })
    )

    yield* expect({
      unguidedReachesDeep: unguided.coverage.stateNodes.covered.includes('exploration-deep.s5'),
      guidedReachesDeep: guided.coverage.stateNodes.covered.includes('exploration-deep.s5'),
      guidedRatioAboveUnguided: transitionRatio(guided.coverage) > transitionRatio(unguided.coverage),
    }).toEqual({
      unguidedReachesDeep: false,
      guidedReachesDeep: true,
      guidedRatioAboveUnguided: true,
    })
  })

  it('shrinks only the generated continuation of a frontier', function*({ expect }) {
    const failure = yield* Effect.promise(() =>
      propertyTest(deepMachine, {
        seed: 3,
        maxCommands: 4,
        events: { GO: fc.constant({}), DEEP: fc.constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.matches('done')) {
            throw new Error('reached done')
          }
        },
        frontiers: 'auto',
        until: { transitions: 1 },
        batchRuns: 10,
        maxRuns: 40,
      }).then(
        () => undefined,
        (cause: unknown) => cause as ModelTestFailure,
      )
    )

    const trace = failure!.trace
    const prefix = trace.prefixEvents
    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      prefixIsNonEmpty: prefix.length > 0,
      prefixIsAllGo: prefix.every((event) => event.type === 'GO'),
      lastEvent: trace.events.at(-1),
      totalSteps: prefix.length + trace.events.length,
      message: failure!.message,
    }).toEqual({
      isModelTestFailure: true,
      prefixIsNonEmpty: true,
      prefixIsAllGo: true,
      lastEvent: { type: 'DEEP' },
      totalSteps: 6,
      message: expect.stringContaining('1. prefix GO'),
    })
  })
})

describe('labels', (it) => {
  it('records labels and enforces `expectLabels`', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 5,
        numRuns: 20,
        maxCommands: 4,
        events: { INC: fc.constant({}) },
        invariant: ({ snapshot, label, classify }) => {
          label('count', snapshot.context.count)
          classify(snapshot.context.count > 1, 'above one')
        },
        expectLabels: { count: { min: 1 } },
      })
    )

    const countLabel = coverage.labels['count']
    if (countLabel === undefined) {
      throw new Error('expected a count label')
    }
    const aboveOneLabel = coverage.labels['above one']
    if (aboveOneLabel === undefined) {
      throw new Error('expected an above-one label')
    }
    yield* expect({
      share: countLabel.share,
      zeroCount: countLabel.values['0'],
      aboveOneCountAboveZero: aboveOneLabel.count > 0,
    }).toEqual({
      share: 1,
      zeroCount: 20,
      aboveOneCountAboveZero: true,
    })
  })

  it('reports label shortfalls with the coverage attached', function*({ expect }) {
    const error = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 5,
        numRuns: 5,
        maxCommands: 2,
        events: { INC: fc.constant({}) },
        invariant: ({ snapshot, classify }) => {
          classify(snapshot.context.count > 50, 'huge')
        },
        expectLabels: { huge: { min: 0.25 } },
      }).then(
        () => undefined,
        (cause: unknown) => cause as Error & { coverage: TestCoverage },
      )
    )

    yield* expect({
      name: error!.name,
      message: error!.message,
      completedRuns: error!.coverage.exploration.completedRuns,
    }).toEqual({
      name: 'PropertyLabelExpectationError',
      message: expect.stringContaining('huge: share 0.000 is below 0.25'),
      completedRuns: 5,
    })
  })
})
