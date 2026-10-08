import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { ModelTestFailure, propertyTest, replayTest } from '../src/index.js'

const counterMachine = createMachine({
  id: 'searchCounter',
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

const events = {
  INC: fc.constant({}),
  DEC: fc.constant({}),
  RESET: fc.constant({}),
}

const noop = () => {}

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the operation to fail')
    },
    (error: unknown) => error,
  )

describe('swarm testing with fast-check', () => {
  it('is deterministic and leaves cases out of individual runs', function*({ expect }) {
    const run = () =>
      Effect.gen(function*() {
        const swarms: string[][] = []
        const { coverage } = yield* Effect.promise(() =>
          propertyTest(counterMachine, {
            seed: 42,
            numRuns: 20,
            maxCommands: 5,
            events,
            swarm: { seed: 9 },
            invariant: noop,
            collect: (trace) => {
              swarms.push([...(trace.swarm ?? [])])
            },
          })
        )
        return { swarms, coverage }
      })

    const first = yield* run()
    const second = yield* run()

    yield* expect({
      swarms: first.swarms,
      everyRunEnablesAtLeastTwoCases: first.swarms.every((swarm) => swarm.length >= 2),
      someRunEnablesFewerThanThreeCases: first.swarms.some((swarm) => swarm.length < 3),
      runs: first.coverage.exploration.swarm!.runs,
      averageEnabledBelowThree: first.coverage.exploration.swarm!.averageEnabled < 3,
    }).toEqual({
      swarms: second.swarms,
      everyRunEnablesAtLeastTwoCases: true,
      someRunEnablesFewerThanThreeCases: true,
      runs: 20,
      averageEnabledBelowThree: true,
    })
  })

  it('keeps shrinking to a minimal counterexample', function*({ expect }) {
    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(counterMachine, {
          seed: 3,
          numRuns: 200,
          maxCommands: 12,
          events,
          swarm: true,
          invariant: ({ snapshot }) => {
            const count = snapshot.context.count
            if (!(count < 3)) {
              throw new Error(
                `the model counter reached ${count}, expected fewer than 3`,
              )
            }
          },
        }),
      )
    )) as ModelTestFailure

    const fixture = failure.fixture!
    yield* expect({
      failure,
      failureMessage: failure.message,
      timelineLength: fixture.timeline.length,
      everyCommandIsAnIncEvent: fixture.timeline.every(
        (entry) => entry.command.type === 'event' && entry.command.event.type === 'INC',
      ),
      swarmKeepsInc: fixture.swarm!.some((caseId) => caseId.includes('INC')),
    }).toEqual({
      failure: expect.any(ModelTestFailure),
      failureMessage: expect.stringContaining('expected fewer than 3'),
      timelineLength: 3,
      everyCommandIsAnIncEvent: true,
      swarmKeepsInc: true,
    })

    const replayFailure = yield* Effect.promise(() =>
      rejectionOf(
        replayTest(counterMachine, fixture, {
          invariant: ({ snapshot }) => {
            const count = snapshot.context.count
            if (!(count < 3)) {
              throw new Error(
                `the model counter reached ${count}, expected fewer than 3`,
              )
            }
          },
        }),
      )
    )
    yield* expect(replayFailure).toMatchObject({
      message: expect.stringMatching(/count/),
    })
  })
})

describe('targeted search with fast-check', () => {
  it('reaches a deeper counter value than random exploration', function*({ expect }) {
    const campaign = (frontiers?: { strategy: 'target' }) =>
      propertyTest(counterMachine, {
        seed: 4,
        maxCommands: 6,
        events: { INC: fc.constant({}), DEC: fc.constant({}) },
        target: ({ snapshot }) => snapshot.context.count,
        ...(frontiers === undefined ? {} : { frontiers }),
        invariant: noop,
        until: (coverage) => coverage.exploration.target.best >= 8,
        batchRuns: 10,
        maxRuns: 60,
      })

    const random = yield* Effect.promise(() => campaign())
    yield* expect(random.coverage.exploration.target.best).toBeLessThan(8)

    const targeted = yield* Effect.promise(() => campaign({ strategy: 'target' }))
    yield* expect({
      bestAtLeastEight: targeted.coverage.exploration.target.best >= 8,
      stoppedBecause: targeted.coverage.exploration.stoppedBecause,
    }).toEqual({ bestAtLeastEight: true, stoppedBecause: 'until' })
  })
})
