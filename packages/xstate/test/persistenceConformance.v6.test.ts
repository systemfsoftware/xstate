import { describe, it } from '@systemfsoftware/vitest'
import {
  type AnyActorRef,
  createActor,
  createMachine,
  initialTransition,
  type PersistedSnapshotFrom,
  setup,
  SimulatedClock,
} from '../src/index.js'

function roundTrip<T>(persisted: T): T {
  return JSON.parse(JSON.stringify(persisted)) as T
}

describe('non-JSON payload warning (dev)', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['function', { fn: () => {} }, 'context.fn'],
    ['symbol', { list: [Symbol('s')] }, 'context.list[0]'],
    ['bigint', { n: 1n }, 'context.n'],
    ['Map', { m: new Map() }, 'context.m'],
    ['Set', { nested: { s: new Set() } }, 'context.nested.s'],
    ['NaN', { score: NaN }, 'context.score'],
    ['Infinity', { list: [Infinity] }, 'context.list[0]'],
    ['-Infinity', { min: -Infinity }, 'context.min'],
  ])('warns once for a %s', function*([kind, context, path], { expect }) {
    const warned: string[] = []
    const machine = createMachine({ context })
    createActor(machine, {
      warn: (message) => warned.push(message),
    }).getPersistedSnapshot()
    yield* expect(warned).toEqual([
      expect.stringContaining(`(${kind}) at '${path}'`),
    ])
  })

  it('warns for a circular reference', function*({ expect }) {
    const warned: string[] = []
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const machine = createMachine({ id: 'cyclic', context: { circular } })
    let message: string | undefined
    try {
      createActor(machine, { warn: (m) => warned.push(m) }).getPersistedSnapshot()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    yield* expect({ message, warned }).toEqual({
      message: 'Cannot persist actor "cyclic": circular reference at context.circular.self',
      warned: [
        expect.stringContaining("(circular reference) at 'context.circular.self'"),
      ],
    })
  })

  it('rejects a circular context with its path, and persists shared references', function*({ expect }) {
    const item: Record<string, unknown> = { name: 'a' }
    item['parent'] = { items: [item] }
    const machine = createMachine({ id: 'list', context: { items: [item] } })
    let message: string | undefined
    try {
      createActor(machine).getPersistedSnapshot()
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    const shared = { a: 1 }
    const sharing = createMachine({
      context: { left: shared, right: { nested: shared } },
    })
    const sharingSnapshot = createActor(sharing).getPersistedSnapshot()
    yield* expect({ message, sharingSnapshot }).toMatchObject({
      message: 'Cannot persist actor "list": circular reference at context.items[0].parent.items[0]',
      sharingSnapshot: {
        context: { left: { a: 1 }, right: { nested: { a: 1 } } },
      },
    })
  })

  it('does not warn for an undefined property', function*({ expect }) {
    const warned: string[] = []
    const machine = createMachine({ context: { result: undefined } })
    createActor(machine, {
      warn: (message) => warned.push(message),
    }).getPersistedSnapshot()
    yield* expect(warned).toEqual([])
  })

  it('does not warn for JSON values, Dates, shared references, or actor refs', function*({ expect }) {
    const warned: string[] = []
    const shared = { a: 1 }
    const machine = createMachine({
      context: ({ spawn }) => ({
        date: new Date(0),
        left: shared,
        right: shared,
        ref: spawn(createMachine({})),
      }),
    })
    createActor(machine, {
      warn: (message) => warned.push(message),
    }).getPersistedSnapshot({ __unsafeAllowInlineActors: true } as {
      embedChildren?: boolean
    })
    yield* expect(warned).toEqual([])
  })
})

