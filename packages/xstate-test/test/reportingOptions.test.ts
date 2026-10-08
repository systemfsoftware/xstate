import { describe, it, vi } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { formatTestStatistics, ModelTestFailure, propertyTest, testPaths } from '../src/index.js'

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

const events = { INC: fc.constant({}), RESET: fc.constant({}) }

const failingOptions = {
  seed: 1,
  numRuns: 50,
  maxCommands: 8,
  events,
  invariant: ({ snapshot }: { snapshot: { context: { count: number } } }) => {
    if (snapshot.context.count >= 3) {
      throw new Error('count reached 3')
    }
  },
}

const catchFailure = (run: () => Promise<unknown>): Promise<ModelTestFailure> =>
  run().then(
    () => {
      throw new Error('Expected the campaign to fail')
    },
    (error: unknown) => error as ModelTestFailure,
  )

describe('fast-check reporting options', () => {
  it('calls reporter with the run details', function*({ expect }) {
    const reports: fc.RunDetails<unknown>[] = []
    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 7,
        events,
        reporter: (details) => {
          reports.push(details)
        },
      })
    )
    yield* expect({
      length: reports.length,
      failed: reports[0]?.failed,
      numRuns: reports[0]?.numRuns,
    }).toEqual({ length: 1, failed: false, numRuns: 7 })
  })

  it('awaits asyncReporter with the failing run details', function*({ expect }) {
    const reports: fc.RunDetails<unknown>[] = []
    yield* Effect.promise(() =>
      catchFailure(() =>
        propertyTest(counterMachine, {
          ...failingOptions,
          asyncReporter: (details) => {
            reports.push(details)
            return Promise.resolve()
          },
        })
      )
    )
    const firstReport = reports[0]
    if (firstReport === undefined) {
      throw new Error('expected a report')
    }
    yield* expect({ length: reports.length, failed: firstReport.failed }).toEqual({
      length: 1,
      failed: true,
    })
  })

  it('appends the fast-check report to the message when verbose is set', function*({ expect }) {
    const quiet = yield* Effect.promise(() => catchFailure(() => propertyTest(counterMachine, failingOptions)))
    const verbose = yield* Effect.promise(() =>
      catchFailure(() => propertyTest(counterMachine, { ...failingOptions, verbose: 1 }))
    )
    yield* expect({
      quietMentionsCounterexample: quiet.message.includes('Counterexample:'),
      verboseMentionsCounterexample: verbose.message.includes('Counterexample:'),
      verboseMentionsFailures: verbose.message.includes('Encountered failures were:'),
    }).toEqual({
      quietMentionsCounterexample: false,
      verboseMentionsCounterexample: true,
      verboseMentionsFailures: true,
    })
  })
})

describe('statistics', () => {
  it('prints event-case and label distributions after a passing campaign', function*({ expect }) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { coverage } = yield* Effect.promise(() =>
        propertyTest(counterMachine, {
          seed: 1,
          numRuns: 20,
          maxCommands: 4,
          events,
          statistics: true,
          invariant: ({ snapshot, classify }) => {
            classify(snapshot.context.count >= 2, 'reached two')
          },
        })
      )
      yield* expect(log.mock.calls).toEqual([[formatTestStatistics(coverage)]])
    } finally {
      log.mockRestore()
    }
  })

  it('formats shares of executed events and of runs', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      testPaths(counterMachine, {
        events,
        fromEvents: [{ type: 'INC' }, { type: 'INC' }, { type: 'RESET' }],
        stopWhen: (snapshot) => snapshot.context.count >= 3,
        invariant: ({ label, step }) => label('step', step % 2 !== 0 ? 'odd' : 'even'),
      })
    )
    yield* expect(formatTestStatistics(coverage)).toBe(
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
    )
  })

  it('leaves shrink attempts out of labels and event cases', function*({ expect }) {
    let created = 0
    const failure = yield* Effect.promise(() =>
      catchFailure(() =>
        propertyTest(counterMachine, {
          ...failingOptions,
          sut: {
            create: ({ label }) => {
              created++
              label('run')
              return { send: () => {} }
            },
          },
        })
      )
    )
    const { exploration, labels, eventCases } = failure.coverage!
    const runLabel = labels['run']
    if (runLabel === undefined) {
      throw new Error('expected a run label')
    }
    const executed = Object.values(eventCases).reduce(
      (total, counts) => total + counts.executed,
      0,
    )
    yield* expect({
      shrinkRunsPositive: exploration.shrinkRuns > 0,
      attemptedRuns: exploration.attemptedRuns,
      runCount: runLabel.count,
      runShare: runLabel.share,
      executionsBelowGenerated: executed < failure.coverage!.generatedSteps,
    }).toEqual({
      shrinkRunsPositive: true,
      attemptedRuns: created,
      runCount: created - exploration.shrinkRuns,
      runShare: 1,
      executionsBelowGenerated: true,
    })
  })
})
