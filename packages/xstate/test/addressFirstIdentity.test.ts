import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable } from '../src/durable/index.js'
import {
  type AnyActor,
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createMachine,
  createSystem,
  deliverEvent,
  getEffectDescriptor,
  initialTransition,
  setup,
  SimulatedClock,
  transition,
  waitFor,
} from '../src/index.js'

function thrownMessage(run: () => unknown): string {
  try {
    run()
    return 'did not throw'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const createManualTime = (initial: number) => {
  let now = initial
  const pending: Array<{
    readonly id: number
    readonly at: number
    readonly fn: () => void
  }> = []
  let nextId = 0
  const clock = {
    setTimeout(fn: () => void, delay: number) {
      const id = nextId
      nextId += 1
      pending.push({ id, at: now + delay, fn })
      return id
    },
    clearTimeout(id: number) {
      const index = pending.findIndex((timer) => timer.id === id)
      if (index !== -1) {
        pending.splice(index, 1)
      }
    },
  }
  return {
    clock,
    wallClock: { now: () => now },
    advance(delay: number) {
      now += delay
      for (;;) {
        const index = pending.findIndex((timer) => timer.at <= now)
        if (index === -1) {
          return
        }
        const [timer] = pending.splice(index, 1)
        if (timer === undefined) {
          continue
        }
        timer.fn()
      }
    },
  }
}

const workerMachine = createMachine({
  id: 'worker',
  initial: 'idle',
  states: {
    idle: {
      on: { PING: { target: 'pinged' } },
    },
    pinged: {},
  },
})

describe('deterministic actor ids', () => {
  it('root actors are named after their logic', function*({ expect }) {
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      states: { a: {} },
    })
    const actor = createActor(machine).start()
    yield* expect({ id: actor.id, address: actor.address }).toEqual({
      id: 'order',
      address: 'order',
    })
  })

  it('generated child ids are src-keyed counters', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
        enq.spawn(actors.worker)
        enq.spawn(actors.worker, { id: 'named' })
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    yield* expect(Object.keys(actor.getSnapshot().children).sort()).toEqual([
      'named',
      'worker:0',
      'worker:1',
    ])
  })

  it('generated ids are identical across pure replays', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
        enq.spawn(actors.worker)
      },
      states: { a: {} },
    })

    const [first] = initialTransition(machine)
    const [second] = initialTransition(machine)
    yield* expect({
      first: Object.keys(first.children),
      second: Object.keys(second.children),
    }).toEqual({
      first: ['worker:0', 'worker:1'],
      second: ['worker:0', 'worker:1'],
    })
  })

  it('restore reserves generated ids so later spawns do not collide', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
        enq.spawn(actors.worker)
      },
      states: {
        a: {
          on: {
            MORE: ({ actors }, enq) => {
              enq.spawn(actors.worker)
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    restored.send({ type: 'MORE' })
    yield* expect(Object.keys(restored.getSnapshot().children).sort()).toEqual([
      'worker:0',
      'worker:1',
      'worker:2',
    ])
  })
})

describe('actor addresses', () => {
  it('uses the first registered source for transition-spawned aliases', function*({ expect }) {
    const machine = setup({
      actors: { first: workerMachine, second: workerMachine },
    }).createMachine({
      entry: ({ actors }, enq) => {
        enq.spawn(actors.first, { id: 'one' })
        enq.spawn(actors.second, { id: 'two' })
      },
    })

    const [snapshot] = initialTransition(machine)
    const persisted = machine.getPersistedSnapshot(snapshot) as any
    yield* expect({
      one: persisted.children.one.src,
      two: persisted.children.two.src,
    }).toEqual({ one: 'first', two: 'first' })
  })

  it('uses the first registered source for context-spawned aliases', function*({ expect }) {
    const machine = setup({
      actors: { first: workerMachine, second: workerMachine },
    }).createMachine({
      context: ({ actors, spawn }) => {
        spawn(actors.first, { id: 'one' })
        spawn(actors.second, { id: 'two' })
        return {}
      },
    })

    const [snapshot] = initialTransition(machine)
    const persisted = machine.getPersistedSnapshot(snapshot) as any
    yield* expect({
      one: persisted.children.one.src,
      two: persisted.children.two.src,
    }).toEqual({ one: 'first', two: 'first' })
  })

  it('addresses are the /-joined id path from the root', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const child = actor.getSnapshot().children['worker:0'] as AnyActor
    yield* expect(child.address).toBe('order/worker:0')
  })

  it('addresses are stable across restore while sessionIds are not', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const child = actor.getSnapshot().children['worker:0'] as AnyActor
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    const restoredChild = restored.getSnapshot().children[
      'worker:0'
    ] as AnyActor
    yield* expect({
      sameAddress: restoredChild.address === child.address,
      sameSessionId: restoredChild.sessionId === child.sessionId,
    }).toEqual({ sameAddress: true, sameSessionId: false })
  })
})

