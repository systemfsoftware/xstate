import { describe } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import * as Effect from 'effect/Effect'
import { propertyTest, testPaths, type TestSutCompleteContext } from '../src/engine/index.js'
import { constant, randomAdapter } from './engine/propertyTestAdapter.js'

const counterMachine = createMachine({
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>(), RESET: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
    RESET: () => ({ context: { count: 0 } }),
  },
})

const failingCampaign = (
  statistics: (report: string) => void | Promise<void>,
): Effect.Effect<{ readonly failure: unknown; readonly completions: readonly TestSutCompleteContext[] }> =>
  Effect.gen(function*() {
    const completions: TestSutCompleteContext[] = []
    const failure = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 1, maxCommands: 1 }),
        events: { INC: constant({}) },
        sut: {
          create: () => ({ send: () => {} }),
          complete: (result) => {
            completions.push(result)
          },
        },
        statistics,
      }).then(
        () => 'the campaign passed',
        (error: unknown) => error,
      )
    )
    return { failure, completions }
  })

describe('statistics sink', (it) => {
  it('delivers the formatted report to a callback after a passing propertyTest campaign', function*({ expect }) {
    const reports: string[] = []

    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 1, maxCommands: 1 }),
        events: { INC: constant({}) },
        statistics: (report) => {
          reports.push(report)
        },
      })
    )

    yield* expect(reports).toEqual([
      [
        'Test statistics (1 run)',
        '',
        'event cases (share of executed events):',
        '  100.0%  INC / default: 1 executed, 0 ignored',
      ].join('\n'),
    ])
  })

  it('delivers the formatted report to a callback after a passing testPaths campaign', function*({ expect }) {
    const reports: string[] = []

    yield* Effect.promise(() =>
      testPaths(counterMachine, {
        events: { INC: constant({}), RESET: constant({}) },
        fromEvents: [{ type: 'INC' }, { type: 'INC' }, { type: 'RESET' }],
        stopWhen: (snapshot) => snapshot.context.count >= 3,
        statistics: (report) => {
          reports.push(report)
        },
        invariant: ({ label, step }) => label('step', step % 2 !== 0 ? 'odd' : 'even'),
      })
    )

    yield* expect(reports).toEqual([
      [
        'Test statistics (1 run)',
        '',
        'event cases (share of executed events):',
        '   66.7%  INC / default: 2 executed, 0 ignored',
        '   33.3%  RESET / default: 1 executed, 0 ignored',
        '',
        'labels (share of runs):',
        '  100.0%  step: 4 recorded (even=2, odd=2)',
      ].join('\n'),
    ])
  })

  it('fails the campaign with the error a callback throws, after the completion hook ran', function*({ expect }) {
    const sinkError = new Error('statistics sink threw')

    const outcome = yield* failingCampaign(() => {
      throw sinkError
    })

    yield* expect(outcome).toStrictEqual({
      failure: sinkError,
      completions: [{ passed: false, failure: sinkError }],
    })
  })

  it(
    'awaits a callback and fails the campaign with the error it rejects with, after the completion hook ran',
    function*({ expect }) {
      const sinkError = new Error('statistics sink rejected')

      const outcome = yield* failingCampaign(() =>
        Promise.resolve().then(() => {
          throw sinkError
        })
      )

      yield* expect(outcome).toStrictEqual({
        failure: sinkError,
        completions: [{ passed: false, failure: sinkError }],
      })
    },
  )
})
