import { describe, it } from '@systemfsoftware/vitest'
import { createMockActorScope } from '../src/graph/actorScope.js'
import { createActor, createMachine, initialSystemTransition, systemTransition } from '../src/index.js'
import { allocateChildId } from '../src/transitionActions.js'

describe('development warning sink', () => {
  it('routes the dead-letter warning through the actor system sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'sender',
      initial: 'active',
      states: {
        active: {
          on: {
            NEXT: (_args, enq) => {
              enq.sendTo('worker', { type: 'PING' })
              return { target: 'done' }
            },
          },
        },
        done: {},
      },
    })

    const actor = createActor(machine, {
      warn: (message) => written.push(message),
    }).start()
    actor.send({ type: 'NEXT' })

    yield* expect(written).toEqual([
      'Actor "sender" sent event "PING" to missing target "worker"; the event was not delivered (missingTarget).',
    ])
  })

  it('routes the unhandled-event warning through the actor sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'sentinel',
      initial: 'a',
      states: {
        a: { on: { NOOP: () => ({}) } },
        b: { on: { UNKNOWN: () => ({}) } },
      },
    })

    const actor = createActor(machine, {
      warn: (message) => written.push(message),
    }).start()
    actor.send({ type: 'UNKNOWN' })

    yield* expect(written).toEqual([
      'Actor sentinel received event "UNKNOWN" in state "a" with no matching transition',
    ])
  })

  it('routes the wildcard-position warning through the actor scope sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'wild',
      initial: 'start',
      states: {
        start: {
          on: {
            'eventually.bar.baz': { target: 'success' },
            'event*.bar.*': { target: 'success' },
          },
        },
        success: { type: 'final' },
      },
    })

    const actor = createActor(machine, {
      warn: (message) => written.push(message),
    }).start()
    actor.send({ type: 'eventually.bar.baz' })

    yield* expect(written).toEqual([
      'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "event*.bar.*" event.',
    ])
  })

  it('routes the infix-wildcard warning through the actor scope sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'infix',
      initial: 'start',
      states: {
        start: {
          on: {
            'event.foo.bar.x': { target: 'success' },
            'event.*.bar.*': { target: 'success' },
          },
        },
        success: { type: 'final' },
      },
    })

    const actor = createActor(machine, {
      warn: (message) => written.push(message),
    }).start()
    actor.send({ type: 'event.foo.bar.x' })

    yield* expect(written).toEqual([
      'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "event.*.bar.*" event.',
      'Infix wildcards in transition events are not allowed. Check the "event.*.bar.*" transition.',
    ])
  })

  it('routes the unresolved-history warning through the actor scope sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'hist',
      initial: 'a',
      states: { a: {} },
    })
    const persisted = JSON.parse(
      JSON.stringify(createActor(machine).start().getPersistedSnapshot()),
    )

    createActor(machine, {
      snapshot: {
        ...persisted,
        historyValue: { 'hist.hist': [{ id: 'nonexistent' }] },
      },
      warn: (message) => written.push(message),
    }).start()

    yield* expect(written).toEqual([
      'Could not resolve StateNode for id: nonexistent',
    ])
  })

  it('routes the eventless-restore warning through the actor scope sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'restore',
      initial: 'waiting',
      states: {
        waiting: { always: () => undefined },
        done: {},
      },
    })
    const persisted = createActor(machine).start().getPersistedSnapshot()

    createActor(machine, {
      snapshot: persisted,
      warn: (message) => written.push(message),
    }).start()

    yield* expect(written).toEqual([
      'Restored snapshot is in state "restore.waiting" which has eventless transitions; they are not re-evaluated until the next event',
    ])
  })

  it('routes the non-JSON-payload warning through the actor sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'p',
      context: { fn: () => undefined },
    })

    createActor(machine, {
      warn: (message) => written.push(message),
    }).getPersistedSnapshot()

    yield* expect(written).toEqual([
      "Persisted snapshot of machine 'p' contains a non-JSON value (function) at 'context.fn'. Persisted snapshots must be JSON-serializable; this value will be lost or throw in JSON.stringify.",
    ])
  })

  it('routes the deprecated dynamic-mapping warning through the actor system sink', function*({ expect }) {
    const written: string[] = []
    const machine = createMachine({
      id: 'out',
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b' } } },
        b: { type: 'final' },
      },
      output: { foo: () => 1 },
    })

    const actor = createActor(machine, {
      warn: (message) => written.push(message),
    }).start()
    actor.send({ type: 'GO' })

    yield* expect(written).toEqual([
      'Dynamically mapping values to individual properties is deprecated. Use a single function that returns the mapped object instead.\nFound object containing properties whose values are possibly mapping functions: \n - foo: () => 1',
    ])
  })

  it('completes a pure system transition whose root output is a dynamic mapping', function*({ expect }) {
    const outputMapper = () => ({ type: 'mapped' })
    const machine = createMachine({
      id: 'root',
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b' } } },
        b: { type: 'final' },
      },
      output: { foo: outputMapper },
    })
    const logic = { root: machine, mappers: { foo: outputMapper } }

    const [snapshot] = initialSystemTransition(logic)
    const [next] = systemTransition(logic, snapshot, snapshot.root, {
      type: 'GO',
    })

    const root = next.actors[next.root]
    yield* expect({
      status: root?.snapshot['status'],
      output: root?.snapshot['output'],
    }).toEqual({
      status: 'done',
      output: { foo: { $systemMapper: 'foo' } },
    })
  })

  it('routes the spawn-allocation warning through the actor scope sink', function*({ expect }) {
    const written: string[] = []
    const scope = {
      ...createMockActorScope(),
      warn: (message: string) => written.push(message),
    }

    allocateChildId(scope, 'child')

    yield* expect(written).toEqual([
      'A child id was generated outside a spawn-allocation transaction; ids may repeat across enqueue objects. Transition entry points must call beginSpawnAllocation().',
    ])
  })
})
