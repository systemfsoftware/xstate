import { describe, it } from '@systemfsoftware/vitest'
import { Deferred, Effect } from 'effect'
import { type Actor, createActor, createMachine } from '../src/index.js'

const createRecordedMachine = (
  recordEntry: () => void,
  recordAction: () => void,
) =>
  createMachine({
    initial: 'a',
    entry: (_, enq) => enq(recordEntry),
    states: {
      a: {
        on: {
          NEXT: (_, enq) => {
            enq(recordAction)
            return { target: 'b' }
          },
        },
      },
      b: {},
    },
  })

const createRecordedFixture = () => {
  const entryCalls: string[] = []
  const actionCalls: string[] = []
  const machine = createRecordedMachine(
    () => {
      entryCalls.push('entry')
    },
    () => {
      actionCalls.push('action')
    },
  )
  const persisted = () => {
    const snapshot = createActor(machine).start().getPersistedSnapshot()
    entryCalls.length = 0
    return snapshot
  }
  const persistedWith = (status: 'done' | 'error' | 'stopped') => {
    const snapshot = persisted()
    return {
      ...snapshot,
      status,
      ...(status === 'error' && { error: new Error('persisted failure') }),
    } as typeof snapshot
  }
  return { machine, entryCalls, actionCalls, persisted, persistedWith }
}

function getThrown(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

const messages = (errors: unknown[]) => errors.map((error) => (error instanceof Error ? error.message : error))

describe('restoring terminal snapshots', () => {
  it.each(['done', 'error', 'stopped'] as const)(
    'keeps a restored %s snapshot terminal after start() without running transitions',
    function*(status, { expect }) {
      const { machine, entryCalls, actionCalls, persistedWith } = createRecordedFixture()
      const actor = createActor(machine, {
        snapshot: persistedWith(status),
        warn: () => {},
      })
      actor.subscribe({ error: () => {} })
      actor.start()
      actor.send({ type: 'NEXT' })

      yield* expect({
        status: actor.getSnapshot().status,
        value: actor.getSnapshot().value,
        entryCalls,
        actionCalls,
      }).toEqual({ status, value: 'a', entryCalls: [], actionCalls: [] })
    },
  )

  it('delivers a restored error to subscribers added before and after start()', function*({ expect }) {
    const { machine, persistedWith } = createRecordedFixture()
    const actor = createActor(machine, { snapshot: persistedWith('error') })
    const before: unknown[] = []
    actor.subscribe({ error: (error: unknown) => before.push(error) })
    actor.start()
    const after: unknown[] = []
    actor.subscribe({ error: (error: unknown) => after.push(error) })

    yield* expect({ before: messages(before), after: messages(after) }).toEqual({
      before: ['persisted failure'],
      after: ['persisted failure'],
    })
  })

  it('surfaces a restore-time failure as an error snapshot and subscriber error', function*({ expect }) {
    const { machine, persisted } = createRecordedFixture()
    const persistedSnapshot = persisted()
    const invalid = {
      ...persistedSnapshot,
      value: 'missing',
    } as typeof persistedSnapshot

    let actor!: Actor<typeof machine>
    const createThrown = getThrown(() => {
      actor = createActor(machine, { snapshot: invalid })
    })
    const delivered = yield* Deferred.make<void>()
    const errorCalls: unknown[] = []
    actor.subscribe({
      error: (error: unknown) => {
        errorCalls.push(error)
        Deferred.doneUnsafe(delivered, Effect.void)
      },
    })
    const startThrown = getThrown(() => {
      actor.start()
    })
    yield* Deferred.await(delivered)

    const snapshot = actor.getSnapshot()
    yield* expect({
      createThrown: createThrown !== undefined,
      startThrown: startThrown !== undefined,
      status: snapshot.status,
      snapshotErrorIsAnError: snapshot.error instanceof Error,
      snapshotErrorMessage: (snapshot.error as Error).message,
      deliveredMessages: messages(errorCalls),
      deliveredIsSnapshotError: errorCalls.length === 1 &&
        errorCalls[0] === snapshot.error,
    }).toEqual({
      createThrown: false,
      startThrown: false,
      status: 'error',
      snapshotErrorIsAnError: true,
      snapshotErrorMessage:
        "Persisted snapshot references state 'missing' which does not exist on machine '(machine)'.",
      deliveredMessages: [
        "Persisted snapshot references state 'missing' which does not exist on machine '(machine)'.",
      ],
      deliveredIsSnapshotError: true,
    })
  })

  it('restore failure yields a machine snapshot with matches()', function*({ expect }) {
    const { machine, persisted } = createRecordedFixture()
    const persistedSnapshot = persisted()
    const invalid = {
      ...persistedSnapshot,
      value: 'missing',
    } as typeof persistedSnapshot
    const actor = createActor(machine, { snapshot: invalid })
    const errorCalls: unknown[] = []
    actor.subscribe({ error: (error: unknown) => errorCalls.push(error) })
    actor.start()

    const snapshot = actor.getSnapshot()
    yield* expect({
      status: snapshot.status,
      matchesIsFunction: typeof snapshot.matches === 'function',
      canIsFunction: typeof snapshot.can === 'function',
      children: snapshot.children,
      nodes: snapshot.nodes,
      deliveredIsSnapshotError: errorCalls.length === 1 &&
        errorCalls[0] === snapshot.error,
    }).toEqual({
      status: 'error',
      matchesIsFunction: true,
      canIsFunction: true,
      children: {},
      nodes: [machine.root],
      deliveredIsSnapshotError: true,
    })
  })
})
