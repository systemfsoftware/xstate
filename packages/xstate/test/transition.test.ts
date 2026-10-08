import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { listenerLogic } from '../src/actors/listener.js'
import { subscriptionLogic } from '../src/actors/subscription.js'
import { XSTATE_SPAWN, XSTATE_START, XSTATE_STOP } from '../src/constants.js'
import { createMachineFromCompiledConfig } from '../src/createMachine.js'
import { createDoneActorEvent } from '../src/eventUtils.js'
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createLogic,
  createMachine,
  type EventFrom,
  getInitialMicrosteps,
  getMicrosteps,
  getNextTransitions,
  isBuiltInExecutableAction,
  toPromise,
  transition,
} from '../src/index.js'
import { setInertActorMaterializationObserver } from '../src/inertActorScope.js'
import { getSnapshotActorRef } from '../src/snapshotActorRef.js'
import { initialTransition } from '../src/transition.js'
import type { AnyActor, AnyEventObject, ExecutableActionObject, SpecialExecutableAction } from '../src/types.js'

const isEffect = <T extends SpecialExecutableAction['type']>(type: T) =>
(
  e: ExecutableActionObject,
): e is Extract<SpecialExecutableAction, { type: T }> => isBuiltInExecutableAction(e) && e.type === type

function describeEffects(effects: ExecutableActionObject[]): string[] {
  // Classify each spawned actor exactly once, from its authored-position
  // `@xstate.spawn` effect (which carries `logic`/`input`; listener and
  // subscription actors carry their target actor ref in `input.actor`). Slim
  // `@xstate.start` effects then reuse the label via their `actor` ref.
  const labelByActor = new Map<any, string>()
  for (const e of effects) {
    if (!isBuiltInExecutableAction(e) || e.type !== XSTATE_SPAWN) {
      continue
    }
    const input = e.input as { actor: { id: string } }
    const label = e.logic === listenerLogic
      ? `listen(${input.actor.id})`
      : e.logic === subscriptionLogic
      ? `subscribe(${input.actor.id})`
      : `spawn(${e.id})`
    labelByActor.set(e.actor, label)
  }

  return effects.filter(isBuiltInExecutableAction).flatMap((e) => {
    switch (e.type) {
      case XSTATE_STOP:
        return `stop(${e.actor.id})`
      case XSTATE_SPAWN:
        return labelByActor.get(e.actor)!
      case XSTATE_START: {
        const label = labelByActor.get(e.actor)
        if (label) {
          return label.startsWith('spawn(')
            ? `start(${e.id})`
            : `start:${label}`
        }
        // No spawn record in this effects array; classify attached actors by
        // logic identity (target id unknown), else a plain child start.
        // These casts are permanent: `logic` lives on the Actor class, not the
        // public `AnyActor` interface carried by the effect.
        if ((e.actor as any).logic === listenerLogic) {
          return `start:listen(${e.actor.id})`
        }
        if ((e.actor as any).logic === subscriptionLogic) {
          return `start:subscribe(${e.actor.id})`
        }
        return `start(${e.id})`
      }
      default:
        return []
    }
  })
}

