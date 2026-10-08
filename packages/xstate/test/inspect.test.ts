import { describe, it, vi } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { XSTATE_INIT } from '../src/constants.js'
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createMachine,
  type InspectionEvent,
  isMachineSnapshot,
  waitFor,
} from '../src/index.js'
// import removed: action events are unified under '@xstate.transition'

function simplifyEvents(
  inspectionEvents: InspectionEvent[],
  filter?: (ev: InspectionEvent) => boolean,
) {
  return inspectionEvents
    .filter(filter ?? (() => true))
    .map((inspectionEvent) => {
      if (inspectionEvent.type === '@xstate.transition') {
        return {
          type: inspectionEvent.type,
          sourceId: inspectionEvent.sourceRef?.sessionId,
          targetId: inspectionEvent.targetRef?.sessionId ??
            inspectionEvent.actorRef.sessionId,
          event: inspectionEvent.event,
          eventType: inspectionEvent.eventType,
          snapshot: isMachineSnapshot(inspectionEvent.snapshot)
            ? {
              value: (inspectionEvent.snapshot as any).value,
              context: (inspectionEvent.snapshot as any).context,
            }
            : inspectionEvent.snapshot,
          status: (inspectionEvent.snapshot as any).status,
          microsteps: (inspectionEvent.microsteps || []).map((t: any) => ({
            eventType: t.eventType,
            target: t.target?.map((target: any) => target.id) ?? [],
          })),
        } as any
      }
    })
    .filter(Boolean as any)
}

