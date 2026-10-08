import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import {
  type ActorSystemRuntime,
  type AnyEventObject,
  createActor,
  createCallbackLogic,
  createMachine,
  type ExecutableActionObject,
  getMicrosteps,
  initialTransition,
  isBuiltInExecutableAction,
  SimulatedClock,
  transition,
} from '../src/index.js'

const internalEvent = <TEvent>(event: AnyEventObject): TEvent => event as unknown as TEvent

const effectId = (effect: ExecutableActionObject): string | undefined => 'id' in effect ? effect.id : undefined

describe('logical snapshot timers', () => {
  it('declares a pending timer in the pure initial snapshot', function*({ expect }) {
    const machine = createMachine({
      initial: 'red',
      states: {
        red: { after: { 100: { target: 'green' } } },
        green: {},
      },
    })

    const [snapshot, effects] = initialTransition(machine)
    const schedule = effects.find(
      (effect) => isBuiltInExecutableAction(effect) && effect.type === '@xstate.raise',
    )!
    const timer = snapshot.timers[schedule.id!]
    if (timer === undefined) {
      throw new Error('expected a pending timer')
    }

    yield* expect({
      timer,
      hasStartedAt: 'startedAt' in timer,
      hasDueAt: 'dueAt' in timer,
      hasElapsed: 'elapsed' in timer,
    }).toEqual({
      timer: {
        id: schedule.id,
        delay: 100,
        type: '@xstate.raise',
        event: schedule.event,
        target: 'self',
      },
      hasStartedAt: false,
      hasDueAt: false,
      hasElapsed: false,
    })

    const calls: Array<Parameters<ActorSystemRuntime['scheduleTimer']>> = []
    const scheduleTimer: ActorSystemRuntime['scheduleTimer'] = (
      source,
      id,
      delay,
    ) => {
      calls.push([source, id, delay])
    }
    yield* Effect.promise(() => Promise.resolve(schedule.exec({ scheduleTimer })))

    yield* expect(calls).toEqual([[schedule.source, schedule.id!, 100]])
  })

  it('keeps wall-clock bookkeeping in the runtime', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 100: { target: 'done' } } },
        done: {},
      },
    })
    const actor = createActor(machine, {
      clock: new SimulatedClock(),
    }).start()
    const [timer] = Object.values(actor.system.getSnapshot()._scheduledTimers)
    if (timer === undefined) {
      throw new Error('expected a scheduled timer')
    }
    const snapshotTimer = actor.getSnapshot().timers[timer.id]
    if (snapshotTimer === undefined) {
      throw new Error('expected a snapshot timer')
    }

    yield* expect({
      id: timer.id,
      delay: timer.delay,
      scheduledAt: timer.scheduledAt,
      dueAt: timer.dueAt,
      snapshotHasScheduledAt: 'scheduledAt' in snapshotTimer,
      snapshotHasDueAt: 'dueAt' in snapshotTimer,
    }).toEqual({
      id: expect.any(String),
      delay: 100,
      scheduledAt: expect.any(Number),
      dueAt: expect.any(Number),
      snapshotHasScheduledAt: false,
      snapshotHasDueAt: false,
    })
  })

  it('consumes a delayed raise in the same macrostep', function*({ expect }) {
    const machine = createMachine({
      initial: 'red',
      states: {
        red: { after: { 100: { target: 'green' } } },
        green: {},
      },
    })
    const [red] = initialTransition(machine)
    const [id] = Object.keys(red.timers)

    const [timerConsumed, effects] = transition(
      machine,
      red,
      internalEvent({ type: 'xstate.timer', id }),
    )

    yield* expect({
      value: timerConsumed.value,
      timers: timerConsumed.timers,
      effects,
    }).toEqual({
      value: 'green',
      timers: {},
      effects: [expect.objectContaining({ type: '@xstate.cancel', id })],
    })
  })

  it('removes cancelled timers and ignores stale timer inputs', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          after: { 100: { target: 'late' } },
          on: { EXIT: { target: 'done' } },
        },
        late: {},
        done: {},
      },
    })
    const [waiting] = initialTransition(machine)
    const [id] = Object.keys(waiting.timers)

    const [done, exitEffects] = transition(machine, waiting, { type: 'EXIT' })

    const [unchanged, staleEffects] = transition(
      machine,
      done,
      internalEvent({ type: 'xstate.timer', id }),
    )

    yield* expect({
      doneTimers: done.timers,
      exitEffectTypes: exitEffects.map((effect) => effect.type),
      staleIsUnchanged: unchanged === done,
      staleEffects,
    }).toEqual({
      doneTimers: {},
      exitEffectTypes: ['@xstate.cancel'],
      staleIsUnchanged: true,
      staleEffects: [],
    })
  })

  it('uses the same timer mechanism for delayed sends to children', function*({ expect }) {
    const childLogic = createCallbackLogic(() => {})
    const machine = createMachine({
      actors: { childLogic },
      invoke: { id: 'child', src: 'childLogic' },
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
    const [active] = initialTransition(machine)

    const [scheduled, scheduleEffects] = transition(machine, active, {
      type: 'SCHEDULE',
    })

    const [consumed, deliveryEffects] = transition(
      machine,
      scheduled,
      internalEvent({ type: 'xstate.timer', id: 'ping' }),
    )

    yield* expect({
      scheduledTimer: scheduled.timers['ping'],
      scheduleEffects,
      consumedTimers: consumed.timers,
      deliveryEffects,
    }).toEqual({
      scheduledTimer: {
        id: 'ping',
        delay: 100,
        type: '@xstate.sendTo',
        event: { type: 'PING' },
        target: active.children['child'],
      },
      scheduleEffects: [
        expect.objectContaining({
          type: '@xstate.sendTo',
          id: 'ping',
          delay: 100,
        }),
      ],
      consumedTimers: {},
      deliveryEffects: [
        expect.objectContaining({
          type: '@xstate.sendTo',
          id: undefined,
          delay: undefined,
          target: active.children['child'],
          event: { type: 'PING' },
        }),
      ],
    })
  })

  it('allocates deterministic ids for anonymous delayed effects', function*({ expect }) {
    const machine = createMachine({
      on: {
        SCHEDULE: (_, enq) => {
          enq.raise({ type: 'FIRST' }, { delay: 10 })
          enq.raise({ type: 'SECOND' }, { delay: 20 })
        },
      },
    })
    const [initial] = initialTransition(machine)

    const [left, leftEffects] = transition(machine, initial, {
      type: 'SCHEDULE',
    })
    const [right, rightEffects] = transition(machine, initial, {
      type: 'SCHEDULE',
    })

    yield* expect({
      leftTimerIds: Object.keys(left.timers),
      rightTimerIds: Object.keys(right.timers),
      leftEffectIds: leftEffects.map(effectId),
    }).toEqual({
      leftTimerIds: ['xstate.timer.auto.0', 'xstate.timer.auto.1'],
      rightTimerIds: ['xstate.timer.auto.0', 'xstate.timer.auto.1'],
      leftEffectIds: rightEffects.map(effectId),
    })
  })

  it('exposes timer consumption as its own microstep', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 10: { target: 'done' } } },
        done: {},
      },
    })
    const [waiting] = initialTransition(machine)
    const [id] = Object.keys(waiting.timers)

    const microsteps = getMicrosteps(
      machine,
      waiting,
      internalEvent({ type: 'xstate.timer', id }),
    )

    if (microsteps[0] === undefined || microsteps[1] === undefined) {
      throw new Error('expected two microsteps')
    }

    yield* expect({
      count: microsteps.length,
      firstTimers: microsteps[0][0].timers,
      firstEffects: microsteps[0][1],
      secondValue: microsteps[1][0].value,
      secondEffects: microsteps[1][1],
    }).toEqual({
      count: 2,
      firstTimers: {},
      firstEffects: [],
      secondValue: 'done',
      secondEffects: [expect.objectContaining({ type: '@xstate.cancel', id })],
    })
  })

  it('cancels remaining timers after child stops when reaching final', function*({ expect }) {
    const child = createCallbackLogic(() => {})
    const machine = createMachine({
      actors: { child },
      initial: 'active',
      states: {
        active: {
          invoke: { id: 'child', src: 'child' },
          on: {
            FINISH: (_, enq) => {
              enq.raise({ type: 'LATE' }, { id: 'late', delay: 100 })
              return { target: 'done' }
            },
          },
        },
        done: { type: 'final' },
      },
    })
    const [active] = initialTransition(machine)

    const [done, effects] = transition(machine, active, { type: 'FINISH' })

    yield* expect({
      status: done.status,
      children: done.children,
      timers: done.timers,
      effectTypes: effects.map(({ type }) => type),
    }).toEqual({
      status: 'done',
      children: {},
      timers: {},
      effectTypes: [
        '@xstate.stop',
        '@xstate.raise',
        '@xstate.cancel',
        '@xstate.terminate',
      ],
    })
  })

  it('cancels remaining timers after child stops when explicitly stopped', function*({ expect }) {
    const child = createCallbackLogic(() => {})
    const machine = createMachine({
      actors: { child },
      invoke: { id: 'child', src: 'child' },
      on: {
        SCHEDULE: (_, enq) => enq.raise({ type: 'LATE' }, { id: 'late', delay: 100 }),
      },
    })
    const [active] = initialTransition(machine)
    const [scheduled] = transition(machine, active, { type: 'SCHEDULE' })

    const [stopped, effects] = transition(
      machine,
      scheduled,
      internalEvent({ type: '@xstate.stop' }),
    )

    yield* expect({
      status: stopped.status,
      children: stopped.children,
      timers: stopped.timers,
      effectTypes: effects.map(({ type }) => type),
    }).toEqual({
      status: 'stopped',
      children: {},
      timers: {},
      effectTypes: ['@xstate.stop', '@xstate.cancel'],
    })
  })
})
