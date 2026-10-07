import { describe } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'

const timerMachine = createMachine({
  id: 'p',
  initial: 'waiting',
  states: {
    waiting: { after: { 1000: { target: 'fired' } } },
    fired: {},
  },
})

interface PendingTimer {
  readonly id: number
  readonly fn: () => void
  readonly delay: number
}

const createSchedulingClock = () => {
  const pending: PendingTimer[] = []
  let nextId = 0
  const clock = {
    setTimeout(fn: () => void, delay: number) {
      const id = nextId
      nextId += 1
      pending.push({ id, fn, delay })
      return id
    },
    clearTimeout(id: number) {
      const index = pending.findIndex((timer) => timer.id === id)
      if (index !== -1) {
        pending.splice(index, 1)
      }
    },
  }
  return {
    clock,
    pending,
    fireNext() {
      const timer = pending.shift()
      if (timer === undefined) {
        throw new Error('no pending timer to fire')
      }
      timer.fn()
    },
  }
}

interface PersistedTimerView {
  readonly delay: number
  readonly startedAt?: number
}

const firstPersistedTimer = (persisted: unknown): PersistedTimerView => {
  const timers: unknown = typeof persisted === 'object' && persisted !== null
    ? Reflect.get(persisted, 'timers')
    : undefined
  if (typeof timers !== 'object' || timers === null) {
    throw new Error('persisted snapshot has no timers')
  }
  const [timer] = Object.values(timers as Record<string, unknown>)
  if (typeof timer !== 'object' || timer === null) {
    throw new Error('persisted snapshot has no timer')
  }
  const delay: unknown = Reflect.get(timer, 'delay')
  const startedAt: unknown = Reflect.get(timer, 'startedAt')
  if (
    typeof delay !== 'number' ||
    (startedAt !== undefined && typeof startedAt !== 'number')
  ) {
    throw new Error('persisted timer has no numeric delay')
  }
  return startedAt === undefined ? { delay } : { delay, startedAt }
}

describe('injected wall clock restore', (it) => {
  it('persists startedAt from a live run and resumes the remaining delay', function*({ expect }) {
    let now = 1_000
    const wallClock = { now: () => now }
    const first = createSchedulingClock()
    const actor = createActor(timerMachine, { clock: first.clock, wallClock }).start()
    now = 1_600
    const persisted = actor.getPersistedSnapshot()
    actor.stop()
    const timer = firstPersistedTimer(persisted)

    const second = createSchedulingClock()
    const restored = createActor(timerMachine, {
      clock: second.clock,
      wallClock,
      snapshot: persisted,
    }).start()
    const [resumeDelay] = second.pending.map((entry) => entry.delay)
    second.fireNext()

    yield* expect({
      startedAt: timer.startedAt,
      resumeDelay,
      value: restored.getSnapshot().value,
    }).toEqual({ startedAt: 1_000, resumeDelay: 400, value: 'fired' })
  })

  it('keeps the same deadline across repeated persist/restore cycles', function*({ expect }) {
    let now = 1_000
    const wallClock = { now: () => now }
    const first = createSchedulingClock()
    const actor = createActor(timerMachine, { clock: first.clock, wallClock }).start()
    now = 1_300
    const firstPersisted = actor.getPersistedSnapshot()
    actor.stop()

    const second = createSchedulingClock()
    const restored = createActor(timerMachine, {
      clock: second.clock,
      wallClock,
      snapshot: firstPersisted,
    }).start()
    now = 1_600
    const repersisted = restored.getPersistedSnapshot()
    restored.stop()
    const timer = firstPersistedTimer(repersisted)

    const third = createSchedulingClock()
    const resumed = createActor(timerMachine, {
      clock: third.clock,
      wallClock,
      snapshot: repersisted,
    }).start()
    const [resumeDelay] = third.pending.map((entry) => entry.delay)
    third.fireNext()

    yield* expect({
      startedAt: timer.startedAt,
      delay: timer.delay,
      resumeDelay,
      value: resumed.getSnapshot().value,
    }).toEqual({ startedAt: 1_000, delay: 1_000, resumeDelay: 400, value: 'fired' })
  })

  it('a timer already past due fires immediately on restore', function*({ expect }) {
    let now = 1_000
    const wallClock = { now: () => now }
    const first = createSchedulingClock()
    const actor = createActor(timerMachine, { clock: first.clock, wallClock }).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()
    now = 7_000

    const second = createSchedulingClock()
    const restored = createActor(timerMachine, {
      clock: second.clock,
      wallClock,
      snapshot: persisted,
    }).start()
    const [resumeDelay] = second.pending.map((entry) => entry.delay)
    second.fireNext()

    yield* expect({ resumeDelay, value: restored.getSnapshot().value }).toEqual({
      resumeDelay: 0,
      value: 'fired',
    })
  })

  it('re-persisting without a live schedule keeps the original deadline', function*({ expect }) {
    let now = 1_000
    const wallClock = { now: () => now }
    const first = createSchedulingClock()
    const actor = createActor(timerMachine, { clock: first.clock, wallClock }).start()
    now = 1_600
    const persisted = actor.getPersistedSnapshot()
    actor.stop()
    const original = firstPersistedTimer(persisted)

    const pure = timerMachine.restoreSnapshot(persisted)
    const repersisted = timerMachine.getPersistedSnapshot(pure)
    const carried = firstPersistedTimer(repersisted)

    const third = createSchedulingClock()
    const resumed = createActor(timerMachine, {
      clock: third.clock,
      wallClock,
      snapshot: repersisted,
    }).start()
    const [resumeDelay] = third.pending.map((entry) => entry.delay)
    third.fireNext()

    yield* expect({
      original: original.startedAt,
      carried: carried.startedAt,
      resumeDelay,
      value: resumed.getSnapshot().value,
    }).toEqual({ original: 1_000, carried: 1_000, resumeDelay: 400, value: 'fired' })
  })
})