describe('transition function', () => {
  it('does not materialize actors or systems for context-only planning', function*({ expect }) {
    let materializations = 0
    setInertActorMaterializationObserver(() => materializations++)
    try {
      const machine = createMachine({
        context: { count: 0 },
        on: {
          INCREMENT: ({ context }) => ({
            context: { count: context.count + 1 },
          }),
        },
      })

      let [snapshot] = initialTransition(machine)
      for (let index = 0; index < 100; index++) {
        ;[snapshot] = transition(machine, snapshot, { type: 'INCREMENT' })
      }

      const contextOnlyCount = snapshot.context.count
      const contextOnlyMaterializations = materializations

      const checkingMachine = createMachine({
        context: { found: false },
        on: {
          CHECK: ({ system }) => ({
            context: { found: !!system.get('missing') },
          }),
        },
      })
      let [checkingSnapshot] = initialTransition(checkingMachine)
      for (let index = 0; index < 100; index++) {
        ;[checkingSnapshot] = transition(checkingMachine, checkingSnapshot, {
          type: 'UNKNOWN',
        })
      }
      ;[checkingSnapshot] = transition(checkingMachine, checkingSnapshot, {
        type: 'CHECK',
      })

      const systemLookupFound = checkingSnapshot.context.found
      const systemLookupMaterializations = materializations

      materializations = 0
      const livePlanningMachine = createMachine({
        context: { count: 0 },
        on: {
          INCREMENT: ({ context }) => ({
            context: { count: context.count + 1 },
          }),
        },
      })
      const liveActor = createActor(livePlanningMachine).start()
      transition(livePlanningMachine, liveActor.getSnapshot(), {
        type: 'INCREMENT',
      })
      const livePlanningMaterializations = materializations

      const entryMachine = createMachine({
        context: { count: 0 },
        entry: ({ context }) => ({ context }),
      })
      initialTransition(entryMachine)
      const entryMaterializations = materializations

      yield* expect({
        contextOnlyCount,
        contextOnlyMaterializations,
        systemLookupFound,
        systemLookupMaterializations,
        livePlanningMaterializations,
        entryMaterializations,
      }).toEqual({
        contextOnlyCount: 100,
        contextOnlyMaterializations: 0,
        systemLookupFound: false,
        systemLookupMaterializations: 2,
        livePlanningMaterializations: 0,
        entryMaterializations: 0,
      })
    } finally {
      setInertActorMaterializationObserver(undefined)
    }
  })

  it('preserves callback argument surfaces while planning lazily', function*({ expect }) {
    let contextKeys: string[] = []
    let guardKeys: string[] = []
    // Object-form guards are only produced by compiled configs.
    const machine = createMachineFromCompiledConfig({
      context: (args: any) => {
        contextKeys = Object.keys(args).sort()
        return { initialized: true }
      },
      on: {
        CHECK: {
          guard: (args: any) => {
            guardKeys = Object.keys(args).sort()
            return true
          },
        },
      },
    } as any)

    const [snapshot] = initialTransition(machine)
    transition(machine, snapshot, { type: 'CHECK' })

    yield* expect({ contextKeys, guardKeys }).toEqual({
      contextKeys: ['actors', 'input', 'self', 'spawn'],
      guardKeys: [
        '_snapshot',
        'actions',
        'actors',
        'children',
        'context',
        'delays',
        'event',
        'guards',
        'output',
        'parent',
        'self',
      ],
    })
  })

  it('keeps materialized pure scopes effect-free', function*({ expect }) {
    let deferred = false
    let executed = false
    const snapshot = {
      status: 'active',
      output: undefined,
      error: undefined,
    }
    const logic = {
      initialTransition: (_input: unknown, actorScope: any) => {
        actorScope.defer(() => (deferred = true))
        actorScope.actionExecutor({ exec: () => (executed = true) })
        return [snapshot, []]
      },
      transition: () => [snapshot, []],
      getInitialSnapshot: () => snapshot,
      getPersistedSnapshot: (value: unknown) => value,
    } as any

    initialTransition(logic)

    yield* expect({ deferred, executed }).toEqual({
      deferred: false,
      executed: false,
    })
  })

  it('does not repeatedly resolve a selected transition during a microstep', function*({ expect }) {
    const updateArgs: Array<{ context: { count: number } }> = []
    const update = ({ context }: { context: { count: number } }) => {
      updateArgs.push({ context })
      return {
        context: { count: context.count + 1 },
      }
    }
    const machine = createMachine({
      context: { count: 0 },
      on: { UPDATE: update },
    })
    const actor = createActor(machine).start()

    updateArgs.length = 0
    actor.send({ type: 'UPDATE' })

    yield* expect({
      updateArgs,
      context: actor.getSnapshot().context,
    }).toEqual({
      updateArgs: [{ context: { count: 0 } }],
      context: { count: 1 },
    })
  })

  it('resolves a selected transition with the real parent', function*({ expect }) {
    const childMachine = createMachine({
      context: { parent: undefined as unknown },
      on: {
        CHECK: ({ parent }) => ({ context: { parent } }),
      },
    })
    const parent = createActor(
      createMachine({
        invoke: { id: 'child', src: childMachine },
      }),
    ).start()
    const child = parent.getSnapshot().children['child']!

    child.send({ type: 'CHECK' })

    yield* expect(child.getSnapshot().context.parent).toBe(parent)
  })

  it('resolves a root transition with an undefined parent', function*({ expect }) {
    const machine = createMachine({
      context: { hasParent: true },
      on: {
        CHECK: ({ parent }) => ({ context: { hasParent: !!parent } }),
      },
    })
    const actor = createActor(machine).start()

    actor.send({ type: 'CHECK' })

    yield* expect(actor.getSnapshot().context).toEqual({ hasParent: false })
  })

  it('does not send to the parent during transition selection', function*({ expect }) {
    const childMachine = createMachine({
      on: {
        CHECK: ({ parent }) => {
          parent?.send({ type: 'CHILD' })
          return {}
        },
      },
    })
    const parent = createActor(
      createMachine({
        context: { received: 0 },
        on: {
          CHILD: ({ context }) => ({
            context: { received: context.received + 1 },
          }),
        },
        invoke: { id: 'child', src: childMachine },
      }),
    ).start()

    parent.getSnapshot().children['child']!.send({ type: 'CHECK' })

    yield* expect(parent.getSnapshot().context.received).toBe(1)
  })

  it('resolves mapper context on object transitions', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          value: z.number(),
        }),
        events: {
          GO: z.object({
            value: z.number(),
          }),
        },
      },
      context: { value: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: {
              target: 'done',
              context: ({ event }) => ({ value: event.value }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => context.value,
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'GO', value: 42 })

    yield* expect(actor.getSnapshot().context.value).toBe(42)
  })

  it('resolves mapper context on invoke onDone object transitions', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          value: z.number(),
        }),
      },
      context: { value: 0 },
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createAsyncLogic({
              run: () => Promise.resolve(42),
            }),
            onDone: {
              target: 'done',
              context: ({ output }) => ({ value: output }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => context.value,
        },
      },
    })

    const actor = createActor(machine).start()

    yield* Effect.promise(() => toPromise(actor))

    yield* expect(actor.getSnapshot().context.value).toBe(42)
  })

  it('should capture actions', function*({ expect }) {
    const actionWithParamsCalls: string[] = []
    const actionWithParams = (_params: { a: number }) => {
      actionWithParamsCalls.push('actionWithParams')
    }
    const actionWithDynamicParamsCalls: string[] = []
    const actionWithDynamicParams = (_params: { msg: string }) => {
      actionWithDynamicParamsCalls.push('actionWithDynamicParams')
    }
    const stringActionCalls: string[] = []
    const stringAction = () => {
      stringActionCalls.push('stringAction')
    }

    // const machine = setup({
    //   types: {
    //     context: {} as { count: number },
    //     events: {} as { type: 'event'; msg: string }
    //   },
    //   actions: {
    //     actionWithParams,
    //     actionWithDynamicParams: (_, params: { msg: string }) => {
    //       actionWithDynamicParams(params);
    //     },
    //     stringAction
    //   }
    // }).
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        events: {
          event: z.object({ msg: z.string() }),
          stringAction: z.object({}),
        },
      },
      entry: (_, enq) => {
        enq(actionWithParams, { a: 1 })
        enq(stringAction)
        return {
          context: { count: 100 },
        }
      },
      context: { count: 0 },
      on: {
        // event: {
        //   actions: {
        //     type: 'actionWithDynamicParams',
        //     params: ({ event }) => {
        //       return { msg: event.msg };
        //     }
        //   }
        // }
        event: ({ event }, enq) => {
          enq(actionWithDynamicParams, { msg: event.msg })
        },
      },
    })

    const [state0, actions0] = initialTransition(machine)

    const entryContextCount = state0.context.count
    const entryActions = actions0

    const [state1, actions1] = transition(machine, state0, {
      type: 'event',
      msg: 'hello',
    })

    yield* expect({
      entryContextCount,
      entryActions,
      actionWithParamsCalls,
      stringActionCalls,
      eventContextCount: state1.context.count,
      eventActions: actions1,
      actionWithDynamicParamsCalls,
    }).toEqual({
      entryContextCount: 100,
      entryActions: [
        expect.objectContaining({ args: [{ a: 1 }] }),
        expect.objectContaining({}),
      ],
      actionWithParamsCalls: [],
      stringActionCalls: [],
      eventContextCount: 100,
      eventActions: [
        expect.objectContaining({
          args: [{ msg: 'hello' }],
        }),
      ],
      actionWithDynamicParamsCalls: [],
    })
  })

  it('should not execute a referenced serialized action', function*({ expect }) {
    const fooCalls: string[] = []
    const foo = () => {
      fooCalls.push('foo')
    }

    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      actions: {
        foo,
      },
      entry: ({ actions }, enq) => enq(actions.foo),
      context: { count: 0 },
    })

    const [, actions] = initialTransition(machine)

    yield* expect(fooCalls).toEqual([])
  })

  it('should capture enqueued actions', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        enq.emit({ type: 'stringAction' })
        enq.emit({ type: 'objectAction' })
      },
    })

    const [_state, actions] = initialTransition(machine)

    yield* expect(actions).toEqual([
      expect.objectContaining({ type: 'stringAction' }),
      expect.objectContaining({ type: 'objectAction' }),
    ])
  })

  it('delayed raise actions should be returned', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          entry: (_, enq) => {
            enq.raise({ type: 'NEXT' }, { delay: 10 })
          },
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {},
      },
    })

    const [state, actions] = initialTransition(machine)

    yield* expect({ value: state.value, firstAction: actions[0] }).toEqual({
      value: 'a',
      firstAction: expect.objectContaining({
        type: '@xstate.raise',
        event: { type: 'NEXT' },
        delay: 10,
      }),
    })
  })

  it('raise actions related to delayed transitions should be returned', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          after: { 10: { target: 'b' } },
        },
        b: {},
      },
    })

    const [state, actions] = initialTransition(machine)

    yield* expect({ value: state.value, firstAction: actions[0] }).toEqual({
      value: 'a',
      firstAction: expect.objectContaining({
        type: '@xstate.raise',
        args: [
          expect.any(Object),
          { type: 'xstate.after', delay: 10, stateId: '(machine).a' },
          expect.objectContaining({
            delay: 10,
            id: 'xstate.after.10.(machine).a',
          }),
        ],
      }),
    })
  })

  it('cancel action should be returned', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          entry: (_, enq) => {
            enq.raise({ type: 'NEXT' }, { delay: 10, id: 'myRaise' })
          },
          on: {
            NEXT: (_, enq) => {
              enq.cancel('myRaise')
              return { target: 'b' }
            },
          },
        },
        b: {},
      },
    })

    const [state] = initialTransition(machine)

    const stateValue = state.value

    const [, actions] = transition(machine, state, { type: 'NEXT' })

    yield* expect({ value: stateValue, actions }).toEqual({
      value: 'a',
      actions: expect.arrayContaining([
        expect.objectContaining({
          type: '@xstate.cancel',
          // params: expect.objectContaining({
          //   sendId: 'myRaise'
          // })
          args: [expect.any(Object), 'myRaise'],
        }),
      ]),
    })
  })

  it('sendTo action should be returned', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      invoke: {
        src: createMachine({}),
        id: 'someActor',
      },
      states: {
        a: {
          on: {
            NEXT: ({ children }, enq) => {
              enq.sendTo(children['someActor'], { type: 'someEvent' })
            },
          },
        },
      },
    })

    const [state, actions0] = initialTransition(machine)

    const stateValue = state.value

    const [, actions] = transition(machine, state, { type: 'NEXT' })

    yield* expect({
      value: stateValue,
      initialActions: actions0,
      nextActions: actions,
    }).toEqual({
      value: 'a',
      initialActions: expect.arrayContaining([
        expect.objectContaining({
          type: '@xstate.start',
          args: [state.children['someActor']],
        }),
      ]),
      nextActions: expect.arrayContaining([
        expect.objectContaining({
          type: '@xstate.sendTo',
        }),
      ]),
    })
  })

  it('enq.raise with a string event throws in a transition function', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: (_, enq) => {
              enq.raise(
                // @ts-expect-error only event objects are allowed
                'a string',
              )
            },
          },
        },
      },
    })

    const [state] = initialTransition(machine)

    yield* expect(() => transition(machine, state, { type: 'NEXT' })).toThrowError(
      'Only event objects may be used with raise; use raise({ type: "a string" }) instead',
    )
  })

  it(
    'enq.sendTo with an undefined actor does not return a sendTo action from a transition function',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: ({ children }, enq) => {
                enq.sendTo(children['missing'], { type: 'someEvent' })
              },
            },
          },
        },
      })

      const [state] = initialTransition(machine)
      const [nextState, actions] = transition(machine, state, { type: 'NEXT' })

      yield* expect({
        sendToActions: actions.filter(isEffect('@xstate.sendTo')),
        status: nextState.status,
      }).toEqual({
        sendToActions: [],
        status: 'active',
      })
    },
  )

  it('enq.spawn creates and starts a child once from a transition function', function*({ expect }) {
    let childConstructions = 0
    const childMachine = createMachine({
      schemas: {
        context: z.object({
          n: z.number(),
        }),
      },
      context: () => {
        childConstructions++
        return { n: 0 }
      },
      on: {
        ping: ({ context }) => ({
          context: { n: context.n + 1 },
        }),
      },
    })

    const parentMachine = createMachine({
      on: {
        SPAWN: (_, enq) => {
          enq.spawn(childMachine, { registryKey: 'child' })
        },
      },
    })

    const actor = createActor(parentMachine).start()

    let spawnThrew: unknown = null
    try {
      actor.send({ type: 'SPAWN' })
    } catch (error) {
      spawnThrew = error
    }

    const child = actor.system.get('child')!
    child.send({ type: 'ping' })

    yield* expect({
      spawnThrew,
      childConstructions,
      childContext: child.getSnapshot().context,
    }).toEqual({
      spawnThrew: null,
      childConstructions: 1,
      childContext: { n: 1 },
    })
  })

  it('keeps one child ref before and after its spawn effect executes', function*({ expect }) {
    const childLogic = createCallbackLogic(() => {})
    const machine = createMachine({
      entry: (_, enq) => {
        enq.spawn(childLogic, { id: 'child', registryKey: 'child' })
      },
    })
    const actor = createActor(machine)
    const child = actor.getSnapshot().children['child']
    if (child === undefined) throw new Error('expected a child')

    const systemChildBeforeStart = actor.system.get('child')

    actor.start()

    yield* expect({
      systemChildBeforeStartIsChild: systemChildBeforeStart === child,
      snapshotChildIsChild: actor.getSnapshot().children['child'] === child,
      systemChildIsChild: actor.system.get('child') === child,
      childStatus: child.getSnapshot().status,
    }).toEqual({
      systemChildBeforeStartIsChild: true,
      snapshotChildIsChild: true,
      systemChildIsChild: true,
      childStatus: 'active',
    })
  })

  it('uses the snapshot child ref as self after start', function*({ expect }) {
    let entrySelf: AnyActor | undefined
    let transitionSelf: AnyActor | undefined
    const childLogic = createMachine({
      entry: ({ self }, enq) => enq(() => (entrySelf = self)),
      on: {
        PING: ({ self }, enq) => enq(() => (transitionSelf = self)),
      },
    })
    const machine = createMachine({
      invoke: { id: 'child', src: childLogic },
    })
    const actor = createActor(machine).start()
    const child = actor.getSnapshot().children['child']
    if (child === undefined) throw new Error('expected a child')

    child.send({ type: 'PING' })

    yield* expect({
      entrySelfIsChild: entrySelf === child,
      transitionSelfIsChild: transitionSelf === child,
    }).toEqual({
      entrySelfIsChild: true,
      transitionSelfIsChild: true,
    })
  })

  it('uses the same system on child self during initialization', function*({ expect }) {
    let initializationSystems:
      | { selfSystem: unknown; system: unknown }
      | undefined
    const childLogic = createMachine({
      entry: ({ self, system }, enq) =>
        enq(() => {
          initializationSystems = { selfSystem: self.system, system }
        }),
    })
    const machine = createMachine({
      invoke: { id: 'child', src: childLogic },
    })

    createActor(machine).start()

    if (initializationSystems === undefined) {
      throw new Error('expected the entry effect to run')
    }
    yield* expect(initializationSystems.selfSystem).toBe(
      initializationSystems.system,
    )
  })

  it('uses the same system on a runtime self', function*({ expect }) {
    let runtimeSystems: { selfSystem: unknown; system: unknown } | undefined
    const machine = createMachine({
      entry: ({ self, system }, enq) =>
        enq(() => {
          runtimeSystems = { selfSystem: self.system, system }
        }),
    })

    createActor(machine).start()

    if (runtimeSystems === undefined) {
      throw new Error('expected the entry effect to run')
    }
    yield* expect(runtimeSystems.selfSystem).toBe(runtimeSystems.system)
  })

  it('built-in action effects expose public metadata fields', function*({ expect }) {
    const childMachine = createMachine({})
    const machine = createMachine({
      initial: 'a',
      invoke: {
        src: childMachine,
        id: 'child',
        input: () => ({ kind: 'invoke' }),
      },
      states: {
        a: {
          on: {
            NEXT: ({ children }, enq) => {
              enq.spawn(childMachine, {
                id: 'spawned',
                input: { kind: 'spawn' },
              })
              enq.raise({ type: 'later' }, { id: 'raise-id', delay: 10 })
              enq.sendTo(
                children['child'],
                { type: 'ping' },
                { id: 'send-id', delay: 20 },
              )
              enq.cancel('raise-id')
              enq.stop(children['child'])
            },
          },
        },
      },
    })

    const [state, initialActions] = initialTransition(machine)

    // Full metadata now lives on the authored-position `@xstate.spawn` effect.
    const invokeSpawn = initialActions.find(isEffect(XSTATE_SPAWN))!
    const invokeStart = initialActions.find(isEffect(XSTATE_START))!

    const [, actions] = transition(machine, state, { type: 'NEXT' })

    const spawnedSpawn = actions
      .filter(isEffect(XSTATE_SPAWN))
      .find((action) => action.id === 'spawned')!
    const spawnedStart = actions
      .filter(isEffect(XSTATE_START))
      .find((action) => action.id === 'spawned')!
    const sendAction = actions.find(isEffect('@xstate.sendTo'))!
    const stopAction = actions.find(isEffect(XSTATE_STOP))!

    yield* expect({
      invokeSpawnActorIsFirstArg: invokeSpawn.actor === invokeSpawn.args[0],
      invokeSpawnId: invokeSpawn.id,
      invokeSpawnLogic: invokeSpawn.logic,
      invokeSpawnSrcIsActorSrc: invokeSpawn.src === invokeSpawn.actor.src,
      invokeSpawnInput: invokeSpawn.input,
      invokeStartType: invokeStart.type,
      invokeStartActorIsFirstArg: invokeStart.actor === invokeStart.args[0],
      invokeStartId: invokeStart.id,
      spawnedSpawnId: spawnedSpawn.id,
      spawnedSpawnActorIsFirstArg: spawnedSpawn.actor === spawnedSpawn.args[0],
      spawnedSpawnLogic: spawnedSpawn.logic,
      spawnedSpawnSrc: spawnedSpawn.src,
      spawnedSpawnInput: spawnedSpawn.input,
      spawnedStartType: spawnedStart.type,
      spawnedStartId: spawnedStart.id,
      spawnedStartActorIsFirstArg: spawnedStart.actor === spawnedStart.args[0],
      raise: actions.find((action) => action.type === '@xstate.raise'),
      send: sendAction,
      sendTargetIsChild: sendAction.target === state.children['child'],
      cancel: actions.find((action) => action.type === '@xstate.cancel'),
      stopType: stopAction.type,
      stopActorIsChild: stopAction.actor === state.children['child'],
      stopId: stopAction.id,
    }).toEqual({
      invokeSpawnActorIsFirstArg: true,
      invokeSpawnId: 'child',
      invokeSpawnLogic: childMachine,
      invokeSpawnSrcIsActorSrc: true,
      invokeSpawnInput: { kind: 'invoke' },
      invokeStartType: '@xstate.start',
      invokeStartActorIsFirstArg: true,
      invokeStartId: 'child',
      spawnedSpawnId: 'spawned',
      spawnedSpawnActorIsFirstArg: true,
      spawnedSpawnLogic: childMachine,
      spawnedSpawnSrc: childMachine,
      spawnedSpawnInput: { kind: 'spawn' },
      spawnedStartType: '@xstate.start',
      spawnedStartId: 'spawned',
      spawnedStartActorIsFirstArg: true,
      raise: expect.objectContaining({
        type: '@xstate.raise',
        event: { type: 'later' },
        id: 'raise-id',
        delay: 10,
      }),
      send: expect.objectContaining({
        type: '@xstate.sendTo',
        event: { type: 'ping' },
        id: 'send-id',
        delay: 20,
      }),
      sendTargetIsChild: true,
      cancel: expect.objectContaining({
        type: '@xstate.cancel',
        id: 'raise-id',
      }),
      stopType: '@xstate.stop',
      stopActorIsChild: true,
      stopId: 'child',
    })
  })

  describe('invoke stop effects', () => {
    const listener = createCallbackLogic(() => {})

    it('returns an @xstate.stop effect when an invoking state exits', function*({ expect }) {
      const machine = createMachine({
        id: 'player',
        initial: 'mini',
        states: {
          mini: { on: { toggle: { target: 'full' } } },
          full: {
            invoke: { id: 'keyEscape', src: listener },
            on: { 'key.escape': { target: 'mini' } },
          },
        },
      })

      const [initial] = initialTransition(machine)
      const [full] = transition(machine, initial, { type: 'toggle' })
      const child = full.children['keyEscape']
      const [mini, effects] = transition(machine, full, {
        type: 'key.escape',
      })

      yield* expect({
        children: mini.children,
        stopEffects: effects.filter(isEffect(XSTATE_STOP)),
      }).toEqual({
        children: {},
        stopEffects: [
          expect.objectContaining({
            type: XSTATE_STOP,
            actor: child,
            id: 'keyEscape',
            args: [expect.any(Object), child],
          }),
        ],
      })
    })

    it('orders an invoke stop after its exit action', function*({ expect }) {
      function exitAction() {}
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: listener },
            exit: (_, enq) => enq(exitAction),
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })

      yield* expect(effects.map((effect) => effect.type)).toEqual([
        'exitAction',
        XSTATE_STOP,
      ])
    })

    it('preserves one-argument exit actions before an invoke stop', function*({ expect }) {
      function exitAction(_: unknown) {}
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: listener },
            exit: exitAction,
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })

      const firstEffect = effects[0]
      if (firstEffect === undefined) throw new Error('expected a first effect')
      yield* expect({
        effectCount: effects.length,
        firstIsNotStop: firstEffect.type !== XSTATE_STOP,
        secondEffect: effects[1],
      }).toEqual({
        effectCount: 2,
        firstIsNotStop: true,
        secondEffect: expect.objectContaining({
          type: XSTATE_STOP,
          id: 'child',
        }),
      })
    })

    it('orders after cancellation before the invoke stop', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: listener },
            after: { 1000: { target: 'inactive' } },
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })
      const lifecycleEffects = effects.filter(
        (effect) => effect.type === '@xstate.cancel' || effect.type === XSTATE_STOP,
      )

      yield* expect(lifecycleEffects).toEqual([
        expect.objectContaining({
          type: '@xstate.cancel',
          id: 'xstate.after.1000.(machine).active',
        }),
        expect.objectContaining({ type: XSTATE_STOP, id: 'child' }),
      ])
    })

    it('stops invokes in reverse state document order on parallel exit', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            type: 'parallel',
            on: { EXIT: { target: 'inactive' } },
            states: {
              left: { invoke: { id: 'left', src: listener } },
              right: { invoke: { id: 'right', src: listener } },
            },
          },
          inactive: {},
        },
      })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })

      yield* expect(
        effects.filter(isEffect(XSTATE_STOP)).map((effect) => effect.id),
      ).toEqual(['right', 'left'])
    })

    it('stops multiple invokes in their declaration order', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: [
              { id: 'first', src: listener },
              { id: 'second', src: listener },
            ],
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })

      yield* expect(
        effects.filter(isEffect(XSTATE_STOP)).map((effect) => effect.id),
      ).toEqual(['first', 'second'])
    })

    it('stops nested invokes from child state to parent state', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'parent', src: listener },
            initial: 'child',
            states: {
              child: { invoke: { id: 'child', src: listener } },
            },
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })

      yield* expect(
        effects.filter(isEffect(XSTATE_STOP)).map((effect) => effect.id),
      ).toEqual(['child', 'parent'])
    })

    it('stops remaining children when the machine reaches a final state', function*({ expect }) {
      const machine = createMachine({
        invoke: { id: 'rootChild', src: listener },
        initial: 'active',
        states: {
          active: { on: { FINISH: { target: 'done' } } },
          done: { type: 'final' },
        },
      })

      const [active] = initialTransition(machine)
      const [done, effects] = transition(machine, active, { type: 'FINISH' })

      yield* expect({
        status: done.status,
        children: done.children,
        stoppedIds: effects
          .filter(isEffect(XSTATE_STOP))
          .map((effect) => effect.id),
      }).toEqual({
        status: 'done',
        children: {},
        stoppedIds: ['rootChild'],
      })
    })

    it('stops spawned children after root exit actions on machine completion', function*({ expect }) {
      const order: string[] = []
      const child = createCallbackLogic(() => () => order.push('stop'))
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
        exit: (_, enq) => enq(() => order.push('exit')),
        initial: 'active',
        states: {
          active: { on: { FINISH: { target: 'done' } } },
          done: { type: 'final' },
        },
      })
      const actor = createActor(machine).start()

      actor.send({ type: 'FINISH' })

      yield* expect(order).toEqual(['exit', 'stop'])
    })

    it('reports every removed child id with a stop effect', function*({ expect }) {
      const machine = createMachine({
        initial: 'first',
        states: {
          first: {
            invoke: { id: 'firstChild', src: listener },
            on: { NEXT: { target: 'second' } },
          },
          second: {
            invoke: { id: 'secondChild', src: listener },
            on: { FINISH: { target: 'done' } },
          },
          done: { type: 'final' },
        },
      })

      const [first] = initialTransition(machine)
      const [second, nextEffects] = transition(machine, first, {
        type: 'NEXT',
      })
      const [done, finishEffects] = transition(machine, second, {
        type: 'FINISH',
      })

      const reports: Array<{ removedIds: string[]; stoppedIds: string[] }> = []
      for (
        const [previous, next, effects] of [
          [first, second, nextEffects],
          [second, done, finishEffects],
        ] as const
      ) {
        const removedIds = Object.keys(previous.children).filter(
          (id) => !(id in next.children),
        )
        const stoppedIds = effects
          .filter(isEffect(XSTATE_STOP))
          .map((effect) => effect.id)

        reports.push({ removedIds, stoppedIds })
      }

      yield* expect(reports).toEqual([
        { removedIds: ['firstChild'], stoppedIds: ['firstChild'] },
        { removedIds: ['secondChild'], stoppedIds: ['secondChild'] },
      ])
    })

    it('exposes stops in getMicrosteps and getInitialMicrosteps', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: listener },
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })
      const [active] = initialTransition(machine)
      const microsteps = getMicrosteps(machine, active, { type: 'EXIT' })
      const [, transitionEffects] = transition(machine, active, {
        type: 'EXIT',
      })

      const firstStep = microsteps[0]
      const firstStepEffects = firstStep?.[1]
      if (firstStepEffects === undefined) {
        throw new Error('expected first step effects')
      }

      const initialMachine = createMachine({
        initial: 'transient',
        states: {
          transient: {
            invoke: { id: 'initialChild', src: listener },
            always: { target: 'settled' },
          },
          settled: {},
        },
      })
      const initialMicrosteps = getInitialMicrosteps(initialMachine)
      const [, initialEffects] = initialTransition(initialMachine)

      const secondStep = initialMicrosteps[1]
      const secondStepEffects = secondStep?.[1]
      if (secondStepEffects === undefined) {
        throw new Error('expected second step effects')
      }

      yield* expect({
        microstepCount: microsteps.length,
        firstStepStoppedIds: firstStepEffects
          .filter(isEffect(XSTATE_STOP))
          .map((effect) => effect.id),
        transitionStoppedIds: transitionEffects
          .filter(isEffect(XSTATE_STOP))
          .map((effect) => effect.id),
        initialMicrostepCount: initialMicrosteps.length,
        secondStepStoppedIds: secondStepEffects
          .filter(isEffect(XSTATE_STOP))
          .map((effect) => effect.id),
        initialStoppedIds: initialEffects
          .filter(isEffect(XSTATE_STOP))
          .map((effect) => effect.id),
      }).toEqual({
        microstepCount: 1,
        firstStepStoppedIds: ['child'],
        transitionStoppedIds: ['child'],
        initialMicrostepCount: 2,
        secondStepStoppedIds: ['initialChild'],
        initialStoppedIds: ['initialChild'],
      })
    })

    it('createActor executes an invoke stop exactly once after exit actions', function*({ expect }) {
      const order: string[] = []
      const disposeCalls: string[] = []
      const dispose = () => {
        disposeCalls.push('stop')
        order.push('stop')
      }
      const childLogic = createCallbackLogic(() => dispose)
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: childLogic },
            exit: (_, enq) => enq(() => order.push('exit')),
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })
      const actor = createActor(machine).start()

      actor.send({ type: 'EXIT' })

      yield* expect({
        order,
        disposeCallCount: disposeCalls.length,
      }).toEqual({
        order: ['exit', 'stop'],
        disposeCallCount: 1,
      })
    })

    it('does not let an actor stop itself through enq.stop()', function*({ expect }) {
      const errors: unknown[] = []
      const machine = createMachine({
        on: {
          STOP_SELF: ({ self }, enq) => enq.stop(self),
        },
      })
      const actor = createActor(machine)
      actor.subscribe({ error: (err) => errors.push(err) })
      actor.start()

      actor.send({ type: 'STOP_SELF' })

      yield* expect(errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining('because it is not a child'),
        }),
      ])
    })

    it('explicit enq.stop removes and stops a child exactly once', function*({ expect }) {
      const disposeCalls: unknown[] = []
      const dispose = () => {
        disposeCalls.push(undefined)
      }
      const childLogic = createCallbackLogic(() => dispose)
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(childLogic, { id: 'child' }),
        on: {
          STOP: ({ children }, enq) => enq.stop(children['child']),
        },
      })
      const [active, initialEffects] = initialTransition(machine)
      initialEffects.forEach((effect) => void effect.exec())
      const child = active.children['child']
      if (child === undefined) throw new Error('expected a child')

      const [stopped, effects] = transition(machine, active, { type: 'STOP' })

      const stoppedChildren = stopped.children
      const stopEffects = effects.filter(isEffect(XSTATE_STOP))
      effects.forEach((effect) => void effect.exec())

      yield* expect({
        stoppedChildren,
        stopEffects,
        disposeCalls,
      }).toEqual({
        stoppedChildren: {},
        stopEffects: [expect.objectContaining({ actor: child, id: 'child' })],
        disposeCalls: [undefined],
      })
    })

    it('does not duplicate invoke auto-stop after an explicit exit stop', function*({ expect }) {
      const disposeCalls: unknown[] = []
      const dispose = () => {
        disposeCalls.push(undefined)
      }
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'child',
              src: createCallbackLogic(() => dispose),
            },
            exit: ({ children }, enq) => enq.stop(children['child']),
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {},
        },
      })
      const actor = createActor(machine).start()

      actor.send({ type: 'EXIT' })

      const [active] = initialTransition(machine)
      const [, effects] = transition(machine, active, { type: 'EXIT' })

      yield* expect({
        disposeCalls,
        stopEffectCount: effects.filter(isEffect(XSTATE_STOP)).length,
      }).toEqual({
        disposeCalls: [undefined],
        stopEffectCount: 1,
      })
    })

    it('supports naive sequential execution of invoke lifecycle effects', function*({ expect }) {
      const disposeCalls: unknown[] = []
      const dispose = () => {
        disposeCalls.push(undefined)
      }
      const childLogic = createCallbackLogic(() => dispose)
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: childLogic },
            on: { RESTART: { target: 'active', reenter: true } },
          },
        },
      })

      const [active, initialEffects] = initialTransition(machine)
      for (const effect of initialEffects) {
        void effect.exec()
      }

      const child = active.children['child']
      if (child === undefined) throw new Error('expected a child')
      const childStatusAfterStart = child.getSnapshot().status

      const [reentered, restartEffects] = transition(machine, active, {
        type: 'RESTART',
      })
      const restartEffectLabels = describeEffects(restartEffects)
      for (const effect of restartEffects) {
        void effect.exec()
      }

      const reenteredChild = reentered.children['child']
      if (reenteredChild === undefined) {
        throw new Error('expected a reentered child')
      }

      yield* expect({
        childStatusAfterStart,
        restartEffectLabels,
        childStatusAfterRestart: child.getSnapshot().status,
        reenteredChildStatus: reenteredChild.getSnapshot().status,
        disposeCalls,
      }).toEqual({
        childStatusAfterStart: 'active',
        restartEffectLabels: ['stop(child)', 'spawn(child)', 'start(child)'],
        childStatusAfterRestart: 'stopped',
        reenteredChildStatus: 'active',
        disposeCalls: [undefined],
      })
    })

    it('executes immediate sends in a sequential effect loop', function*({ expect }) {
      const receivedEvents: unknown[] = []
      const received = (event: unknown) => {
        receivedEvents.push(event)
      }
      const machine = createMachine({
        invoke: {
          id: 'child',
          src: createCallbackLogic(({ receive }) => receive(received)),
        },
        on: {
          SEND: ({ children }, enq) => enq.sendTo(children['child'], { type: 'PING' }),
        },
      })
      const [active, initialEffects] = initialTransition(machine)
      initialEffects.forEach((effect) => void effect.exec())

      const [, effects] = transition(machine, active, { type: 'SEND' })
      effects.forEach((effect: ExecutableActionObject) => void effect.exec())

      yield* expect(receivedEvents).toEqual([{ type: 'PING' }])
    })

    it('cancels a previously scheduled effect in a sequential effect loop', function*({ expect }) {
      const machine = createMachine({
        initial: 'waiting',
        states: {
          waiting: {
            after: { 10_000: { target: 'done' } },
            on: { CANCEL: { target: 'done' } },
          },
          done: {},
        },
      })
      const [waiting, initialEffects] = initialTransition(machine)
      initialEffects.forEach((effect) => void effect.exec())
      const source = initialEffects.find(isEffect('@xstate.raise'))!.source

      const scheduledTimerCountBefore = Object.keys(
        source.system.getSnapshot()._scheduledTimers,
      ).length

      const [, effects] = machine.transition(waiting, { type: 'CANCEL' })
      effects.forEach((effect: ExecutableActionObject) => void effect.exec())

      const scheduledTimerCountAfter = Object.keys(
        source.system.getSnapshot()._scheduledTimers,
      ).length

      yield* expect({
        scheduledTimerCountBefore,
        scheduledTimerCountAfter,
      }).toEqual({
        scheduledTimerCountBefore: 1,
        scheduledTimerCountAfter: 0,
      })
    })

    it('machine transition methods do not require an actor scope', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: { on: { NEXT: { target: 'b' } } },
          b: {},
        },
      })

      const [a] = machine.initialTransition(undefined)
      const [b] = machine.transition(a, { type: 'NEXT' })

      yield* expect(b.value).toBe('b')
    })

    it('keeps the inert self snapshot in sync for executable effects', function*({ expect }) {
      let effectSnapshot: unknown
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: ({ self }, enq) => {
                enq(() => {
                  effectSnapshot = self.getSnapshot().value
                })
                return { target: 'b' }
              },
            },
          },
          b: {},
        },
      })

      const [a] = machine.initialTransition(undefined)
      const [, effects] = machine.transition(a, { type: 'NEXT' })
      effects.forEach((effect: ExecutableActionObject) => void effect.exec())

      yield* expect(effectSnapshot).toBe('b')
    })

    it('keeps executable effect self snapshots isolated between branches', function*({ expect }) {
      let effectSnapshot: unknown
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              LEFT: ({ self }, enq) => {
                enq(() => {
                  effectSnapshot = self.getSnapshot().value
                })
                return { target: 'left' }
              },
              RIGHT: { target: 'right' },
            },
          },
          left: {},
          right: {},
        },
      })

      const [a] = machine.initialTransition(undefined)
      const [, leftEffects] = machine.transition(a, { type: 'LEFT' })
      machine.transition(a, { type: 'RIGHT' })
      leftEffects.forEach(
        (effect: ExecutableActionObject) => void effect.exec(),
      )

      yield* expect(effectSnapshot).toBe('left')
    })

    it('keeps pure system registries isolated between branches', function*({ expect }) {
      let branchSystemEntry: AnyActor | string = 'not-checked'
      const child = createMachine({})
      const machine = createMachine({
        on: {
          SPAWN: (_, enq) => {
            enq.spawn(child, { registryKey: 'child' })
          },
          CHECK: ({ system }) => {
            branchSystemEntry = system.get('child') ?? 'no child'
          },
        },
      })

      const [initial] = machine.initialTransition(undefined)
      machine.transition(initial, { type: 'UNKNOWN' })
      machine.transition(initial, { type: 'SPAWN' })
      machine.transition(initial, { type: 'CHECK' })

      yield* expect(branchSystemEntry).toEqual('no child')
    })

    it('does not expose future runtime registry entries to old snapshots', function*({ expect }) {
      let oldSnapshotSystemEntry: AnyActor | string = 'not-checked'
      const child = createMachine({})
      const machine = createMachine({
        on: {
          SPAWN: (_, enq) => {
            enq.spawn(child, { registryKey: 'child' })
          },
          CHECK: ({ system }) => {
            oldSnapshotSystemEntry = system.get('child') ?? 'no child'
          },
        },
      })
      const actor = createActor(machine).start()
      const oldSnapshot = actor.getSnapshot()

      actor.send({ type: 'SPAWN' })
      transition(machine, oldSnapshot, { type: 'CHECK' })

      const registryChild = actor.system.get('child')
      yield* expect({
        registryChildIsDefined: registryChild !== undefined,
        oldSnapshotSystemEntry,
      }).toEqual({
        registryChildIsDefined: true,
        oldSnapshotSystemEntry: 'no child',
      })
    })

    it('reuses captured live system state until topology changes', function*({ expect }) {
      const child = createMachine({})
      const machine = createMachine({
        context: { count: 0 },
        on: {
          INCREMENT: ({ context }) => ({
            context: { count: context.count + 1 },
          }),
          SPAWN: (_, enq) => {
            enq.spawn(child, { registryKey: 'child' })
          },
        },
      })
      const actor = createActor(machine).start()
      const getSystemState = () => getSnapshotActorRef(actor.getSnapshot())!.systemState
      const initialSystemState = getSystemState()

      actor.send({ type: 'INCREMENT' })
      const afterIncrementSystemState = getSystemState()

      actor.send({ type: 'SPAWN' })
      const spawnedSystemState = getSystemState()

      actor.send({ type: 'INCREMENT' })
      const afterSecondIncrementSystemState = getSystemState()
      const registryChild = actor.system.get('child')

      yield* expect({
        firstReusePreserved: afterIncrementSystemState === initialSystemState,
        spawnChanged: spawnedSystemState !== initialSystemState,
        secondReusePreserved: afterSecondIncrementSystemState === spawnedSystemState,
        registryChildIsDefined: registryChild !== undefined,
      }).toEqual({
        firstReusePreserved: true,
        spawnChanged: true,
        secondReusePreserved: true,
        registryChildIsDefined: true,
      })
    })

    it('does not discover future nested actors through old child refs', function*({ expect }) {
      let oldSnapshotGrandchildEntry: AnyActor | string = 'not-checked'
      const child = createMachine({
        on: {
          SPAWN: (_, enq) => {
            enq.spawn(createMachine({}), { registryKey: 'grandchild' })
          },
        },
      })
      const machine = createMachine({
        invoke: { id: 'child', src: child },
        on: {
          CHECK: ({ system }) => {
            oldSnapshotGrandchildEntry = system.get('grandchild') ?? 'no child'
          },
        },
      })
      const actor = createActor(machine).start()
      const oldSnapshot = actor.getSnapshot()

      const oldSnapshotChild = oldSnapshot.children['child']
      if (oldSnapshotChild === undefined) {
        throw new Error('expected an old snapshot child')
      }
      oldSnapshotChild.send({ type: 'SPAWN' })
      transition(machine, oldSnapshot, { type: 'CHECK' })

      yield* expect(oldSnapshotGrandchildEntry).toEqual('no child')
    })

    it('removes stopped children from later pure system views', function*({ expect }) {
      let laterSystemEntry: AnyActor | string = 'not-checked'
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'child',
              src: createMachine({}),
              registryKey: 'child',
            },
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: {
            on: {
              CHECK: ({ system }) => {
                laterSystemEntry = system.get('child') ?? 'no child'
              },
            },
          },
        },
      })
      const [active] = initialTransition(machine)
      const [inactive] = transition(machine, active, { type: 'EXIT' })

      transition(machine, inactive, { type: 'CHECK' })

      yield* expect(laterSystemEntry).toEqual('no child')
    })

    it('uses a new actor session ID across pure stop and reentry', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: { id: 'child', src: listener },
            on: { EXIT: { target: 'inactive' } },
          },
          inactive: { on: { ENTER: { target: 'active' } } },
        },
      })
      const [active] = initialTransition(machine)
      const activeChild = active.children['child']
      if (activeChild === undefined) throw new Error('expected an active child')
      const firstSessionId = activeChild.sessionId
      const [inactive] = transition(machine, active, { type: 'EXIT' })
      const [reentered] = transition(machine, inactive, { type: 'ENTER' })

      const reenteredChild = reentered.children['child']
      if (reenteredChild === undefined) {
        throw new Error('expected a reentered child')
      }
      yield* expect(reenteredChild.sessionId).not.toBe(firstSessionId)
    })

    it('assigns distinct opaque session IDs across pure initial transitions', function*({ expect }) {
      const machine = createMachine({
        invoke: { id: 'child', src: listener },
      })

      const [first] = initialTransition(machine)
      const [second] = initialTransition(machine)

      const firstChildRef = first.children['child']
      const secondChildRef = second.children['child']
      if (firstChildRef === undefined || secondChildRef === undefined) {
        throw new Error('expected children')
      }
      yield* expect(firstChildRef.sessionId).not.toBe(secondChildRef.sessionId)
    })

    it('assigns distinct session IDs to branches from the same snapshot', function*({ expect }) {
      const machine = createMachine({
        initial: 'idle',
        states: {
          idle: { on: { ENTER: { target: 'active' } } },
          active: { invoke: { id: 'child', src: listener } },
        },
      })
      const [idle] = initialTransition(machine)

      const [first] = transition(machine, idle, { type: 'ENTER' })
      const [second] = transition(machine, idle, { type: 'ENTER' })

      const firstChildRef = first.children['child']
      const secondChildRef = second.children['child']
      if (firstChildRef === undefined || secondChildRef === undefined) {
        throw new Error('expected children')
      }
      yield* expect({
        childrenDistinct: first.children['child'] !== second.children['child'],
        sessionIdsDistinct: firstChildRef.sessionId !== secondChildRef.sessionId,
      }).toEqual({
        childrenDistinct: true,
        sessionIdsDistinct: true,
      })
    })

    it('projects nested system registries from the input snapshot', function*({ expect }) {
      let foundGrandchild: AnyActor | undefined
      const child = createMachine({
        invoke: {
          id: 'grandchild',
          src: createMachine({}),
          registryKey: 'grandchild',
        },
      })
      const machine = createMachine({
        invoke: { id: 'child', src: child },
        on: {
          CHECK: ({ system }) => {
            foundGrandchild = system.get('grandchild')
          },
        },
      })

      const [initial] = machine.initialTransition(undefined)
      const grandchild = initial.children.child.getSnapshot().children
        .grandchild as AnyActor
      machine.transition(initial, { type: 'CHECK' })

      yield* expect(foundGrandchild).toBe(grandchild)
    })

    it('preserves parent refs when purely transitioning a child snapshot', function*({ expect }) {
      let seenParent: unknown
      const child = createMachine({
        on: {
          CHECK: ({ parent }, enq) => enq(() => (seenParent = parent)),
        },
      })
      const parent = createActor(
        createMachine({ invoke: { id: 'child', src: child } }),
      ).start()
      const parentChild = parent.getSnapshot().children['child']
      if (parentChild === undefined) throw new Error('expected a child')
      const childSnapshot = parentChild.getSnapshot()

      const [, effects] = transition(child, childSnapshot, { type: 'CHECK' })
      effects.forEach((effect) => void effect.exec())

      yield* expect(seenParent).toBe(parent)
    })

    it('does not reuse a running actor scope for a pure transition', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: { on: { NEXT: { target: 'b' } } },
          b: {},
        },
      })
      const actor = createActor(machine).start()

      const [next] = transition(machine, actor.getSnapshot(), {
        type: 'NEXT',
      })

      yield* expect({
        nextValue: next.value,
        liveValue: actor.getSnapshot().value,
      }).toEqual({
        nextValue: 'b',
        liveValue: 'a',
      })
    })

    it('replaces inherited live identity after materializing a pure branch', function*({ expect }) {
      let branchSelf: AnyActor | undefined
      const machine = createMachine({
        context: { count: 0 },
        on: {
          INCREMENT: ({ context, self, system }) => {
            branchSelf = self
            system.get('missing')
            return { context: { count: context.count + 1 } }
          },
        },
      })
      const actor = createActor(machine).start()
      const liveSnapshot = actor.getSnapshot()

      const [nextSnapshot] = transition(machine, liveSnapshot, {
        type: 'INCREMENT',
      })
      const branchRef = getSnapshotActorRef(nextSnapshot)!

      yield* expect({
        branchSelfIsNotActor: branchSelf !== actor,
        branchRefActorIsBranchSelf: branchRef.actor === branchSelf,
        branchRefSnapshotIsNext: branchRef.actor.getSnapshot() === nextSnapshot,
        liveActorSnapshotIsLive: actor.getSnapshot() === liveSnapshot,
        liveRefActorIsActor: getSnapshotActorRef(liveSnapshot)!.actor === actor,
      }).toEqual({
        branchSelfIsNotActor: true,
        branchRefActorIsBranchSelf: true,
        branchRefSnapshotIsNext: true,
        liveActorSnapshotIsLive: true,
        liveRefActorIsActor: true,
      })
    })

    it('gives every planned snapshot its own current owner snapshot', function*({ expect }) {
      const machine = createMachine({
        context: { count: 0 },
        on: {
          INCREMENT: ({ context }) => ({
            context: { count: context.count + 1 },
          }),
        },
      })
      const liveActor = createActor(machine).start()
      const liveSnapshot = liveActor.getSnapshot()
      const [first] = transition(machine, liveSnapshot, {
        type: 'INCREMENT',
      })
      const [second] = transition(machine, first, { type: 'INCREMENT' })

      yield* expect({
        firstOwnerIsFirst: getSnapshotActorRef(first)!.actor.getSnapshot() === first,
        secondOwnerIsSecond: getSnapshotActorRef(second)!.actor.getSnapshot() === second,
        liveRefActorIsLiveActor: getSnapshotActorRef(liveSnapshot)!.actor === liveActor,
      }).toEqual({
        firstOwnerIsFirst: true,
        secondOwnerIsSecond: true,
        liveRefActorIsLiveActor: true,
      })
    })

    it('keeps one session identity across a plan started from scratch', function*({ expect }) {
      const machine = createMachine({
        context: { count: 0 },
        on: {
          INCREMENT: ({ context }) => ({
            context: { count: context.count + 1 },
          }),
        },
      })
      const [initial] = initialTransition(machine)
      const [next] = transition(machine, initial, { type: 'INCREMENT' })

      yield* expect(getSnapshotActorRef(next)!.actor.sessionId).toBe(
        getSnapshotActorRef(initial)!.actor.sessionId,
      )
    })

    it('keeps one session identity across initial microsteps', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: { always: { target: 'b' } },
          b: {},
        },
      })
      const microsteps = getInitialMicrosteps(machine)

      yield* expect({
        microstepCount: microsteps.length,
        distinctSessionIds: new Set(
          microsteps.map(
            ([snapshot]) => getSnapshotActorRef(snapshot)!.actor.sessionId,
          ),
        ).size,
      }).toEqual({
        microstepCount: 2,
        distinctSessionIds: 1,
      })
    })

    it('gives every microstep its own current owner snapshot', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: { on: { NEXT: { target: 'b' } } },
          b: { always: { target: 'c' } },
          c: {},
        },
      })
      const [initial] = initialTransition(machine)
      const microsteps = getMicrosteps(machine, initial, { type: 'NEXT' })

      const microstepOwnerMatches = microsteps.map(
        ([snapshot]) => getSnapshotActorRef(snapshot)!.actor.getSnapshot() === snapshot,
      )
      const firstMicrostep = microsteps[0]
      const secondMicrostep = microsteps[1]
      const firstMicrostepSnapshot = firstMicrostep?.[0]
      const secondMicrostepSnapshot = secondMicrostep?.[0]
      if (
        firstMicrostepSnapshot === undefined ||
        secondMicrostepSnapshot === undefined
      ) {
        throw new Error('expected microstep snapshots')
      }

      yield* expect({
        microstepCount: microsteps.length,
        microstepOwnerMatches,
        firstActorIsNotSecondActor: getSnapshotActorRef(firstMicrostepSnapshot)!.actor !==
          getSnapshotActorRef(secondMicrostepSnapshot)!.actor,
      }).toEqual({
        microstepCount: 2,
        microstepOwnerMatches: [true, true],
        firstActorIsNotSecondActor: true,
      })
    })

    it('appends deferred starts to the final microstep', function*({ expect }) {
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(listener, { id: 'child' }),
      })

      const microsteps = getInitialMicrosteps(machine)
      const effects = microsteps.flatMap(([, stepEffects]) => stepEffects)

      yield* expect(describeEffects(effects)).toEqual([
        'spawn(child)',
        'start(child)',
      ])
    })

    it('represents context initializer spawns as executable effects', function*({ expect }) {
      const startedCalls: unknown[] = []
      const child = createCallbackLogic(() => {
        startedCalls.push(undefined)
      })
      const machine = createMachine({
        context: ({ spawn }) => ({
          child: spawn(child, { id: 'child' }),
        }),
      })

      const [snapshot, effects] = initialTransition(machine)

      const effectLabelsBeforeExec = describeEffects(effects)
      const startedCallsBeforeExec = startedCalls.length
      effects.forEach((effect) => void effect.exec())
      const snapshotChild = snapshot.children['child']
      if (snapshotChild === undefined) throw new Error('expected a child')

      yield* expect({
        startedCallsBeforeExec,
        effectLabelsBeforeExec,
        childStatus: snapshotChild.getSnapshot().status,
        startedCalls,
      }).toEqual({
        startedCallsBeforeExec: 0,
        effectLabelsBeforeExec: ['spawn(child)', 'start(child)'],
        childStatus: 'active',
        startedCalls: [undefined],
      })
    })
  })

  describe('terminal child cleanup', () => {
    const child = createLogic({
      context: undefined,
      run: () => undefined,
    })

    it('removes a dynamically spawned child after its matching done event', function*({ expect }) {
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
      })
      const [active] = initialTransition(machine)
      const childRef = active.children['child']
      if (childRef === undefined) throw new Error('expected a child ref')

      const [completed] = transition(machine, active, {
        type: 'xstate.done.actor',
        actorId: 'child',
        sessionId: childRef.sessionId,
        output: 42,
      } as any)

      yield* expect(completed.children).toEqual({})
    })

    it('removes a dynamically spawned child after its matching error event', function*({ expect }) {
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
        on: {
          'xstate.error.actor.child': {},
        },
      })
      const [active] = initialTransition(machine)
      const childRef = active.children['child']
      if (childRef === undefined) throw new Error('expected a child ref')

      const [failed] = transition(machine, active, {
        type: 'xstate.error.actor.child',
        actorId: 'child',
        sessionId: childRef.sessionId,
        error: new Error('failed'),
      } as any)

      yield* expect(failed.children).toEqual({})
    })

    it('keeps the child visible while handling its terminal event', function*({ expect }) {
      let observedChild: AnyActor | undefined
      let observedEvent: AnyEventObject | undefined
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
        on: {
          'xstate.done.actor.child': ({ children, event }, _enq) => {
            observedChild = children['child']
            observedEvent = event
          },
        },
      })
      const [active] = initialTransition(machine)
      const childRef = active.children['child']
      if (childRef === undefined) throw new Error('expected a child ref')

      const [completed] = transition(machine, active, {
        type: 'xstate.done.actor.child',
        actorId: 'child',
        sessionId: childRef.sessionId,
        output: 42,
      } as any)

      yield* expect({
        observedChildIsChildRef: observedChild === childRef,
        observedEvent,
        completedChildren: completed.children,
      }).toEqual({
        observedChildIsChildRef: true,
        observedEvent: expect.objectContaining({
          sessionId: childRef.sessionId,
          output: 42,
        }),
        completedChildren: {},
      })
    })

    it('does not remove a replacement child for a stale terminal event', function*({ expect }) {
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
        on: {
          REPLACE: ({ children }, enq) => {
            enq.stop(children['child'])
            enq.spawn(child, { id: 'child' })
          },
        },
      })
      const [firstSnapshot] = initialTransition(machine)
      const firstChild = firstSnapshot.children['child']
      if (firstChild === undefined) throw new Error('expected a first child')
      const [secondSnapshot] = transition(machine, firstSnapshot, {
        type: 'REPLACE',
      })
      const secondChild = secondSnapshot.children['child']
      if (secondChild === undefined) throw new Error('expected a second child')

      const [afterStaleDone] = transition(machine, secondSnapshot, {
        type: 'xstate.done.actor.child',
        actorId: 'child',
        sessionId: firstChild.sessionId,
        output: undefined,
      } as any)

      yield* expect({
        secondIsNotFirst: secondChild !== firstChild,
        staleDoneChildIsSecond: afterStaleDone.children['child'] === secondChild,
      }).toEqual({
        secondIsNotFirst: true,
        staleDoneChildIsSecond: true,
      })
    })

    it('does not take an invoke completion transition for a stale child', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'child',
              src: createAsyncLogic({ run: () => new Promise(() => {}) }),
              onDone: { target: 'done' },
            },
            on: { RESET: { target: 'active', reenter: true } },
          },
          done: {},
        },
      })
      const [firstSnapshot] = initialTransition(machine)
      const firstChild = firstSnapshot.children['child']
      if (firstChild === undefined) throw new Error('expected a first child')
      const [secondSnapshot] = transition(machine, firstSnapshot, {
        type: 'RESET',
      })
      const secondChild = secondSnapshot.children['child']
      if (secondChild === undefined) throw new Error('expected a second child')

      const [afterStaleDone] = transition(machine, secondSnapshot, {
        type: 'xstate.done.actor',
        actorId: 'child',
        sessionId: firstChild.sessionId,
        output: undefined,
      } as any)

      yield* expect({
        value: afterStaleDone.value,
        childIsSecond: afterStaleDone.children['child'] === secondChild,
      }).toEqual({
        value: 'active',
        childIsSecond: true,
      })
    })

    it('ignores an unhandled error from a stale child', function*({ expect }) {
      const machine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'child',
              src: createAsyncLogic({ run: () => new Promise(() => {}) }),
            },
            on: { RESET: { target: 'active', reenter: true } },
          },
        },
      })
      const [firstSnapshot] = initialTransition(machine)
      const [secondSnapshot] = transition(machine, firstSnapshot, {
        type: 'RESET',
      })

      const staleChild = firstSnapshot.children['child']
      if (staleChild === undefined) throw new Error('expected a child')
      const [afterStaleError] = transition(machine, secondSnapshot, {
        type: 'xstate.error.actor',
        actorId: 'child',
        sessionId: staleChild.sessionId,
        error: new Error('stale'),
      } as any)

      yield* expect({
        status: afterStaleError.status,
        childIsSecondChild: afterStaleError.children['child'] === secondSnapshot.children['child'],
      }).toEqual({
        status: 'active',
        childIsSecondChild: true,
      })
    })

    it('accepts legacy suffixed actor terminal events', function*({ expect }) {
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
      })
      const [active] = initialTransition(machine)
      const childRef = active.children['child']
      if (childRef === undefined) throw new Error('expected a child ref')

      const [completed] = transition(machine, active, {
        type: 'xstate.done.actor.child',
        actorId: 'child',
        sessionId: childRef.sessionId,
        output: undefined,
      } as any)

      yield* expect(completed.children).toEqual({})
    })

    it('reports the pruned child in the final microstep', function*({ expect }) {
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(child, { id: 'child' }),
      })
      const [active] = initialTransition(machine)
      const childRef = active.children['child']
      if (childRef === undefined) throw new Error('expected a child ref')

      const microsteps = getMicrosteps(machine, active, {
        type: 'xstate.done.actor.child',
        actorId: 'child',
        sessionId: childRef.sessionId,
        output: undefined,
      } as any)

      yield* expect(microsteps.at(-1)?.[0].children).toEqual({})
    })

    it('removes a completed dynamically spawned child on the live path', function*({ expect }) {
      const completingChild = createLogic({
        context: undefined,
        run: () => ({ status: 'done', output: 42 }),
      })
      const machine = createMachine({
        entry: (_, enq) => enq.spawn(completingChild, { id: 'completingChild' }),
      })

      const actor = createActor(machine).start()

      yield* expect(actor.getSnapshot().children).toEqual({})
    })
  })

  describe('legacy suffixed internal events', () => {
    it('accepts state completion events', function*({ expect }) {
      const machine = createMachine({
        initial: 'parent',
        states: {
          parent: {
            initial: 'active',
            states: { active: {} },
            onDone: { target: 'done' },
          },
          done: {},
        },
      })
      const [active] = initialTransition(machine)

      const [completed] = transition(machine, active, {
        type: 'xstate.done.state.(machine).parent',
        output: undefined,
      } as any)

      yield* expect(completed.value).toBe('done')
    })

    it('accepts delayed transition events', function*({ expect }) {
      const machine = createMachine({
        initial: 'waiting',
        states: {
          waiting: { after: { 10: { target: 'done' } } },
          done: {},
        },
      })
      const [waiting] = initialTransition(machine)

      const [completed] = transition(machine, waiting, {
        type: 'xstate.after.10.(machine).waiting',
      } as any)

      yield* expect(completed.value).toBe('done')
    })
  })

  const emittingLogic = createCallbackLogic(({ emit }) => {
    emit({ type: 'someEvent' })
  })

  const completingLogic = createLogic({
    context: undefined,
    run: () => ({
      status: 'done',
      output: { result: 'success' },
    }),
  })

  it('initialTransition: defers listener/child starts to the end of the effects', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        const child = enq.spawn(emittingLogic, { id: 'child' })
        enq.listen(child, 'someEvent', () => ({ type: 'HEARD' }))
      },
    })

    const [, effects] = initialTransition(machine)

    yield* expect(describeEffects(effects)).toEqual([
      'spawn(child)',
      'listen(child)',
      'start:listen(child)',
      'start(child)',
    ])
  })

  it('initialTransition: defers subscription/child starts to the end of the effects', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        const child = enq.spawn(completingLogic, { id: 'child' })
        enq.subscribeTo(child, {
          done: (output) => ({ type: 'CHILD_DONE', output }),
        })
      },
    })

    const [, effects] = initialTransition(machine)

    yield* expect(describeEffects(effects)).toEqual([
      'spawn(child)',
      'subscribe(child)',
      'start:subscribe(child)',
      'start(child)',
    ])
  })

  it(
    'transition: cross-phase spawns with listeners from exit and entry defer starts to the end of the effects',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        context: {} as { spawnedOnExit: any },
        states: {
          a: {
            on: {
              GO: { target: 'b' },
            },
            exit: (_, enq) => {
              const spawnedOnExit = enq.spawn(emittingLogic, {
                id: 'exitChild',
              })
              enq.listen(spawnedOnExit, 'someEvent', () => ({ type: 'HEARD' }))
              return { context: { spawnedOnExit } }
            },
          },
          b: {
            entry: ({ context }, enq) => {
              const spawnedOnEntry = enq.spawn(emittingLogic, {
                id: 'entryChild',
              })
              enq.listen(spawnedOnEntry, 'someEvent', () => ({ type: 'HEARD' }))
              enq.listen(context.spawnedOnExit, 'someEvent', () => ({
                type: 'HEARD',
              }))
            },
          },
        },
      })

      const [state] = initialTransition(machine)
      const [, effects] = transition(machine, state, { type: 'GO' })

      yield* expect(describeEffects(effects)).toEqual([
        // authored-position records across both microsteps
        'spawn(exitChild)',
        'listen(exitChild)',
        'spawn(entryChild)',
        'listen(entryChild)',
        'listen(exitChild)',
        // appended attached-actor starts (authored order)
        'start:listen(exitChild)',
        'start:listen(entryChild)',
        'start:listen(exitChild)',
        // appended child starts (authored order)
        'start(exitChild)',
        'start(entryChild)',
      ])
    },
  )

  it(
    'transition: a same-transition spawn+stop keeps its appended start (which no-ops at runtime)',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        context: {} as { spawnedChild: any },
        states: {
          a: {
            on: {
              GO: { target: 'b' },
            },
            exit: (_, enq) => {
              const spawnedChild = enq.spawn(emittingLogic, { id: 'child' })
              enq.stop(spawnedChild)
              return { context: { spawnedChild } }
            },
          },
          b: {
            entry: ({ context }, enq) => {
              enq.listen(context.spawnedChild, 'someEvent', () => ({
                type: 'HEARD',
              }))
            },
          },
        },
      })

      const [state] = initialTransition(machine)
      const [, effects] = transition(machine, state, { type: 'GO' })

      yield* expect(describeEffects(effects)).toEqual([
        'spawn(child)',
        'stop(child)',
        'listen(child)',
        'start:listen(child)',
        // still present; no-ops at runtime because the child was already stopped
        'start(child)',
      ])
    },
  )

  it(
    'transition: interleaved spawns and listeners in the same phase defer starts to the end (attached before child, each in authored order)',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              GO: { target: 'b' },
            },
          },
          b: {
            entry: (_, enq) => {
              const actorA = enq.spawn(emittingLogic, { id: 'actorA' })
              const actorB = enq.spawn(emittingLogic, { id: 'actorB' })
              enq.listen(actorB, 'someEvent', () => ({ type: 'HEARD_B' }))
              enq.listen(actorA, 'someEvent', () => ({ type: 'HEARD_A' }))
            },
          },
        },
      })

      const [state] = initialTransition(machine)
      const [, effects] = transition(machine, state, { type: 'GO' })

      yield* expect(describeEffects(effects)).toEqual([
        'spawn(actorA)',
        'spawn(actorB)',
        'listen(actorB)',
        'listen(actorA)',
        // attached starts keep authored order (B then A)
        'start:listen(actorB)',
        'start:listen(actorA)',
        // child starts keep authored order (A then B)
        'start(actorA)',
        'start(actorB)',
      ])
    },
  )

  it(
    'transition: listening to a pre-existing actor spawns+starts only the listener actor (no new target start)',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        context: {} as { existingChild: any },
        states: {
          a: {
            entry: (_, enq) => {
              const existingChild = enq.spawn(emittingLogic, {
                id: 'existing',
              })
              return { context: { existingChild } }
            },
            on: {
              GO: { target: 'b' },
            },
          },
          b: {
            entry: ({ context }, enq) => {
              enq.listen(context.existingChild, 'someEvent', () => ({
                type: 'HEARD',
              }))
            },
          },
        },
      })

      const [state] = initialTransition(machine)
      const [, effects] = transition(machine, state, { type: 'GO' })

      yield* expect(describeEffects(effects)).toEqual([
        'listen(existing)',
        'start:listen(existing)',
      ])
    },
  )

  it('initialTransition: spawn+listen+subscribeTo on the same child defers starts to the end', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        const child = enq.spawn(completingLogic, { id: 'child' })
        enq.listen(child, 'someEvent', () => ({ type: 'HEARD' }))
        enq.subscribeTo(child, {
          done: (output) => ({ type: 'CHILD_DONE', output }),
        })
      },
    })

    const [, effects] = initialTransition(machine)

    yield* expect(describeEffects(effects)).toEqual([
      'spawn(child)',
      'listen(child)',
      'subscribe(child)',
      // attached-actor starts first, in authored order
      'start:listen(child)',
      'start:subscribe(child)',
      // child start last
      'start(child)',
    ])
  })

  it('initialTransition: invoke start is deferred to the end, after entry actions', function*({ expect }) {
    const machine = createMachine({
      invoke: {
        id: 'child',
        src: emittingLogic,
      },
      entry: ({ children }, enq) => {
        enq.listen(children['child']!, 'someEvent', () => ({ type: 'HEARD' }))
      },
    })

    const [, effects] = initialTransition(machine)

    yield* expect(describeEffects(effects)).toEqual([
      'spawn(child)',
      'listen(child)',
      'start:listen(child)',
      'start(child)',
    ])
  })

  it(
    'initialTransition: effects can be executed by a manual executor loop with listener starting before child',
    function*({ expect }) {
      const childLogic = createCallbackLogic(() => {})

      const machine = createMachine({
        entry: (_, enq) => {
          const child = enq.spawn(childLogic, { id: 'child' })
          enq.listen(child, 'someEvent', () => ({ type: 'HEARD' }))
        },
      })

      const [, effects] = initialTransition(machine)

      const spawnEffects = effects.filter(isEffect(XSTATE_SPAWN))
      const childSpawn = spawnEffects.find((e) => e.logic === childLogic)!
      const listenerSpawn = spawnEffects.find((e) => e.logic === listenerLogic)!

      const childRef = childSpawn.actor
      const listenerRef = listenerSpawn.actor

      const childStartRecorder = childRef as unknown as { start: () => unknown }
      const listenerStartRecorder = listenerRef as unknown as {
        start: () => unknown
      }
      const childOriginalStart = childStartRecorder.start.bind(childRef)
      const listenerOriginalStart = listenerStartRecorder.start.bind(listenerRef)
      const startOrder: string[] = []
      childStartRecorder.start = () => {
        startOrder.push('child')
        return childOriginalStart()
      }
      listenerStartRecorder.start = () => {
        startOrder.push('listener')
        return listenerOriginalStart()
      }

      for (const effect of effects) {
        void effect.exec()
      }

      yield* expect({
        startOrder,
        childStatus: childRef.getSnapshot().status,
      }).toEqual({
        startOrder: ['listener', 'child'],
        childStatus: 'active',
      })
    },
  )

  it('does not classify inherited object keys as built-in actions', function*({ expect }) {
    yield* expect({
      builtIn: isBuiltInExecutableAction({
        kind: 'action',
        type: 'toString',
        params: undefined,
        args: [],
        action: undefined,
        exec() {},
      }),
    }).toEqual({ builtIn: false })
  })

  it('does not classify emitted reserved event names as built-in actions', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        enq.emit({ type: '@xstate.spawn' } as any)
      },
    })

    const [, effects] = initialTransition(machine)
    const emittedEffect = effects.find(
      (effect) => effect.type === XSTATE_SPAWN,
    )!

    yield* expect({
      builtIn: isBuiltInExecutableAction(emittedEffect),
      startEffectCount: effects.filter(isEffect(XSTATE_START)).length,
    }).toEqual({
      builtIn: false,
      startEffectCount: 0,
    })
  })

  it('does not classify user-created reserved action shapes as built-in actions', function*({ expect }) {
    const actor = createActor(createMachine({}))

    const userCreatedSpawn = {
      kind: 'action',
      type: XSTATE_SPAWN,
      params: undefined,
      args: [actor],
      action: undefined,
      actor,
      id: actor.id,
      logic: actor.logic,
      src: actor.src,
      input: undefined,
    } as unknown as ExecutableActionObject

    yield* expect({
      builtIn: isBuiltInExecutableAction(userCreatedSpawn),
    }).toEqual({ builtIn: false })
  })

  it('emit actions should be returned', function*({ expect }) {
    const machine = createMachine({
      // types: {
      //   emitted: {} as { type: 'counted'; count: number }
      // },
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        emitted: {
          counted: z.object({
            count: z.number(),
          }),
        },
      },
      initial: 'a',
      context: { count: 10 },
      states: {
        a: {
          on: {
            NEXT: ({ context }, enq) => {
              enq.emit({
                type: 'counted',
                count: context.count,
              })
            },
          },
        },
      },
    })

    const [state] = initialTransition(machine)

    const stateValue = state.value

    const [, nextActions] = transition(machine, state, { type: 'NEXT' })

    yield* expect({ value: stateValue, nextActions }).toEqual({
      value: 'a',
      nextActions: expect.arrayContaining([
        expect.objectContaining({
          type: 'counted',
          params: { count: 10 },
        }),
      ]),
    })
  })

  it('log actions should be returned', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'a',
      context: { count: 10 },
      states: {
        a: {
          on: {
            NEXT: ({ context }, enq) => {
              enq.log(`count: ${context.count}`)
            },
          },
        },
      },
    })

    const [state] = initialTransition(machine)

    const stateValue = state.value

    const [, nextActions] = transition(machine, state, { type: 'NEXT' })

    yield* expect({ value: stateValue, nextActions }).toEqual({
      value: 'a',
      nextActions: expect.arrayContaining([
        expect.objectContaining({
          args: ['count: 10'],
        }),
      ]),
    })
  })

  it('should calculate the next snapshot for custom logic', function*({ expect }) {
    const logic = createLogic({
      context: { count: 0 },
      run: ({ context, event }) => {
        if (event.type === 'next') {
          return { context: { count: context.count + 1 } }
        }
        return
      },
    })

    const [init] = initialTransition(logic)
    const [s1] = transition(logic, init, { type: 'next' })
    const [s2] = transition(logic, s1, { type: 'next' })

    yield* expect({
      s1Count: s1.context.count,
      s2Count: s2.context.count,
    }).toEqual({
      s1Count: 1,
      s2Count: 2,
    })
  })

  it('should calculate the next snapshot for machine logic', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            NEXT: { target: 'c' },
          },
        },
        c: {},
      },
    })

    const [init] = initialTransition(machine)
    const [s1] = transition(machine, init, { type: 'NEXT' })
    const [s2] = transition(machine, s1, { type: 'NEXT' })

    yield* expect({ s1Value: s1.value, s2Value: s2.value }).toEqual({
      s1Value: 'b',
      s2Value: 'c',
    })
  })

  it('should not execute entry actions', function*({ expect }) {
    const entryActionCalls: unknown[] = []
    const fn = () => {
      entryActionCalls.push(undefined)
    }

    const machine = createMachine({
      initial: 'a',
      entry: (_, enq) => enq(fn),
      states: {
        a: {},
        b: {},
      },
    })

    initialTransition(machine)

    yield* expect(entryActionCalls).toEqual([])
  })

  it('should not execute transition actions', function*({ expect }) {
    const transitionActionCalls: unknown[] = []
    const fn = () => {
      transitionActionCalls.push(undefined)
    }

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            event: (_, enq) => {
              enq(fn)
              return { target: 'b' }
            },
          },
        },
        b: {},
      },
    })

    const [init] = initialTransition(machine)
    const [nextSnapshot] = transition(machine, init, { type: 'event' })

    yield* expect({
      transitionActionCalls,
      nextValue: nextSnapshot.value,
    }).toEqual({
      transitionActionCalls: [],
      nextValue: 'b',
    })
  })

  it('delayed events example (experimental)', function*({ expect }) {
    const db = {
      state: undefined as any,
    }

    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            next: { target: 'waiting' },
          },
        },
        waiting: {
          after: {
            10: { target: 'done' },
          },
        },
        done: {
          type: 'final',
        },
      },
    })

    function execute(action: ExecutableActionObject): Effect.Effect<void> {
      return Effect.gen(function*() {
        if (
          isBuiltInExecutableAction(action) &&
          action.type === '@xstate.raise' &&
          action.delay
        ) {
          const currentTime = Date.now()
          const startedAt = currentTime
          const elapsed = currentTime - startedAt
          const timeRemaining = Math.max(0, action.delay - elapsed)

          const { promise, resolve } = Promise.withResolvers<void>()
          setTimeout(resolve, timeRemaining)
          yield* Effect.promise(() => promise)
          yield* postEvent(action.event as EventFrom<typeof machine>)
        }
      })
    }

    // POST /workflow
    function postStart(): Effect.Effect<void> {
      return Effect.gen(function*() {
        const [state, actions] = initialTransition(machine)

        db.state = JSON.stringify(state)

        // execute actions
        for (const action of actions) {
          yield* execute(action)
        }
      })
    }

    // POST /workflow/{sessionId}
    function postEvent(event: EventFrom<typeof machine>): Effect.Effect<void> {
      return Effect.gen(function*() {
        const [nextState, actions] = transition(
          machine,
          machine.resolveState(JSON.parse(db.state)),
          event,
        )

        db.state = JSON.stringify(nextState)

        for (const action of actions) {
          yield* execute(action)
        }
      })
    }

    yield* postStart()
    yield* postEvent({ type: 'next' })

    yield* Effect.promise(() => sleep(15))
    yield* expect(JSON.parse(db.state).status).toBe('done')
  })

  it('serverless workflow example (experimental)', function*({ expect }) {
    const db = {
      state: undefined as any,
    }

    const machine = createMachine({
      actors: {
        sendWelcomeEmail: createAsyncLogic({
          run: () => {
            calls.push('sendWelcomeEmail')
            return Promise.resolve({
              status: 'sent',
            })
          },
        }),
      },
      initial: 'sendingWelcomeEmail',
      states: {
        sendingWelcomeEmail: {
          invoke: {
            src: ({ actors }) => actors.sendWelcomeEmail,
            input: () => ({ message: 'hello world', subject: 'hi' }),
            onDone: { target: 'logSent' },
          },
        },
        logSent: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve() }),
            onDone: { target: 'finish' },
          },
        },
        finish: {},
      },
    })

    const calls: string[] = []

    function execute(action: ExecutableActionObject): Effect.Effect<void> {
      return Effect.gen(function*() {
        if (!isBuiltInExecutableAction(action)) {
          return
        }
        switch (action.type) {
          case '@xstate.start': {
            yield* Effect.promise(() => Promise.resolve(action.exec()))
            const startedActor = action.actor as ReturnType<typeof createActor>
            const output = yield* Effect.promise(() => toPromise(startedActor))
            yield* postEvent(
              createDoneActorEvent(
                startedActor.id,
                output,
                startedActor.sessionId,
              ),
            )
            break
          }

          default:
            break
        }
      })
    }

    // POST /workflow
    function postStart(): Effect.Effect<void> {
      return Effect.gen(function*() {
        const [state, actions] = initialTransition(machine)

        db.state = JSON.stringify(state)

        // execute actions
        for (const action of actions) {
          yield* execute(action)
        }
      })
    }

    // POST /workflow/{sessionId}
    function postEvent(event: EventFrom<typeof machine>): Effect.Effect<void> {
      return Effect.gen(function*() {
        const [nextState, actions] = transition(
          machine,
          machine.resolveState(JSON.parse(db.state)),
          event,
        )

        db.state = JSON.stringify(nextState)

        // "sync" built-in actions: assign, raise, cancel, stop
        // "external" built-in actions: sendTo, raise w/delay, log
        for (const action of actions) {
          yield* execute(action)
        }
      })
    }

    yield* postStart()
    yield* postEvent({ type: 'sent' })

    yield* expect(calls).toEqual(['sendWelcomeEmail'])

    yield* Effect.promise(() => sleep(10))
    yield* expect(JSON.parse(db.state).value).toBe('finish')
  })

  it('should support transition functions', function*({ expect }) {
    const transitionActionCalls: unknown[] = []
    const fn = () => {
      transitionActionCalls.push(undefined)
    }
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: {
              description: 'next',
              to: (_, enq) => {
                enq(fn)
                return {
                  target: 'b',
                }
              },
            },
          },
        },
        b: {},
      },
    })

    const [init] = initialTransition(machine)
    const [s1, actions] = transition(machine, init, { type: 'NEXT' })
    yield* expect({
      value: s1.value,
      actionCount: actions.length,
    }).toEqual({
      value: 'b',
      actionCount: 1,
    })
  })

  it('fast-paths flat static target/context transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      context: { count: 0 },
      states: {
        a: {
          on: {
            NEXT: {
              target: 'b',
              context: { count: 1 },
            },
          },
        },
        b: {},
      },
    })
    const getTransitionDataCalls: unknown[] = []
    machine.getTransitionData = () => {
      getTransitionDataCalls.push('getTransitionData')
      return []
    }

    const [init] = initialTransition(machine)
    const [next, actions] = transition(machine, init, { type: 'NEXT' })

    yield* expect({
      value: next.value,
      context: next.context,
      actions,
      getTransitionDataCalls,
    }).toEqual({
      value: 'b',
      context: { count: 1 },
      actions: [],
      getTransitionDataCalls: [],
    })
  })

  it('fast-paths flat static targetless context transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      context: { count: 0 },
      states: {
        a: {
          on: {
            INC: {
              context: { count: 1 },
            },
          },
        },
      },
    })
    const getTransitionDataCalls: unknown[] = []
    machine.getTransitionData = () => {
      getTransitionDataCalls.push('getTransitionData')
      return []
    }

    const [init] = initialTransition(machine)
    const [next, actions] = transition(machine, init, { type: 'INC' })

    yield* expect({
      value: next.value,
      context: next.context,
      actions,
      getTransitionDataCalls,
    }).toEqual({
      value: 'a',
      context: { count: 1 },
      actions: [],
      getTransitionDataCalls: [],
    })
  })
})

