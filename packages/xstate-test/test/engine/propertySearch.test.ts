import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { propertyTest, type TestTrace } from '../../src/engine/index.js'
import { constant, randomAdapter } from './propertyTestAdapter.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: {
      INC: types<{}>(),
      DEC: types<{}>(),
      RESET: types<{}>(),
    },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
    DEC: ({ context }) => ({ context: { count: context.count - 1 } }),
    RESET: () => ({ context: { count: 0 } }),
  },
})

const noop = () => {}

const collectSwarmSets = (seed: number): Promise<string[][]> => {
  const swarms: string[][] = []
  return propertyTest(counterMachine, {
    adapter: randomAdapter({ seed: 7, numRuns: 12, maxCommands: 4 }),
    events: {
      INC: constant({}),
      DEC: constant({}),
      RESET: constant({}),
    },
    swarm: { seed },
    invariant: noop,
    collect: (trace: TestTrace<any, any>) => {
      swarms.push([...(trace.swarm ?? [])])
    },
  }).then(() => swarms)
}

describe('swarm testing', () => {
  it('picks the same enabled sets for the same seed', function*({ expect }) {
    const first = yield* Effect.promise(() => collectSwarmSets(3))
    const second = yield* Effect.promise(() => collectSwarmSets(3))

    yield* expect({ first, firstLength: first.length }).toEqual({
      first: second,
      firstLength: 12,
    })

    const other = yield* Effect.promise(() => collectSwarmSets(11))

    yield* expect(other).not.toEqual(first)
  })

  it('excludes event cases from individual runs', function*({ expect }) {
    const swarms: string[][] = []
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 5, numRuns: 20, maxCommands: 6 }),
        events: {
          INC: constant({}),
          DEC: constant({}),
          RESET: constant({}),
        },
        swarm: true,
        invariant: noop,
        collect: (trace: TestTrace<any, any>) => {
          swarms.push([...(trace.swarm ?? [])])
        },
      })
    )

    const swarm = coverage.exploration.swarm
    const averageEnabled = swarm?.averageEnabled
    const cases = Object.values(coverage.eventCases)

    yield* expect({
      everyRunHasAtLeastTwoEnabled: swarms.every((entries) => entries.length >= 2),
      someRunHasFewerThanThreeEnabled: swarms.some((entries) => entries.length < 3),
      swarmRuns: swarm?.runs,
      swarmAverageEnabled: averageEnabled,
      swarmAverageBelowThree: typeof averageEnabled === 'number' && averageEnabled < 3,
      swarmAverageAtLeastTwo: typeof averageEnabled === 'number' && averageEnabled >= 2,
      someCaseExcludesGenerated: cases.some((counts) => counts.applicable < counts.generated),
    }).toEqual({
      everyRunHasAtLeastTwoEnabled: true,
      someRunHasFewerThanThreeEnabled: true,
      swarmRuns: 20,
      swarmAverageEnabled: expect.any(Number),
      swarmAverageBelowThree: true,
      swarmAverageAtLeastTwo: true,
      someCaseExcludesGenerated: true,
    })
  })

  it('reports no swarm statistics when it is not enabled', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 5, numRuns: 4, maxCommands: 4 }),
        events: { INC: constant({}) },
        invariant: noop,
      })
    )

    yield* expect(coverage.exploration.swarm).toBe(null)
  })
})

describe('targeted search', () => {
  const MAX_COMMANDS = 6
  const events = {
    INC: constant({}),
    DEC: constant({}),
  }
  const target = ({ snapshot }: { snapshot: any }): number => snapshot.context.count

  it('records the best observed value', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 2, numRuns: 10, maxCommands: 4 }),
        events,
        invariant: ({ snapshot, target: observe }) => {
          observe((snapshot as any).context.count, 'count')
        },
      })
    )

    yield* expect({
      improvementsPositive: coverage.exploration.target.improvements > 0,
      label: coverage.exploration.target.label,
      bestPositive: coverage.exploration.target.best > 0,
    }).toEqual({
      improvementsPositive: true,
      label: 'count',
      bestPositive: true,
    })
  })

  it('climbs deeper than random exploration on the same budget', function*({ expect }) {
    const randomCampaign = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, maxCommands: MAX_COMMANDS }),
        events,
        target,
        invariant: noop,
        until: (coverage) => coverage.exploration.target.best >= 8,
        batchRuns: 10,
        maxRuns: 60,
      })
    )

    yield* expect({
      bestBelowEight: randomCampaign.coverage.exploration.target.best < 8,
      stoppedBecause: randomCampaign.coverage.exploration.stoppedBecause,
    }).toEqual({ bestBelowEight: true, stoppedBecause: 'budget' })

    const targeted = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, maxCommands: MAX_COMMANDS }),
        events,
        target,
        frontiers: { strategy: 'target' },
        invariant: noop,
        until: (coverage) => coverage.exploration.target.best >= 8,
        batchRuns: 10,
        maxRuns: 60,
      })
    )

    yield* expect({
      bestAtLeastEight: targeted.coverage.exploration.target.best >= 8,
      stoppedBecause: targeted.coverage.exploration.stoppedBecause,
      completedWithinBudget: targeted.coverage.exploration.completedRuns <= 60,
    }).toEqual({
      bestAtLeastEight: true,
      stoppedBecause: 'until',
      completedWithinBudget: true,
    })
  })
})
