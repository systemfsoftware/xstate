import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import {
  type ActorLogic,
  type AnyActorSystem,
  createActor,
  createMachine,
  type Snapshot,
  transition,
} from '../src/index.js'
import { Mailbox } from '../src/Mailbox.js'

describe('runtime allocation lifecycle', () => {
  it('keeps idle-only storage lazy', function*({ expect }) {
    const actor = createActor(createMachine({})).start()
    const runtime = actor as unknown as {
      mailbox?: unknown
      observers?: unknown
      eventListeners?: unknown
      _trigger?: unknown
      _boundSend?: unknown
    }
    const runtimeSystem = actor.system as typeof actor.system & {
      _children?: unknown
      _inspectionObservers?: unknown
      _timerMap?: unknown
      _keyedActors?: unknown
      _reverseKeyedActors?: unknown
    }

    const before = {
      mailbox: runtime.mailbox,
      observers: runtime.observers,
      eventListeners: runtime.eventListeners,
      trigger: runtime._trigger,
      boundSend: runtime._boundSend,
      inspectionObservers: runtimeSystem._inspectionObservers,
      children: runtimeSystem._children,
      timerMap: runtimeSystem._timerMap,
      keyedActors: runtimeSystem._keyedActors,
      reverseKeyedActors: runtimeSystem._reverseKeyedActors,
      systemGetMissing: actor.system.get('missing'),
    }
    const keyedActorsAfterMissing = runtimeSystem._keyedActors

    actor.subscribe(() => {})
    actor.send({ type: 'event' })
    const triggerEvent = actor.trigger['event']
    if (triggerEvent === undefined) {
      throw new Error('expected a trigger for "event"')
    }
    triggerEvent()
    actor.system.inspect(() => {})

    yield* expect({
      ...before,
      keyedActorsAfterMissing,
      mailboxAfter: runtime.mailbox,
      observersAfter: runtime.observers,
      inspectionObserversAfter: runtimeSystem._inspectionObservers,
      triggerIsActorTrigger: runtime._trigger === actor.trigger,
      boundSendIsActorSend: runtime._boundSend === actor.send,
    }).toEqual({
      mailbox: undefined,
      observers: undefined,
      eventListeners: undefined,
      trigger: undefined,
      boundSend: undefined,
      inspectionObservers: undefined,
      children: undefined,
      timerMap: undefined,
      keyedActors: undefined,
      reverseKeyedActors: undefined,
      systemGetMissing: undefined,
      keyedActorsAfterMissing: undefined,
      mailboxAfter: expect.any(Mailbox),
      observersAfter: expect.any(Set),
      inspectionObserversAfter: expect.any(Set),
      triggerIsActorTrigger: true,
      boundSendIsActorSend: true,
    })
  })

  it('keeps the running root inline until registered actors are requested', function*({ expect }) {
    let transitionSawRoot = false
    let actor: ReturnType<typeof createActor>
    const machine = createMachine({
      on: {
        CHECK: ({ system }) => {
          transitionSawRoot = system.children.get(actor.sessionId) === actor
        },
      },
    })
    actor = createActor(machine).start()
    const runtimeSystem = actor.system as typeof actor.system & {
      _children?: Map<string, unknown>
    }

    const childrenBefore = runtimeSystem._children
    transition(machine, actor.getSnapshot(), { type: 'CHECK' })
    const sawRoot = transitionSawRoot
    const childrenAfterTransition = runtimeSystem._children
    const registeredIsActor = actor.system.children.get(actor.sessionId) === actor
    const childrenSize = runtimeSystem._children?.size

    yield* expect({
      childrenBefore,
      sawRoot,
      childrenAfterTransition,
      registeredIsActor,
      childrenSize,
    }).toEqual({
      childrenBefore: undefined,
      sawRoot: true,
      childrenAfterTransition: undefined,
      registeredIsActor: true,
      childrenSize: 1,
    })
  })

  it('shares runtime operations between independent systems', function*({ expect }) {
    const first = createActor(createMachine({}))
    const second = createActor(createMachine({}))

    yield* expect({
      sameSendEvent: first.system.sendEvent === second.system.sendEvent,
      hasOwnSendEvent: Object.hasOwn(first.system, 'sendEvent'),
    }).toEqual({
      sameSendEvent: true,
      hasOwnSendEvent: false,
    })
  })

  it('shares enumerable default actor options but copies explicit options', function*({ expect }) {
    const logic = createMachine({})
    const first = createActor(logic)
    const second = createActor(logic)
    const explicit = createActor(logic, {})

    yield* expect({
      sameDefaultOptions: first.options === second.options,
      defaultOptionKeys: Object.keys(first.options),
      explicitDiffers: explicit.options !== first.options,
      explicitOptionKeys: Object.keys(explicit.options),
    }).toEqual({
      sameDefaultOptions: true,
      defaultOptionKeys: ['clock', 'logger'],
      explicitDiffers: true,
      explicitOptionKeys: ['clock', 'logger'],
    })
  })

  it('keeps detachable actor-scope operations lazy', function*({ expect }) {
    type ScopeMethods = {
      defer: (fn: () => void) => void
      stopChild: (child: never) => void
      actionExecutor: (action: never) => void
    }
    const logic = createMachine({})
    const first = createActor(logic)
    const second = createActor(logic)
    const firstScope = (first as unknown as { _actorScope: ScopeMethods })
      ._actorScope
    const secondScope = (second as unknown as { _actorScope: ScopeMethods })
      ._actorScope

    const ownsDeferBefore = Object.hasOwn(firstScope, 'defer')
    const ownsStopChildBefore = Object.hasOwn(firstScope, 'stopChild')
    const ownsActionExecutorBefore = Object.hasOwn(firstScope, 'actionExecutor')

    const detachedDefer = firstScope.defer
    detachedDefer(() => {})

    yield* expect({
      ownsDeferBefore,
      ownsStopChildBefore,
      ownsActionExecutorBefore,
      deferSame: firstScope.defer === detachedDefer,
      ownsDeferAfter: Object.hasOwn(firstScope, 'defer'),
      ownsDeferSecond: Object.hasOwn(secondScope, 'defer'),
    }).toEqual({
      ownsDeferBefore: false,
      ownsStopChildBefore: false,
      ownsActionExecutorBefore: false,
      deferSame: true,
      ownsDeferAfter: true,
      ownsDeferSecond: false,
    })
  })

  it('keeps detached actor-scope operations callable asynchronously', function*({ expect }) {
    const childLogic = createMachine({})
    const actor = createActor(
      createMachine({
        invoke: { id: 'child', src: childLogic },
        on: { FLUSH: {} },
      }),
    ).start()
    const child = actor.getSnapshot().children['child']!
    const scope = (
      actor as unknown as {
        _actorScope: {
          defer: (fn: () => void) => void
          emit: (event: { type: string }) => void
          stopChild: (child: typeof actor) => void
          actionExecutor: (action: unknown) => void
        }
      }
    )._actorScope
    const { defer, emit, stopChild, actionExecutor } = scope
    let deferred = false
    let emitted = false
    let executed = false

    actor.on('scope-event' as never, () => {
      emitted = true
    })
    yield* Effect.promise(() => Promise.resolve())
    defer(() => {
      deferred = true
    })
    emit({ type: 'scope-event' })
    actionExecutor({
      type: 'scope-action',
      params: undefined,
      exec: () => {
        executed = true
      },
    })
    actor.send({ type: 'FLUSH' })
    stopChild(child as typeof actor)

    yield* expect({
      deferred,
      emitted,
      executed,
      childStatusIsStopped: child.getSnapshot().status === 'stopped',
    }).toEqual({
      deferred: true,
      emitted: true,
      executed: true,
      childStatusIsStopped: true,
    })
  })

  it('shares frozen empty snapshot records', function*({ expect }) {
    const machine = createMachine({})
    const first = createActor(machine).getSnapshot()
    const second = createActor(machine).getSnapshot()

    yield* expect({
      sameChildren: first.children === second.children,
      sameTimers: first.timers === second.timers,
      sameHistoryValue: first.historyValue === second.historyValue,
      sameStateInputs: first._stateInputs === second._stateInputs,
      childrenFrozen: Object.isFrozen(first.children),
    }).toEqual({
      sameChildren: true,
      sameTimers: true,
      sameHistoryValue: true,
      sameStateInputs: true,
      childrenFrozen: true,
    })
  })

  it('queues start-time events until logic start returns', function*({ expect }) {
    const order: string[] = []
    type QueuedEvent = { type: 'queued' }
    const initialSnapshot: Snapshot<never> = {
      status: 'active',
      output: undefined,
      error: undefined,
    }
    const logic: ActorLogic<
      Snapshot<never>,
      QueuedEvent,
      undefined,
      AnyActorSystem
    > = {
      initialTransition: () => [initialSnapshot, []],
      getInitialSnapshot: () => initialSnapshot,
      transition: (snapshot) => {
        order.push('transition')
        return [snapshot, []]
      },
      start: (_snapshot, scope) => {
        order.push('start:before')
        scope.system.sendEvent(scope.self, scope.self, { type: 'queued' })
        order.push('start:after')
      },
      getPersistedSnapshot: (snapshot) => snapshot,
    }

    createActor(logic).start()

    yield* expect(order).toEqual(['start:before', 'start:after', 'transition'])
  })
})
