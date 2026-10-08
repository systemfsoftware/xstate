import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { formatTestCoverage, propertyTest, type TestCoverage, testCoverageToJSON } from '../../src/engine/index.js'
import { constant, randomAdapter } from './propertyTestAdapter.js'

const ringMachine = createMachine({
  id: 'ring',
  initial: 'a',
  states: {
    a: { on: { NEXT: { target: 'b' } } },
    b: { on: { NEXT: { target: 'c' } } },
    c: { on: { NEXT: { target: 'a' } } },
  },
})

const deepMachine = createMachine({
  id: 'deep',
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

const labelMachine = createMachine({
  id: 'labels',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

const noop = () => {}

function transitionRatio(coverage: TestCoverage): number {
  const { covered, uncovered } = coverage.transitions
  return covered.length / (covered.length + uncovered.length)
}

describe('property stop conditions', () => {
  it('runs a single campaign when `until` is absent', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 8, maxCommands: 4 }),
        events: { NEXT: constant({}) },
        invariant: noop,
      })
    )

    yield* expect({
      configuredRuns: coverage.exploration.configuredRuns,
      completedRuns: coverage.exploration.completedRuns,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({ configuredRuns: 8, completedRuns: 8, stoppedBecause: 'budget' })
  })

  it('stops early once the transition ratio is reached', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        adapter: randomAdapter({ seed: 1, maxCommands: 6 }),
        events: { NEXT: constant({}) },
        invariant: noop,
        until: { transitions: 1 },
        batchRuns: 5,
        maxRuns: 200,
      })
    )

    yield* expect({
      transitionRatio: transitionRatio(coverage),
      stoppedBecause: coverage.exploration.stoppedBecause,
      completedRuns: coverage.exploration.completedRuns,
      stoppedBeforeConfigured: coverage.exploration.completedRuns <
        coverage.exploration.configuredRuns!,
    }).toEqual({
      transitionRatio: 1,
      stoppedBecause: 'until',
      completedRuns: 5,
      stoppedBeforeConfigured: true,
    })
  })

  it('accepts a predicate stop condition', function*({ expect }) {
    const seen: number[] = []
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        adapter: randomAdapter({ seed: 3, maxCommands: 2 }),
        events: { NEXT: constant({}) },
        invariant: noop,
        until: (current) => {
          seen.push(current.exploration.completedRuns)
          return current.exploration.completedRuns >= 10
        },
        batchRuns: 5,
        maxRuns: 100,
      })
    )

    yield* expect({
      seen,
      completedRuns: coverage.exploration.completedRuns,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({ seen: [5, 10], completedRuns: 10, stoppedBecause: 'until' })
  })

  it('stops on the budget when the condition is never met', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        adapter: randomAdapter({ seed: 4, maxCommands: 1 }),
        events: { NEXT: constant({}) },
        invariant: noop,
        until: { runs: 1000 },
        batchRuns: 4,
        maxRuns: 8,
      })
    )

    yield* expect({
      completedRuns: coverage.exploration.completedRuns,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({ completedRuns: 8, stoppedBecause: 'budget' })
  })

  it('ORs the conditions listed under `any`', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        adapter: randomAdapter({ seed: 5, maxCommands: 1 }),
        events: { NEXT: constant({}) },
        invariant: noop,
        until: { any: [{ transitions: 1 }, { runs: 4 }] },
        batchRuns: 4,
        maxRuns: 40,
      })
    )

    yield* expect({
      completedRuns: coverage.exploration.completedRuns,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({ completedRuns: 4, stoppedBecause: 'until' })
  })
})

