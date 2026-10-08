import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createAsyncLogic, createCallbackLogic, createLogic } from '../src/actors/index.js'
import {
  type ActorSystemRuntime,
  type AnyActor,
  type AnyActorLogic,
  createActor,
  createMachine,
  type EventFromLogic,
  type ExecutableActionObject,
  executeEffects,
  getInitialMicrosteps,
  getMicrosteps,
  initialTransition,
  transition,
} from '../src/index.js'

class CustomInterpreter<TLogic extends AnyActorLogic> {
  private readonly queue: EventFromLogic<TLogic>[] = []
  private readonly timers = new Map<string, NodeJS.Timeout>()
  readonly runtime: Partial<ActorSystemRuntime>

  constructor(runtime: Partial<ActorSystemRuntime> = {}) {
    this.runtime = {
      sendEvent: (_source, target, event) => {
        if (!target._parent) {
          this.enqueue(event as EventFromLogic<TLogic>)
          return
        }
        target._send(event)
      },
      scheduleTimer: (source, id, delay) => {
        const timeout = setTimeout(() => {
          void this.runtime.sendEvent?.(source, source, {
            type: 'xstate.timer',
            id,
          })
        }, delay)
        this.timers.set(`${source.sessionId}.${id}`, timeout)
      },
      cancelTimer: (source, id) => {
        clearTimeout(this.timers.get(`${source.sessionId}.${id}`))
      },
      spawnActor: (_source, actor) => {
        Object.assign(actor.system, this.runtime)
      },
      startActor: (actor) => {
        actor.start()
      },
      stopActor: (actor) => {
        ;(actor as any)._stop()
      },
      ...runtime,
    }
  }

  async executeEffects(
    effects: Parameters<typeof executeEffects>[0],
  ): Promise<void> {
    for (const effect of effects) {
      await effect.exec(this.runtime)
    }
  }

  enqueue(event: EventFromLogic<TLogic>): void {
    this.queue.push(event)
  }

  dequeue(): EventFromLogic<TLogic> | undefined {
    return this.queue.shift()
  }

  hasEvents(): boolean {
    return this.queue.length > 0
  }
}