describe('effect descriptors', () => {
  it('spawn and sendTo effects serialize to addresses and src keys', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
      },
      states: {
        a: {
          on: {
            KICK: ({ children }, enq) => {
              enq.sendTo(children['worker:0'], { type: 'PING' })
            },
          },
        },
      },
    })

    const [snapshot, initialEffects] = initialTransition(machine)
    const spawnDescriptor = initialEffects
      .map(getEffectDescriptor)
      .find((d) => d.type === '@xstate.spawn')

    const [, effects] = transition(machine, snapshot, { type: 'KICK' })
    const sendDescriptor = effects
      .map(getEffectDescriptor)
      .find((d) => d.type === '@xstate.sendTo')

    const roundTrips = [...initialEffects, ...effects].map((effect) =>
      JSON.parse(JSON.stringify(getEffectDescriptor(effect)))
    )

    yield* expect({ spawnDescriptor, sendDescriptor, roundTrips }).toEqual({
      spawnDescriptor: {
        kind: 'builtin',
        type: '@xstate.spawn',
        source: 'order',
        actor: 'order/worker:0',
        id: 'worker:0',
        src: 'worker',
        input: undefined,
      },
      sendDescriptor: {
        kind: 'builtin',
        type: '@xstate.sendTo',
        source: 'order',
        target: 'order/worker:0',
        incarnation: undefined,
        event: { type: 'PING' },
        id: undefined,
        delay: undefined,
      },
      roundTrips: [
        {
          kind: 'builtin',
          type: '@xstate.spawn',
          source: 'order',
          actor: 'order/worker:0',
          id: 'worker:0',
          src: 'worker',
        },
        {
          kind: 'builtin',
          type: '@xstate.start',
          source: 'order',
          actor: 'order/worker:0',
          id: 'worker:0',
        },
        {
          kind: 'builtin',
          type: '@xstate.sendTo',
          source: 'order',
          target: 'order/worker:0',
          event: { type: 'PING' },
        },
      ],
    })
  })
})

describe('sessionId as incarnation id', () => {
  const invokeMachine = setup({
    actors: { worker: workerMachine },
  }).createMachine({
    id: 'order',
    initial: 'working',
    states: {
      working: {
        invoke: {
          id: 'w',
          src: 'worker',
          onDone: { target: 'finished' },
        },
      },
      finished: { type: 'final' },
    },
  })

  it('drops completions from a previous incarnation after restore', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const staleSessionId = (actor.getSnapshot().children['w'] as AnyActor)
      .sessionId
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const restored = createActor(invokeMachine, { snapshot: persisted })
    restored.start()
    restored.send({
      type: 'xstate.done.actor',
      actorId: 'w',
      output: undefined,
      sessionId: staleSessionId,
    } as never)
    yield* expect(restored.getSnapshot().value).toBe('working')
  })

  it('accepts completions from the current incarnation', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const restored = createActor(invokeMachine, { snapshot: persisted })
    restored.start()
    const currentSessionId = (restored.getSnapshot().children['w'] as AnyActor)
      .sessionId
    restored.send({
      type: 'xstate.done.actor',
      actorId: 'w',
      output: undefined,
      sessionId: currentSessionId,
    } as never)
    yield* expect({
      value: restored.getSnapshot().value,
      status: restored.getSnapshot().status,
    }).toEqual({ value: 'finished', status: 'done' })
  })
})

describe('children-by-address persistence', () => {
  const coordinatorMachine = setup({
    actors: { worker: workerMachine },
  }).createMachine({
    id: 'coordinator',
    initial: 'a',
    entry: ({ actors }, enq) => {
      enq.spawn(actors.worker)
    },
    states: {
      a: {
        on: {
          MORE: ({ actors }, enq) => {
            enq.spawn(actors.worker)
          },
        },
      },
    },
  })

  it('persisted children carry their logical address', function*({ expect }) {
    const actor = createActor(coordinatorMachine).start()
    const persisted = actor.getPersistedSnapshot() as unknown as {
      children: Record<string, { address: string; src: string }>
    }
    yield* expect(persisted.children['worker:0']).toMatchObject({
      address: 'coordinator/worker:0',
      src: 'worker',
    })
  })

  it('an actor owns its id counters in its own persisted snapshot', function*({ expect }) {
    const orderMachine = setup({
      actors: { coordinator: coordinatorMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.coordinator)
      },
      states: { a: {} },
    })

    const root = createActor(orderMachine).start()
    const coordinator = root.getSnapshot().children[
      'coordinator:0'
    ] as AnyActor
    coordinator.send({ type: 'MORE' })
    const persistedSubtree = coordinator.getPersistedSnapshot() as {
      _nextActorIds?: Record<string, number>
    }
    const persistedCounters = persistedSubtree._nextActorIds
    root.stop()

    const restored = createActor(coordinatorMachine, {
      snapshot: persistedSubtree as never,
    }).start()
    restored.send({ type: 'MORE' })
    yield* expect({
      persistedCounters,
      restoredChildren: Object.keys(restored.getSnapshot().children).sort(),
    }).toEqual({
      persistedCounters: { worker: 2 },
      restoredChildren: ['worker:0', 'worker:1', 'worker:2'],
    })
  })
})

