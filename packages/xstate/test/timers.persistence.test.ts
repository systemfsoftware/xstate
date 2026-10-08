import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createActor, createAsyncLogic, createMachine, SimulatedClock } from '../src/index.js'

const createLightMachine = () =>
  createMachine({
    initial: 'green',
    states: {
      green: {
        after: { 1000: { target: 'yellow' } },
        on: { STOP: { target: 'red' } },
      },
      yellow: {},
      red: {},
    },
  })

const persistedTimers = z.record(z.string(), z.unknown())
const persistedSnapshot = z.object({
  timers: persistedTimers,
  children: z.record(z.string(), z.unknown()),
})
const persistedMachineChild = z.object({
  snapshot: z.object({ timers: persistedTimers }),
})
const persistedTimerParts = z.object({
  event: z.unknown(),
  target: z.unknown(),
})

describe('persisted logical timers', (it) => {
  it('persists timer intent without runtime clock bookkeeping', function*({ expect }) {
    const actor = createActor(createLightMachine(), {
      clock: new SimulatedClock(),
    }).start()

    const persisted = actor.getPersistedSnapshot()
    const [timer] = Object.values(persistedSnapshot.parse(persisted).timers)
    const [roundTrippedTimer] = Object.values(
      persistedSnapshot.parse(JSON.parse(JSON.stringify(persisted))).timers,
    )

    yield* expect({ timer, roundTrippedTimer }).toStrictEqual({
      timer: {
        id: expect.stringMatching(/^xstate\.after/),
        delay: 1000,
        type: '@xstate.raise',
        event: {
          type: 'xstate.after',
          delay: 1000,
          stateId: '(machine).green',
        },
        target: 'self',
      },
      roundTrippedTimer: {
        id: expect.stringMatching(/^xstate\.after/),
        delay: 1000,
        type: '@xstate.raise',
        event: {
          type: 'xstate.after',
          delay: 1000,
          stateId: '(machine).green',
        },
        target: 'self',
      },
    })
  })

  it('does not persist timers that were cancelled', function*({ expect }) {
    const actor = createActor(createLightMachine(), {
      clock: new SimulatedClock(),
    }).start()
    actor.send({ type: 'STOP' })

    yield* expect(
      persistedSnapshot.parse(actor.getPersistedSnapshot()).timers,
    ).toEqual({})
  })

  it('restarts logical timers with their declared delay when locally restored', function*({ expect }) {
    const actor = createActor(createLightMachine(), {
      clock: new SimulatedClock(),
    }).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const clock = new SimulatedClock()
    const restored = createActor(createLightMachine(), {
      clock,
      snapshot: persisted,
    }).start()

    clock.increment(999)
    const beforeDeclaredDelay = restored.getSnapshot().value
    clock.increment(1)
    const atDeclaredDelay = restored.getSnapshot().value

    yield* expect({ beforeDeclaredDelay, atDeclaredDelay }).toEqual({
      beforeDeclaredDelay: 'green',
      atDeclaredDelay: 'yellow',
    })
  })

  it('materializes a restored invoke timeout for the current child session', function*({ expect }) {
    const child = createAsyncLogic({ run: () => new Promise(() => {}) })
    const machine = createMachine({
      actors: { child },
      initial: 'working',
      states: {
        working: {
          invoke: {
            id: 'child',
            src: 'child',
            timeout: 100,
            onTimeout: { target: 'timedOut' },
          },
        },
        timedOut: {},
      },
    })
    const original = createActor(machine, {
      clock: new SimulatedClock(),
    }).start()
    const originalChild = original.getSnapshot().children['child']
    if (originalChild === undefined) {
      throw new Error('expected the original actor to have a child session')
    }
    const originalSessionId = originalChild.sessionId
    const persisted = original.getPersistedSnapshot()
    const [persistedTimer] = Object.values(
      persistedSnapshot.parse(persisted).timers,
    )
    original.stop()

    const clock = new SimulatedClock()
    const restored = createActor(machine, {
      clock,
      snapshot: persisted,
    }).start()
    const restoredChild = restored.getSnapshot().children['child']
    if (restoredChild === undefined) {
      throw new Error('expected the restored actor to have a child session')
    }

    clock.increment(100)

    yield* expect({
      persistedTimerEvent: persistedTimerParts.parse(persistedTimer).event,
      restoredChildSessionChanged: restoredChild.sessionId !== originalSessionId,
      valueAfterTimeout: restored.getSnapshot().value,
    }).toEqual({
      persistedTimerEvent: {
        type: 'xstate.timeout.actor',
        actorId: 'child',
      },
      restoredChildSessionChanged: true,
      valueAfterTimeout: 'timedOut',
    })
  })

  it('cancels a restored timer when its declaring state exits', function*({ expect }) {
    const actor = createActor(createLightMachine(), {
      clock: new SimulatedClock(),
    }).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const clock = new SimulatedClock()
    const restored = createActor(createLightMachine(), {
      clock,
      snapshot: persisted,
    }).start()

    restored.send({ type: 'STOP' })
    clock.increment(2000)

    yield* expect(restored.getSnapshot().value).toBe('red')
  })

  it('round-trips timers through a restored-but-never-started actor', function*({ expect }) {
    const actor = createActor(createLightMachine(), {
      clock: new SimulatedClock(),
    }).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const idle = createActor(createLightMachine(), { snapshot: persisted })
    const rePersisted = idle.getPersistedSnapshot()
    const [timer] = Object.values(persistedSnapshot.parse(rePersisted).timers)

    yield* expect(timer).toEqual({
      id: expect.stringMatching(/^xstate\.after/),
      delay: 1000,
      type: '@xstate.raise',
      event: {
        type: 'xstate.after',
        delay: 1000,
        stateId: '(machine).green',
      },
      target: 'self',
    })
  })

  it('restores timers of rehydrated child actors', function*({ expect }) {
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 1000: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = createMachine({
      actors: { child },
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: 'child',
            onDone: { target: 'finished' },
          },
        },
        finished: {},
      },
    })

    const actor = createActor(parent, {
      clock: new SimulatedClock(),
    }).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const childTimers = persistedMachineChild.parse(
      Object.values(persistedSnapshot.parse(persisted).children)[0],
    ).snapshot.timers

    const clock = new SimulatedClock()
    const restored = createActor(parent, {
      clock,
      snapshot: persisted,
    }).start()
    const valueBeforeDelay = restored.getSnapshot().value
    clock.increment(1000)
    const valueAfterDelay = restored.getSnapshot().value

    yield* expect({
      childTimers: Object.values(childTimers),
      valueBeforeDelay,
      valueAfterDelay,
    }).toEqual({
      childTimers: [
        {
          id: expect.stringMatching(/^xstate\.after/),
          delay: 1000,
          type: '@xstate.raise',
          event: {
            type: 'xstate.after',
            delay: 1000,
            stateId: '(machine).waiting',
          },
          target: 'self',
        },
      ],
      valueBeforeDelay: 'working',
      valueAfterDelay: 'finished',
    })
  })

  it('restores the logical target of a delayed child send', function*({ expect }) {
    const received: unknown[] = []
    const recordReceived = (event: unknown) => {
      received.push(event)
    }
    const child = createMachine({
      on: { PING: ({ event }, enq) => enq(recordReceived, event) },
    })
    const parent = createMachine({
      actors: { child },
      invoke: { id: 'child', src: 'child' },
      on: {
        SCHEDULE: ({ children }, enq) => {
          enq.sendTo(
            children['child'],
            { type: 'PING' },
            {
              id: 'ping',
              delay: 100,
            },
          )
        },
      },
    })
    const actor = createActor(parent, {
      clock: new SimulatedClock(),
    }).start()
    actor.send({ type: 'SCHEDULE' })
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const clock = new SimulatedClock()
    createActor(parent, { clock, snapshot: persisted }).start()
    clock.increment(100)

    yield* expect({
      pingTimer: persistedSnapshot.parse(persisted).timers['ping'],
      received,
    }).toEqual({
      pingTimer: {
        id: 'ping',
        delay: 100,
        type: '@xstate.sendTo',
        event: { type: 'PING' },
        target: 'child',
      },
      received: [{ type: 'PING' }],
    })
  })

  it('restores the logical parent target of a delayed child send', function*({ expect }) {
    const received: unknown[] = []
    const recordReceived = (event: unknown) => {
      received.push(event)
    }
    const child = createMachine({
      on: {
        SCHEDULE: ({ parent }, enq) =>
          enq.sendTo(
            parent,
            { type: 'PING' },
            { id: 'ping-parent', delay: 100 },
          ),
      },
    })
    const parent = createMachine({
      actors: { child },
      invoke: { id: 'child', src: 'child' },
      on: {
        START: ({ children }, enq) => enq.sendTo(children['child'], { type: 'SCHEDULE' }),
        PING: ({ event }, enq) => enq(recordReceived, event),
      },
    })
    const actor = createActor(parent).start()
    actor.send({ type: 'START' })
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const childTimers = persistedMachineChild.parse(
      Object.values(persistedSnapshot.parse(persisted).children)[0],
    ).snapshot.timers

    const clock = new SimulatedClock()
    createActor(parent, { clock, snapshot: persisted }).start()
    clock.increment(100)

    yield* expect({
      parentTarget: persistedTimerParts.parse(childTimers['ping-parent']).target,
      received,
    }).toEqual({
      parentTarget: { type: 'parent' },
      received: [{ type: 'PING' }],
    })
  })

  it('does not rebind a delayed send to a replacement child with the same id', function*({ expect }) {
    const child = createMachine({})
    const parent = createMachine({
      actors: { child },
      initial: 'active',
      states: {
        active: {
          invoke: { id: 'child', src: 'child' },
          on: {
            SCHEDULE: ({ children }, enq) =>
              enq.sendTo(
                children['child'],
                { type: 'PING' },
                { id: 'ping', delay: 100 },
              ),
            REENTER: { target: 'active', reenter: true },
          },
        },
      },
    })
    const actor = createActor(parent).start()
    actor.send({ type: 'SCHEDULE' })
    actor.send({ type: 'REENTER' })

    yield* expect(() => actor.getPersistedSnapshot()).toThrow(
      "Unable to persist timer 'ping'",
    )
  })
})
