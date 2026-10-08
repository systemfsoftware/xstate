import { describe } from '@systemfsoftware/vitest'
import {
  createActor,
  createMachine,
  initialTransition,
  type InspectionEvent,
  isUnhandled,
  transition,
} from '../src/index.js'

const machine = createMachine({
  id: 'toggle',
  initial: 'a',
  states: {
    a: {
      on: {
        NOOP: () => ({}),
        NEXT: { target: 'b' },
      },
    },
    b: {},
  },
})

describe('unhandled events', (it) => {
  it('transition() returns the same snapshot reference and no effects for an unhandled event', function*({ expect }) {
    const [snapshot] = initialTransition(machine)
    const result = transition(machine, snapshot, { type: 'UNKNOWN' } as any)

    yield* expect({
      sameSnapshot: result[0] === snapshot,
      effects: result[1],
      unhandled: isUnhandled(snapshot, result),
    }).toEqual({ sameSnapshot: true, effects: [], unhandled: true })
  })

  it('transition() returns a new snapshot object for a handled event that changes nothing', function*({ expect }) {
    const [snapshot] = initialTransition(machine)
    const result = transition(machine, snapshot, { type: 'NOOP' })

    yield* expect({
      sameSnapshot: result[0] === snapshot,
      value: result[0].value,
      unhandled: isUnhandled(snapshot, result),
    }).toEqual({ sameSnapshot: false, value: 'a', unhandled: false })
  })

  it('calls onUnhandledEvent with the event and unchanged snapshot', function*({ expect }) {
    const calls: Array<[unknown, unknown]> = []
    const onUnhandledEvent = (event: unknown, snapshot: unknown) => {
      calls.push([event, snapshot])
    }
    const actor = createActor(machine, { onUnhandledEvent }).start()
    const snapshot = actor.getSnapshot()
    actor.send({ type: 'UNKNOWN' } as any)

    yield* expect({
      calls,
      snapshotUnchanged: actor.getSnapshot() === snapshot,
    }).toEqual({
      calls: [[{ type: 'UNKNOWN' }, snapshot]],
      snapshotUnchanged: true,
    })
  })

  it('shows an unhandled event in the inspection stream as a transition with the same snapshot', function*({ expect }) {
    const events: InspectionEvent[] = []
    const actor = createActor(machine, {
      inspect: (ev) => {
        events.push(ev)
      },
    }).start()
    const before = actor.getSnapshot()
    actor.send({ type: 'UNKNOWN' } as any)

    const transitions = events.filter(
      (ev): ev is Extract<InspectionEvent, { type: '@xstate.transition' }> =>
        ev.type === '@xstate.transition' && ev.event.type === 'UNKNOWN',
    )
    const firstTransition = transitions[0]

    yield* expect({
      count: transitions.length,
      snapshotIsBefore: firstTransition?.snapshot === before,
      hasUnhandledNamedEvent: events.some((ev) => (ev.type as string).includes('unhandled')),
    }).toEqual({
      count: 1,
      snapshotIsBefore: true,
      hasUnhandledNamedEvent: false,
    })
  })

  it('warns once per event type per actor in development', function*({ expect }) {
    const written: string[] = []
    const actor = createActor(machine, {
      warn: (message) => written.push(message),
    }).start()
    actor.send({ type: 'UNKNOWN' } as any)
    actor.send({ type: 'UNKNOWN' } as any)

    yield* expect(written).toEqual([
      `Actor ${actor.id} received event "UNKNOWN" in state "a" with no matching transition`,
    ])
  })

  it('does not report handled, wildcard-matched or internal xstate.* events', function*({ expect }) {
    const calls: Array<[unknown, unknown]> = []
    const written: string[] = []
    const onUnhandledEvent = (event: unknown, snapshot: unknown) => {
      calls.push([event, snapshot])
    }
    const actor = createActor(
      createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NOOP: () => ({}),
              'wild.*': () => ({}),
            },
          },
        },
      }),
      { onUnhandledEvent, warn: (message) => written.push(message) },
    ).start()
    actor.send({ type: 'NOOP' })
    actor.send({ type: 'wild.card' } as any)
    actor.send({ type: 'xstate.snapshot.actor' } as any)

    yield* expect({ calls, warnings: written }).toEqual({
      calls: [],
      warnings: [],
    })
  })
})