describe('detached children (remote handles)', () => {
  const invokeMachine = setup({
    actors: { worker: workerMachine },
  }).createMachine({
    id: 'order',
    initial: 'working',
    states: {
      working: {
        invoke: { id: 'w', src: 'worker', onDone: { target: 'finished' } },
        on: {
          KICK: ({ children }, enq) => {
            enq.sendTo(children['w'], { type: 'PING' })
          },
        },
      },
      finished: { type: 'final' },
    },
  })

  it('persists children by address only when not embedding', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    }) as unknown as { children: Record<string, unknown> }
    yield* expect(persisted.children['w']).toEqual({
      address: 'order/w',
      remote: true,
      src: 'worker',
      registryKey: undefined,
      syncSnapshot: false,
    })
    actor.stop()
  })

  it('restores address-only children as location-transparent handles', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    })
    actor.stop()

    const restored = createActor(invokeMachine, {
      snapshot: persisted,
    }).start()
    const handle = restored.getSnapshot().children['w'] as AnyActor

    const again = restored.getPersistedSnapshot() as unknown as {
      children: Record<string, { address: string; snapshot?: unknown }>
    }
    const persistedChild = again.children['w']
    if (persistedChild === undefined) {
      throw new Error('expected a persisted child')
    }
    yield* expect({
      address: handle.address,
      sessionId: handle.sessionId,
      status: handle.getSnapshot().status,
      childAddress: persistedChild.address,
      childSnapshot: persistedChild.snapshot,
    }).toEqual({
      address: 'order/w',
      sessionId: undefined,
      status: 'active',
      childAddress: 'order/w',
      childSnapshot: undefined,
    })
  })

  it('co-located-only members throw a descriptive error on a remote handle', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot({ embedChildren: false })
    actor.stop()

    const restored = createActor(invokeMachine, {
      snapshot: persisted,
    }).start()
    const handle = restored.getSnapshot().children['w'] as AnyActor

    yield* expect({
      stop: thrownMessage(() => handle.stop()),
      select: thrownMessage(() => handle.select((s) => s)),
      trigger: thrownMessage(() => handle.trigger),
    }).toEqual({
      stop: expect.stringMatching(/co-located/),
      select: expect.stringMatching(/remote actor/i),
      trigger: expect.stringMatching(/co-located/),
    })
    restored.stop()
  })

  it('accepts completions for remote children from any incarnation', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    })
    actor.stop()

    const restored = createActor(invokeMachine, {
      snapshot: persisted,
    }).start()
    restored.send({
      type: 'xstate.done.actor',
      actorId: 'w',
      output: undefined,
      sessionId: 'some-other-runtime:7',
    } as never)
    yield* expect(restored.getSnapshot().value).toBe('finished')
  })
})

describe('review findings: allocation across a macrostep', () => {
  it('spawns of one source across microsteps get distinct ids', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
        enq.raise({ type: 'AGAIN' })
      },
      states: {
        a: {
          on: {
            AGAIN: ({ actors }, enq) => {
              enq.spawn(actors.worker)
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    yield* expect(Object.keys(actor.getSnapshot().children).sort()).toEqual([
      'worker:0',
      'worker:1',
    ])
  })

  it('context spawns and entry spawns of one source do not collide', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      context: ({ spawn }) => ({
        ref: spawn(workerMachine),
      }),
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const ids = Object.keys(actor.getSnapshot().children)
    yield* expect({ idCount: ids.length, distinctIds: new Set(ids).size })
      .toEqual({ idCount: 2, distinctIds: 2 })
  })
})

describe('review findings: identity edge cases', () => {
  it('parentless actors of one machine in a shared system get distinct addresses', function*({ expect }) {
    const system = createSystem()
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      states: { a: {} },
    })
    const first = system.createActor(machine)
    const second = system.createActor(machine)
    yield* expect({
      firstAddress: first.address,
      sameAddress: second.address === first.address,
    }).toEqual({ firstAddress: 'order', sameAddress: false })
  })

  it('re-persisting a restored snapshot with a context-held remote child does not recurse', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      context: ({ spawn }) => ({
        ref: spawn(workerMachine, { src: 'worker' } as never),
      }),
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot({ embedChildren: false })
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    const again = restored.getPersistedSnapshot() as unknown as {
      children: Record<string, { address: string; snapshot?: unknown }>
    }
    yield* expect(Object.values(again.children)[0]?.address).toMatch(/^order\//)
  })
})

describe('review findings: second round', () => {
  it('records sent[] inspection for sends delivered by a host runtime', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker, { id: 'w' })
      },
      states: {
        a: {
          on: {
            KICK: ({ children }, enq) => {
              enq.sendTo(children['w'], { type: 'PING' })
            },
          },
        },
      },
    })

    const sent: string[] = []
    const actor = createActor(machine, {
      inspect: (event) => {
        if (event.type === '@xstate.transition') {
          for (const record of event.sent) {
            sent.push(`${record.targetId}:${record.event.type}`)
          }
        }
      },
    })
    actor.system.runtime = {
      sendEvent: (source, target, event) => {
        deliverEvent(source, target, event)
      },
    }
    actor.start()
    actor.send({ type: 'KICK' })
    yield* expect(sent).toContain('w:PING')
  })

  it('explicit generated-shaped ids reserve numbering for live runs and replays', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker, { id: 'worker:5' })
      },
      states: {
        a: {
          on: {
            MORE: ({ actors }, enq) => {
              enq.spawn(actors.worker)
            },
          },
        },
      },
    })

    const live = createActor(machine).start()
    live.send({ type: 'MORE' })
    const liveIds = Object.keys(live.getSnapshot().children).sort()
    live.stop()

    const [initial] = initialTransition(machine)
    const [afterMore] = transition(machine, initial, { type: 'MORE' })
    yield* expect({
      liveIds,
      replayIds: Object.keys(afterMore.children).sort(),
    }).toEqual({
      liveIds: ['worker:5', 'worker:6'],
      replayIds: ['worker:5', 'worker:6'],
    })
  })

  it('address-only restore keeps registryKey lookups and syncSnapshot', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker, {
          id: 'w',
          registryKey: 'theWorker',
          syncSnapshot: true,
        } as never)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot({ embedChildren: false })
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    const handle = restored.system.get('theWorker' as never) as AnyActor

    const again = restored.getPersistedSnapshot({
      embedChildren: false,
    }) as unknown as {
      children: Record<string, { syncSnapshot?: boolean }>
    }
    const persistedChild = again.children['w']
    if (persistedChild === undefined) {
      throw new Error('expected a persisted child')
    }
    yield* expect({
      handleDefined: handle !== undefined,
      handleAddress: handle.address,
      syncSnapshot: persistedChild.syncSnapshot,
    }).toEqual({
      handleDefined: true,
      handleAddress: 'order/w',
      syncSnapshot: true,
    })
  })
})

