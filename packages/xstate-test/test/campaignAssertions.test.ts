import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { formatTestCoverage, ModelTestFailure, propertyTest, TestCampaignError, testPaths } from '../src/index.js'

const doorMachine = createMachine({
  id: 'door',
  schemas: {
    context: types<{ opened: number }>(),
    events: { OPEN: types<{}>(), CLOSE: types<{}>(), LOCK: types<{}>() },
  },
  context: { opened: 0 },
  initial: 'closed',
  states: {
    closed: {
      tags: ['shut'],
      on: {
        OPEN: ({ context }) => ({
          target: 'open',
          context: { opened: context.opened + 1 },
        }),
        LOCK: { target: 'locked' },
      },
    },
    open: { on: { CLOSE: { target: 'closed' } } },
    locked: { tags: ['shut'] },
    broken: {},
  },
})

const events = {
  OPEN: fc.constant({}),
  CLOSE: fc.constant({}),
  LOCK: fc.constant({}),
}

function catchError(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => {
      throw new Error('Expected the campaign to fail')
    },
    (error: unknown) => error,
  )
}

describe('sometimes', () => {
  it('passes when one run satisfies it, and counts runs', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(doorMachine, {
        seed: 1,
        numRuns: 20,
        maxCommands: 4,
        events,
        temporal: [
          {
            type: 'sometimes',
            id: 'opened-twice',
            predicate: ({ snapshot }) => snapshot.context.opened >= 2,
          },
        ],
      })
    )
    const counts = coverage.temporal.counts['opened-twice']
    if (counts === undefined) {
      throw new Error('expected counts for opened-twice')
    }
    yield* expect({
      satisfiedPositive: counts.satisfied > 0,
      inconclusivePositive: counts.inconclusive > 0,
      countedAllRuns: counts.satisfied + counts.inconclusive,
      satisfied: coverage.temporal.satisfied,
      inconclusive: coverage.temporal.inconclusive,
    }).toEqual({
      satisfiedPositive: true,
      inconclusivePositive: true,
      countedAllRuns: 20,
      satisfied: ['opened-twice'],
      inconclusive: [],
    })
  })

  it('fails the campaign when no run satisfies it', function*({ expect }) {
    const error = (yield* Effect.promise(() =>
      catchError(() =>
        propertyTest(doorMachine, {
          seed: 1,
          numRuns: 10,
          maxCommands: 3,
          events,
          temporal: [
            {
              type: 'sometimes',
              id: 'opened-five-times',
              predicate: ({ snapshot }) => snapshot.context.opened >= 5,
            },
          ],
        })
      )
    )) as TestCampaignError
    yield* expect({
      error,
      message: error.message,
      failed: error.coverage.temporal.failed,
      inconclusive: error.coverage.temporal.inconclusive,
      counts: error.coverage.temporal.counts['opened-five-times'],
      coverageText: formatTestCoverage(error.coverage),
    }).toEqual({
      error: expect.any(TestCampaignError),
      message: 'Campaign assertions failed:\n  - sometimes "opened-five-times" did not hold in 10 run(s)',
      failed: ['opened-five-times'],
      inconclusive: [],
      counts: {
        satisfied: 0,
        failed: 0,
        inconclusive: 10,
      },
      coverageText: expect.stringContaining(
        '  - opened-five-times: 0 satisfied, 0 failed, 10 inconclusive (never held)',
      ),
    })
  })
})

describe('reachable', () => {
  it('accepts state values, state node ids, and tags', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(doorMachine, {
        seed: 1,
        numRuns: 20,
        maxCommands: 4,
        events,
        reachable: ['open', '#door.locked', 'shut'],
      })
    )
    yield* expect(coverage.temporal.satisfied).toEqual([
      'reachable:#door.locked',
      'reachable:open',
      'reachable:shut',
    ])
  })

  it('lists the targets no run entered, in both entry points', function*({ expect }) {
    const observed: {
      readonly error: unknown
      readonly failures: readonly string[]
    }[] = []
    for (
      const run of [
        () =>
          propertyTest(doorMachine, {
            seed: 1,
            numRuns: 10,
            maxCommands: 4,
            events,
            reachable: ['open', '#door.broken'],
          }),
        () =>
          testPaths(doorMachine, {
            events,
            stopWhen: (snapshot) => snapshot.context.opened >= 2,
            reachable: ['open', '#door.broken'],
          }),
      ]
    ) {
      const error = (yield* Effect.promise(() => catchError(run))) as TestCampaignError
      observed.push({ error, failures: error.failures })
    }
    yield* expect(observed).toEqual([
      {
        error: expect.any(TestCampaignError),
        failures: [
          expect.stringMatching(
            /^reachable "#door.broken" was not entered in \d+ run\(s\)$/,
          ),
        ],
      },
      {
        error: expect.any(TestCampaignError),
        failures: [
          expect.stringMatching(
            /^reachable "#door.broken" was not entered in \d+ run\(s\)$/,
          ),
        ],
      },
    ])
  })
})

