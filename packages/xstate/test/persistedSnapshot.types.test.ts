import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine, setup, types } from '../src/index.js'
import type { PersistedSnapshotFrom, Snapshot } from '../src/index.js'

describe('persisted snapshot round-trip types', (it) => {
  it('should round-trip getPersistedSnapshot into createActor without a cast', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: { a: {} },
    })

    const snapshot = createActor(machine).getPersistedSnapshot()

    const restored = createActor(machine, { snapshot })
    yield* expect(restored.getSnapshot().value).toBe('a')
  })

  it('should round-trip a versioned machine snapshot without a cast', function*({ expect }) {
    const machine = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'a',
      states: { a: {} },
    })

    const snapshot = createActor(machine).getPersistedSnapshot()

    const restored = createActor(machine, { snapshot })
    yield* expect(restored.getSnapshot().value).toBe('a')
  })

  it(
    'should accept a snapshot persisted from a different version of the same machine (migration path)',
    function*({ expect }) {
      const checkoutV1 = createMachine({
        id: 'checkout',
        version: '1',
        initial: 'a',
        states: { a: {} },
      })
      const checkoutV2 = createMachine({
        id: 'checkout',
        version: '2',
        initial: 'a',
        states: { a: {} },
      })

      const snapshot = createActor(checkoutV1).getPersistedSnapshot()

      const restored = createActor(checkoutV2, { snapshot })
      yield* expect(restored.getSnapshot().value).toBe('a')
    },
  )

  it('should reject a snapshot persisted from a machine with a different ID', function*({ expect }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'a',
      states: { a: {} },
    })
    const cart = createMachine({
      id: 'cart',
      version: '1',
      initial: 'a',
      states: { a: {} },
    })

    const snapshot = createActor(checkout).getPersistedSnapshot()

    createActor(cart, {
      // @ts-expect-error
      snapshot,
    })

    yield* expect({ checkout: checkout.id, cart: cart.id }).toEqual({
      checkout: 'checkout',
      cart: 'cart',
    })
  })

  it('should reject a snapshot from an unversioned machine with a different ID', function*({ expect }) {
    const machineA = createMachine({
      id: 'a',
      initial: 'x',
      states: { x: {} },
    })
    const machineB = createMachine({
      id: 'b',
      initial: 'x',
      states: { x: {} },
    })

    const snapshot = createActor(machineA).getPersistedSnapshot()

    createActor(machineB, {
      // @ts-expect-error
      snapshot,
    })

    yield* expect({ a: machineA.id, b: machineB.id }).toEqual({ a: 'a', b: 'b' })
  })

  it('should round-trip a provided machine snapshot without a cast', function*({ expect }) {
    const machine = createMachine({
      id: 'checkout',
      initial: 'a',
      states: { a: {} },
    })
    const provided = machine.provide({})

    const snapshot = createActor(provided).getPersistedSnapshot()

    createActor(machine, { snapshot })
    const restored = createActor(provided, {
      snapshot: createActor(machine).getPersistedSnapshot(),
    })
    yield* expect(restored.getSnapshot().value).toBe('a')
  })

  it('preserves identity through repeated provision of a versioned setup machine', function*({ expect }) {
    const machine = setup().createMachine({
      id: 'checkout',
      version: '1',
      initial: 'a',
      states: { a: {} },
    })
    const provided = machine.provide({}).provide({})
    provided.id satisfies 'checkout'
    provided.version satisfies '1'
    createActor(machine, {
      snapshot: createActor(provided).getPersistedSnapshot(),
    })
    createActor(provided, {
      snapshot: createActor(machine).getPersistedSnapshot(),
    })
    yield* expect({ id: provided.id, version: provided.version }).toEqual({
      id: 'checkout',
      version: '1',
    })
  })

  it('should accept a revived (unbranded) snapshot', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: { a: {} },
    })

    const revived = JSON.parse(
      JSON.stringify(createActor(machine).getPersistedSnapshot()),
    ) as Snapshot<unknown>

    const restored = createActor(machine, { snapshot: revived })
    yield* expect(restored.getSnapshot().value).toBe('a')
  })

  it('should be usable where a plain Snapshot<unknown> is expected', function*({ expect }) {
    const machine = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'a',
      states: { a: {} },
    })

    const snapshot: Snapshot<unknown> = createActor(machine).getPersistedSnapshot()
    snapshot satisfies Snapshot<unknown>
    const restored = createActor(machine, { snapshot })
    yield* expect(restored.getSnapshot().value).toBe('a')
  })

  it('should be assignable to PersistedSnapshotFrom<typeof machine>', function*({ expect }) {
    const machine = createMachine({
      id: 'counter',
      schemas: { context: types<{ count: number }>() },
      context: { count: 0 },
      initial: 'a',
      states: { a: {} },
    })

    const snapshot: PersistedSnapshotFrom<typeof machine> = createActor(machine).getPersistedSnapshot()

    snapshot.context['count'] satisfies number

    createActor(machine, { snapshot })
    yield* expect(snapshot.context).toEqual({ count: 0 })
  })

  it('should be assignable to PersistedSnapshotFrom<typeof machine> for a versioned machine', function*({ expect }) {
    const machine = createMachine({
      id: 'counter',
      version: '1',
      schemas: { context: types<{ count: number }>() },
      context: { count: 0 },
      initial: 'a',
      states: { a: {} },
    })

    const snapshot: PersistedSnapshotFrom<typeof machine> = createActor(machine).getPersistedSnapshot()

    createActor(machine, { snapshot })
    yield* expect(snapshot.context).toEqual({ count: 0 })
  })

  it('should reject a PersistedSnapshotFrom of a machine with a different ID', function*({ expect }) {
    const checkout = createMachine({
      id: 'checkout',
      initial: 'a',
      states: { a: {} },
    })
    const cart = createMachine({
      id: 'cart',
      initial: 'a',
      states: { a: {} },
    })

    // @ts-expect-error
    const snapshot: PersistedSnapshotFrom<typeof cart> = createActor(checkout).getPersistedSnapshot()
    snapshot
    yield* expect(snapshot.context).toEqual({})
  })
})
