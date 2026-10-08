import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable, type DurableEffectMetadata, DurableExecutionCancelledError } from '../src/durable/index.js'
import { type ActorLogic, type ActorSystemRuntime, createLogic, createMachine, type Snapshot } from '../src/index.js'

const errorNameOf = (error: unknown): string | undefined => error instanceof Error ? error.name : undefined

describe('durable execution', () => {
  it('tags and executes effects in deterministic transition order', function*({ expect }) {
    const operations: string[] = []
    const executed: DurableEffectMetadata[] = []
    const machine = createMachine({
      initial: 'active',
      entry: (_, enq) => {
        enq(() => operations.push('initial:first'))
        enq(() => operations.push('initial:second'))
      },
      states: {
        active: {
          on: {
            FINISH: { target: 'done' },
          },
        },
        done: {
          type: 'final',
          entry: (_, enq) => enq(() => operations.push('finish')),
        },
      },
    })
    const d = createDurable(machine, {
      runtime: (metadata) => ({
        terminateActor: () => {
          executed.push(metadata)
        },
      }),
      executeAction: (effect, metadata) => {
        executed.push(metadata)
        return Promise.resolve(effect.exec())
      },
      waitForEvent: () => ({ type: 'FINISH' }),
    })

    const [initialState, initialEffects] = d.initialTransition(undefined)
    yield* expect(initialEffects.map(({ id }) => id)).toEqual(['0:0', '0:1'])
    yield* Effect.promise(() => d.executeEffects(initialEffects))
    const finishEvent = yield* Effect.promise(() => d.waitForEvent())
    const [state, effects] = d.transition(initialState, finishEvent)
    yield* expect(effects.map(({ id }) => id)).toEqual(['1:0', '1:1'])
    yield* Effect.promise(() => d.executeEffects(effects))

    yield* expect({
      status: state.status,
      operations,
      executed,
    }).toEqual({
      status: 'done',
      operations: ['initial:first', 'initial:second', 'finish'],
      executed: [
        { id: '0:0', transitionIndex: 0, effectIndex: 0 },
        { id: '0:1', transitionIndex: 0, effectIndex: 1 },
        { id: '1:0', transitionIndex: 1, effectIndex: 0 },
        { id: '1:1', transitionIndex: 1, effectIndex: 1 },
      ],
    })
  })

  it('keeps effect IDs stable when a durable host retries a batch', function*({ expect }) {
    const ids: string[] = []
    const machine = createMachine({
      entry: (_, enq) => enq(() => {}),
    })
    const d = createDurable(machine, {
      executeAction: (_effect, { id }) => {
        ids.push(id)
      },
      waitForEvent: () => ({ type: 'unused' as const }),
    })
    const [, effects] = d.initialTransition(undefined)

    yield* Effect.promise(() => d.executeEffects(effects))
    yield* Effect.promise(() => d.executeEffects(effects))

    yield* expect(ids).toEqual(['0:0', '0:0'])
  })

  it('reconstructs the same IDs during replay', function*({ expect }) {
    const machine = createMachine({
      initial: 'one',
      entry: (_, enq) => enq(() => {}),
      states: {
        one: {
          on: {
            NEXT: (_, enq) => {
              enq(() => {})
              return { target: 'two' }
            },
          },
        },
        two: {},
      },
    })
    const replay = () => {
      const d = createDurable(machine, {
        executeAction: () => {},
        waitForEvent: () => ({ type: 'NEXT' }),
      })
      const [state, initialEffects] = d.initialTransition(undefined)
      const [, nextEffects] = d.transition(state, { type: 'NEXT' })
      return [...initialEffects, ...nextEffects].map(({ id }) => id)
    }

    yield* expect({ first: replay(), again: replay() }).toEqual({
      first: ['0:0', '1:0'],
      again: ['0:0', '1:0'],
    })
  })

  it('delegates timers to the host runtime without awaiting the delay', function*({ expect }) {
    const scheduleTimerCalls: Array<[string, number]> = []
    const seenEffects: unknown[] = []
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 100: { target: 'done' } } },
        done: {},
      },
    })
    const d = createDurable(machine, {
      runtime: (_metadata, effect) => {
        seenEffects.push(effect)
        return {
          scheduleTimer: (_source, id, delay) => {
            scheduleTimerCalls.push([id, delay])
          },
        }
      },
      executeAction: () => {},
      waitForEvent: () => ({ type: 'unused' as const }),
    })
    const [, effects] = d.initialTransition(undefined)

    yield* Effect.promise(() => d.executeEffects(effects))

    yield* expect({
      scheduleTimerCalls,
      seenEffects,
    }).toEqual({
      scheduleTimerCalls: [['xstate.after.100.(machine).waiting', 100]],
      seenEffects: [
        expect.objectContaining({
          type: '@xstate.raise',
          delay: 100,
          event: expect.objectContaining({ type: 'xstate.after' }),
        }),
      ],
    })
  })

  it('fails when the host does not support a required runtime operation', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 100: { target: 'done' } } },
        done: {},
      },
    })
    const d = createDurable(machine, {
      executeAction: () => {},
      waitForEvent: () => ({ type: 'unused' }),
    })
    const [, effects] = d.initialTransition(undefined)

    const failure = yield* Effect.flip(
      Effect.tryPromise({
        try: () => d.executeEffects(effects),
        catch: (error: unknown) => error,
      }),
    )

    yield* expect(failure).toSatisfy(
      (error) => error instanceof TypeError,
      'a TypeError because the host runtime lacks the required operation',
    )
  })

  it('exposes the next transition index for host-managed checkpoints', function*({ expect }) {
    const machine = createMachine({
      on: {
        EFFECT: (_, enq) => enq(() => {}),
      },
    })
    const d = createDurable(machine, {
      transitionIndex: 12,
      executeAction: () => {},
      waitForEvent: () => ({ type: 'unused' }),
    })

    const [state, initialEffects] = d.initialTransition(undefined)
    const checkpoint = d.nextTransitionIndex
    const restored = createDurable(machine, {
      transitionIndex: checkpoint,
      executeAction: () => {},
      waitForEvent: () => ({ type: 'unused' }),
    })
    const [, effects] = restored.transition(state, { type: 'EFFECT' })

    yield* expect({
      initialEffects,
      checkpoint,
      effectId: effects[0]?.id,
      nextTransitionIndex: restored.nextTransitionIndex,
    }).toEqual({
      initialEffects: [],
      checkpoint: 13,
      effectId: '13:0',
      nextTransitionIndex: 14,
    })
  })

  it('rejects an invalid starting transition index', function*({ expect }) {
    const machine = createMachine({})

    const failure = yield* Effect.flip(
      Effect.try({
        try: () =>
          createDurable(machine, {
            transitionIndex: -1,
            executeAction: () => {},
            waitForEvent: () => ({ type: 'unused' }),
          }),
        catch: (error: unknown) => error,
      }),
    )

    yield* expect(failure).toSatisfy(
      (error) =>
        error instanceof RangeError &&
        error.message === 'transitionIndex must be a non-negative safe integer',
      'a RangeError naming the invalid transition index',
    )
  })

  it('rejects run() when configured to resume from a checkpoint', function*({ expect }) {
    const actionCalls: Array<unknown[]> = []
    const action = (...args: unknown[]) => {
      actionCalls.push(args)
    }
    const machine = createMachine({
      entry: (_, enq) => enq(action),
    })
    const durable = createDurable(machine, {
      transitionIndex: 12,
      executeAction: (effect, _metadata, runtime) => effect.exec(runtime),
      waitForEvent: () => ({ type: 'unused' }),
    })

    const failure = yield* Effect.flip(
      Effect.tryPromise({
        try: () => durable.run(undefined),
        catch: (error: unknown) => error,
      }),
    )

    yield* expect({
      errorName: errorNameOf(failure),
      actionCalls,
    }).toEqual({
      errorName: 'DurableExecutionResumeError',
      actionCalls: [],
    })
  })

  it('rejects run() after lower-level transition methods were used', function*({ expect }) {
    const machine = createMachine({})
    const durable = createDurable(machine, {
      executeAction: () => {},
      waitForEvent: () => ({ type: 'unused' }),
    })

    durable.initialTransition(undefined)

    const failure = yield* Effect.flip(
      Effect.tryPromise({
        try: () => durable.run(undefined),
        catch: (error: unknown) => error,
      }),
    )

    yield* expect(errorNameOf(failure)).toBe('DurableExecutionResumeError')
  })

  it('forwards the host runtime to createLogic effects', function*({ expect }) {
    const sendEventCalls: Array<[unknown, unknown, unknown]> = []
    const runtime = {
      sendEvent: (source: unknown, target: unknown, event: unknown) => {
        sendEventCalls.push([source, target, event])
      },
    }
    const providedRuntime: { value: Partial<ActorSystemRuntime> | undefined } = {
      value: undefined,
    }
    const logic = createLogic({
      context: undefined,
      run: ({ event }, enq) => {
        if (event.type === '@xstate.init') {
          enq.effect((effectRuntime) => {
            providedRuntime.value = effectRuntime
          })
        }
      },
    })
    const durable = createDurable(logic, {
      executeAction: (effect, _metadata, effectRuntime) => effect.exec(effectRuntime),
      runtime: () => runtime,
      waitForEvent: () => ({ type: 'unused' }),
    })
    const [, effects] = durable.initialTransition(undefined)

    yield* Effect.promise(() => durable.executeEffects(effects))

    const target = { address: 'elsewhere' } as never
    const event = { type: 'X' }
    const effectRuntime = providedRuntime.value
    if (effectRuntime?.sendEvent === undefined) {
      throw new Error('expected the effect runtime to provide sendEvent')
    }
    yield* Effect.promise(() => Promise.resolve(effectRuntime.sendEvent!(undefined, target, event)))

    yield* expect(sendEventCalls).toEqual([
      [undefined, { address: 'elsewhere' }, { type: 'X' }],
    ])
  })

  it('routes parked root events through the dedicated mailbox hook', function*({ expect }) {
    const enqueueRootEventCalls: Array<[unknown, unknown]> = []
    const providedRuntime: { value: Partial<ActorSystemRuntime> | undefined } = {
      value: undefined,
    }
    const logic = createLogic({
      context: undefined,
      run: ({ event }, enq) => {
        if (event.type === '@xstate.init') {
          enq.effect((effectRuntime) => {
            providedRuntime.value = effectRuntime
          })
        }
      },
    })
    const durable = createDurable(logic, {
      executeAction: (effect, _metadata, effectRuntime) => effect.exec(effectRuntime),
      enqueueRootEvent: (source, event) => {
        enqueueRootEventCalls.push([source, event])
      },
      waitForEvent: () => ({ type: 'unused' }),
    })
    const [, effects] = durable.initialTransition(undefined)
    yield* Effect.promise(() => durable.executeEffects(effects))

    const source = { id: 'child' } as never
    const target = { address: durable.rootAddress } as never
    const event = { type: 'CHILD_EVENT' }
    const effectRuntime = providedRuntime.value
    if (effectRuntime?.sendEvent === undefined) {
      throw new Error('expected the effect runtime to provide sendEvent')
    }
    yield* Effect.promise(() => Promise.resolve(effectRuntime.sendEvent!(source, target, event)))

    yield* expect(enqueueRootEventCalls).toEqual([
      [{ id: 'child' }, { type: 'CHILD_EVENT' }],
    ])
  })

  it('runs to completion and assigns stable IDs to event waits', function*({ expect }) {
    const waits: Array<{ id: string; transitionIndex: number }> = []
    const machine = createMachine({
      output: 42,
      initial: 'active',
      states: {
        active: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const durable = createDurable(machine, {
      executeAction: () => {},
      runtime: () => ({ terminateActor: () => {} }),
      waitForEvent: (metadata) => {
        waits.push(metadata)
        return { type: 'FINISH' }
      },
    })

    const output = yield* Effect.promise(() => durable.run(undefined))

    yield* expect({ output, waits }).toEqual({
      output: 42,
      waits: [{ id: 'event:0', transitionIndex: 0 }],
    })
  })

  it('throws the machine error when execution ends with an error', function*({ expect }) {
    const error = new Error('failed')
    const snapshot: Snapshot<never> = {
      status: 'error',
      output: undefined,
      error,
    }
    const logic: ActorLogic<Snapshot<never>, { type: 'unused' }, undefined> = {
      initialTransition: () => [snapshot, []],
      transition: () => [snapshot, []],
      getInitialSnapshot: () => snapshot,
      getPersistedSnapshot: (value) => value,
    }
    const durable = createDurable(logic, {
      executeAction: () => {},
      runtime: () => ({ terminateActor: () => {} }),
      waitForEvent: () => ({ type: 'unused' as const }),
    })

    const caught = yield* Effect.flip(
      Effect.tryPromise({
        try: () => durable.run(undefined),
        catch: (cause: unknown) => cause,
      }),
    )

    yield* expect(caught).toBe(error)
  })

  it('treats a stopped machine as cancellation', function*({ expect }) {
    const snapshot: Snapshot<never> = {
      status: 'stopped',
      output: undefined,
      error: undefined,
    }
    const logic: ActorLogic<Snapshot<never>, { type: 'unused' }, undefined> = {
      initialTransition: () => [snapshot, []],
      transition: () => [snapshot, []],
      getInitialSnapshot: () => snapshot,
      getPersistedSnapshot: (value) => value,
    }
    const durable = createDurable(logic, {
      executeAction: () => {},
      waitForEvent: () => ({ type: 'unused' as const }),
    })

    const caught = yield* Effect.flip(
      Effect.tryPromise({
        try: () => durable.run(undefined),
        catch: (cause: unknown) => cause,
      }),
    )

    yield* expect(caught).toSatisfy(
      (error) => error instanceof DurableExecutionCancelledError,
      'a DurableExecutionCancelledError because a stopped machine is cancellation',
    )
  })
})
