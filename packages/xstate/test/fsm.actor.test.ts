import { describe, it } from '@systemfsoftware/vitest'
import { createActor } from '../src/createActor.js'
import { createFSM } from '../src/fsm.js'
import { initialTransition, transition } from '../src/transition.js'

function createCounter() {
  return createFSM<
    { count: number },
    { type: 'inc' } | { type: 'stop' },
    { active: unknown; stopped: unknown }
  >({
    initial: 'active',
    context: { count: 0 },
    states: {
      active: {
        on: {
          inc: ({ context }) => ({ context: { count: context.count + 1 } }),
          stop: 'stopped',
        },
      },
      stopped: {},
    },
  })
}

describe('createFSM as actor logic', () => {
  it('runs in createActor', function*({ expect }) {
    const actor = createActor(createCounter()).start()
    const values: string[] = []
    actor.subscribe((snapshot) => {
      values.push(`${snapshot.value}:${snapshot.context.count}`)
    })

    actor.send({ type: 'inc' })
    actor.send({ type: 'inc' })
    actor.send({ type: 'stop' })
    actor.send({ type: 'inc' })

    yield* expect({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
      status: actor.getSnapshot().status,
      values,
    }).toEqual({
      value: 'stopped',
      context: { count: 2 },
      status: 'active',
      values: ['active:1', 'active:2', 'stopped:2', 'stopped:2'],
    })
  })

  it('works with transition()', function*({ expect }) {
    const fsm = createCounter()
    const [next, effects] = transition(fsm, fsm.initialState, { type: 'inc' })

    yield* expect({
      value: next.value,
      context: next.context,
      effects,
      transitionResult: fsm.transition(fsm.initialState, { type: 'inc' }),
    }).toEqual({
      value: 'active',
      context: { count: 1 },
      effects: [],
      transitionResult: [next, []],
    })
  })

  it('works with initialTransition()', function*({ expect }) {
    const fsm = createCounter()
    const [snapshot, effects] = initialTransition(fsm)

    yield* expect({
      snapshotIsInitialState: snapshot === fsm.initialState,
      effects,
      getInitialSnapshotIsInitialState: fsm.getInitialSnapshot() === fsm.initialState,
    }).toEqual({
      snapshotIsInitialState: true,
      effects: [],
      getInitialSnapshotIsInitialState: true,
    })
  })

  it('restores a persisted snapshot', function*({ expect }) {
    const fsm = createCounter()
    const actor = createActor(fsm).start()
    actor.send({ type: 'inc' })
    const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()))

    const restored = createActor(fsm, { snapshot: persisted }).start()
    const valueAfterRestore = restored.getSnapshot().value
    const contextBeforeSend = restored.getSnapshot().context

    restored.send({ type: 'inc' })

    yield* expect({
      valueAfterRestore,
      contextBeforeSend,
      contextAfterSend: restored.getSnapshot().context,
    }).toEqual({
      valueAfterRestore: 'active',
      contextBeforeSend: { count: 1 },
      contextAfterSend: { count: 2 },
    })
  })
})