describe('review findings: third round', () => {
  it('context-spawn allocations persist so freed ids are not reused after restore', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      context: ({ spawn }) => ({
        ref: spawn(workerMachine, { src: 'worker' } as never),
      }),
      states: {
        a: {
          on: {
            STOP: ({ children }, enq) => {
              enq.stop(children['worker:0'])
            },
            MORE: ({ actors }, enq) => {
              enq.spawn(actors.worker)
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    const beforeIds = Object.keys(actor.getSnapshot().children)
    actor.send({ type: 'STOP' })
    const persisted = actor.getPersistedSnapshot()
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    restored.send({ type: 'MORE' })
    yield* expect({
      beforeIds,
      afterIds: Object.keys(restored.getSnapshot().children),
    }).toEqual({ beforeIds: ['worker:0'], afterIds: ['worker:1'] })
  })
})

describe('review findings: fourth round', () => {
  it('encodes the path delimiter in address segments', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a/b',
      states: { 'a/b': { invoke: { src: 'worker' } } },
    })

    const actor = createActor(machine).start()
    const child = Object.values(actor.getSnapshot().children)[0] as AnyActor
    yield* expect({
      status: actor.getSnapshot().status,
      childIdHasSlash: child.id.includes('/'),
      address: child.address,
      addressSegments: child.address.split('/').length,
    }).toEqual({
      status: 'active',
      childIdHasSlash: true,
      address: `order/${child.id.replaceAll('/', '%2F')}`,
      addressSegments: 2,
    })
  })

  it('restoring a remote child without a registered source key fails loudly', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker, { id: 'w' })
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    }) as unknown as { children: Record<string, { src?: unknown }> }
    actor.stop()
    const persistedChild = persisted.children['w']
    if (persistedChild === undefined) {
      throw new Error('expected a persisted child')
    }
    persistedChild.src = {}

    yield* expect(() => machine.restoreSnapshot(persisted as never)).toThrow(
      /requires a registered source key/,
    )
  })
})

describe('review findings: sixth round', () => {
  it('an explicit low id does not lower later generated allocations', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }, enq) => {
        enq.spawn(actors.worker)
        enq.spawn(actors.worker)
        enq.spawn(actors.worker)
      },
      states: {
        a: {
          on: {
            CLEAR: ({ children }, enq) => {
              enq.stop(children['worker:0'])
              enq.stop(children['worker:1'])
              enq.stop(children['worker:2'])
            },
            REUSE: ({ actors }, enq) => {
              enq.spawn(actors.worker, { id: 'worker:0' })
              enq.spawn(actors.worker)
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'CLEAR' })
    actor.send({ type: 'REUSE' })
    yield* expect(Object.keys(actor.getSnapshot().children).sort()).toEqual([
      'worker:0',
      'worker:3',
    ])
  })
})

describe('review findings: seventh round', () => {
  it('gives internal helper actors their own id namespace', function*({ expect }) {
    const emitter = createCallbackLogic(() => {})
    const anonymous = createMachine({ initial: 'i', states: { i: {} } })
    let listener: AnyActor | undefined
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      entry: (_, enq) => {
        const child = enq.spawn(emitter)
        listener = enq.listen(child, 'E', () => ({ type: 'GOT' })) as AnyActor
        enq.spawn(anonymous)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const childAddresses = Object.values(actor.getSnapshot().children).map(
      (child) => (child as AnyActor).address,
    )
    yield* expect({
      containsListener: childAddresses.includes(listener!.address),
      listenerAddress: listener!.address,
    }).toEqual({
      containsListener: false,
      listenerAddress: 'order/xstate.listener:0',
    })
  })
})

describe('review findings: eighth round', () => {
  it('address encoding stays injective for ids containing % and /', function*({ expect }) {
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(workerMachine, { id: 'a/b' })
        enq.spawn(workerMachine, { id: 'a%2Fb' })
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const children = actor.getSnapshot().children
    yield* expect({
      slashId: children['a/b']!.address,
      percentId: children['a%2Fb']!.address,
    }).toEqual({ slashId: 'order/a%2Fb', percentId: 'order/a%252Fb' })
  })

  it('persisting an inline child by address fails loudly', function*({ expect }) {
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(workerMachine)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    yield* expect(() =>
      actor.getPersistedSnapshot({
        embedChildren: false,
        __unsafeAllowInlineActors: true,
      } as never)
    ).toThrow(/requires a registered source key/)
  })

  it('drops the legacy _nextActorId field on restore', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }: any, enq: any) => {
        enq.spawn(actors.worker)
      },
      states: { a: {} },
    })

    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot() as any
    actor.stop()
    persisted._nextActorId = 42

    const restored = createActor(machine, { snapshot: persisted }).start()
    const repersisted = restored.getPersistedSnapshot() as any
    yield* expect({
      hasLegacyId: '_nextActorId' in repersisted,
      nextActorIds: repersisted._nextActorIds,
    }).toEqual({ hasLegacyId: false, nextActorIds: { worker: 1 } })
  })
})

