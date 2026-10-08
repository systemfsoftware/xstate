import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable } from '../src/durable/index.js'
import { type AnyActor, type AnyStateMachine, createMachine, setup } from '../src/index.js'

interface JournalEntry {
  address: string
  event: { type: string; id?: string }
}

interface PendingTimer {
  address: string
  id: string
  delay: number
  event: { type: 'xstate.timer'; id: string }
}

const timerKey = (address: string, id: string) => `${address}:${id}`

function createEventJournalHost<TMachine extends AnyStateMachine>(
  machine: TMachine,
  journal: JournalEntry[],
) {
  const pending = new Map<string, PendingTimer>()
  const armTimerCalls: Array<[PendingTimer]> = []
  const armTimer = (timer: PendingTimer) => {
    armTimerCalls.push([timer])
    pending.set(timerKey(timer.address, timer.id), timer)
  }
  const cancelTimerCalls: Array<[AnyActor, string]> = []
  const cancelTimer = (source: AnyActor, id: string) => {
    cancelTimerCalls.push([source, id])
    pending.delete(timerKey(source.address, id))
  }
  const cancelAllTimersCalls: Array<[AnyActor]> = []
  const cancelAllTimers = (source: AnyActor) => {
    cancelAllTimersCalls.push([source])
    for (const [key, timer] of pending) {
      if (timer.address === source.address) {
        pending.delete(key)
      }
    }
  }

  const durable = createDurable(machine, {
    executionId: 'event-journal-test',
    executeAction: () => {},
    scheduleTimer: (source, id, delay) => {
      const event = { type: 'xstate.timer' as const, id }
      const alreadyFired = journal.some(
        (entry) =>
          entry.address === source.address &&
          entry.event.type === event.type &&
          entry.event.id === id,
      )
      if (!alreadyFired) {
        armTimer({ address: source.address, id, delay, event })
      }
    },
    cancelTimer,
    cancelAllTimers,
    waitForEvent: () => {
      throw new Error('The event-journal host drives transitions directly')
    },
  })

  const replay = Effect.gen(function*() {
    let [snapshot, effects] = durable.initialTransition(undefined as never)
    yield* Effect.promise(() => durable.executeEffects(effects))
    for (const entry of journal) {
      ;[snapshot, effects] = durable.transition(snapshot, entry.event as never)
      yield* Effect.promise(() => durable.executeEffects(effects))
    }
    return snapshot
  })

  return {
    durable,
    pending,
    armTimerCalls,
    cancelTimerCalls,
    cancelAllTimersCalls,
    replay,
  }
}

describe('durable event-journal timers', () => {
  const timerMachine = createMachine({
    id: 'reminder',
    initial: 'waiting',
    states: {
      waiting: {
        after: { 5000: { target: 'done' } },
        on: { EXIT: { target: 'cancelled' } },
      },
      done: { type: 'final' },
      cancelled: { type: 'final' },
    },
  })

  it('fires a recorded timer after tearing down and replaying a fresh execution', function*({ expect }) {
    const journal: JournalEntry[] = []
    const firstProcess = createEventJournalHost(timerMachine, journal)
    const waiting = yield* firstProcess.replay
    const [pendingTimer] = firstProcess.pending.values()
    if (pendingTimer === undefined) {
      throw new Error('expected a pending timer')
    }

    yield* expect({
      value: waiting.value,
      pendingTimer,
    }).toEqual({
      value: 'waiting',
      pendingTimer: {
        address: 'reminder',
        id: 'xstate.after.5000.reminder.waiting',
        delay: 5000,
        event: {
          type: 'xstate.timer',
          id: 'xstate.after.5000.reminder.waiting',
        },
      },
    })

    journal.push({
      address: pendingTimer.address,
      event: pendingTimer.event,
    })
    const secondProcess = createEventJournalHost(timerMachine, journal)
    const done = yield* secondProcess.replay

    yield* expect({
      journalAddresses: journal.map((entry) => entry.address),
      value: done.value,
      status: done.status,
      pendingSize: secondProcess.pending.size,
    }).toEqual({
      journalAddresses: ['reminder'],
      value: 'done',
      status: 'done',
      pendingSize: 0,
    })
  })

  it('does not re-arm a timer whose firing is already journaled', function*({ expect }) {
    const firstProcess = createEventJournalHost(timerMachine, [])
    yield* firstProcess.replay
    const [timer] = firstProcess.pending.values()
    if (timer === undefined) {
      throw new Error('expected a pending timer')
    }
    const journal: JournalEntry[] = [
      { address: timer.address, event: timer.event },
    ]

    const replayProcess = createEventJournalHost(timerMachine, journal)
    yield* replayProcess.replay

    yield* expect({
      journalAddresses: journal.map((entry) => entry.address),
      armTimerCalls: replayProcess.armTimerCalls,
      pendingSize: replayProcess.pending.size,
    }).toEqual({
      journalAddresses: ['reminder'],
      armTimerCalls: [],
      pendingSize: 0,
    })
  })

  it('cancels a pending timer when a journaled event exits its state', function*({ expect }) {
    const journal: JournalEntry[] = [
      { address: 'reminder', event: { type: 'EXIT' } },
    ]
    const process = createEventJournalHost(timerMachine, journal)
    const cancelled = yield* process.replay

    yield* expect({
      journalAddresses: journal.map((entry) => entry.address),
      value: cancelled.value,
      cancelTimerCalls: process.cancelTimerCalls,
      pendingSize: process.pending.size,
    }).toEqual({
      journalAddresses: ['reminder'],
      value: 'cancelled',
      cancelTimerCalls: [[
        expect.objectContaining({ address: 'reminder' }),
        'xstate.after.5000.reminder.waiting',
      ]],
      pendingSize: 0,
    })
  })

  it('routes child-owned timer cleanup through the adapter', function*({ expect }) {
    const child = createMachine({
      id: 'childLogic',
      initial: 'waiting',
      states: {
        waiting: { after: { 5000: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = setup({ actors: { child } }).createMachine({
      id: 'parent',
      initial: 'running',
      states: {
        running: {
          invoke: { id: 'child', src: 'child' },
          on: { EXIT: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    })
    const journal: JournalEntry[] = [
      { address: 'parent', event: { type: 'EXIT' } },
    ]
    const process = createEventJournalHost(parent, journal)

    yield* process.replay

    yield* expect({
      journalAddresses: journal.map((entry) => entry.address),
      cancelAllTimersCalls: process.cancelAllTimersCalls,
      pendingSize: process.pending.size,
    }).toEqual({
      journalAddresses: ['parent'],
      cancelAllTimersCalls: [[
        expect.objectContaining({ address: 'parent/child' }),
      ]],
      pendingSize: 0,
    })
  })
})