describe('#5077 re-persistability of children', () => {
  it('a transition-spawned registered child survives a JSON round-trip and re-persists', function*({ expect }) {
    const child = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })
    const parent = createMachine({
      actors: { child },
      on: {
        spawn: (_, enq) => {
          enq.spawn('child', { id: 'myChild' })
        },
        ping: ({ children }, enq) => {
          enq.sendTo(children['myChild'], { type: 'inc' })
        },
      },
    })

    const actor = createActor(parent).start()
    actor.send({ type: 'spawn' })
    const persisted = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(parent, { snapshot: persisted }).start()
    restored.send({ type: 'ping' })

    yield* expect({
      src: persisted.children['myChild']?.src,
      restoredChild: restored.getSnapshot().children['myChild']?.getSnapshot(),
      restoredSrc: roundTrip(restored.getPersistedSnapshot()).children['myChild']?.src,
    }).toMatchObject({
      src: 'child',
      restoredChild: { context: { count: 1 } },
      restoredSrc: 'child',
    })
  })

  it('a provided actor retains its registered source when transition-spawned', function*({ expect }) {
    const child = createMachine({})
    const parent = createMachine({
      actors: {} as { child: typeof child },
      on: {
        spawn: (_, enq) => {
          enq.spawn('child', { id: 'myChild' })
        },
      },
    }).provide({ actors: { child } })

    const actor = createActor(parent).start()
    actor.send({ type: 'spawn' })

    yield* expect(roundTrip(actor.getPersistedSnapshot()).children['myChild']?.src).toBe('child')
  })

  it('an extended actor retains its registered source when transition-spawned', function*({ expect }) {
    const child = createMachine({})
    const parent = setup()
      .extend({ actors: { child } })
      .createMachine({
        on: {
          spawn: (_, enq) => {
            enq.spawn('child', { id: 'myChild' })
          },
        },
      })

    const actor = createActor(parent).start()
    actor.send({ type: 'spawn' })

    yield* expect(roundTrip(actor.getPersistedSnapshot()).children['myChild']?.src).toBe('child')
  })

  it('preserves the explicitly selected source when duplicate registrations later diverge', function*({ expect }) {
    const shared = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })
    const replacement = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context }) => ({ context: { count: context.count + 10 } }),
      },
    })
    const parent = createMachine({
      actors: { first: shared, second: shared },
      on: {
        spawn: (_, enq) => {
          enq.spawn('second', { id: 'worker' })
        },
        ping: ({ children }, enq) => {
          enq.sendTo(children['worker'], { type: 'inc' })
        },
      },
    })

    const actor = createActor(parent).start()
    actor.send({ type: 'spawn' })
    const persisted = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const migratedParent = parent.provide({ actors: { second: replacement } })
    const restored = createActor(migratedParent, {
      snapshot: persisted,
    }).start()
    restored.send({ type: 'ping' })

    yield* expect({
      src: persisted.children['worker']?.src,
      worker: restored.getSnapshot().children['worker']?.getSnapshot(),
    }).toMatchObject({
      src: 'second',
      worker: { context: { count: 10 } },
    })
  })

  it('throws immediately when a declared actor source has no implementation', function*({ expect }) {
    const child = createMachine({})
    const parent = createMachine({
      actors: {} as { child: typeof child },
      entry: (_, enq) => {
        enq.spawn('child')
      },
    })

    yield* expect(() => initialTransition(parent)).toThrow(
      "Actor source 'child' is not provided",
    )
  })

  it('a spawned child survives a JSON round-trip, responds to events, and re-persists', function*({ expect }) {
    const child = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })

    const parent = createMachine({
      actors: { child },
      context: ({ spawn, actors }) => {
        spawn(actors.child, { id: 'myChild' })
        return {}
      },
      initial: 'active',
      states: {
        active: {
          on: {
            ping: ({ children }, enq) => {
              enq.sendTo(children['myChild'], { type: 'inc' })
            },
          },
        },
      },
    })

    const actor = createActor(parent).start()
    const json = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(parent, { snapshot: json }).start()

    restored.send({ type: 'ping' })

    const secondRestored = createActor(parent, {
      snapshot: roundTrip(restored.getPersistedSnapshot()),
    }).start()

    yield* expect({
      child: restored.getSnapshot().children['myChild']?.getSnapshot(),
      secondStatus: secondRestored.getSnapshot().status,
    }).toMatchObject({
      child: { context: { count: 1 } },
      secondStatus: 'active',
    })
  })

  it('an invoked child survives a JSON round-trip, responds to events, and re-persists', function*({ expect }) {
    const child = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })

    const parent = createMachine({
      actors: { child },
      initial: 'active',
      states: {
        active: {
          invoke: { src: 'child', id: 'myChild' },
          on: {
            ping: ({ children }, enq) => {
              enq.sendTo(children['myChild'], { type: 'inc' })
            },
          },
        },
      },
    })

    const actor = createActor(parent).start()
    const json = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(parent, { snapshot: json }).start()

    restored.send({ type: 'ping' })

    const secondRestored = createActor(parent, {
      snapshot: roundTrip(restored.getPersistedSnapshot()),
    }).start()

    yield* expect({
      child: restored.getSnapshot().children['myChild']?.getSnapshot(),
      secondStatus: secondRestored.getSnapshot().status,
    }).toMatchObject({
      child: { context: { count: 1 } },
      secondStatus: 'active',
    })
  })

  it('assigns a new runtime session to a restored child', function*({ expect }) {
    const child = createMachine({})
    const parent = createMachine({
      actors: { child },
      context: ({ spawn, actors }) => {
        spawn(actors.child, { id: 'myChild' })
        return {}
      },
    })
    const actor = createActor(parent).start()
    const actorChild = actor.getSnapshot().children['myChild']
    if (actorChild === undefined) {
      throw new Error('expected a spawned child')
    }
    const sessionId = actorChild.sessionId
    const persisted = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(parent, { snapshot: persisted }).start()
    const restoredChild = restored.getSnapshot().children['myChild']
    if (restoredChild === undefined) {
      throw new Error('expected a restored child')
    }

    const restoredRef: AnyActorRef = restored
    restoredRef.send({
      type: 'xstate.done.actor.myChild',
      actorId: 'myChild',
      sessionId,
      output: undefined,
    })

    const persistedRef = persisted.children['myChild']
    yield* expect({
      hasIncarnationId: persistedRef !== undefined && 'incarnationId' in persistedRef,
      hasSessionId: persistedRef !== undefined && 'sessionId' in persistedRef,
      sameSession: restoredChild.sessionId === sessionId,
      childIsSame: restored.getSnapshot().children['myChild'] === restoredChild,
    }).toEqual({
      hasIncarnationId: false,
      hasSessionId: false,
      sameSession: false,
      childIsSame: true,
    })
  })

  it('does not reuse a removed child incarnation after restoration', function*({ expect }) {
    const child = createMachine({})
    const parent = createMachine({
      actors: { child },
      entry: (_, enq) => enq.spawn(child, { id: 'myChild' }),
      on: {
        REMOVE: ({ children }, enq) => enq.stop(children['myChild']),
        SPAWN: (_, enq) => {
          enq.spawn(child, { id: 'myChild' })
        },
      },
    })
    const actor = createActor(parent).start()
    const removedChild = actor.getSnapshot().children['myChild']
    if (removedChild === undefined) {
      throw new Error('expected a removed child')
    }
    const removedSessionId = removedChild.sessionId
    actor.send({ type: 'REMOVE' })
    const persisted = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(parent, { snapshot: persisted }).start()
    restored.send({ type: 'SPAWN' })
    const replacement = restored.getSnapshot().children['myChild']
    if (replacement === undefined) {
      throw new Error('expected a replacement child')
    }

    const restoredRef: AnyActorRef = restored
    restoredRef.send({
      type: 'xstate.done.actor.myChild',
      actorId: 'myChild',
      sessionId: removedSessionId,
      output: undefined,
    })

    yield* expect({
      sameSession: replacement.sessionId === removedSessionId,
      childIsSame: restored.getSnapshot().children['myChild'] === replacement,
    }).toEqual({
      sameSession: false,
      childIsSame: true,
    })
  })
})