describe('inspect', (it) => {
  it('uses globally unique session IDs across actor systems', function*({ expect }) {
    const machine = createMachine({
      invoke: {
        id: 'child',
        src: createMachine({}),
      },
    })
    const events: InspectionEvent[] = []

    const actorA = createActor(machine, {
      inspect: (event) => events.push(event),
    })
    const actorB = createActor(machine, {
      inspect: (event) => events.push(event),
    })

    actorA.start()
    actorB.start()

    const rootIds = [...new Set(events.map((event) => event.rootId))].sort()
    yield* expect({
      idA: actorA.id,
      idB: actorB.id,
      differentSessions: actorA.sessionId !== actorB.sessionId,
      actorRefSessionCount: new Set(
        events.map((event) => event.actorRef.sessionId),
      ).size,
      rootIds,
    }).toEqual({
      idA: 'x:0',
      idB: 'x:0',
      differentSessions: true,
      actorRefSessionCount: 4,
      rootIds: [actorA.sessionId, actorB.sessionId].sort(),
    })
  })

  it('falls back without failing when Web Crypto is unusable', function*({ expect }) {
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('unavailable')
      },
      getRandomValues: () => {
        throw new Error('unavailable')
      },
    })
    const sessionIds: string[] = []

    try {
      vi.resetModules()
      const isolatedXState = yield* Effect.promise(() => import('../src/index.js'))
      sessionIds.push(
        isolatedXState.createActor(isolatedXState.createMachine({})).sessionId,
        isolatedXState.createActor(isolatedXState.createMachine({})).sessionId,
      )
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }

    yield* expect({
      uniqueSessions: new Set(sessionIds).size,
      allFallbackPrefixed: sessionIds.every((id) => id.startsWith('xstate-')),
    }).toEqual({ uniqueSessions: 2, allFallbackPrefixed: true })
  })

  it('uses new globally unique session IDs when restoring the same snapshot', function*({ expect }) {
    const child = createMachine({})
    const machine = createMachine({
      actors: { child },
      invoke: { id: 'child', src: child },
    })
    const original = createActor(machine).start()
    const snapshot = JSON.parse(
      JSON.stringify(original.getPersistedSnapshot()),
    )
    original.stop()
    const events: InspectionEvent[] = []

    const restoredA = createActor(machine, {
      snapshot,
      inspect: (event) => events.push(event),
    })
    const restoredB = createActor(machine, {
      snapshot,
      inspect: (event) => events.push(event),
    })

    const restoredAChild = restoredA.getSnapshot().children['child']
    const restoredBChild = restoredB.getSnapshot().children['child']
    if (restoredAChild === undefined) {
      throw new Error('expected a restored child for A')
    }
    if (restoredBChild === undefined) {
      throw new Error('expected a restored child for B')
    }
    yield* expect({
      differentChildSessions: restoredAChild.sessionId !==
        restoredBChild.sessionId,
      childActorSessionCount: new Set(
        events
          .filter(
            (event) => event.type === '@xstate.actor' && event.id === 'child',
          )
          .map((event) => event.actorRef.sessionId),
      ).size,
    }).toEqual({ differentChildSessions: true, childActorSessionCount: 2 })
  })

  it('the .inspect option can observe inspection events', function*({ expect }) {
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

    const events: InspectionEvent[] = []

    const actor = createActor(machine, {
      inspect: (ev) => events.push(ev),
      id: 'parent',
    })
    actor.start()

    actor.send({ type: 'NEXT' })
    actor.send({ type: 'NEXT' })

    const simplified = simplifyEvents(
      events,
      (ev) => ev.type === '@xstate.transition',
    ) as any[]
    yield* expect({
      eventTypes: simplified.map((e) => e.event.type),
      values: simplified.map((e) => e.snapshot.value),
    }).toEqual({
      eventTypes: ['@xstate.init', 'NEXT', 'NEXT'],
      values: ['a', 'b', 'c'],
    })
  })

  it('can inspect communications between actors', function*({ expect }) {
    const parentMachine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {},
        success: {},
      },
      invoke: {
        src: createMachine({
          initial: 'start',
          states: {
            start: {
              on: {
                loadChild: { target: 'loading' },
              },
            },
            loading: {
              invoke: {
                src: createAsyncLogic({
                  run: () => {
                    return Promise.resolve(42)
                  },
                }),
                onDone: ({ parent }) => {
                  parent?.send({ type: 'toParent' })
                  return {
                    target: 'loaded',
                  }
                },
              },
            },
            loaded: {
              type: 'final',
            },
          },
        }),
        id: 'child',
        onDone: (_, enq) => {
          enq(() => {})
          return {
            target: '.success',
          }
        },
      },
      on: {
        load: ({ children }) => {
          const child = children['child']
          if (child === undefined) {
            throw new Error('expected a child actor')
          }
          child.send({ type: 'loadChild' })
        },
      },
    })

    const events: InspectionEvent[] = []

    const actor = createActor(parentMachine, {
      inspect: {
        next: (event) => {
          events.push(event)
        },
      },
    })

    actor.start()
    actor.send({ type: 'load' })

    yield* Effect.promise(() => waitFor(actor, (state) => state.value === 'success'))

    const simplified = simplifyEvents(
      events,
      (ev) => ev.type === '@xstate.transition',
    ) as any[]
    const parentEvents = simplified.filter(
      (e) => e.targetId === actor.sessionId,
    )
    yield* expect({
      initCountAtLeastTwo: simplified.filter((e) => e.event.type === XSTATE_INIT).length >= 2,
      lastParentValue: parentEvents[parentEvents.length - 1].snapshot.value,
    }).toEqual({ initCountAtLeastTwo: true, lastParentValue: 'success' })
  })

  it('preserves the source of events delivered through snapshot actor refs', function*({ expect }) {
    const childMachine = createMachine({
      on: {
        PING: {},
      },
    })
    const parentMachine = createMachine({
      invoke: { id: 'child', src: childMachine },
      on: {
        SEND: ({ children }, enq) => enq.sendTo(children['child'], { type: 'PING' }),
      },
    })
    const events: InspectionEvent[] = []
    const actor = createActor(parentMachine, {
      inspect: (event) => events.push(event),
    }).start()
    const child = actor.getSnapshot().children['child']

    actor.send({ type: 'SEND' })

    const childTransition = events.find(
      (event) => event.type === '@xstate.transition' && event.event.type === 'PING',
    )
    if (childTransition?.type !== '@xstate.transition') {
      throw new Error('Child transition was not inspected.')
    }
    yield* expect({
      actorRefIsChild: childTransition?.actorRef === child,
      sourceRefIsActor: childTransition?.sourceRef === actor,
      targetRefIsChild: childTransition?.targetRef === child,
    }).toEqual({
      actorRefIsChild: true,
      sourceRefIsActor: true,
      targetRefIsChild: true,
    })
  })

  it('uses the snapshot actor ref as the source of child errors', function*({ expect }) {
    const childLogic = createCallbackLogic(() => {
      throw new Error('child failed')
    })
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: { id: 'child', src: childLogic },
          onError: { target: 'failed' },
        },
        failed: {},
      },
    })
    const events: InspectionEvent[] = []
    const actor = createActor(machine, {
      inspect: (event) => events.push(event),
    })
    const child = actor.getSnapshot().children['child']

    actor.start()

    const errorTransition = events.find(
      (event) =>
        event.type === '@xstate.transition' &&
        event.actorRef === actor &&
        event.event.type === 'xstate.error.actor' &&
        event.event['actorId'] === 'child',
    )
    if (errorTransition?.type !== '@xstate.transition') {
      throw new Error('Error transition was not inspected.')
    }
    yield* expect({
      sourceRefIsChild: errorTransition?.sourceRef === child,
    }).toEqual({ sourceRefIsChild: true })
  })

  it('uses the snapshot parent ref as the source of nested child init', function*({ expect }) {
    const parentLogic = createMachine({
      invoke: {
        id: 'child',
        src: createCallbackLogic(() => {}),
      },
    })
    const machine = createMachine({
      invoke: { id: 'parent', src: parentLogic },
    })
    const events: InspectionEvent[] = []
    const actor = createActor(machine, {
      inspect: (event) => events.push(event),
    })
    const parent = actor.getSnapshot().children['parent']
    if (parent === undefined) {
      throw new Error('expected a parent actor')
    }
    const child = parent.getSnapshot().children.child

    actor.start()

    const childInit = events.find(
      (event) =>
        event.type === '@xstate.transition' &&
        event.actorRef === child &&
        event.event.type === XSTATE_INIT,
    )
    if (childInit?.type !== '@xstate.transition') {
      throw new Error('Child init transition was not inspected.')
    }
    yield* expect({
      sourceRefIsParent: childInit?.sourceRef === parent,
    }).toEqual({ sourceRefIsParent: true })
  })

  it('can inspect microsteps from always events', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: { count: 0 },
      initial: 'counting',
      states: {
        counting: {
          always: ({ context }) => {
            if (context.count === 3) {
              return {
                target: 'done',
              }
            }
            return {
              context: {
                count: context.count + 1,
              },
            }
          },
        },
        done: {},
      },
    })

    const events: InspectionEvent[] = []

    createActor(machine, {
      inspect: (ev) => {
        events.push(ev)
      },
    }).start()

    const simplified = simplifyEvents(
      events,
      (ev) => ev.type === '@xstate.transition',
    ) as any[]
    yield* expect({
      length: simplified.length,
      eventType: simplified[0].event.type,
      value: simplified[0].snapshot.value,
      count: simplified[0].snapshot.context.count,
      hasMicrosteps: simplified[0].microsteps.length > 0,
    }).toEqual({
      length: 1,
      eventType: XSTATE_INIT,
      value: 'done',
      count: 3,
      hasMicrosteps: true,
    })
  })

  it('can inspect microsteps from raised events', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          entry: (_, enq) => {
            enq.raise({ type: 'to_b' })
          },
          on: { to_b: { target: 'b' } },
        },
        b: {
          entry: (_, enq) => {
            enq.raise({ type: 'to_c' })
          },
          on: { to_c: { target: 'c' } },
        },
        c: {},
      },
    })

    const events: InspectionEvent[] = []

    const actor = createActor(machine, {
      inspect: (ev) => {
        events.push(ev)
      },
    }).start()

    const simplified = simplifyEvents(events) as any[]
    const ms = simplified[0].microsteps.map(
      (m: { eventType: string }) => m.eventType,
    )
    yield* expect({
      matchesC: actor.getSnapshot().matches('c'),
      length: simplified.length,
      microsteps: ms,
      value: simplified[0].snapshot.value,
    }).toEqual({
      matchesC: true,
      length: 1,
      microsteps: ['to_b', 'to_c'],
      value: 'c',
    })
  })

  it('should inspect microsteps for normal transitions', function*({ expect }) {
    const events: any[] = []
    const machine = createMachine({
      initial: 'a',
      states: {
        a: { on: { EV: { target: 'b' } } },
        b: {},
      },
    })
    const actorRef = createActor(machine, {
      inspect: (ev) => events.push(ev),
    }).start()
    actorRef.send({ type: 'EV' })

    const simplified = simplifyEvents(events) as any[]
    yield* expect({
      eventTypes: simplified.map((e) => e.event.type),
      values: simplified.map((e) => e.snapshot.value),
    }).toEqual({ eventTypes: [XSTATE_INIT, 'EV'], values: ['a', 'b'] })
  })

  it('should inspect microsteps for eventless/always transitions', function*({ expect }) {
    const events: any[] = []
    const machine = createMachine({
      initial: 'a',
      states: {
        a: { on: { EV: { target: 'b' } } },
        b: { always: { target: 'c' } },
        c: {},
      },
    })
    const actorRef = createActor(machine, {
      inspect: (ev) => events.push(ev),
    }).start()
    actorRef.send({ type: 'EV' })

    const simplified = simplifyEvents(events) as any[]
    const stepTypes = simplified[1].microsteps.map(
      (m: { eventType: string }) => m.eventType,
    )
    yield* expect({
      length: simplified.length,
      firstEventType: simplified[0].event.type,
      firstValue: simplified[0].snapshot.value,
      secondEventType: simplified[1].event.type,
      secondValue: simplified[1].snapshot.value,
      stepTypes,
    }).toEqual({
      length: 2,
      firstEventType: XSTATE_INIT,
      firstValue: 'a',
      secondEventType: 'EV',
      secondValue: 'c',
      stepTypes: ['EV', ''],
    })
  })

  // TODO: fix way actions are inspected
  it('should inspect transitions when actions run', function*({ expect }) {
    const events: InspectionEvent[] = []

    const enter1 = () => {}
    const exit1 = () => {}
    const stringAction = () => {}
    const namedAction = (_params: { foo: string }) => {}

    const machine = createMachine({
      entry: (_, enq) => enq(enter1),
      exit: (_, enq) => enq(exit1),
      initial: 'loading',
      states: {
        loading: {
          on: {
            event: (_, enq) => {
              enq(stringAction)
              enq(namedAction, { foo: 'bar' })
              enq(() => {})
              return { target: 'done' }
            },
          },
        },
        done: {
          type: 'final',
        },
      },
    })

    const actor = createActor(machine, {
      inspect: (ev) => {
        if (ev.type === '@xstate.transition') {
          events.push(ev)
        }
      },
    })

    actor.start()
    actor.send({ type: 'event' })

    const simplified = simplifyEvents(
      events,
      (ev) => ev.type === '@xstate.transition',
    ) as any[]
    const last = simplified[simplified.length - 1]
    const stepTypes = last.microsteps.map(
      (m: { eventType: string }) => m.eventType,
    )
    yield* expect({
      atLeastTwo: simplified.length >= 2,
      lastEventType: last.event.type,
      lastValue: last.snapshot.value,
      containsEvent: stepTypes.includes('event'),
    }).toEqual({
      atLeastTwo: true,
      lastEventType: 'event',
      lastValue: 'done',
      containsEvent: true,
    })
  })

  it(
    '@xstate.transition inspection event should report no microsteps if an unknown event was sent',
    function*({ expect }) {
      const machine = createMachine({})
      const events: InspectionEvent[] = []
      const actor = createActor(machine, {
        inspect: (ev) => {
          events.push(ev)
        },
      })

      actor.start()
      actor.send({ type: 'any' })
      const simplified = simplifyEvents(
        events,
        (ev) => ev.type === '@xstate.transition',
      ) as any[]
      const last = simplified[simplified.length - 1]
      yield* expect({
        eventType: last.event.type,
        microstepCount: last.microsteps.length,
      }).toEqual({ eventType: 'any', microstepCount: 0 })
    },
  )

  it('actor.system.inspect(…) can inspect actors', function*({ expect }) {
    const actor = createActor(createMachine({}))
    const events: InspectionEvent[] = []

    actor.system.inspect((ev) => {
      events.push(ev)
    })

    actor.start()

    yield* expect({
      hasTransition: events.some((e) => e.type === '@xstate.transition'),
    }).toEqual({ hasTransition: true })
  })

  it('actor.system.inspect(…) captures initial microsteps before start', function*({ expect }) {
    const actor = createActor(
      createMachine({
        initial: 'a',
        states: {
          a: { always: () => ({ target: 'b' }) },
          b: {},
        },
      }),
    )
    const events: InspectionEvent[] = []

    actor.system.inspect((event) => events.push(event))
    actor.start()

    const initialTransition = events.find(
      (event) => event.type === '@xstate.transition' && event.event.type === XSTATE_INIT,
    )
    if (initialTransition?.type !== '@xstate.transition') {
      throw new Error('Initial transition was not inspected.')
    }
    yield* expect({
      type: initialTransition.type,
      microstepCount: initialTransition.microsteps.length,
    }).toEqual({ type: '@xstate.transition', microstepCount: 1 })
  })

  it('clears a pre-start event source before inspecting initialization', function*({ expect }) {
    const actor = createActor(createMachine({}))
    const sender = createActor(createMachine({}), { parent: actor })
    const events: InspectionEvent[] = []

    actor.system._relay(sender, actor, { type: 'QUEUED' })
    actor.system.inspect((event) => events.push(event))
    actor.start()

    const initialTransition = events.find(
      (event) => event.type === '@xstate.transition' && event.event.type === XSTATE_INIT,
    )
    if (initialTransition?.type !== '@xstate.transition') {
      throw new Error('Initial transition was not inspected.')
    }
    yield* expect({
      type: initialTransition.type,
      sourceRef: initialTransition.sourceRef,
    }).toEqual({ type: '@xstate.transition', sourceRef: undefined })
  })

  it('does not retain uninspected initialization steps for the first event', function*({ expect }) {
    const actor = createActor(
      createMachine({
        initial: 'a',
        states: {
          a: { always: { target: 'b' } },
          b: {},
        },
      }),
    )
    const events: InspectionEvent[] = []

    actor.start()
    actor.system.inspect((event) => events.push(event))
    actor.send({ type: 'PING' })

    const transition = events.find(
      (event) => event.type === '@xstate.transition' && event.event.type === 'PING',
    )
    if (transition?.type !== '@xstate.transition') {
      throw new Error('PING transition was not inspected.')
    }
    yield* expect({
      type: transition.type,
      microstepCount: transition.microsteps.length,
    }).toEqual({ type: '@xstate.transition', microstepCount: 0 })
  })

  it('actor.system.inspect(…) can inspect actors (observer)', function*({ expect }) {
    const actor = createActor(createMachine({}))
    const events: InspectionEvent[] = []

    actor.system.inspect({
      next: (ev) => {
        events.push(ev)
      },
    })

    actor.start()

    yield* expect({
      hasTransition: events.some((e) => e.type === '@xstate.transition'),
    }).toEqual({ hasTransition: true })
  })

  it('actor.system.inspect(…) can be unsubscribed', function*({ expect }) {
    const actor = createActor(createMachine({}))
    const events: InspectionEvent[] = []

    const sub = actor.system.inspect((ev) => {
      events.push(ev)
    })

    actor.start()

    const hadTransition = events.some((e) => e.type === '@xstate.transition')

    events.length = 0

    sub.unsubscribe()

    actor.send({ type: 'someEvent' })
    yield* expect({
      hadTransition,
      countAfterUnsubscribe: events.length,
    }).toEqual({ hadTransition: true, countAfterUnsubscribe: 0 })
  })

  it('actor.system.inspect(…) can be unsubscribed (observer)', function*({ expect }) {
    const actor = createActor(createMachine({}))
    const events: InspectionEvent[] = []

    const sub = actor.system.inspect({
      next: (ev) => {
        events.push(ev)
      },
    })

    actor.start()

    const hadTransition = events.some((e) => e.type === '@xstate.transition')

    events.length = 0

    sub.unsubscribe()

    actor.send({ type: 'someEvent' })
    yield* expect({
      hadTransition,
      countAfterUnsubscribe: events.length,
    }).toEqual({ hadTransition: true, countAfterUnsubscribe: 0 })
  })
})
