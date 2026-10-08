import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, type EventFrom, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import {
  fastCheckAdapter,
  getCurrentScheduler,
  ModelTestFailure,
  propertyTest,
  withScheduledSut,
} from '../src/index.js'
import type { FastCheckSchedulerReport, TestSut } from '../src/index.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>
type CounterEvent = EventFrom<typeof counterMachine>

const racyCounterSut: TestSut<CounterSnapshot, CounterEvent> = {
  create: () => {
    const scheduler = getCurrentScheduler()
    let committed = 0
    let pending = 0
    return {
      send: (event) => {
        if (event.type !== 'INC') {
          return
        }
        pending += 1
        const next = pending
        const commit = scheduler !== undefined
          ? scheduler.schedule(Promise.resolve(), 'commit')
          : Promise.resolve()
        void commit.then(() => {
          committed = next
        })
      },
      read: () => committed,
    }
  },
  projectModel: (snapshot) => snapshot.context.count,
}

function schedulerReport(
  failure: ModelTestFailure | undefined,
): FastCheckSchedulerReport {
  const data = failure?.replay?.data
  if (data === null || typeof data !== 'object' || !('scheduler' in data)) {
    throw new Error('expected the failing run to carry a scheduler report')
  }
  return data.scheduler as FastCheckSchedulerReport
}

describe('scheduled property runs', () => {
  it('finds an ordering where the SUT read races the write', function*({ expect }) {
    const failure = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 7,
        numRuns: 50,
        maxCommands: 6,
        scheduler: true,
        events: { INC: fc.constant({}) },
        sut: withScheduledSut(racyCounterSut),
        invariant: () => {},
      }).then(
        () => undefined,
        (error) => error as ModelTestFailure,
      )
    )

    const report = schedulerReport(failure)
    yield* expect({
      isFailure: failure instanceof ModelTestFailure,
      hasOrdering: report.ordering.length > 0,
      hasCommitTask: report.tasks.some((task) => task.label === 'commit'),
      allTaskIdsNumeric: report.tasks.every(
        (task) => typeof task.taskId === 'number',
      ),
    }).toEqual({
      isFailure: true,
      hasOrdering: true,
      hasCommitTask: true,
      allTaskIdsNumeric: true,
    })
  })

  it('reports the schedule of the failing run, not of a later passing one', function*({ expect }) {
    const failure = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 7,
        numRuns: 50,
        maxCommands: 6,
        scheduler: true,
        events: { INC: fc.constant({}) },
        sut: withScheduledSut(racyCounterSut),
        invariant: () => {},
      }).then(
        () => undefined,
        (error) => error as ModelTestFailure,
      )
    )

    const report = schedulerReport(failure)
    const sentEvents = (failure?.trace.timeline ?? []).filter(
      (entry) => entry.kind === 'event',
    ).length
    yield* expect({
      isFailure: failure instanceof ModelTestFailure,
      commitTasks: report.tasks.filter((task) => task.label === 'commit').length,
    }).toEqual({ isFailure: true, commitTasks: sentEvents })
  })

  it('passes for a SUT that commits before resolving', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 7,
        numRuns: 25,
        maxCommands: 6,
        scheduler: true,
        events: { INC: fc.constant({}) },
        sut: withScheduledSut<CounterSnapshot, CounterEvent>({
          create: () => {
            let count = 0
            return {
              send: (event) => {
                if (event.type === 'INC') {
                  count += 1
                }
              },
              read: () => count,
            }
          },
          projectModel: (snapshot) => snapshot.context.count,
        }),
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.runs).toSatisfy(
      (runs) => runs > 0,
      'the campaign ran at least once',
    )
  })

  it('leaves runs unscheduled when the option is off', function*({ expect }) {
    let observed: unknown
    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 7,
        numRuns: 5,
        maxCommands: 3,
        events: { INC: fc.constant({}) },
        sut: withScheduledSut<CounterSnapshot, CounterEvent>({
          create: () => {
            observed = getCurrentScheduler()
            let count = 0
            return {
              send: (event) => {
                if (event.type === 'INC') {
                  count += 1
                }
              },
              read: () => count,
            }
          },
          projectModel: (snapshot) => snapshot.context.count,
        }),
        invariant: () => {},
      })
    )

    yield* expect(observed).toEqual(undefined)
  })
})