describe('custom interpreter runtime', () => {
  it('routes delayed raises back through a custom mailbox', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 10: { target: 'done' } } },
        done: {},
      },
    })
    const timers: Array<() => void> = []
    const interpreter = new CustomInterpreter<typeof machine>({
      scheduleTimer: (source, id) => {
        timers.push(() => {
          void interpreter.runtime.sendEvent?.(source, source, {
            type: 'xstate.timer',
            id,
          })
        })
      },
    })
    let [state, effects] = machine.initialTransition(undefined)
    yield* expect(effects).toSatisfy(
      (all: ReadonlyArray<ExecutableActionObject>) =>
        all.every(
          (effect: ExecutableActionObject) => typeof effect.exec === 'function',
        ),
      'every effect from the initial transition is executable',
    )
    yield* Effect.promise(() => interpreter.executeEffects(effects))

    for (const fire of timers) {
      fire()
    }
    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(state.value).toEqual('done')
  })

  it('executes createLogic startup and termination with the same loop', function*({ expect }) {
    const operations: string[] = []
    const logic = createLogic({
      context: undefined,
      run: ({ event }, enq) => {
        if (event.type === '@xstate.init') {
          enq.effect(() => {
            operations.push('start')
          })
          enq.emit({ type: 'started' })
        }
        if (event.type === 'finish') {
          enq.effect(() => {
            operations.push('finish')
          })
          return { status: 'done' as const, output: 42 }
        }
        return undefined
      },
    })
    const interpreter = new CustomInterpreter<typeof logic>({
      emitEvent: (_source, event) => {
        operations.push(`emit:${event.type}`)
      },
      terminateActor: (_actor, termination) => {
        operations.push(`terminate:${termination.status}`)
      },
    })

    let [state, effects] = initialTransition(logic)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    ;[state, effects] = transition(logic, state, { type: 'finish' })
    yield* Effect.promise(() => interpreter.executeEffects(effects))

    yield* expect({
      state: { status: state.status, output: state.output },
      operations,
    }).toEqual({
      state: { status: 'done', output: 42 },
      operations: ['start', 'emit:started', 'finish', 'terminate:done'],
    })
  })

  it('uses self.system as the default effect runtime', function*({ expect }) {
    let self: AnyActor | undefined
    let runtime: Partial<ActorSystemRuntime> | undefined
    const logic = createLogic({
      context: undefined,
      run: (args, enq) => {
        self = args.self as AnyActor
        enq.effect((providedRuntime) => {
          runtime = providedRuntime
        })
      },
    })
    const [, effects] = initialTransition(logic)

    yield* Effect.promise(() => executeEffects(effects))

    yield* expect(runtime).toBe(self!.system)
  })

  it('preserves an invoked createLogic child reference across pure transitions', function*({ expect }) {
    const child = createLogic({
      context: undefined,
      run: ({ event }, enq) => {
        if (event.type === 'ping') {
          enq.sendBack({ type: 'pong' })
        }
      },
    })
    const parent = createMachine({ invoke: { id: 'worker', src: child } })
    const [parentSnapshot] = initialTransition(parent)
    const childRef = parentSnapshot.children['worker']!
    const [, effects] = transition(child, childRef.getSnapshot(), {
      type: 'ping',
    })
    const deliveries: Array<{
      source: AnyActor
      target: AnyActor
      event: { type: string }
    }> = []

    yield* Effect.promise(() =>
      executeEffects(effects, {
        sendEvent: (source, target, event) => {
          deliveries.push({ source: source!, target, event })
        },
      })
    )

    yield* expect(deliveries).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ id: childRef.id }),
        target: expect.objectContaining({ id: 'x:0' }),
        event: { type: 'pong' },
      }),
    ])
  })

  it('terminates an invoked createLogic child under its logical id', function*({ expect }) {
    const child = createLogic({
      context: undefined,
      run: ({ event }) =>
        event.type === 'finish'
          ? { status: 'done' as const, output: 42 }
          : undefined,
    })
    const parent = createMachine({ invoke: { id: 'worker', src: child } })
    const [parentSnapshot] = initialTransition(parent)
    const childRef = parentSnapshot.children['worker']!
    const [, effects] = transition(child, childRef.getSnapshot(), {
      type: 'finish',
    })
    const terminated: string[] = []

    yield* Effect.promise(() =>
      executeEffects(effects, {
        terminateActor: (actor) => {
          terminated.push(actor.id)
        },
      })
    )

    yield* expect(terminated).toEqual(['worker'])
  })

  it('routes async logic emissions and completion through the runtime', function*({ expect }) {
    const operations: string[] = []
    const logic = createAsyncLogic({
      run: async (_, enq) => {
        enq.emit({ type: 'progress' })
        return 42
      },
    })
    const interpreter = new CustomInterpreter<typeof logic>({
      emitEvent: (_source, event) => {
        operations.push(`emit:${event.type}`)
      },
      terminateActor: (_actor, termination) => {
        operations.push(`terminate:${termination.status}`)
      },
    })

    let [state, effects] = initialTransition(logic)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    yield* Effect.promise(() => Promise.resolve())
    yield* Effect.promise(() => Promise.resolve())

    while (state.status === 'active' && interpreter.hasEvents()) {
      ;[state, effects] = transition(logic, state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect({
      state: { status: state.status, output: state.output },
      operations,
    }).toEqual({
      state: { status: 'done', output: 42 },
      operations: ['emit:progress', 'terminate:done'],
    })
  })

  it('keeps custom actions and arguments explicit', function*({ expect }) {
    const actionCalls: Array<{ value: number }> = []
    const action = (args: { value: number }) => {
      actionCalls.push(args)
    }
    const machine = createMachine({
      entry: (_, enq) => enq(action, { value: 42 }),
    })

    const [, effects] = machine.initialTransition(undefined)
    const [effect] = effects

    yield* expect(effect).toMatchObject({
      kind: 'action',
      action,
      args: [{ value: 42 }],
      exec: expect.any(Function),
    })

    yield* Effect.promise(() => Promise.resolve(effect.exec()))
    yield* expect(actionCalls).toEqual([{ value: 42 }])
  })

  it('serializes reentrant sends in a caller-owned transition loop', function*({ expect }) {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            START: ({ self }, enq) => {
              enq.sendTo(self, { type: 'CONTINUE' })
              return { target: 'second' }
            },
          },
        },
        second: { on: { CONTINUE: { target: 'done' } } },
        done: {},
      },
    })
    const interpreter = new CustomInterpreter<typeof machine>()
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    interpreter.enqueue({ type: 'START' })

    while (state.status === 'active' && interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(state.value).toEqual('done')
  })

  it('routes messages and completion between invoked actors and their parent', function*({ expect }) {
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'child',
            src: child,
            onDone: { target: 'success' },
          },
          on: {
            FINISH_CHILD: ({ children }, enq) => enq.sendTo(children['child'], { type: 'FINISH' }),
          },
        },
        success: {},
      },
    })
    const interpreter = new CustomInterpreter<typeof machine>()
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    interpreter.enqueue({ type: 'FINISH_CHILD' })

    while (state.status === 'active' && interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(state.value).toEqual('success')
  })

  it('surfaces child completion as an ordered termination effect', function*({ expect }) {
    const exit = () => {}
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { exit, on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = createMachine({
      invoke: { id: 'child', src: child },
    })
    const [parentSnapshot] = initialTransition(parent)
    const childRef = parentSnapshot.children['child']!

    const [done, effects] = transition(child, childRef.getSnapshot(), {
      type: 'FINISH',
    })
    const secondTransitionLastEffect = child.transition(childRef.getSnapshot(), {
      type: 'FINISH',
    })[1].at(-1)
    const repeatedEffects = transition(child, done, { type: 'FINISH' })[1]

    yield* expect({
      status: done.status,
      secondLastKind: effects.at(-2)?.kind,
      lastEffect: effects.at(-1),
      secondTransitionLastEffect,
      repeatedHasTerminate: repeatedEffects.some(
        (effect) => effect.type === '@xstate.terminate',
      ),
    }).toEqual({
      status: 'done',
      secondLastKind: 'action',
      lastEffect: expect.objectContaining({
        type: '@xstate.terminate',
        actor: expect.objectContaining({ id: 'child' }),
        status: 'done',
      }),
      secondTransitionLastEffect: expect.objectContaining({
        type: '@xstate.terminate',
        actor: expect.objectContaining({ id: 'child' }),
        status: 'done',
      }),
      repeatedHasTerminate: false,
    })
  })

  it('exposes child completion in the final microstep', function*({ expect }) {
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = createMachine({ invoke: { id: 'child', src: child } })
    const [parentSnapshot] = initialTransition(parent)
    const childSnapshot = parentSnapshot.children['child']!.getSnapshot()

    const microsteps = getMicrosteps(child, childSnapshot, {
      type: 'FINISH',
    })

    yield* expect(microsteps.at(-1)?.[1].at(-1)).toMatchObject({
      type: '@xstate.terminate',
      actor: expect.objectContaining({ id: 'child' }),
      status: 'done',
    })
  })

  it('exposes initial completion in the final initial microstep', function*({ expect }) {
    const machine = createMachine({
      initial: 'done',
      states: { done: { type: 'final' } },
    })

    const [, effects] = initialTransition(machine)
    const microsteps = getInitialMicrosteps(machine)

    yield* expect({
      effect: effects.at(-1),
      microstepLast: microsteps.at(-1)?.[1].at(-1),
    }).toEqual({
      effect: expect.objectContaining({
        type: '@xstate.terminate',
        status: 'done',
      }),
      microstepLast: expect.objectContaining({
        type: '@xstate.terminate',
        status: 'done',
      }),
    })
  })

  it('delegates terminal lifecycle to the runtime in effect order', function*({ expect }) {
    const operations: string[] = []
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          exit: (_, enq) => enq(() => operations.push('exit')),
          on: { FINISH: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    })
    const [active] = initialTransition(machine)
    const [, effects] = transition(machine, active, { type: 'FINISH' })

    yield* Effect.promise(() =>
      executeEffects(effects, {
        terminateActor: (actor, termination) => {
          operations.push(`terminate:${actor.id}:${termination.status}`)
        },
      })
    )

    yield* expect(operations).toEqual(['exit', 'terminate:x:0:done'])
  })

  it('surfaces unhandled actor errors as terminal termination effects', function*({ expect }) {
    const error = new Error('failed')
    const machine = createMachine({})
    const [active] = initialTransition(machine)

    const [failed, effects] = transition(machine, active, {
      type: 'xstate.error.actor.child',
      error,
      actorId: 'child',
    } as any)

    yield* expect({
      status: failed.status,
      error: failed.error,
      lastEffect: effects.at(-1),
    }).toEqual({
      status: 'error',
      error,
      lastEffect: expect.objectContaining({
        type: '@xstate.terminate',
        status: 'error',
        error,
      }),
    })
  })

  it('completes a child before notifying its parent', function*({ expect }) {
    const order: string[] = []
    const child = createMachine({
      initial: 'active',
      states: {
        active: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = createMachine({
      invoke: {
        id: 'child',
        src: child,
        onDone: (_, enq) => enq(() => order.push('parent done')),
      },
    })
    const actor = createActor(parent).start()
    const childRef = actor.getSnapshot().children['child']!
    childRef.subscribe({
      next: (snapshot) => {
        if (snapshot.status === 'done') {
          order.push('child done snapshot')
        }
      },
      complete: () => order.push('child complete'),
    })

    childRef.send({ type: 'FINISH' })

    yield* expect(order).toEqual([
      'child done snapshot',
      'child complete',
      'parent done',
    ])
  })

  it('does not notify an invoked parent twice on child completion', function*({ expect }) {
    const completedCalls: Array<null> = []
    const completed = () => {
      completedCalls.push(null)
    }
    const duplicateCalls: Array<null> = []
    const duplicate = () => {
      duplicateCalls.push(null)
    }
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'child',
            src: child,
            onDone: (_, enq) => {
              enq(completed)
              return { target: 'success' }
            },
          },
        },
        success: {
          on: {
            'xstate.done.actor.child': (_, enq) => {
              enq(duplicate)
            },
          },
        },
      },
    })
    const actor = createActor(parent).start()

    actor.getSnapshot().children['child']!.send({ type: 'FINISH' })

    yield* expect({
      value: actor.getSnapshot().value,
      completedCalls,
      duplicateCalls,
    }).toEqual({ value: 'success', completedCalls: [null], duplicateCalls: [] })
  })

  it('delivers delayed sends through the source timer input', function*({ expect }) {
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { on: { PING: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const machine = createMachine({
      actors: { child },
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'child',
            src: 'child',
            onDone: { target: 'success' },
          },
          on: {
            SEND: ({ children }, enq) => {
              enq.sendTo(
                children['child'],
                { type: 'PING' },
                {
                  id: 'ping',
                  delay: 10,
                },
              )
            },
          },
        },
        success: {},
      },
    })
    const timers: Array<() => void> = []
    const interpreter = new CustomInterpreter<typeof machine>({
      scheduleTimer: (source, id) => {
        timers.push(() => {
          void interpreter.runtime.sendEvent?.(source, source, {
            type: 'xstate.timer',
            id,
          })
        })
      },
    })
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    interpreter.enqueue({ type: 'SEND' })

    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }
    for (const fire of timers) {
      fire()
    }
    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(state.value).toEqual('success')
  })

  it('delegates invoked actor lifecycle to the runtime', function*({ expect }) {
    const operations: string[] = []
    const child = createMachine({})
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: { id: 'child', src: child },
          on: { EXIT: { target: 'inactive' } },
        },
        inactive: {},
      },
    })
    const interpreter = new CustomInterpreter<typeof machine>({
      spawnActor: (_source, actor) => {
        operations.push(`spawn:${actor.id}`)
      },
      startActor: (actor) => {
        operations.push(`start:${actor.id}`)
        actor.start()
      },
      stopActor: (actor) => {
        operations.push(`stop:${actor.id}`)
        ;(actor as any)._stop()
      },
    })
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    interpreter.enqueue({ type: 'EXIT' })
    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(operations).toEqual(['spawn:child', 'start:child', 'stop:child'])
  })

  it('delegates timer scheduling and cancellation to the runtime', function*({ expect }) {
    const operations: Array<{ type: string; id: string | undefined }> = []
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          after: { 1000: { target: 'timedOut' } },
          on: { EXIT: { target: 'exited' } },
        },
        timedOut: {},
        exited: {},
      },
    })
    const interpreter = new CustomInterpreter<typeof machine>({
      scheduleTimer: (_source, id) => {
        operations.push({ type: 'schedule', id })
      },
      cancelTimer: (_source, id) => {
        operations.push({ type: 'cancel', id })
      },
    })
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    interpreter.enqueue({ type: 'EXIT' })
    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    const firstOperation = operations[0]
    const secondOperation = operations[1]
    if (firstOperation === undefined || secondOperation === undefined) {
      throw new Error('expected two timer operations')
    }
    yield* expect({
      types: operations.map(({ type }) => type),
      sameId: secondOperation.id === firstOperation.id,
    }).toEqual({ types: ['schedule', 'cancel'], sameId: true })
  })

  it('routes attached listener events through the custom mailbox', function*({ expect }) {
    const child = createCallbackLogic(({ emit }) => {
      emit({ type: 'READY' })
    })
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          invoke: { id: 'child', src: child },
          entry: ({ children }, enq) => {
            enq.listen(children['child']!, 'READY', () => ({
              type: 'CHILD_READY',
            }))
          },
          on: { CHILD_READY: { target: 'ready' } },
        },
        ready: {},
      },
    })

    const interpreter = new CustomInterpreter<typeof machine>()
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(state.value).toEqual('ready')
  })

  it('uses the same runtime lifecycle for explicitly spawned actors', function*({ expect }) {
    const operations: string[] = []
    const child = createCallbackLogic(() => {})
    const machine = createMachine({
      entry: (_, enq) => {
        enq.spawn(child, { id: 'child' })
      },
      on: {
        STOP_CHILD: ({ children }, enq) => enq.stop(children['child']),
      },
    })
    const interpreter = new CustomInterpreter<typeof machine>({
      spawnActor: (_source, actor) => {
        operations.push(`spawn:${actor.id}`)
      },
      startActor: (actor) => {
        operations.push(`start:${actor.id}`)
        actor.start()
      },
      stopActor: (actor) => {
        operations.push(`stop:${actor.id}`)
        ;(actor as any)._stop()
      },
    })
    let [state, effects] = machine.initialTransition(undefined)
    yield* Effect.promise(() => interpreter.executeEffects(effects))
    interpreter.enqueue({ type: 'STOP_CHILD' })
    while (interpreter.hasEvents()) {
      ;[state, effects] = machine.transition(state, interpreter.dequeue()!)
      yield* Effect.promise(() => interpreter.executeEffects(effects))
    }

    yield* expect(operations).toEqual(['spawn:child', 'start:child', 'stop:child'])
  })

  it('needs no actor scope for machine transition methods', function*({ expect }) {
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { on: { NEXT: { target: 'done' } } },
        done: {},
      },
    })
    const [waiting] = machine.initialTransition(undefined)
    const [done, effects] = machine.transition(waiting, { type: 'NEXT' })

    yield* Effect.promise(() => executeEffects(effects))
    yield* expect(done.value).toEqual('done')
  })

  it('selects the runtime when executing effects', function*({ expect }) {
    const received: string[] = []
    const sendEvent: NonNullable<ActorSystemRuntime['sendEvent']> = (
      _source,
      _target,
      event,
    ) => {
      received.push(event.type)
    }
    const machine = createMachine({
      on: {
        SEND: ({ self }, enq) => enq.sendTo(self, { type: 'NOTICE' }),
      },
    })
    const [initial] = machine.initialTransition(undefined)
    const [, effects] = machine.transition(initial, { type: 'SEND' })

    yield* Effect.promise(() => executeEffects(effects, { sendEvent }))

    yield* expect(received).toEqual(['NOTICE'])
  })

  it('invokes runtime operations with the runtime as this', function*({ expect }) {
    const runtime: Partial<ActorSystemRuntime> & { received: string[] } = {
      received: [],
      sendEvent(_source, _target, event) {
        this.received.push(event.type)
      },
    }
    const machine = createMachine({
      on: {
        SEND: ({ self }, enq) => enq.sendTo(self, { type: 'NOTICE' }),
      },
    })
    const [initial] = machine.initialTransition(undefined)
    const [, effects] = machine.transition(initial, { type: 'SEND' })

    yield* Effect.promise(() => Promise.resolve(effects[0].exec(runtime)))

    yield* expect(runtime.received).toEqual(['NOTICE'])
  })

  it('awaits runtime effects sequentially', function*({ expect }) {
    const operations: string[] = []
    const child = createCallbackLogic(() => {})
    const machine = createMachine({
      invoke: { id: 'child', src: child },
    })
    const [, effects] = machine.initialTransition(undefined)

    yield* Effect.promise(() =>
      executeEffects(effects, {
        spawnActor: async () => {
          await Promise.resolve()
          operations.push('spawn')
        },
        startActor: (actor) => {
          operations.push('start')
          actor.start()
        },
      })
    )

    yield* expect(operations).toEqual(['spawn', 'start'])
  })

  it('uses the same runtime contract in createActor', function*({ expect }) {
    const child = createCallbackLogic(() => {})
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: { id: 'child', src: child },
          on: { EXIT: { target: 'inactive' } },
        },
        inactive: {},
      },
    })
    const actor = createActor(machine)
    const system = actor.system
    const spawnCalls: string[] = []
    const startCalls: string[] = []
    const stopCalls: string[] = []
    const originalSpawn = system.spawnActor.bind(system)
    const originalStart = system.startActor.bind(system)
    const originalStop = system.stopActor.bind(system)
    system.spawnActor = (source, childActor) => {
      spawnCalls.push(childActor.id)
      return originalSpawn(source, childActor)
    }
    system.startActor = (childActor) => {
      startCalls.push(childActor.id)
      return originalStart(childActor)
    }
    system.stopActor = (childActor) => {
      stopCalls.push(childActor.id)
      return originalStop(childActor)
    }

    actor.start()
    actor.send({ type: 'EXIT' })

    yield* expect({ spawn: spawnCalls, start: startCalls, stop: stopCalls }).toEqual({
      spawn: ['child'],
      start: ['child'],
      stop: ['child'],
    })
  })

  it('can execute an existing snapshot transition with another runtime', function*({ expect }) {
    const operations: string[] = []
    const child = createCallbackLogic(() => {})
    const machine = createMachine({
      initial: 'inactive',
      states: {
        inactive: { on: { START: { target: 'active' } } },
        active: { invoke: { id: 'child', src: child } },
      },
    })
    const [inactive] = initialTransition(machine)

    const [, effects] = transition(machine, inactive, { type: 'START' })
    yield* Effect.promise(() =>
      executeEffects(effects, {
        spawnActor: (_source, actor) => {
          operations.push(`spawn:${actor.id}`)
        },
        startActor: (actor) => {
          operations.push(`start:${actor.id}`)
        },
      })
    )

    yield* expect(operations).toEqual(['spawn:child', 'start:child'])
  })

  it('uses the execution runtime to stop an existing child', function*({ expect }) {
    const stopped: string[] = []
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: { id: 'child', src: createCallbackLogic(() => {}) },
          on: { EXIT: { target: 'inactive' } },
        },
        inactive: {},
      },
    })
    const [active] = initialTransition(machine)
    const [, effects] = transition(machine, active, { type: 'EXIT' })

    yield* Effect.promise(() =>
      executeEffects(effects, {
        stopActor: (actor) => {
          stopped.push(actor.id)
        },
      })
    )

    yield* expect(stopped).toEqual(['child'])
  })

  it('awaits asynchronous sends before executing the next effect', function*({ expect }) {
    const operations: string[] = []
    let sending = false
    const observedBeforeSend: boolean[] = []
    const machine = createMachine({
      on: {
        SEND: ({ self }, enq) => {
          enq.sendTo(self, { type: 'FIRST' })
          enq.sendTo(self, { type: 'SECOND' })
        },
      },
    })
    const [snapshot] = machine.initialTransition(undefined)
    const [, effects] = transition(machine, snapshot, { type: 'SEND' })

    yield* Effect.promise(() =>
      executeEffects(effects, {
        sendEvent: async (_source, _target, event) => {
          observedBeforeSend.push(sending)
          sending = true
          await Promise.resolve()
          await Promise.resolve()
          operations.push(event.type)
          sending = false
        },
      })
    )

    yield* expect({ observedBeforeSend, operations }).toEqual({
      observedBeforeSend: [false, false],
      operations: ['FIRST', 'SECOND'],
    })
  })

  it('uses the runtime for effects exposed per microstep', function*({ expect }) {
    const operations: string[] = []
    const machine = createMachine({
      invoke: { id: 'child', src: createCallbackLogic(() => {}) },
    })
    const microsteps = getInitialMicrosteps(machine)
    const runtime: Partial<ActorSystemRuntime> = {
      spawnActor: (_source, actor) => {
        operations.push(`spawn:${actor.id}`)
      },
      startActor: (actor) => {
        operations.push(`start:${actor.id}`)
      },
    }

    for (const [, effects] of microsteps) {
      yield* Effect.promise(() => executeEffects(effects, runtime))
    }

    yield* expect(operations).toEqual(['spawn:child', 'start:child'])
  })

  it('delegates emitted events to the runtime', function*({ expect }) {
    const emitted: string[] = []
    const machine = createMachine({
      on: {
        EMIT: (_, enq) => enq.emit({ type: 'NOTICE' }),
      },
    })
    const [snapshot] = machine.initialTransition(undefined)
    const [, effects] = transition(machine, snapshot, { type: 'EMIT' })

    yield* Effect.promise(() =>
      executeEffects(effects, {
        emitEvent: (_source, event) => {
          emitted.push(event.type)
        },
      })
    )

    yield* expect(emitted).toEqual(['NOTICE'])
  })
})
