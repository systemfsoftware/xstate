import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable } from '../src/durable/index.js'
import {
  type AnyActor,
  createCallbackLogic,
  createMachine,
  deliverEvent,
  type EffectDescriptor,
  setup,
} from '../src/index.js'

interface ThrownSummary {
  readonly name: string
  readonly message: string
}

type Settled =
  | { readonly resolved: true; readonly value: unknown }
  | { readonly resolved: false; readonly error: ThrownSummary }

const thrownSummary = (error: unknown): ThrownSummary =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: typeof error, message: String(error) }

const summaryOf = (run: () => unknown): ThrownSummary | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    return thrownSummary(error)
  }
}

const settledError = (
  promise: PromiseLike<unknown>,
): Effect.Effect<ThrownSummary | undefined> =>
  Effect.promise(() => promise.then(() => undefined, (error: unknown) => thrownSummary(error)))

const settledValue = (promise: PromiseLike<unknown>): Effect.Effect<Settled> =>
  Effect.promise(() =>
    promise.then(
      (value: unknown) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, error: thrownSummary(error) }),
    )
  )

const isSpawnDescriptor = (
  descriptor: EffectDescriptor,
): descriptor is Extract<EffectDescriptor, { type: '@xstate.spawn' }> => descriptor.type === '@xstate.spawn'

const workerMachine = setup({}).createMachine({
  id: 'worker',
  initial: 'idle',
  states: {
    idle: {
      on: {
        PING: ({ parent }, enq) => {
          enq.sendTo(parent, { type: 'WORKER.READY' })
          return { target: 'ready' }
        },
      },
    },
    ready: {},
  },
})

const orderMachine = setup({
  actors: { worker: workerMachine },
}).createMachine({
  id: 'order',
  initial: 'starting',
  entry: ({ actors }, enq) => {
    enq.spawn(actors.worker)
  },
  states: {
    starting: {
      on: {
        KICK: ({ children }, enq) => {
          enq.sendTo(children['worker:0'], { type: 'PING' })
        },
        'WORKER.READY': { target: 'done' },
      },
    },
    done: { type: 'final' },
  },
})

