import { describe, expectTypeOf, it } from '@systemfsoftware/vitest'
import { XSTATE_INIT } from '../src/constants.js'
import {
  type ActorInspectionEvent,
  createActor,
  createMachine,
  type EventRejection,
  type InspectionEvent,
  SimulatedClock,
  type TransitionInspectionEvent,
} from '../src/index.js'

describe('v6 inspection protocol conformance', () => {
  const childMachine = createMachine({
    initial: 'idle',
    states: {
      idle: { on: { PING: { target: 'pinged' } } },
      pinged: {},
    },
  })

  function namedAction() {}

  function buildMachine() {
    return createMachine({
      context: { count: 0 } as { count: number; childRef?: unknown },
      initial: 'start',
      states: {
        start: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childMachine, { id: 'myChild' })
            enq(namedAction)
            enq.raise({ type: 'GO' }, { delay: 100 })
            enq.sendTo(childRef, { type: 'PING' }, { delay: 50, id: 'ping-1' })
            return { context: { count: 0, childRef } }
          },
          on: { GO: { target: 'middle' } },
        },
        middle: {
          always: ({ context }) => {
            if (context.count < 2) {
              return { context: { count: context.count + 1 } }
            }
            return { target: 'done' }
          },
        },
        done: { type: 'final' },
      },
    })
  }

  function runAndCollect() {
    const events: InspectionEvent[] = []
    const clock = new SimulatedClock()
    const actor = createActor(buildMachine(), {
      inspect: (ev) => events.push(ev),
      clock,
    })
    actor.start()
    clock.increment(100)
    return { events, actor }
  }

  const actorEvents = (events: InspectionEvent[]) =>
    events.filter((e): e is ActorInspectionEvent => e.type === '@xstate.actor')
  const transitionEvents = (events: InspectionEvent[]) =>
    events.filter(
      (e): e is TransitionInspectionEvent => e.type === '@xstate.transition',
    )

  const snapshotValue = (snapshot: unknown): unknown =>
    typeof snapshot === 'object' && snapshot !== null && 'value' in snapshot
      ? snapshot.value
      : undefined

  it('emits exactly one @xstate.actor topology event per actor, with parentRef', function*({ expect }) {
    const { events, actor } = runAndCollect()
    const actors = actorEvents(events)

    const root = actors.find((a) => a.parentRef === undefined)
    const child = actors.find((a) => a.id === 'myChild')

    yield* expect({
      actorCount: actors.length,
      rootRefIsActor: root?.actorRef === actor,
      rootSnapshotValue: snapshotValue(root?.snapshot),
      childParentIsActor: child?.parentRef === actor,
      childSnapshotValue: snapshotValue(child?.snapshot),
    }).toEqual({
      actorCount: 2,
      rootRefIsActor: true,
      rootSnapshotValue: 'start',
      childParentIsActor: true,
      childSnapshotValue: 'idle',
    })
  })

  it('captures every executed action in actions[]', function*({ expect }) {
    const { events } = runAndCollect()
    const actionTypes = transitionEvents(events).flatMap((e) => e.actions.map((a) => a.type))

    yield* expect(actionTypes).toEqual(
      expect.arrayContaining(['namedAction', '@xstate.sendTo']),
    )
  })

  it('captures every relayed/scheduled event in sent[] with delay & id', function*({ expect }) {
    const { events, actor } = runAndCollect()
    const sent = transitionEvents(events).flatMap((e) => e.sent)

    const ping = sent.find((s) => s.event.type === 'PING')
    const go = sent.find((s) => s.event.type === 'GO')

    yield* expect({
      ping: ping && {
        delay: ping.delay,
        id: ping.id,
        targetId: ping.targetId,
      },
      go: go && {
        delay: go.delay,
        targetId: go.targetId,
      },
    }).toEqual({
      ping: { delay: 50, id: 'ping-1', targetId: 'myChild' },
      go: { delay: 100, targetId: actor.id },
    })
  })

  it('captures microsteps of a multi-microstep transition', function*({ expect }) {
    const { events } = runAndCollect()
    const hasMicrosteps = transitionEvents(events).some(
      (e) => e.microsteps.length > 0,
    )
    const last = transitionEvents(events).at(-1)!

    yield* expect({
      hasMicrosteps,
      lastSnapshotValue: snapshotValue(last.snapshot),
    }).toEqual({ hasMicrosteps: true, lastSnapshotValue: 'done' })
  })

  it('all facets are flat & always-present (no narrowing on absent fields)', function*({ expect }) {
    const { events } = runAndCollect()

    yield* expect({
      actorFacets: actorEvents(events).every((e) =>
        'parentRef' in e &&
        typeof e.id === 'string' &&
        e.snapshot !== undefined &&
        'src' in e
      ),
      transitionFacets: transitionEvents(events).every((e) =>
        Array.isArray(e.actions) &&
        Array.isArray(e.sent) &&
        Array.isArray(e.microsteps) &&
        e.event !== undefined &&
        e.snapshot !== undefined
      ),
    }).toEqual({ actorFacets: true, transitionFacets: true })
  })

  it('actor tree + action timeline are fully reconstructable from the two event types alone', function*({ expect }) {
    const { events, actor } = runAndCollect()

    const tree = new Map<string, string[]>()
    for (const a of actorEvents(events)) {
      const parentId = a.parentRef !== undefined &&
          'id' in a.parentRef &&
          typeof a.parentRef.id === 'string'
        ? a.parentRef.id
        : '(root)'
      const list = tree.get(parentId) ?? []
      list.push(a.id)
      tree.set(parentId, list)
    }

    const timeline = transitionEvents(events).flatMap((e) => e.actions.map((a) => a.type))

    const initEvent = transitionEvents(events).find(
      (e) => e.event.type === XSTATE_INIT,
    )

    yield* expect({
      rootChildren: tree.get('(root)'),
      childUnderRoot: (tree.get(actor.id) ?? []).includes('myChild'),
      timelineHasActions: timeline.length > 0,
      timelineHasNamedAction: timeline.includes('namedAction'),
      hasInitEvent: initEvent !== undefined,
    }).toEqual({
      rootChildren: [actor.id],
      childUnderRoot: true,
      timelineHasActions: true,
      timelineHasNamedAction: true,
      hasInitEvent: true,
    })
  })

  it('the protocol is exactly @xstate.actor and @xstate.transition', function*({ expect }) {
    const types = new Set<string>()
    createActor(buildMachine(), {
      inspect: (e) => types.add(e.type),
    }).start()

    yield* expect([...types].sort()).toEqual([
      '@xstate.actor',
      '@xstate.transition',
    ])

    expectTypeOf<InspectionEvent['type']>().toEqualTypeOf<
      '@xstate.actor' | '@xstate.transition'
    >()
  })

  it('reports dead letters through onRejectedEvent, not inspection', function*({ expect }) {
    const types = new Set<string>()
    const rejections: EventRejection[] = []
    const actor = createActor(buildMachine(), {
      inspect: (e) => types.add(e.type),
      onRejectedEvent: (rejection) => rejections.push(rejection),
    }).start()
    actor.stop()
    actor.send({ type: 'LATE' } as unknown as Parameters<typeof actor.send>[0])

    yield* expect({
      types: [...types].sort(),
      rejections: rejections.map((rejection) => ({
        event: rejection.event,
        targetRef: rejection.targetRef === actor,
        sourceRef: rejection.sourceRef,
        reason: rejection.reason,
      })),
    }).toEqual({
      types: ['@xstate.actor', '@xstate.transition'],
      rejections: [
        {
          event: { type: 'LATE' },
          targetRef: true,
          sourceRef: undefined,
          reason: 'stopped',
        },
      ],
    })
  })
})