describe('respond', () => {
  it('fails when a trigger is not answered within the bound', function*({ expect }) {
    const failure = (yield* Effect.promise(() =>
      catchError(() =>
        propertyTest(doorMachine, {
          seed: 1,
          numRuns: 50,
          maxCommands: 6,
          events,
          temporal: [
            {
              type: 'respond',
              id: 'closes-again',
              within: 1,
              trigger: ({ snapshot }) => snapshot.matches('open'),
              response: ({ snapshot }) => snapshot.matches('closed'),
            },
          ],
        })
      )
    )) as ModelTestFailure
    yield* expect({
      failure,
      summary: failure.summary,
      temporalFailure: failure.fixture?.temporalFailure,
      stepEvents: failure.trace.steps.map((step) => step.event.type),
    }).toMatchObject({
      failure: expect.any(ModelTestFailure),
      summary: 'Temporal property "closes-again" failed',
      temporalFailure: { type: 'respond', id: 'closes-again', within: 1 },
      stepEvents: ['OPEN', expect.stringMatching(/OPEN|LOCK/)],
    })
  })

  it('counts the response on the trigger step, and is inconclusive when the run ends first', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(doorMachine, {
        seed: 1,
        numRuns: 30,
        maxCommands: 4,
        events: { OPEN: fc.constant({}), CLOSE: fc.constant({}) },
        temporal: [
          {
            type: 'respond',
            id: 'opened-counts',
            within: 0,
            trigger: ({ event }) => event?.type === 'OPEN',
            response: ({ snapshot }) => snapshot.context.opened > 0,
          },
          {
            type: 'respond',
            id: 'closes-within-3',
            within: 3,
            trigger: ({ snapshot }) => snapshot.matches('open'),
            response: ({ snapshot }) => snapshot.matches('closed'),
          },
        ],
      })
    )
    const closesWithin3 = coverage.temporal.counts['closes-within-3']
    if (closesWithin3 === undefined) {
      throw new Error('expected counts for closes-within-3')
    }
    yield* expect({
      openedSatisfied: coverage.temporal.counts['opened-counts']?.satisfied,
      openedFailed: coverage.temporal.counts['opened-counts']?.failed,
      closesWithin3Failed: closesWithin3.failed,
    }).toEqual({
      openedSatisfied: 30,
      openedFailed: 0,
      closesWithin3Failed: 0,
    })
  })

  it('fails at the end of the run without within', function*({ expect }) {
    const failure = (yield* Effect.promise(() =>
      catchError(() =>
        propertyTest(doorMachine, {
          seed: 1,
          numRuns: 20,
          maxCommands: 3,
          events,
          temporal: [
            {
              type: 'respond',
              id: 'closes-eventually',
              trigger: ({ snapshot }) => snapshot.matches('open'),
              response: ({ snapshot }) => snapshot.matches('closed'),
            },
          ],
        })
      )
    )) as ModelTestFailure
    yield* expect({
      summary: failure.summary,
      stepEvents: failure.trace.steps.map((step) => step.event.type),
    }).toEqual({
      summary: 'Temporal property "closes-eventually" failed',
      stepEvents: ['OPEN'],
    })
  })
})

describe('vacuity warnings', () => {
  const eventually = {
    type: 'eventually' as const,
    id: 'opens',
    within: 50,
    predicate: ({
      snapshot,
    }: {
      snapshot: { matches: (v: 'open') => boolean }
    }) => snapshot.matches('open'),
  }

  it('warns when within exceeds maxCommands', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(doorMachine, {
        seed: 1,
        numRuns: 5,
        maxCommands: 4,
        events,
        temporal: [eventually],
      })
    )
    yield* expect({
      warnings: coverage.temporal.warnings,
      coverageText: formatTestCoverage(coverage),
    }).toEqual({
      warnings: [
        'eventually "opens" has within 50, but the longest sequence is 4 steps, so it can never fail',
      ],
      coverageText: expect.stringContaining(
        '  warning: eventually "opens" has within 50',
      ),
    })
  })

  it('warns when within exceeds the longest path', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      testPaths(doorMachine, {
        events,
        stopWhen: (snapshot) => snapshot.context.opened >= 2,
        temporal: [
          { ...eventually, id: 'soon', within: 1, predicate: () => true },
          { ...eventually, id: 'late' },
        ],
      })
    )
    yield* expect(coverage.temporal.warnings).toEqual([
      expect.stringMatching(
        /^eventually "late" has within 50, but the longest sequence is \d steps/,
      ),
    ])
  })

  it('reports an id inconclusive in every run as inconclusive', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(doorMachine, {
        seed: 1,
        numRuns: 5,
        maxCommands: 2,
        events: { LOCK: fc.constant({}) },
        temporal: [eventually],
      })
    )
    yield* expect({
      inconclusive: coverage.temporal.inconclusive,
      counts: coverage.temporal.counts['opens'],
    }).toEqual({
      inconclusive: ['opens'],
      counts: {
        satisfied: 0,
        failed: 0,
        inconclusive: 5,
      },
    })
  })
})
