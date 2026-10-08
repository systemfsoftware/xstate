import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable, type DurableExecutionAdapter, type DurableWaitMetadata } from '../src/durable/index.js'
import {
  type AnyActor,
  type AnyActorLogic,
  type AnyEventObject,
  createAsyncLogic,
  createMachine,
  setup,
  type Snapshot,
  stopActor,
} from '../src/index.js'
import type { ActorValidationRequest } from '../src/validation.types.js'

function adapter(
  overrides: Partial<DurableExecutionAdapter<AnyActorLogic>> = {},
) {
  return {
    executeAction: () => Promise.resolve(),
    enqueueRootEvent: () => {},
    waitForEvent: () => ({ type: 'CONTINUE' }),
    ...overrides,
  }
}

function callRecorder<Args extends unknown[] = unknown[], Result = void>(
  impl?: (...args: Args) => Result,
) {
  const calls: Args[] = []
  const fn = (...args: Args): Result => {
    calls.push(args)
    return impl === undefined ? (undefined as Result) : impl(...args)
  }
  return { calls, fn }
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function thrownMessage(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('durable checkpoint restoration', () => {
  it('does not reuse a journaled event-wait ID when restoring without a saved index', function*({ expect }) {
    const machine = createMachine({ on: { CONTINUE: {} } })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const { calls: waitCalls, fn: waitForEvent } = callRecorder<
      [DurableWaitMetadata],
      AnyEventObject
    >(() => ({ type: 'CONTINUE' }))
    const host = adapter({ waitForEvent })
    const resumed = createDurable(machine, host)
    const [snapshot, effects] = resumed.restore(
      machine.getPersistedSnapshot(initial),
    )
    yield* Effect.promise(() => resumed.executeEffects(effects))
    const event = yield* Effect.promise(() => resumed.waitForEvent())
    resumed.transition(snapshot, event)
    yield* Effect.promise(() => resumed.waitForEvent())
    yield* expect(waitCalls).toEqual([
      [{ id: 'event:restore:0', transitionIndex: 0 }],
      [{ id: 'event:0', transitionIndex: 0 }],
    ])
  })
  it('restores without a machine event, entry actions, or a consumed transition index', function*({ expect }) {
    const { calls: entryCalls, fn: entry } = callRecorder()
    const { calls: checkCalls, fn: check } = callRecorder<[ActorValidationRequest], Error | undefined>()
    const machine = setup({ validator: { check } }).createMachine({
      id: 'workflow',
      initial: 'waiting',
      states: {
        waiting: {
          entry: (_, enq) => enq(entry),
          on: { '*': { target: 'done' } },
        },
        done: { type: 'final', entry: (_, enq) => enq(entry) },
      },
    })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const persisted = roundTrip(machine.getPersistedSnapshot(initial))
    checkCalls.length = 0
    const { calls: waitCalls, fn: waitForEvent } = callRecorder<
      [DurableWaitMetadata],
      AnyEventObject
    >(() => ({ type: 'CONTINUE' }))
    const host = adapter({ transitionIndex: 7, waitForEvent })
    const execution = createDurable(machine, host)

    const [snapshot, effects] = execution.restore(persisted)
    yield* expect({
      value: snapshot.value,
      effects,
      entryCalls,
      noEventValidation: !checkCalls.some(([request]) => request.kind === 'event'),
      address: execution.getActorRef(snapshot)?.address,
      nextTransitionIndex: execution.nextTransitionIndex,
    }).toEqual({
      value: 'waiting',
      effects: [],
      entryCalls: [],
      noEventValidation: true,
      address: 'workflow',
      nextTransitionIndex: 7,
    })
    yield* Effect.promise(() => execution.executeEffects(effects))
    const event = yield* Effect.promise(() => execution.waitForEvent())

    const [done, nextEffects] = execution.transition(snapshot, {
      type: 'CONTINUE',
    })
    const [firstEffect] = nextEffects
    if (firstEffect === undefined) {
      throw new Error('expected a next effect')
    }
    yield* expect({
      event,
      waitCalls,
      status: done.status,
      firstEffectId: firstEffect.id,
    }).toEqual({
      event: { type: 'CONTINUE' },
      waitCalls: [[{ id: 'event:6', transitionIndex: 6 }]],
      status: 'done',
      firstEffectId: '7:0',
    })
  })

  it('restarts a pending request only when its restoration effects execute', function*({ expect }) {
    const { calls: runCalls, fn: run } = callRecorder<[], Promise<string>>(() => Promise.resolve('answer'))
    const worker = createAsyncLogic({ run })
    const machine = createMachine({
      id: 'request',
      actors: { worker },
      initial: 'working',
      states: {
        working: {
          invoke: { id: 'worker', src: 'worker', onDone: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const execution = createDurable(machine, adapter())
    const [snapshot, effects] = execution.restore(
      roundTrip(machine.getPersistedSnapshot(initial)),
    )

    const [firstEffect] = effects
    if (firstEffect === undefined) {
      throw new Error('expected a restore effect')
    }
    yield* expect({
      runCalls,
      effectIds: effects.map(({ id }) => id),
      firstDescriptor: firstEffect.descriptor,
    }).toEqual({
      runCalls: [],
      effectIds: ['restore:0:0'],
      firstDescriptor: expect.objectContaining({
        type: '@xstate.start',
        actor: 'request/worker',
      }),
    })
    yield* Effect.promise(() => execution.executeEffects(effects))
    yield* expect(runCalls.length).toBe(1)
    const event = yield* Effect.promise(() => execution.waitForEvent())
    yield* expect({
      event,
      nextStatus: execution.transition(snapshot, event)[0].status,
    }).toMatchObject({
      event: { type: 'xstate.done.actor', actorId: 'worker' },
      nextStatus: 'done',
    })
  })

  it(
    'routes restored descendants and their timers through the adapter and cleans them up on stop',
    function*({ expect }) {
      const leaf = createMachine({
        initial: 'waiting',
        states: {
          waiting: { after: { 100: { target: 'done' } } },
          done: { type: 'final' },
        },
      })
      const child = createMachine({
        actors: { leaf },
        invoke: { id: 'leaf', src: 'leaf' },
      })
      const machine = createMachine({
        id: 'tree',
        actors: { child },
        invoke: { id: 'child', src: 'child' },
      })
      const fresh = createDurable(machine, adapter())
      const [initial] = fresh.initialTransition()
      const { calls: startActorCalls, fn: startActor } = callRecorder<[AnyActor]>((actor) => {
        actor.start()
      })
      const { calls: scheduleTimerCalls, fn: scheduleTimer } = callRecorder<[AnyActor, string, number]>()
      const { calls: cancelAllTimersCalls, fn: cancelAllTimers } = callRecorder<[AnyActor]>()
      const execution = createDurable(
        machine,
        adapter({ startActor, scheduleTimer, cancelAllTimers }),
      )
      const [snapshot, effects] = execution.restore(
        roundTrip(machine.getPersistedSnapshot(initial)),
      )

      yield* expect(startActorCalls).toEqual([])
      yield* Effect.promise(() => execution.executeEffects(effects))
      const leafRef = execution.getActorRef(snapshot, 'tree/child/leaf')!
      yield* expect({
        startedAddresses: startActorCalls.map(([actor]) => actor.address),
        scheduledCalls: scheduleTimerCalls,
      }).toEqual({
        startedAddresses: ['tree/child', 'tree/child/leaf'],
        scheduledCalls: expect.arrayContaining([[leafRef, expect.any(String), 100]]),
      })
      yield* Effect.promise(() =>
        Promise.resolve(
          execution
            .getActorRef(snapshot, 'tree/child')!
            .system.stopActor(snapshot.children['child']),
        )
      )
      yield* expect({
        cancelledAddresses: cancelAllTimersCalls.map(([actor]) => actor.address),
        leafStatus: leafRef.getSnapshot().status,
      }).toEqual({
        cancelledAddresses: expect.arrayContaining(['tree/child/leaf']),
        leafStatus: 'stopped',
      })
    },
  )

  it('restores root raises and delayed sends with stable IDs and current targets', function*({ expect }) {
    const worker = createMachine({ on: { PING: {} } })
    const machine = createMachine({
      id: 'timers',
      actors: { worker },
      invoke: { id: 'worker', src: 'worker' },
      entry: ({ children }, enq) => {
        enq.sendTo(
          children['worker'],
          { type: 'PING' },
          { id: 'ping', delay: 200 },
        )
      },
      initial: 'waiting',
      states: { waiting: { after: { 100: { target: 'done' } } }, done: {} },
    })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const persisted = roundTrip(machine.getPersistedSnapshot(initial))
    const { calls: scheduleTimerCalls, fn: scheduleTimer } = callRecorder<[AnyActor, string, number]>()
    const execution = createDurable(
      machine,
      adapter({ transitionIndex: 12, scheduleTimer }),
    )
    const [snapshot, effects] = execution.restore(persisted)
    const timerEffects = effects.filter(
      ({ descriptor }) => descriptor.type !== '@xstate.start',
    )
    yield* expect({
      scheduleTimerCalls,
      timerDescriptors: timerEffects.map(({ descriptor }) => descriptor),
    }).toEqual({
      scheduleTimerCalls: [],
      timerDescriptors: expect.arrayContaining([
        expect.objectContaining({
          type: '@xstate.sendTo',
          target: 'timers/worker',
          id: 'ping',
          delay: 200,
        }),
        expect.objectContaining({ type: '@xstate.raise', delay: 100 }),
      ]),
    })
    yield* Effect.promise(() => execution.executeEffects(effects))
    const retry = createDurable(machine, adapter({ transitionIndex: 12 }))
    yield* expect({
      scheduleTimerCalls,
      retryEffects: retry
        .restore(persisted)[1]
        .map(({ id, descriptor }) => ({ id, descriptor })),
      nextTransitionIndex: execution.nextTransitionIndex,
    }).toEqual({
      scheduleTimerCalls: expect.arrayContaining([
        [execution.getActorRef(snapshot), 'ping', 200],
        [execution.getActorRef(snapshot), expect.any(String), 100],
      ]),
      retryEffects: effects.map(({ id, descriptor }) => ({ id, descriptor })),
      nextTransitionIndex: 12,
    })
    const workerChild = snapshot.children['worker']
    if (workerChild === undefined) {
      throw new Error('expected a worker child')
    }
    stopActor(workerChild)
  })

  it.each([
    [900, 400],
    [0, 0],
    [2000, 500],
  ])(
    'honors a persisted wall-clock start %s (remaining %s)',
    function*([startedAt, remaining], { expect }) {
      const machine = createMachine({
        initial: 'waiting',
        states: { waiting: { after: { 500: { target: 'done' } } }, done: {} },
      })
      const fresh = createDurable(machine, adapter({ now: () => 1000 }))
      const [initial] = fresh.initialTransition()
      const persisted = roundTrip(
        machine.getPersistedSnapshot(initial),
      ) as Snapshot<unknown> & {
        timers: Record<string, { startedAt?: number }>
      }
      const [firstTimer] = Object.values(persisted.timers)
      if (firstTimer === undefined || startedAt === undefined) {
        throw new Error('expected a persisted timer')
      }
      firstTimer.startedAt = startedAt
      const { calls: scheduleTimerCalls, fn: scheduleTimer } = callRecorder<[AnyActor, string, number]>()
      const execution = createDurable(
        machine,
        adapter({ scheduleTimer, now: () => 1000 }),
      )
      const [snapshot, effects] = execution.restore(persisted)
      yield* Effect.promise(() => execution.executeEffects(effects))
      yield* expect(scheduleTimerCalls).toEqual(
        expect.arrayContaining([
          [execution.getActorRef(snapshot), expect.any(String), remaining],
        ]),
      )
    },
  )

  it.each([false, true])(
    'preserves root timer deadlines through delayed execution, startup and retry (per-effect runtime: %s)',
    function*(perEffectRuntime, { expect }) {
      let now = 900
      const worker = createMachine({ on: { PING: {} } })
      const machine = createMachine({
        actors: { worker },
        invoke: { id: 'worker', src: 'worker' },
        entry: ({ children }, enq) => {
          enq.sendTo(
            children['worker'],
            { type: 'PING' },
            { id: 'ping', delay: 2000 },
          )
          enq.sendTo(
            children['worker'],
            { type: 'PING' },
            { id: 'pure', delay: 3000 },
          )
        },
        initial: 'waiting',
        states: { waiting: { after: { 1000: { target: 'done' } } }, done: {} },
      })
      const fresh = createDurable(machine, adapter({ now: () => now }))
      const [initial] = fresh.initialTransition()
      const persisted = roundTrip(
        machine.getPersistedSnapshot(initial),
      ) as Snapshot<unknown> & {
        timers: Record<string, { startedAt?: number }>
      }
      Object.entries(persisted.timers).forEach(([id, timer]) => {
        if (id !== 'pure') timer.startedAt = 0
      })
      const { calls: scheduleTimerCalls, fn: scheduleTimer } = callRecorder<[AnyActor, string, number]>()
      const startActor = (actor: AnyActor): Promise<void> => {
        // Startup initiates another host operation without awaiting it. That
        // operation sits ahead of the root timer on the runtime's queue.
        void actor.system.sendEvent(actor, actor, { type: 'PING' })
        return Promise.resolve().then(() => {
          now = 975
        })
      }
      const runtime = {
        startActor,
        scheduleTimer,
        sendEvent: () =>
          Promise.resolve().then(() => {
            now = 1100
          }),
      }
      const execution = createDurable(
        machine,
        adapter({
          transitionIndex: 12,
          now: () => now,
          sendEvent: runtime.sendEvent,
          ...(perEffectRuntime ? { runtime: () => runtime } : runtime),
        }),
      )
      const [snapshot, effects] = execution.restore(persisted)
      const ids = effects.map(({ id }) => id)
      const descriptors = effects.map(({ descriptor }) => descriptor)
      yield* expect(Object.values(snapshot.timers).map(({ delay }) => delay)).toEqual([
        2000,
        3000,
        1000,
      ])
      now = 950
      yield* Effect.promise(() => execution.executeEffects(effects))
      yield* expect(scheduleTimerCalls.map(([, , delay]) => delay)).toEqual([
        900,
        3000,
        0,
      ])

      now = 1200
      yield* Effect.promise(() =>
        execution.executeEffects(
          effects.filter(({ effect }) => effect.type !== '@xstate.start'),
        )
      )
      const retry = createDurable(machine, adapter({ transitionIndex: 12 }))
      yield* expect({
        scheduleDelays: scheduleTimerCalls.map(([, , delay]) => delay),
        effectIds: effects.map(({ id }) => id),
        effectDescriptors: effects.map(({ descriptor }) => descriptor),
        nextTransitionIndex: execution.nextTransitionIndex,
        retryEffects: retry
          .restore(persisted)[1]
          .map(({ id, descriptor }) => ({ id, descriptor })),
      }).toEqual({
        scheduleDelays: [
          900,
          3000,
          0,
          800,
          2900,
          0,
        ],
        effectIds: ids,
        effectDescriptors: descriptors,
        nextTransitionIndex: 12,
        retryEffects: effects.map(({ id, descriptor }) => ({ id, descriptor })),
      })
    },
  )

  it.each(['done', 'error', 'stopped'] as const)(
    'does not restart work in a terminal %s snapshot',
    function*(status, { expect }) {
      const worker = createAsyncLogic({ run: () => Promise.resolve('done') })
      const machine = createMachine({
        actors: { worker },
        invoke: { id: 'worker', src: 'worker' },
      })
      const fresh = createDurable(machine, adapter())
      const [initial] = fresh.initialTransition()
      const persisted = roundTrip(machine.getPersistedSnapshot(initial))
      persisted.status = status
      const execution = createDurable(machine, adapter())
      yield* expect(execution.restore(persisted)[1]).toEqual([])
    },
  )

  it('keeps address-only children remote and installs their routing without starting them', function*({ expect }) {
    const worker = createMachine({})
    const machine = createMachine({
      id: 'remote',
      actors: { worker },
      invoke: { id: 'worker', src: 'worker' },
    })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const persisted = roundTrip(
      machine.getPersistedSnapshot(initial, { embedChildren: false }),
    )
    const { calls: sendEventCalls, fn: sendEvent } = callRecorder<
      [AnyActor | undefined, AnyActor, AnyEventObject]
    >()
    const execution = createDurable(machine, adapter({ sendEvent }))
    const [snapshot, effects] = execution.restore(persisted)
    const workerChild = snapshot.children['worker']
    if (workerChild === undefined) {
      throw new Error('expected a worker child')
    }
    workerChild.send({ type: 'PING' })
    yield* expect({
      effects,
      sendCalls: sendEventCalls.map(([, target, event]) => [target === workerChild, event]),
    }).toEqual({
      effects: [],
      sendCalls: [[true, { type: 'PING' }]],
    })
  })

  it('propagates restoration errors without consuming a transition index', function*({ expect }) {
    const old = createMachine({
      id: 'versioned',
      version: '1',
      initial: 'waiting',
      states: { waiting: {} },
    })
    const fresh = createDurable(old, adapter())
    const [initial] = fresh.initialTransition()
    const machine = createMachine({
      id: 'versioned',
      version: '2',
      initial: 'waiting',
      states: { waiting: {} },
    })
    const execution = createDurable(machine, adapter({ transitionIndex: 3 }))
    const thrown = thrownMessage(() => execution.restore(old.getPersistedSnapshot(initial)))
    yield* expect({
      thrown,
      nextTransitionIndex: execution.nextTransitionIndex,
    }).toEqual({
      thrown: expect.stringMatching(/version/),
      nextTransitionIndex: 3,
    })
  })

  it('does not restart a completed embedded child or a request on a retried batch', function*({ expect }) {
    const { calls: runCalls, fn: run } = callRecorder<[], Promise<string>>(() => Promise.resolve('answer'))
    const worker = createAsyncLogic({ run })
    const machine = createMachine({
      actors: { worker },
      invoke: { id: 'worker', src: 'worker' },
    })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const persisted = roundTrip(machine.getPersistedSnapshot(initial))
    const execution = createDurable(machine, adapter())
    const [, effects] = execution.restore(persisted)
    yield* Effect.promise(() => execution.executeEffects(effects))
    yield* Effect.promise(() => execution.executeEffects(effects))

    const completed = roundTrip(persisted) as Snapshot<unknown> & {
      children: Record<string, { snapshot: Snapshot<unknown> }>
    }
    const completedWorker = completed.children['worker']
    if (completedWorker === undefined) {
      throw new Error('expected a persisted worker child')
    }
    completedWorker.snapshot = {
      status: 'done',
      output: 'answer',
      error: undefined,
    }
    const restored = createDurable(machine, adapter())
    const [, completedEffects] = restored.restore(completed)
    yield* expect({
      runCallCount: runCalls.length,
      completedEffects,
    }).toEqual({
      runCallCount: 1,
      completedEffects: [],
    })
    yield* Effect.promise(() => restored.executeEffects(completedEffects))
    yield* expect(runCalls.length).toBe(1)
  })

  it('cancels restored root timers on exit and ignores their stale firing inputs', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          after: { 100: { target: 'expired' } },
          on: { CANCEL: { target: 'cancelled' } },
        },
        expired: {},
        cancelled: {},
      },
    })
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const { calls: cancelTimerCalls, fn: cancelTimer } = callRecorder<[AnyActor, string]>()
    const execution = createDurable(
      machine,
      adapter({ scheduleTimer: () => {}, cancelTimer }),
    )
    const [snapshot, effects] = execution.restore(
      roundTrip(machine.getPersistedSnapshot(initial)),
    )
    yield* Effect.promise(() => execution.executeEffects(effects))
    const id = Object.keys(snapshot.timers)[0]
    const [cancelled, cancelEffects] = execution.transition(snapshot, {
      type: 'CANCEL',
    })
    yield* Effect.promise(() => execution.executeEffects(cancelEffects))
    const staleFiring = { type: 'xstate.timer', id }
    yield* expect({
      firstCancelId: cancelTimerCalls[0]?.[1] === id,
      timers: cancelled.timers,
      staleValue: execution.transition(cancelled, staleFiring)[0].value,
    }).toEqual({
      firstCancelId: true,
      timers: {},
      staleValue: 'cancelled',
    })
  })

  it('keeps a host-owned deadline when a pure checkpoint re-arms the same logical timer', function*({ expect }) {
    let now = 0
    const deadlines = new Map<string, number>()
    const host = adapter({
      now: () => now,
      scheduleTimer: (source, id, delay) => {
        const key = `${source.address}:${id}`
        if (!deadlines.has(key)) deadlines.set(key, now + delay)
      },
    })
    const machine = createMachine({
      id: 'deadline',
      initial: 'waiting',
      states: { waiting: { after: { 1000: { target: 'done' } } }, done: {} },
    })
    const fresh = createDurable(machine, host)
    const [initial, initialEffects] = fresh.initialTransition()
    yield* Effect.promise(() => fresh.executeEffects(initialEffects))
    const checkpoint = roundTrip(machine.getPersistedSnapshot(initial))
    now = 300
    const resumed = createDurable(machine, {
      ...host,
      transitionIndex: fresh.nextTransitionIndex,
    })
    const [, effects] = resumed.restore(checkpoint)
    yield* Effect.promise(() => resumed.executeEffects(effects))
    yield* expect([...deadlines.values()]).toEqual([1000])
  })

  it('requires a fresh execution and keeps run() from initializing a restored checkpoint', function*({ expect }) {
    const machine = createMachine({})
    const fresh = createDurable(machine, adapter())
    const [initial] = fresh.initialTransition()
    const checkpoint = machine.getPersistedSnapshot(initial)
    const freshRestore = thrownMessage(() => fresh.restore(checkpoint))
    const resumed = createDurable(machine, adapter())
    resumed.restore(checkpoint)
    const resumedRestore = thrownMessage(() => resumed.restore(checkpoint))
    const resumedInitial = thrownMessage(() => resumed.initialTransition())
    const runMessage = yield* Effect.promise(() =>
      resumed.run().then(
        () => undefined,
        (error: unknown) => error instanceof Error ? error.message : String(error),
      )
    )
    yield* expect({
      freshRestore,
      resumedRestore,
      resumedInitial,
      runMessage,
      nextTransitionIndex: resumed.nextTransitionIndex,
    }).toEqual({
      freshRestore: expect.stringMatching(/fresh/),
      resumedRestore: expect.stringMatching(/fresh/),
      resumedInitial: expect.stringMatching(/restored/),
      runMessage: expect.stringMatching(/fresh/),
      nextTransitionIndex: 0,
    })
  })
})
