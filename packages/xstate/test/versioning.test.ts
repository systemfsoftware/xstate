import { describe } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'

describe('persisted snapshot versioning', (it) => {
  it('stamps the machine version on persisted snapshots', function*({ expect }) {
    const machine = createMachine({
      version: '1',
      initial: 'a',
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot()

    yield* expect({
      version: (persisted as any).version,
      roundTripped: JSON.parse(JSON.stringify(persisted)).version,
    }).toEqual({ version: '1', roundTripped: '1' })
  })

  it('does not stamp a version when the machine has none', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot()

    yield* expect({ hasVersion: 'version' in (persisted as any) }).toEqual({
      hasVersion: false,
    })
  })

  it('restores a snapshot with a matching version', function*({ expect }) {
    const machine = createMachine({
      version: '1',
      initial: 'a',
      states: { a: { on: { NEXT: { target: 'b' } } }, b: {} },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    yield* expect(restored.getSnapshot().value).toBe('b')
  })

  it('does not treat a live snapshot machine reference as persisted identity', function*({ expect }) {
    const machineV1 = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'a',
      states: { a: { on: { NEXT: { target: 'b' } } }, b: {} },
    })
    const machineV2 = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'a',
      states: { a: { on: { NEXT: { target: 'b' } } }, b: {} },
    })
    const actor = createActor(machineV1).start()
    actor.send({ type: 'NEXT' })
    const migrated = { ...actor.getSnapshot(), version: '2' }

    const restored = createActor(machineV2, { snapshot: migrated }).start()

    yield* expect({
      status: restored.getSnapshot().status,
      value: restored.getSnapshot().value,
      machineIsV2: restored.getSnapshot().machine === machineV2,
    }).toEqual({ status: 'active', value: 'b', machineIsV2: true })
  })

  it('restores from nested machine identity without the legacy top-level version', function*({ expect }) {
    const machine = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'a',
      states: { a: { on: { NEXT: { target: 'b' } } }, b: {} },
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    const { version: _, ...persisted } = actor.getPersistedSnapshot() as any

    const restored = createActor(machine, { snapshot: persisted }).start()

    yield* expect(restored.getSnapshot().value).toBe('b')
  })

  it('errors when restoring a version-mismatched snapshot without a migrate function', function*({ expect }) {
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

    const restored = createActor(machineV2, { snapshot: persisted })
    restored.subscribe({ error: () => {} })
    restored.start()

    const snapshot = restored.getSnapshot()
    yield* expect({
      status: snapshot.status,
      message: (snapshot as any).error.message,
    }).toEqual({
      status: 'error',
      message:
        "Persisted snapshot version '1' does not match machine version '2' for machine '(machine)'. Provide a `migrate(persistedSnapshot, fromVersion)` function in the machine config to migrate old snapshots.",
    })
  })

  it('migrates a version-mismatched snapshot with the `migrate` function', function*({ expect }) {
    const machineV1 = createMachine({
      version: '1',
      context: { count: 5 },
      initial: 'a',
      states: { a: {} },
    })

    const fromVersions: Array<string | undefined> = []
    const migrate = (persisted: any, fromVersion: string | undefined) => {
      fromVersions.push(fromVersion)
      return {
        ...persisted,
        version: '2',
        context: { total: persisted.context.count },
      }
    }

    const machineV2 = createMachine({
      version: '2',
      migrate,
      context: { total: 0 },
      initial: 'a',
      states: { a: {} },
    })

    const persisted = createActor(machineV1).start().getPersistedSnapshot()
    const restored = createActor(machineV2, { snapshot: persisted }).start()

    yield* expect({
      fromVersions,
      status: restored.getSnapshot().status,
      context: restored.getSnapshot().context,
    }).toEqual({
      fromVersions: ['1'],
      status: 'active',
      context: { total: 5 },
    })
  })

  it('passes the nested machine version to migration without a top-level version', function*({ expect }) {
    const machineV1 = createMachine({
      id: 'checkout',
      version: '1',
      context: { count: 5 },
      initial: 'a',
      states: { a: {} },
    })
    const fromVersions: Array<string | undefined> = []
    const migrate = (persisted: any, fromVersion: string | undefined) => {
      fromVersions.push(fromVersion)
      return {
        ...persisted,
        context: { total: persisted.context.count },
      }
    }
    const machineV2 = createMachine({
      id: 'checkout',
      version: '2',
      migrate,
      context: { total: 0 },
      initial: 'a',
      states: { a: {} },
    })
    const { version: _, ...persisted } = createActor(machineV1)
      .start()
      .getPersistedSnapshot() as any

    const restored = createActor(machineV2, { snapshot: persisted }).start()

    yield* expect({
      fromVersions,
      context: restored.getSnapshot().context,
    }).toEqual({ fromVersions: ['1'], context: { total: 5 } })
  })

  it('migrates an unversioned snapshot (fromVersion is undefined)', function*({ expect }) {
    const legacyMachine = createMachine({
      context: { count: 3 },
      initial: 'a',
      states: { a: {} },
    })

    const fromVersions: Array<string | undefined> = []
    const machineV1 = createMachine({
      version: '1',
      migrate: (persisted: any, fromVersion: string | undefined) => {
        fromVersions.push(fromVersion)
        return persisted
      },
      context: { count: 0 },
      initial: 'a',
      states: { a: {} },
    })

    const persisted = createActor(legacyMachine).start().getPersistedSnapshot()
    const restored = createActor(machineV1, { snapshot: persisted }).start()

    yield* expect({
      fromVersions,
      status: restored.getSnapshot().status,
      context: restored.getSnapshot().context,
    }).toEqual({
      fromVersions: [undefined],
      status: 'active',
      context: { count: 3 },
    })
  })
})