describe('coverage-guided exploration', () => {
  it('reaches a deep branch that random exploration cannot', function*({ expect }) {
    const shared = {
      events: { GO: constant({}), DEEP: constant({}) },
      invariant: noop,
      maxRuns: 20,
      batchRuns: 5,
    } as const

    const random = yield* Effect.promise(() =>
      propertyTest(deepMachine, {
        adapter: randomAdapter({ seed: 11, maxCommands: 4 }),
        ...shared,
        until: { transitions: 1 },
      })
    )
    const guided = yield* Effect.promise(() =>
      propertyTest(deepMachine, {
        adapter: randomAdapter({ seed: 11, maxCommands: 4 }),
        ...shared,
        frontiers: 'auto',
        until: { transitions: 1 },
      })
    )

    yield* expect({
      randomCoversS5: random.coverage.stateNodes.covered.includes('deep.s5'),
      guidedCoversS5: guided.coverage.stateNodes.covered.includes('deep.s5'),
      guidedCoversDone: guided.coverage.stateNodes.covered.includes(
        'deep.done',
      ),
      guidedRatioAboveRandom: transitionRatio(guided.coverage) >
        transitionRatio(random.coverage),
      moreThanOneFrontier: guided.coverage.exploration.frontiers.length > 1,
    }).toEqual({
      randomCoversS5: false,
      guidedCoversS5: true,
      guidedCoversDone: true,
      guidedRatioAboveRandom: true,
      moreThanOneFrontier: true,
    })
  })

  it('accepts the explicit `uncovered` strategy and reports frontiers', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(deepMachine, {
        adapter: randomAdapter({ seed: 2, maxCommands: 3 }),
        events: { GO: constant({}), DEEP: constant({}) },
        invariant: noop,
        frontiers: { strategy: 'uncovered', maxFrontiers: 3, runsPerFrontier: 2 },
        until: { transitions: 1 },
        batchRuns: 6,
        maxRuns: 30,
      })
    )

    yield* expect({
      someFrontierCovered: coverage.frontiers.covered.length > 0,
      everyFrontierAtBudgetTwo: coverage.exploration.frontiers.every(
        (frontier) => frontier.runBudget === 2,
      ),
    }).toEqual({
      someFrontierCovered: true,
      everyFrontierAtBudgetTwo: true,
    })
  })

  it('falls back to random exploration when nothing is uncovered', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(ringMachine, {
        adapter: randomAdapter({ seed: 6, maxCommands: 6 }),
        events: { NEXT: constant({}) },
        invariant: noop,
        frontiers: 'auto',
        batchRuns: 4,
        maxRuns: 8,
      })
    )

    yield* expect({
      completedRuns: coverage.exploration.completedRuns,
      stoppedBecause: coverage.exploration.stoppedBecause,
    }).toEqual({ completedRuns: 8, stoppedBecause: 'budget' })
  })
})

describe('labels and statistics', () => {
  it('aggregates label counts, values and shares', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(labelMachine, {
        adapter: randomAdapter({ seed: 9, numRuns: 4, maxCommands: 3 }),
        events: { INC: constant({}) },
        invariant: ({ snapshot, label, classify }) => {
          label('count', snapshot.context.count)
          classify(snapshot.context.count === 0, 'initial')
        },
      })
    )

    const countLabel = coverage.labels['count']
    const initialLabel = coverage.labels['initial']
    if (countLabel === undefined || initialLabel === undefined) {
      throw new Error('expected count and initial label statistics')
    }
    yield* expect({
      countCount: countLabel.count,
      zeroValues: countLabel.values['0'],
      initialCount: initialLabel.count,
      initialShare: initialLabel.share,
      countShare: countLabel.share,
    }).toEqual({
      countCount: coverage.invariantChecks,
      zeroValues: 4,
      initialCount: 4,
      initialShare: 1,
      countShare: 1,
    })
  })

  it('renders labels in text, markdown and JSON', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(labelMachine, {
        adapter: randomAdapter({ seed: 9, numRuns: 2, maxCommands: 2 }),
        events: { INC: constant({}) },
        invariant: ({ snapshot, label }) => {
          label('count', snapshot.context.count)
        },
      })
    )

    const jsonCountLabel = testCoverageToJSON(coverage).labels['count']
    const countLabel = coverage.labels['count']
    if (jsonCountLabel === undefined || countLabel === undefined) {
      throw new Error('expected count label statistics')
    }
    yield* expect({
      textContainsLabels: formatTestCoverage(coverage).includes('labels:'),
      markdownContainsLabelsHeading: formatTestCoverage(coverage, {
        format: 'markdown',
      }).includes('## Labels'),
      jsonCount: jsonCountLabel.count,
    }).toEqual({
      textContainsLabels: true,
      markdownContainsLabelsHeading: true,
      jsonCount: countLabel.count,
    })
  })

  it('fails the campaign when `expectLabels` is not met', function*({ expect }) {
    const error = yield* Effect.promise(() =>
      propertyTest(labelMachine, {
        adapter: randomAdapter({ seed: 9, numRuns: 3, maxCommands: 2 }),
        events: { INC: constant({}) },
        invariant: ({ snapshot, classify }) => {
          classify(snapshot.context.count > 100, 'large')
        },
        expectLabels: { large: { min: 0.5, minCount: 1 } },
      }).then(
        () => undefined,
        (cause: unknown) => cause as Error & { coverage: TestCoverage },
      )
    )

    yield* expect({
      isError: error instanceof Error,
      shareMessage: error!.message.includes('large: share 0.000 is below 0.5'),
      countMessage: error!.message.includes('large: count 0 is below 1'),
      runs: error!.coverage.runs,
    }).toEqual({
      isError: true,
      shareMessage: true,
      countMessage: true,
      runs: 3,
    })
  })

  it('passes when `expectLabels` is met', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(labelMachine, {
        adapter: randomAdapter({ seed: 9, numRuns: 3, maxCommands: 2 }),
        events: { INC: constant({}) },
        invariant: ({ classify }) => {
          classify(true, 'always')
        },
        expectLabels: { always: { min: 1, minCount: 3 } },
      })
    )

    yield* expect({
      labelCount: result.coverage.labels['always']?.count,
      labelShare: result.coverage.labels['always']?.share,
    }).toEqual({
      labelCount: result.coverage.invariantChecks,
      labelShare: 1,
    })
  })
})