describe('reserved id namespace', () => {
  it('rejects user sources that would number in the internal helper namespace', function*({ expect }) {
    const impostor = createMachine({
      id: 'xstate.listener',
      initial: 'a',
      states: { a: {} },
    })
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(impostor)
      },
      states: { a: {} },
    })

    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()
    yield* expect({
      status: actor.getSnapshot().status,
      error: actor.getSnapshot().error,
    }).toEqual({
      status: 'error',
      error: expect.objectContaining({
        message: expect.stringMatching(/reserved for internal actors/),
      }),
    })
  })

  it('rejects explicit generated-shaped ids in the reserved namespace', function*({ expect }) {
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(workerMachine, { id: 'xstate.listener:0' })
      },
      states: { a: {} },
    })

    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()
    yield* expect(actor.getSnapshot().status).toBe('error')
  })
})

describe('unique child ids per parent', () => {
  it('throws when an explicit spawn id is already claimed in the same transition', function*({ expect }) {
    const machine = createMachine({
      id: 'p',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(workerMachine, { id: 'dup' })
        enq.spawn(workerMachine, { id: 'dup' })
      },
      states: { a: {} },
    })
    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()
    yield* expect({
      status: actor.getSnapshot().status,
      error: actor.getSnapshot().error,
    }).toEqual({
      status: 'error',
      error: expect.objectContaining({
        message: expect.stringMatching(/already in use by another child of 'p'/),
      }),
    })
  })

  it('throws when an explicit spawn id collides with a live child', function*({ expect }) {
    const machine = createMachine({
      id: 'p',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(workerMachine, { id: 'dup' })
      },
      states: {
        a: {
          on: {
            AGAIN: (_: any, enq: any) => {
              enq.spawn(workerMachine, { id: 'dup' })
            },
          },
        },
      },
    })
    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()
    actor.send({ type: 'AGAIN' })
    yield* expect(actor.getSnapshot().status).toBe('error')
  })

  it('throws for duplicate invoke ids across parallel regions', function*({ expect }) {
    const machine = setup({ actors: { worker: workerMachine } }).createMachine({
      id: 'p',
      type: 'parallel',
      states: {
        one: { invoke: { id: 'same', src: 'worker' } },
        two: { invoke: { id: 'same', src: 'worker' } },
      },
    })
    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()
    yield* expect(actor.getSnapshot().status).toBe('error')
  })

  it('allows stop-then-spawn of the same id in one transition', function*({ expect }) {
    const machine = createMachine({
      id: 'p',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(workerMachine, { id: 'w' })
      },
      states: {
        a: {
          on: {
            RESTART: ({ children }: any, enq: any) => {
              enq.stop(children.w)
              enq.spawn(workerMachine, { id: 'w' })
            },
          },
        },
      },
    })
    const actor = createActor(machine).start()
    const first = actor.getSnapshot().children['w']
    actor.send({ type: 'RESTART' })
    const second = actor.getSnapshot().children['w']
    yield* expect({
      status: actor.getSnapshot().status,
      replaced: second !== first,
      address: second!.address,
    }).toEqual({ status: 'active', replaced: true, address: 'p/w' })
  })

  it('allows an invoke to restart with its id on reentry', function*({ expect }) {
    const machine = setup({ actors: { worker: workerMachine } }).createMachine({
      id: 'p',
      initial: 'a',
      states: {
        a: {
          invoke: { id: 'inv', src: 'worker' },
          on: { REENTER: { target: 'a', reenter: true } },
        },
      },
    })
    const actor = createActor(machine).start()
    const first = actor.getSnapshot().children['inv']
    actor.send({ type: 'REENTER' })
    yield* expect({
      status: actor.getSnapshot().status,
      replaced: actor.getSnapshot().children['inv'] !== first,
    }).toEqual({ status: 'active', replaced: true })
  })
})

describe('history reentry stops the previous invoke', () => {
  it('restoring the source through a history state exits it first', function*({ expect }) {
    const machine = setup({ actors: { worker: workerMachine } }).createMachine({
      id: 'p',
      initial: 'running',
      states: {
        running: {
          on: { PING: { target: 'refresh' } },
          invoke: { id: 'inv', src: 'worker' },
        },
        refresh: { type: 'history', target: 'running' },
      },
    })
    const actor = createActor(machine).start()
    const first = actor.getSnapshot().children['inv'] as AnyActor
    actor.send({ type: 'PING' })
    const second = actor.getSnapshot().children['inv'] as AnyActor
    yield* expect({
      replaced: second !== first,
      firstStatus: first.getSnapshot().status,
      secondStatus: second.getSnapshot().status,
    }).toEqual({ replaced: true, firstStatus: 'stopped', secondStatus: 'active' })
  })
})