describe('durable execution with only adapter runtime operations', () => {
  it('executes spawn effects without a per-effect runtime', function*({ expect }) {
    const operations: string[] = []
    const durable = createDurable(orderMachine, {
      executeAction: (action) => {
        operations.push(`action:${action.type}`)
      },
      spawnActor: (_source, actor) => {
        operations.push(`spawn:${actor.address}`)
      },
      startActor: (actor) => {
        operations.push(`start:${actor.address}`)
        actor.start()
      },
      sendEvent: (source, target, event) => {
        operations.push(
          `send:${source?.address}->${target.address}:${event.type}`,
        )
        deliverEvent(source, target, event)
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    let [snapshot, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* expect(operations).toEqual([
      'spawn:order/worker:0',
      'start:order/worker:0',
    ])
    ;[snapshot, effects] = durable.transition(snapshot, { type: 'KICK' })
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* expect({
      sentRootPing: operations.includes('send:order->order/worker:0:PING'),
      sentChildReply: operations.includes(
        'send:order/worker:0->order:WORKER.READY',
      ),
    }).toEqual({ sentRootPing: true, sentChildReply: false })
    const reply = yield* Effect.promise(() => durable.waitForEvent())
    ;[snapshot] = durable.transition(snapshot, reply)
    yield* expect({ reply, status: snapshot.status }).toEqual({
      reply: { type: 'WORKER.READY' },
      status: 'done',
    })
  })
})

describe('durable effect descriptors', () => {
  it('tags every effect with a JSON-safe descriptor', function*({ expect }) {
    const durable = createDurable(orderMachine, {
      executeAction: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    const descriptors = effects.map(({ descriptor }) => descriptor)
    const spawn = descriptors.find(isSpawnDescriptor)
    yield* expect({
      roundTripped: descriptors.map((descriptor) => JSON.stringify(JSON.parse(JSON.stringify(descriptor)))),
      types: descriptors.map(({ type }) => type),
      spawnActor: spawn?.actor,
      spawnSrc: spawn?.src,
    }).toEqual({
      roundTripped: descriptors.map((descriptor) => JSON.stringify(descriptor)),
      types: ['@xstate.spawn', '@xstate.start'],
      spawnActor: 'order/worker:0',
      spawnSrc: 'worker',
    })
  })

  it('retains an explicitly selected source when aliases share logic', function*({ expect }) {
    const shared = createMachine({})
    const machine = setup({
      actors: { first: shared, second: shared },
    }).createMachine({
      id: 'aliases',
      entry: (_, enq) => {
        enq.spawn('second', { id: 'worker' })
      },
    })
    const durable = createDurable(machine, {
      executeAction: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    yield* expect(
      effects.find(({ descriptor }) => descriptor.type === '@xstate.spawn')
        ?.descriptor,
    ).toMatchObject({ actor: 'aliases/worker', src: 'second' })
  })
})

describe('durable rootAddress', () => {
  it('is the logic name, known before any transition', function*({ expect }) {
    const durable = createDurable(orderMachine, {
      executeAction: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })
    const [snapshot] = durable.initialTransition()
    yield* expect({
      rootAddress: durable.rootAddress,
      actorAddress: durable.getActorRef(snapshot)?.address,
    }).toEqual({ rootAddress: 'order', actorAddress: 'order' })
  })
})

describe('restored children under a durable execution', () => {
  it('routes sends to restored remote handles through the system runtime', function*({ expect }) {
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

    const seed = createDurable(machine, {
      executeAction: () => {},
      startActor: (actor) => {
        actor.start()
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })
    const [seedSnapshot, seedEffects] = seed.initialTransition()
    yield* Effect.promise(() => seed.executeEffects(seedEffects))
    const persisted = machine.getPersistedSnapshot(seedSnapshot, {
      embedChildren: false,
    } as never)

    const sent: string[] = []
    const durable = createDurable(machine, {
      executeAction: () => {},
      sendEvent: (_source, target, event) => {
        sent.push(`${target.address}:${event.type}`)
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })
    const restored = machine.restoreSnapshot(persisted as never)
    const [, effects] = durable.transition(restored as never, {
      type: 'KICK',
    })
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* expect(sent).toEqual(['order/worker:0:PING'])
  })
})

describe('review findings: durable runtime edges', () => {
  it('serializes nested operations behind the running one', function*({ expect }) {
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

    const order: string[] = []
    const inFlightObservations: boolean[] = []
    let inFlight = false
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const durable = createDurable(machine, {
      executeAction: () => {},
      startActor: (actor) => {
        inFlightObservations.push(inFlight)
        inFlight = true
        order.push('start')
        void actor.system.scheduleTimer(actor, 'nested', 5)
        started.resolve()
        return release.promise.then(() => {
          order.push('start:done')
          inFlight = false
        })
      },
      scheduleTimer: (_source, id) => {
        inFlightObservations.push(inFlight)
        inFlight = true
        order.push(`timer:${id}`)
        return Promise.resolve().then(() => {
          inFlight = false
        })
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    const execution = durable.executeEffects(effects)
    yield* Effect.promise(() => started.promise)
    release.resolve()
    yield* Effect.promise(() => execution)
    yield* expect({ order, inFlightObservations }).toEqual({
      order: ['start', 'start:done', 'timer:nested'],
      inFlightObservations: [false, false],
    })
  })

  it('hands custom actions the system runtime when no per-effect runtime exists', function*({ expect }) {
    const sent: string[] = []
    const sendEventTypes: string[] = []
    const machine = setup({
      actions: {
        notify: () => {},
      },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actions }, enq) => {
        enq(actions.notify)
      },
      states: { a: {} },
    })

    const durable = createDurable(machine, {
      executeAction: (_action, _metadata, runtime) => {
        sendEventTypes.push(typeof runtime.sendEvent)
        return Promise.resolve(
          runtime.sendEvent!(undefined, { address: 'elsewhere' } as never, {
            type: 'X',
          }),
        ).then(() => {})
      },
      sendEvent: (_source, target, event) => {
        sent.push(`${target.address}:${event.type}`)
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* expect({ sent, sendEventTypes }).toEqual({
      sent: ['elsewhere:X'],
      sendEventTypes: ['function'],
    })
  })
})

describe('review findings: fourth round', () => {
  it('a failed runtime operation rejects executeEffects even after settling early', function*({ expect }) {
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

    let spawnAttempted = false
    const durable = createDurable(machine, {
      executeAction: () => {},
      spawnActor: () => {
        spawnAttempted = true
        return Promise.resolve().then(() => {
          throw new Error('host rejected the spawn')
        })
      },
      startActor: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    const outcome = yield* settledError(durable.executeEffects(effects))
    yield* expect({ spawnAttempted, outcome }).toEqual({
      spawnAttempted: true,
      outcome: { name: 'Error', message: 'host rejected the spawn' },
    })
  })

  it('failed batches do not leak captured root events into later calls', function*({ expect }) {
    const machine = setup({
      actors: { worker: workerMachine },
      actions: { boom: () => {} },
    }).createMachine({
      id: 'order',
      initial: 'a',
      entry: ({ actors, actions }, enq) => {
        enq.spawn(actors.worker)
        enq(actions.boom)
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

    const durable = createDurable(machine, {
      executeAction: (action) => {
        if (action.type === 'boom') {
          throw new Error('step failed')
        }
      },
      sendEvent: (source, target, event) => {
        deliverEvent(source, target, event)
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [snapshot, effects] = durable.initialTransition()
    const batchFailure = yield* settledError(durable.executeEffects(effects))
    const [, kickEffects] = durable.transition(snapshot, { type: 'KICK' })
    yield* Effect.promise(() => durable.executeEffects(kickEffects))
    const waitFailure = yield* settledError(durable.waitForEvent())
    yield* expect({ batchFailure, waitFailure }).toEqual({
      batchFailure: { name: 'Error', message: 'step failed' },
      waitFailure: { name: 'Error', message: 'host-driven loop' },
    })
  })

  it('a per-effect runtime falls back to the system runtime for omitted operations', function*({ expect }) {
    const operations: string[] = []
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

    const durable = createDurable(machine, {
      executeAction: () => {},
      spawnActor: (_source, actor) => {
        operations.push(`system-spawn:${actor.address}`)
      },
      startActor: (actor) => {
        operations.push(`system-start:${actor.address}`)
      },
      runtime: () => ({
        sendEvent: () => {},
      }),
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* expect(operations).toEqual([
      'system-spawn:order/worker:0',
      'system-start:order/worker:0',
    ])
  })
})

describe('review findings: fifth round', () => {
  it('a retried batch succeeds after a transient host operation failure', function*({ expect }) {
    let attempt = 0
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

    const durable = createDurable(machine, {
      executeAction: () => {},
      spawnActor: () => {
        attempt++
        if (attempt === 1) {
          return Promise.resolve().then(() => {
            throw new Error('transient host failure')
          })
        }
        return undefined
      },
      startActor: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    const firstAttempt = yield* settledError(durable.executeEffects(effects))
    const retry = yield* settledValue(durable.executeEffects(effects))
    yield* expect({ firstAttempt, retry }).toEqual({
      firstAttempt: { name: 'Error', message: 'transient host failure' },
      retry: { resolved: true, value: undefined },
    })
  })
})

describe('review findings: sixth round', () => {
  it('root-bound events sent while the loop is parked reach the host runtime', function*({ expect }) {
    const sent: string[] = []
    const replyDelivered = Promise.withResolvers<void>()
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

    const durable = createDurable(machine, {
      executeAction: () => {},
      spawnActor: () => {},
      startActor: (actor) => {
        actor.start()
      },
      sendEvent: (_source, target, event) => {
        sent.push(`${target.address}:${event.type}`)
        if (target.address === durable.rootAddress) {
          replyDelivered.resolve()
        } else {
          deliverEvent(_source, target, event)
        }
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [snapshot, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))

    const worker = snapshot.children['worker:0'] as AnyActor
    yield* Effect.promise(() =>
      Promise.resolve(
        durable.getActorRef(snapshot)!.system.runtime!.sendEvent!(
          undefined,
          worker,
          { type: 'PING' },
        ),
      )
    )
    yield* Effect.promise(() => replyDelivered.promise)
    yield* expect(sent).toEqual(['order/worker:0:PING', 'order:WORKER.READY'])

    const [, nextEffects] = durable.transition(snapshot, {
      type: 'WORKER.READY',
    })
    yield* Effect.promise(() => durable.executeEffects(nextEffects))
    yield* expect(yield* settledError(durable.waitForEvent())).toEqual({
      name: 'Error',
      message: 'host-driven loop',
    })
  })

  it('an operation that fails while the loop is parked does not fail the next batch', function*({ expect }) {
    let parked = false
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

    const durable = createDurable(machine, {
      executeAction: () => {},
      spawnActor: () => {},
      startActor: (actor) => {
        actor.start()
      },
      sendEvent: (source, target, event) => {
        if (parked) {
          return Promise.reject(new Error('host-owned delivery failed'))
        }
        deliverEvent(source, target, event)
        return undefined
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [snapshot, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))

    parked = true
    const worker = snapshot.children['worker:0'] as AnyActor
    const parkedFailure = yield* settledError(
      Promise.resolve(
        durable.getActorRef(snapshot)!.system.runtime!.sendEvent!(
          undefined,
          worker,
          { type: 'PING' },
        ),
      ),
    )

    parked = false
    const [, kickEffects] = durable.transition(snapshot, { type: 'KICK' })
    const retry = yield* settledValue(durable.executeEffects(kickEffects))
    yield* expect({ parkedFailure, retry }).toEqual({
      parkedFailure: { name: 'Error', message: 'host-owned delivery failed' },
      retry: { resolved: true, value: undefined },
    })
  })
})

describe('review findings: seventh round', () => {
  it('a per-effect runtime keeps local behavior for operations neither implements', function*({ expect }) {
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

    const durable = createDurable(machine, {
      sendEvent: () => {},
      runtime: () => ({ sendEvent: () => {} }),
      executeAction: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [snapshot, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    const child = snapshot.children['worker:0'] as AnyActor
    yield* expect(child.getSnapshot().status).toBe('active')
  })
})

describe('review findings: eighth round', () => {
  it('rejects overlapping executeEffects calls', function*({ expect }) {
    const durable = createDurable(orderMachine, {
      executeAction: () => {},
      spawnActor: () => {},
      startActor: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    const first = durable.executeEffects(effects)
    const overlapFailure = yield* settledError(durable.executeEffects(effects))
    yield* Effect.promise(() => first)
    yield* expect(overlapFailure).toEqual({
      name: 'Error',
      message: 'executeEffects calls must not overlap: await the previous call before starting the next batch.',
    })
  })

  it('a parked root-addressed event without a host mailbox hook fails loudly', function*({ expect }) {
    let send: ((event: { type: string }) => void) | undefined
    const emitter = createCallbackLogic(({ sendBack }) => {
      send = sendBack
    })
    const machine = createMachine({
      id: 'order',
      initial: 'a',
      entry: (_, enq) => {
        enq.spawn(emitter)
      },
      states: { a: {} },
    })

    const durable = createDurable(machine, {
      executeAction: () => {},
      cancelTimer: () => {},
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    yield* expect(summaryOf(() => send!({ type: 'LATE' }))).toEqual({
      name: 'Error',
      message:
        'A root-addressed event ("LATE") was produced while the durable loop was parked, but the adapter has no enqueueRootEvent or sendEvent to receive it. Implement enqueueRootEvent to place root-addressed events in the host\'s mailbox.',
    })
  })
})