describe('getNextTransitions', () => {
  it('should return no transitions for an error snapshot', function*({ expect }) {
    const machineV1 = createMachine({
      version: '1',
      initial: 'a',
      states: { a: {} },
    })
    const machineV2 = createMachine({
      version: '2',
      initial: 'a',
      states: { a: {} },
    })
    const persisted = createActor(machineV1).start().getPersistedSnapshot()
    const errorSnapshot = createActor(machineV2, {
      snapshot: persisted,
    }).getSnapshot()

    yield* expect({
      status: errorSnapshot.status,
      transitions: getNextTransitions(errorSnapshot),
    }).toEqual({
      status: 'error',
      transitions: [],
    })
  })

  it('should return no transitions for a completed snapshot', function*({ expect }) {
    const machine = createMachine({
      initial: 'done',
      on: { RESET: { target: '.done' } },
      states: { done: { type: 'final' } },
    })
    const doneSnapshot = createActor(machine).getSnapshot()

    yield* expect({
      status: doneSnapshot.status,
      transitions: getNextTransitions(doneSnapshot),
    }).toEqual({
      status: 'done',
      transitions: [],
    })
  })

  it('should return all transitions from current state', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            GO_B: { target: 'b' },
            GO_C: { target: 'c' },
          },
        },
        b: {},
        c: {},
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order should be deterministic: transitions appear in the order they're defined
    yield* expect(transitions.map((t) => t.eventType)).toEqual([
      'GO_B',
      'GO_C',
    ])
  })

  it('should include guarded transitions regardless of guard result', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: { count: 100 },
      states: {
        a: {
          on: {
            GO_B: ({ context }) => {
              if (context.count < 10) {
                return { target: 'b' }
              }
              return { target: 'd' }
            },
            GO_C: ({ context }) => {
              if (context.count > 50) {
                return { target: 'c' }
              }
              return undefined
            },
          },
        },
        b: {},
        c: {},
        d: {},
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order should be deterministic: all GO_B transitions first (in order), then GO_C
    yield* expect(transitions.map((t) => t.eventType)).toEqual([
      'GO_B',
      'GO_C',
    ])
  })

  it('should include always (eventless) transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: { count: 5 },
      states: {
        a: {
          always: ({ context }) => {
            if (context.count > 10) {
              return { target: 'b' }
            } else if (!1) {
              return { target: 'c' }
            }
            return undefined
          },
          on: {
            GO_D: { target: 'd' },
          },
        },
        b: {},
        c: {},
        d: {},
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order: on transitions first, then always transitions (in order they appear)
    yield* expect(transitions.map((t) => t.eventType)).toEqual(['GO_D', ''])
  })

  it('should include after (delayed) transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          after: {
            1000: { target: 'b' },
          },
          on: {
            GO_C: { target: 'c' },
          },
        },
        b: {},
        c: {},
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    const secondTransition = transitions[1]
    if (secondTransition === undefined) {
      throw new Error('expected a second transition')
    }
    // Order: on transitions first (in definition order), then after transitions
    yield* expect({
      eventTypes: transitions.map((t) => t.eventType),
      secondMatches: secondTransition.matches,
      targets: transitions.map((t) => t.target?.[0]?.key),
    }).toEqual({
      eventTypes: ['GO_C', 'xstate.after'],
      secondMatches: { delay: 1000, stateId: '(machine).a' },
      targets: ['c', 'b'],
    })
  })

  it('should include transitions from parent states in depth-first order', function*({ expect }) {
    const machine = createMachine({
      initial: 'parent',
      states: {
        parent: {
          initial: 'child',
          on: {
            PARENT_EVENT: { target: 'other' },
          },
          states: {
            child: {
              on: {
                CHILD_EVENT: { target: 'sibling' },
              },
            },
            sibling: {},
          },
        },
        other: {},
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order: child state transitions first, then parent state transitions
    yield* expect(transitions.map((t) => t.eventType)).toEqual([
      'CHILD_EVENT',
      'PARENT_EVENT',
    ])
  })

  it('should include all guarded transitions from different state nodes with same event type', function*({ expect }) {
    const machine = createMachine({
      initial: 'parent',
      states: {
        parent: {
          initial: 'child',
          on: {
            SAME_EVENT: () => {
              if (!1) {
                return { target: 'parentTarget' }
              }
              return { target: 'parentTarget2' }
            },
          },
          states: {
            child: {
              on: {
                SAME_EVENT: {
                  target: 'childTarget',
                },
              },
            },
            childTarget: {},
          },
        },
        parentTarget: {},
        parentTarget2: {},
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    const sameEventTransitions = transitions.filter(
      (t) => t.eventType === 'SAME_EVENT',
    )
    yield* expect({
      transitionCount: transitions.length,
      // Wrapped into 1 transition in v6
      sameEventCount: sameEventTransitions.length,
    }).toEqual({
      transitionCount: 2,
      sameEventCount: 2,
    })
  })

  it('should return transitions from parallel states in document order', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        regionA: {
          initial: 'a1',
          on: {
            REGION_A_EVENT: { target: '.a2' },
          },
          states: {
            a1: {
              on: {
                A1_EVENT: { target: 'a2' },
              },
            },
            a2: {},
          },
        },
        regionB: {
          initial: 'b1',
          on: {
            REGION_B_EVENT: { target: '.b2' },
          },
          states: {
            b1: {
              on: {
                B1_EVENT: { target: 'b2' },
              },
            },
            b2: {},
          },
        },
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order: regionA atomic state first (depth-first), then regionB atomic state
    // Within each: child transitions first, then parent transitions
    yield* expect(transitions.map((t) => t.eventType)).toEqual([
      'A1_EVENT', // regionA.a1 (atomic)
      'REGION_A_EVENT', // regionA (parent)
      'B1_EVENT', // regionB.b1 (atomic)
      'REGION_B_EVENT', // regionB (parent)
    ])
  })

  it('should return transitions from deeply nested compound states in depth-first order', function*({ expect }) {
    const machine = createMachine({
      initial: 'level1',
      on: {
        ROOT_EVENT: { target: '.level1' },
      },
      states: {
        level1: {
          initial: 'level2',
          on: {
            LEVEL1_EVENT: { target: '.level2' },
          },
          states: {
            level2: {
              initial: 'level3',
              on: {
                LEVEL2_EVENT: { target: '.level3' },
              },
              states: {
                level3: {
                  on: {
                    LEVEL3_EVENT: { target: 'level3' },
                  },
                },
              },
            },
          },
        },
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order: deepest state first, then ancestors up to root
    yield* expect(transitions.map((t) => t.eventType)).toEqual([
      'LEVEL3_EVENT', // level3 (atomic, deepest)
      'LEVEL2_EVENT', // level2 (parent of level3)
      'LEVEL1_EVENT', // level1 (grandparent)
      'ROOT_EVENT', // root (great-grandparent)
    ])
  })

  it('should return transitions from parallel states with nested compound states', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      on: {
        ROOT_EVENT: {},
      },
      states: {
        regionA: {
          initial: 'nested',
          on: {
            REGION_A_EVENT: { target: '.nested' },
          },
          states: {
            nested: {
              initial: 'deep',
              on: {
                NESTED_A_EVENT: { target: '.deep' },
              },
              states: {
                deep: {
                  on: {
                    DEEP_A_EVENT: { target: 'deep' },
                  },
                },
              },
            },
          },
        },
        regionB: {
          initial: 'leaf',
          on: {
            REGION_B_EVENT: { target: '.leaf' },
          },
          states: {
            leaf: {
              on: {
                LEAF_B_EVENT: { target: 'leaf' },
              },
            },
          },
        },
      },
    })

    const actor = createActor(machine)
    actor.start()
    const state = actor.getSnapshot()

    const transitions = getNextTransitions(state)

    // Order: regionA's atomic state (depth-first up to regionA),
    // then regionB's atomic state (depth-first up to regionB),
    // then root
    yield* expect(transitions.map((t) => t.eventType)).toEqual([
      'DEEP_A_EVENT', // regionA.nested.deep (atomic)
      'NESTED_A_EVENT', // regionA.nested
      'REGION_A_EVENT', // regionA
      'ROOT_EVENT', // root
      'LEAF_B_EVENT', // regionB.leaf (atomic)
      'REGION_B_EVENT', // regionB
    ])
  })
})