describe('incarnation tokens on remote handles', () => {
  const invokeMachine = setup({
    actors: { worker: workerMachine },
  }).createMachine({
    id: 'order',
    initial: 'a',
    states: {
      a: {
        invoke: { id: 'w', src: 'worker', onDone: { target: 'finished' } },
      },
      finished: {},
    },
  })

  function persistedWithIncarnation(incarnation: string) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    }) as any
    actor.stop()
    persisted.children.w.incarnation = incarnation
    return persisted
  }

  it('round-trips a host-supplied incarnation verbatim', function*({ expect }) {
    const restored = createActor(invokeMachine, {
      snapshot: persistedWithIncarnation('runtime-b:7'),
    }).start()
    const handle = restored.getSnapshot().children['w'] as any
    const repersisted = restored.getPersistedSnapshot({
      embedChildren: false,
    }) as any
    yield* expect({
      sessionId: handle.sessionId,
      incanation: repersisted.children.w.incarnation,
    }).toEqual({ sessionId: 'runtime-b:7', incanation: 'runtime-b:7' })
    restored.stop()
  })

  it('never stamps a token itself', function*({ expect }) {
    const actor = createActor(invokeMachine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    }) as any
    actor.stop()
    yield* expect(persisted.children.w.incarnation).toEqual(undefined)
  })

  it('drops completions from a different incarnation when a token is present', function*({ expect }) {
    const restored = createActor(invokeMachine, {
      snapshot: persistedWithIncarnation('runtime-b:7'),
    }).start()
    restored.send({
      type: 'xstate.done.actor',
      actorId: 'w',
      output: undefined,
      sessionId: 'runtime-b:3',
    } as never)
    const valueAfterStale = restored.getSnapshot().value
    const childAfterStale = restored.getSnapshot().children['w']
    restored.send({
      type: 'xstate.done.actor',
      actorId: 'w',
      output: undefined,
      sessionId: 'runtime-b:7',
    } as never)
    yield* expect({
      valueAfterStale,
      childAfterStalePresent: childAfterStale !== undefined,
      valueAfterCompletion: restored.getSnapshot().value,
    }).toEqual({
      valueAfterStale: 'a',
      childAfterStalePresent: true,
      valueAfterCompletion: 'finished',
    })
    restored.stop()
  })

  it('journals the target incarnation on sendTo descriptors', function*({ expect }) {
    const machine = setup({ actors: { worker: workerMachine } }).createMachine({
      id: 'order',
      initial: 'a',
      states: {
        a: {
          invoke: { id: 'w', src: 'worker' },
          on: {
            KICK: ({ children }, enq) => {
              enq.sendTo(children['w']!, { type: 'PING' })
            },
          },
        },
      },
    })
    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot({
      embedChildren: false,
    }) as any
    actor.stop()
    persisted.children.w.incarnation = 'runtime-b:7'

    const restored = machine.restoreSnapshot(persisted as never)
    const [, effects] = transition(machine, restored as never, {
      type: 'KICK',
    })
    const descriptor = getEffectDescriptor(effects[0]!) as any
    yield* expect({
      type: descriptor.type,
      incarnation: descriptor.incarnation,
    }).toEqual({ type: '@xstate.sendTo', incarnation: 'runtime-b:7' })
  })
})

describe('dead letters', () => {
  it('routes undeliverable events to the runtime deadLetter operation', function*({ expect }) {
    const deadLetters: Array<
      { target: string; type: string; reason: string }
    > = []
    const machine = createMachine({ id: 'p', initial: 'a', states: { a: {} } })
    const actor = createActor(machine)
    actor.system.runtime = {
      deadLetter: (_source: any, target: any, event: any, reason: string) => {
        deadLetters.push({ target: target.address, type: event.type, reason })
      },
    }
    actor.start()
    actor.stop()
    actor.send({ type: 'LATE' })
    yield* expect(deadLetters).toEqual([
      { target: 'p', type: 'LATE', reason: 'stopped' },
    ])
  })

  it('reports a dead letter to onRejectedEvent, not inspection', function*({ expect }) {
    const seen: string[] = []
    const inspected: string[] = []
    const machine = createMachine({ id: 'p', initial: 'a', states: { a: {} } })
    const actor = createActor(machine, {
      onRejectedEvent: (rejection) => {
        seen.push(`${rejection.event.type}:${rejection.reason}`)
      },
      inspect: (ev) => {
        inspected.push(ev.type)
      },
    })
    actor.start()
    actor.stop()
    actor.send({ type: 'LATE' })
    yield* expect({
      seen,
      inspectedAllActorOrTransition: inspected.every((type) =>
        type === '@xstate.actor' || type === '@xstate.transition'
      ),
    }).toEqual({ seen: ['LATE:stopped'], inspectedAllActorOrTransition: true })
  })
})