describe('missing persisted child sources', () => {
  it('fails restoration instead of silently dropping the child', function*({ expect }) {
    const child = createMachine({})
    const parent = createMachine({
      actors: {} as { child: typeof child },
      context: ({ spawn, actors }) => {
        spawn(actors.child, { id: 'myChild' })
        return {}
      },
    })
    const configuredParent = parent.provide({
      actors: { child },
    })
    const actor = createActor(configuredParent).start()
    const persisted = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(parent, { snapshot: persisted })

    yield* expect(restored.getSnapshot()).toMatchObject({
      status: 'error',
      error: expect.objectContaining({
        message: expect.stringContaining("child source 'child'"),
      }),
    })
  })
})

describe('#4873 system.get after restore', () => {
  it(
    'a child spawned with a registryKey is retrievable via restored.system.get and transitions on send',
    function*({ expect }) {
      const child = createMachine({
        context: { count: 0 },
        on: {
          inc: ({ context }) => ({ context: { count: context.count + 1 } }),
        },
      })

      const parent = createMachine({
        actors: { child },
        context: ({ spawn, actors }) => {
          spawn(actors.child, { registryKey: 'mySystemId' })
          return {}
        },
      })

      const actor = createActor(parent).start()
      const json = roundTrip(actor.getPersistedSnapshot())
      actor.stop()

      const restored = createActor(parent, { snapshot: json }).start()

      const ref = restored.system.get('mySystemId')
      ref?.send({ type: 'inc' })

      yield* expect({
        present: ref !== undefined,
        snapshot: ref?.getSnapshot(),
      }).toMatchObject({
        present: true,
        snapshot: { context: { count: 1 } },
      })
    },
  )
})