describe('timer restore honors wall-clock deadlines', () => {
  const timerMachine = createMachine({
    id: 'p',
    initial: 'waiting',
    states: {
      waiting: { after: { 1000: { target: 'fired' } } },
      fired: {},
    },
  })

  it('persists startedAt from a live runtime and resumes the remaining delay', function*({ expect }) {
    const time = createManualTime(5_000)
    const actor = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
    }).start()
    time.advance(600)
    const persisted = actor.getPersistedSnapshot() as any
    actor.stop()
    const [timer] = Object.values(persisted.timers) as any[]

    const restored = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
      snapshot: persisted,
    }).start()
    time.advance(399)
    const valueAt399 = restored.getSnapshot().value
    time.advance(1)
    yield* expect({
      startedAt: timer.startedAt,
      valueAt399,
      valueAfter400: restored.getSnapshot().value,
    }).toEqual({
      startedAt: 5_000,
      valueAt399: 'waiting',
      valueAfter400: 'fired',
    })
    restored.stop()
  })

  it('keeps the same deadline across repeated persist/restore cycles', function*({ expect }) {
    const time = createManualTime(5_000)
    const actor = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
    }).start()
    time.advance(300)
    const first = actor.getPersistedSnapshot() as any
    actor.stop()

    const second = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
      snapshot: first,
    }).start()
    time.advance(300)
    const repersisted = second.getPersistedSnapshot() as any
    second.stop()
    const [timer] = Object.values(repersisted.timers) as any[]

    const third = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
      snapshot: repersisted,
    }).start()
    time.advance(400)
    yield* expect({
      deadline: timer.startedAt + timer.delay,
      valueAfter400: third.getSnapshot().value,
    }).toEqual({ deadline: 6_000, valueAfter400: 'fired' })
    third.stop()
  })

  it('a timer already past due fires immediately on restore', function*({ expect }) {
    const time = createManualTime(5_000)
    const actor = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
    }).start()
    const persisted = actor.getPersistedSnapshot() as any
    actor.stop()
    time.advance(5_000)

    const restored = createActor(timerMachine, {
      clock: time.clock,
      wallClock: time.wallClock,
      snapshot: persisted,
    }).start()
    time.advance(0)
    yield* expect(restored.getSnapshot().value).toBe('fired')
    restored.stop()
  })

  it('pure-transition snapshots persist no timestamp', function*({ expect }) {
    const [snapshot] = initialTransition(timerMachine)
    const persisted = timerMachine.getPersistedSnapshot(snapshot) as any
    const [timer] = Object.values(persisted.timers) as any[]
    yield* expect(timer.startedAt).toEqual(undefined)
  })
})

describe('runStep runtime operation', () => {
  it('a host runStep owns the step journal instead of the snapshot', function*({ expect }) {
    const journal = new Map<string, unknown>()
    const calls: string[] = []
    const logic = createAsyncLogic({
      run: (_: any, enq: any) =>
        enq
          .step('a', () => Promise.resolve(1))
          .then((a: number) => enq.step('b', () => Promise.resolve(a + 1))),
    })
    const actor = createActor(logic)
    actor.system.runtime = {
      runStep: (_target: any, key: string, exec: () => any) => {
        calls.push(key)
        if (journal.has(key)) {
          return Promise.resolve(journal.get(key))
        }
        return Promise.resolve(exec()).then((output) => {
          journal.set(key, output)
          return output
        })
      },
    }
    actor.start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s: any) => s.status === 'done'))

    yield* expect({
      output: snapshot.output,
      calls,
      journalA: journal.get('a'),
      effectA: (snapshot as any).effects?.a,
      effectB: (snapshot as any).effects?.b,
    }).toEqual({
      output: 2,
      calls: ['a', 'b'],
      journalA: 1,
      effectA: undefined,
      effectB: undefined,
    })
  })

  it('a host runStep replays memoized results without re-running exec', function*({ expect }) {
    const journal = new Map<string, unknown>([['a', 41]])
    let executions = 0
    const logic = createAsyncLogic({
      run: (_: any, enq: any) =>
        enq
          .step('a', () => {
            executions++
            return Promise.resolve(1)
          })
          .then((a: number) => a + 1),
    })
    const actor = createActor(logic)
    actor.system.runtime = {
      runStep: (_target: any, key: string, exec: () => any) =>
        journal.has(key)
          ? Promise.resolve(journal.get(key))
          : Promise.resolve(exec()).then((output) => {
            journal.set(key, output)
            return output
          }),
    }
    actor.start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s: any) => s.status === 'done'))
    yield* expect({ output: snapshot.output, executions }).toEqual({
      output: 42,
      executions: 0,
    })
  })

  it('a durable adapter runStep receives the async child steps', function*({ expect }) {
    const stepped: string[] = []
    const asyncWorker = createAsyncLogic({
      id: 'asyncWorker',
      run: (_: any, enq: any) => enq.step('warmup', () => Promise.resolve('ok')).then(() => 'done'),
    })
    const machine = setup({ actors: { asyncWorker } }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors }: any, enq: any) => {
        enq.spawn(actors.asyncWorker)
      },
      states: { a: {} },
    })

    const durable = createDurable(machine, {
      executeAction: (action: any, _meta: any, runtime: any) => action.exec(runtime),
      startActor: (actor: any) => {
        actor.start()
      },
      runStep: (actor: any, key: string, exec: () => any) => {
        stepped.push(`${actor.address}:${key}`)
        return Promise.resolve(exec())
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* Effect.promise(() => Promise.resolve())
    yield* expect(stepped).toEqual(['order/asyncWorker:0:warmup'])
  })
})

describe('tenth round: review findings', () => {
  it('a completed child frees its id for the transition handling its completion', function*({ expect }) {
    const job = createMachine({
      initial: 'working',
      states: {
        working: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const machine = createMachine({
      id: 'sup',
      initial: 'a',
      entry: (_: any, enq: any) => {
        enq.spawn(job, { id: 'job' })
      },
      states: {
        a: {
          on: {
            KICK: ({ children }: any, enq: any) => {
              enq.sendTo(children.job, { type: 'FINISH' })
            },
            'xstate.done.actor': (_: any, enq: any) => {
              enq.spawn(job, { id: 'job' })
            },
          },
        },
      },
    })
    const actor = createActor(machine).start()
    const first = actor.getSnapshot().children['job']
    actor.send({ type: 'KICK' })
    const replacement = actor.getSnapshot().children['job'] as AnyActor
    yield* expect({
      status: actor.getSnapshot().status,
      replacementPresent: replacement !== undefined,
      replaced: replacement !== first,
      replacementStatus: replacement.getSnapshot().status,
    }).toEqual({
      status: 'active',
      replacementPresent: true,
      replaced: true,
      replacementStatus: 'active',
    })
  })

  it('restores under a custom clock with the declared delay', function*({ expect }) {
    const machine = createMachine({
      id: 'p',
      initial: 'waiting',
      states: {
        waiting: { after: { 1000: { target: 'fired' } } },
        fired: {},
      },
    })
    const live = createActor(machine).start()
    const persisted = live.getPersistedSnapshot() as any
    live.stop()
    const [timer] = Object.values(persisted.timers) as any[]
    const startedAtIsNumber = typeof timer.startedAt === 'number'

    const clock = new SimulatedClock()
    const restored = createActor(machine, {
      clock,
      snapshot: persisted,
    }).start()
    clock.increment(999)
    const valueAt999 = restored.getSnapshot().value
    clock.increment(1)
    yield* expect({
      startedAtIsNumber,
      valueAt999,
      valueAfter1000: restored.getSnapshot().value,
    }).toEqual({
      startedAtIsNumber: true,
      valueAt999: 'waiting',
      valueAfter1000: 'fired',
    })
    restored.stop()
  })

  it('captures root events for machine ids containing address separators', function*({ expect }) {
    const worker = setup({}).createMachine({
      id: 'worker',
      initial: 'idle',
      entry: ({ parent }: any, enq: any) => {
        enq.sendTo(parent, { type: 'HELLO' })
      },
      states: { idle: {} },
    })
    const machine = setup({ actors: { worker } }).createMachine({
      id: 'a/b',
      initial: 'a',
      entry: ({ actors }: any, enq: any) => {
        enq.spawn(actors.worker)
      },
      states: { a: {} },
    })
    const durable = createDurable(machine, {
      executeAction: () => {},
      startActor: (actor: any) => {
        actor.start()
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })
    const rootAddress = durable.rootAddress
    const [, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    const hello = yield* Effect.promise(() => durable.waitForEvent())
    yield* expect({ rootAddress, helloType: hello.type }).toEqual({
      rootAddress: 'a%2Fb',
      helloType: 'HELLO',
    })
  })
})

describe('remote handle serialization', () => {
  it('serializes with the same actor-reference marker as a co-located actor', function*({ expect }) {
    const machine = setup({ actors: { worker: workerMachine } }).createMachine({
      id: 'order',
      initial: 'a',
      states: {
        a: { invoke: { id: 'w', src: 'worker' } },
      },
    })
    const actor = createActor(machine).start()
    const persisted = actor.getPersistedSnapshot({ embedChildren: false })
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()
    const handle = restored.getSnapshot().children['w'] as AnyActor
    const json = JSON.parse(JSON.stringify(restored.getSnapshot())) as any
    yield* expect({
      handleJson: handle.toJSON!(),
      childType: json.children.w.xstate$type,
    }).toEqual({
      handleJson: {
        xstate$type: 'actorRef',
        id: 'w',
        address: 'order/w',
        src: 'worker',
      },
      childType: 'actorRef',
    })
    restored.stop()
  })
})

describe('timer startedAt survives a restore that never starts', () => {
  const timerMachine2 = createMachine({
    id: 'p2',
    initial: 'waiting',
    states: {
      waiting: { after: { 1000: { target: 'fired' } } },
      fired: {},
    },
  })

  it('re-persisting without a live schedule keeps the original deadline', function*({ expect }) {
    const time = createManualTime(5_000)
    const actor = createActor(timerMachine2, {
      clock: time.clock,
      wallClock: time.wallClock,
    }).start()
    time.advance(600)
    const persisted = actor.getPersistedSnapshot() as any
    actor.stop()
    const originalStart = Object.values(persisted.timers as any)[0] as any

    const restored = timerMachine2.restoreSnapshot(persisted as never)
    const repersisted = timerMachine2.getPersistedSnapshot(restored) as any
    const carried = Object.values(repersisted.timers as any)[0] as any

    const resumed = createActor(timerMachine2, {
      clock: time.clock,
      wallClock: time.wallClock,
      snapshot: repersisted,
    }).start()
    time.advance(399)
    const valueAt399 = resumed.getSnapshot().value
    time.advance(1)
    yield* expect({
      carriedStartedAt: carried.startedAt,
      originalStartedAt: originalStart.startedAt,
      valueAt399,
      valueAfter400: resumed.getSnapshot().value,
    }).toEqual({
      carriedStartedAt: 5_000,
      originalStartedAt: 5_000,
      valueAt399: 'waiting',
      valueAfter400: 'fired',
    })
    resumed.stop()
  })
})