describe('#5178 historyValue revival', () => {
  it('a shallow history state remembers the last child across a JSON round-trip', function*({ expect }) {
    const machine = createMachine({
      initial: 'on',
      states: {
        on: {
          initial: 'first',
          states: {
            first: {
              on: { SWITCH: { target: 'second' } },
            },
            second: {},
            hist: {
              type: 'history',
              history: 'shallow',
              target: 'first',
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
        off: {
          on: { POWER: { target: 'on.hist' } },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'SWITCH' })
    actor.send({ type: 'POWER' })
    const offValue = actor.getSnapshot().value

    const json = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(machine, { snapshot: json }).start()
    restored.send({ type: 'POWER' })

    yield* expect({ offValue, restoredValue: restored.getSnapshot().value }).toEqual({
      offValue: 'off',
      restoredValue: { on: 'second' },
    })
  })
})

describe('#5331 logical timers restored', () => {
  const createDelayMachine = () =>
    createMachine({
      initial: 'pending',
      states: {
        pending: {
          after: { 500: { target: 'done' } },
        },
        done: { type: 'final' },
      },
    })

  it('persists timer intent and restarts its declared delay locally', function*({ expect }) {
    const clock = new SimulatedClock()
    const actor = createActor(createDelayMachine(), { clock }).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const json = roundTrip(persisted)
    const timers = Object.values(
      (json['timers'] ?? {}) as Record<string, Record<string, unknown>>,
    )
    const timer = timers[0]

    const clock2 = new SimulatedClock()
    const restored = createActor(createDelayMachine(), {
      clock: clock2,
      snapshot: json,
    }).start()

    clock2.increment(499)
    const pendingValue = restored.getSnapshot().value
    clock2.increment(1)
    const doneValue = restored.getSnapshot().value

    yield* expect({
      timerCount: timers.length,
      timer,
      hasStartedAt: timer !== undefined && 'startedAt' in timer,
      hasElapsed: timer !== undefined && 'elapsed' in timer,
      pendingValue,
      doneValue,
    }).toMatchObject({
      timerCount: 1,
      timer: {
        delay: 500,
        target: 'self',
        event: { type: expect.stringMatching(/^xstate\.after/) },
      },
      hasStartedAt: false,
      hasElapsed: false,
      pendingValue: 'pending',
      doneValue: 'done',
    })
  })
})

describe('#5228 restore errors surface', () => {
  it(
    'a corrupted snapshot value referencing a nonexistent state surfaces an error, not a silently-running actor',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: { on: { NEXT: { target: 'b' } } },
          b: {},
        },
      })

      const actor = createActor(machine).start()
      const persisted = roundTrip(actor.getPersistedSnapshot())
      actor.stop()

      persisted['value'] = 'nonexistent'

      let surfaced = false
      const restored = createActor(machine, { snapshot: persisted })
      restored.subscribe({ error: () => (surfaced = true) })

      let threw = false
      try {
        restored.start()
      } catch {
        threw = true
      }

      const status = restored.getSnapshot().status
      yield* expect({
        surfacedOrThrewOrError: threw || surfaced || status === 'error',
        statusNotActive: status !== 'active',
      }).toEqual({ surfacedOrThrewOrError: true, statusNotActive: true })
    },
  )

  it('a version-mismatched snapshot without `migrate` surfaces an error', function*({ expect }) {
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

    const persisted = roundTrip(
      createActor(machineV1).start().getPersistedSnapshot(),
    )

    const restored = createActor(machineV2, { snapshot: persisted })
    restored.subscribe({ error: () => {} })
    restored.start()

    yield* expect(restored.getSnapshot()).toMatchObject({
      status: 'error',
      error: {
        message: expect.stringMatching(/does not match machine version/),
      },
    })
  })

  it('positive control: a version-mismatched snapshot WITH `migrate` restores successfully', function*({ expect }) {
    const machineV1 = createMachine({
      version: '1',
      context: { count: 5 },
      initial: 'a',
      states: { a: {} },
    })
    const machineV2 = createMachine({
      version: '2',
      migrate: (persisted: PersistedSnapshotFrom<typeof machineV1>) => ({
        ...persisted,
        version: '2',
        context: { total: persisted.context.count },
      }),
      context: { total: 0 },
      initial: 'a',
      states: { a: {} },
    })

    const persisted = roundTrip(
      createActor(machineV1).start().getPersistedSnapshot(),
    )
    const restored = createActor(machineV2, { snapshot: persisted }).start()

    yield* expect({
      status: restored.getSnapshot().status,
      context: restored.getSnapshot().context,
    }).toEqual({ status: 'active', context: { total: 5 } })
  })

  it('preserves an explicit child source through parent snapshot migration', function*({ expect }) {
    const shared = createMachine({ context: { implementation: 'shared' } })
    const secondV2 = createMachine({
      context: { implementation: 'second-v2' },
    })
    const machineV1 = createMachine({
      version: '1',
      actors: { first: shared, second: shared },
      entry: (_, enq) => {
        enq.spawn('second', { id: 'worker' })
      },
    })
    const machineV2 = createMachine({
      version: '2',
      migrate: (persisted: PersistedSnapshotFrom<typeof machineV1>) => ({
        ...persisted,
        version: '2',
      }),
      actors: { first: shared, second: secondV2 },
    })

    const persisted = roundTrip(
      createActor(machineV1).start().getPersistedSnapshot(),
    )

    const restored = createActor(machineV2, { snapshot: persisted }).start()

    const worker = restored.getSnapshot().children['worker']
    yield* expect({
      src: persisted.children['worker']?.src,
      sameLogic: worker !== undefined && 'logic' in worker && worker.logic === secondV2,
    }).toEqual({ src: 'second', sameLogic: true })
  })
})

describe('#4583 rehydrated stopped (done) actor', () => {
  it(
    'restoring a snapshot in a final state does not throw on subscribe and reports status "done"',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: { on: { NEXT: { target: 'bar' } } },
          bar: { type: 'final' },
        },
      })

      const actor = createActor(machine).start()
      actor.send({ type: 'NEXT' })
      const doneBeforePersist = actor.getSnapshot().status

      const json = roundTrip(actor.getPersistedSnapshot())
      actor.stop()

      const restored = createActor(machine, { snapshot: json })
      restored.subscribe(() => {})
      restored.start()

      yield* expect({
        doneBeforePersist,
        statusAfterRestore: restored.getSnapshot().status,
      }).toEqual({ doneBeforePersist: 'done', statusAfterRestore: 'done' })
    },
  )
})

describe('#5013 unserializable event to stopped actor (dev)', () => {
  it('sending an event with a circular reference to a stopped actor does not throw', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: { type: 'final' },
      },
    })

    const actor = createActor(machine).start()
    actor.stop()

    const circular: { type: string; self?: unknown } = { type: 'BOOM' }
    circular.self = circular

    const ref: AnyActorRef = actor
    let sendError: unknown
    try {
      ref.send(circular)
    } catch (error) {
      sendError = error
    }

    yield* expect(sendError).toBe(undefined)
  })
})

describe('#4774 initialTransition single init', () => {
  it('runs the context factory exactly once', function*({ expect }) {
    let initCount = 0
    const machine = createMachine({
      context: () => {
        initCount++
        return { count: 0 }
      },
      initial: 'a',
      states: { a: {} },
    })

    initialTransition(machine)

    yield* expect(initCount).toBe(1)
  })
})
