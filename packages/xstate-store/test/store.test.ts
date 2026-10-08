import { createBrowserInspector } from '@statelyai/inspect'
import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { produce } from 'immer'
import { z } from 'zod'
import { createStore, createStoreConfig, createStoreLogic } from '../src/index.js'
import { reset } from '../src/reset.js'
import { createStoreTransition } from '../src/store.js'
import { type AnyStoreConfig, type ContextFromStoreConfig, type EventFromStoreConfig } from '../src/types.js'

it('processes triggered events breadth-first when handlers append more events', function*({ expect }) {
  const processed: number[] = []
  const effects: number[] = []
  const store = createStore({
    context: { count: 0 },
    on: {
      start: (_context, _event, enqueue) => {
        for (let id = 0; id < 100; id++) {
          const triggerItem = enqueue.trigger['item']
          if (triggerItem === undefined) {
            throw new Error('expected an item trigger')
          }
          triggerItem({ id })
        }
      },
      item: (context, event: { id: number }, enqueue) => {
        processed.push(event.id)
        if (event.id < 100) {
          const triggerItem = enqueue.trigger['item']
          if (triggerItem === undefined) {
            throw new Error('expected an item trigger')
          }
          triggerItem({ id: event.id + 100 })
        }
        enqueue.effect(() => effects.push(event.id))
        return { count: context.count + 1 }
      },
    },
  })

  store.trigger.start()
  const expected = Array.from({ length: 200 }, (_, index) => index)
  yield* expect({
    processed,
    effects,
    count: store.getSnapshot().context.count,
  }).toEqual({
    processed: expected,
    effects: expected,
    count: 200,
  })
})

it('updates a store with an event without mutating original context', function*({ expect }) {
  const context = { count: 0 }
  const store = createStore({
    context,
    on: {
      inc: (context, event: { by: number }) => {
        return {
          count: context.count + event.by,
        }
      },
    },
  })

  const initial = store.getInitialSnapshot()

  store.trigger.inc({
    by: 1,
  })

  const next = store.getSnapshot()

  yield* expect({
    initial: initial.context,
    next: next.context,
    original: context.count,
  }).toEqual({
    initial: { count: 0 },
    next: { count: 1 },
    original: 0,
  })
})

it('can update context', function*({ expect }) {
  const store = createStore({
    context: { count: 0, greeting: 'hello' },
    on: {
      inc: (ctx) => ({
        ...ctx,
        count: ctx.count + 1,
      }),
      updateBoth: () => ({
        count: 42,
        greeting: 'hi',
      }),
    },
  })

  store.trigger.inc()
  const afterInc = store.getSnapshot().context

  store.trigger.updateBoth()
  yield* expect({ afterInc, afterUpdateBoth: store.getSnapshot().context }).toEqual({
    afterInc: { count: 1, greeting: 'hello' },
    afterUpdateBoth: { count: 42, greeting: 'hi' },
  })
})

it('handles unknown events sent via store.send (does not do anything)', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({
        count: ctx.count + 1,
      }),
    },
  })

  store.send({ type: 'unknown' } as any)
  yield* expect(store.getSnapshot().context).toEqual({ count: 0 })
})

it('updates state from sent events', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    on: {
      inc: (ctx, ev: { by: number }) => {
        return {
          count: ctx.count + ev.by,
        }
      },
      dec: (ctx, ev: { by: number }) => {
        return {
          count: ctx.count - ev.by,
        }
      },
      clear: () => {
        return {
          count: 0,
        }
      },
    },
  })

  store.trigger.inc({
    by: 9,
  })
  store.trigger.dec({
    by: 3,
  })

  const afterIncDec = store.getSnapshot().context
  store.trigger.clear()

  yield* expect({ afterIncDec, afterClear: store.getSnapshot().context }).toEqual({
    afterIncDec: { count: 6 },
    afterClear: { count: 0 },
  })
})

it('can be observed', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    on: {
      inc: (ctx) => ({
        count: ctx.count + 1,
      }),
    },
  })

  const counts: number[] = []

  const sub = store.subscribe((s) => counts.push(s.context.count))

  const afterSubscribe = [...counts]

  store.trigger.inc() // 1
  store.trigger.inc() // 2
  store.trigger.inc() // 3

  const afterSubscribedIncs = [...counts]

  sub.unsubscribe()

  store.trigger.inc() // 4
  store.trigger.inc() // 5
  store.trigger.inc() // 6

  yield* expect({ afterSubscribe, afterSubscribedIncs, afterUnsubscribe: counts }).toEqual({
    afterSubscribe: [],
    afterSubscribedIncs: [1, 2, 3],
    afterUnsubscribe: [1, 2, 3],
  })
})

it('does not expose atom internals at runtime', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {},
  })

  yield* expect(store).toSatisfy(
    (value) => !('_snapshot' in value),
    'the store does not expose atom internals',
  )
})

it('exposes schemas at runtime', function*({ expect }) {
  const schemas = {
    context: z.object({ count: z.number() }),
    events: {
      inc: z.object({ by: z.number() }),
    },
    emitted: {
      increased: z.object({ by: z.number() }),
    },
  }
  const store = createStore({
    schemas,
    context: { count: 0 },
    on: {
      inc: (context, event, enq) => {
        enq.emit.increased({ by: event.by })
        return { count: context.count + event.by }
      },
    },
  })

  yield* expect(store.schemas).toBe(schemas)
})

it('exposes schemas after extension', function*({ expect }) {
  const schemas = {
    context: z.object({ count: z.number() }),
  }
  const store = createStore({
    schemas,
    context: { count: 0 },
    on: {},
  }).with(reset())

  yield* expect(store.schemas).toBe(schemas)
})

it('can be inspected', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    on: {
      inc: (ctx) => ({
        count: ctx.count + 1,
      }),
    },
  })

  const evs: any[] = []

  store.inspect((ev) => evs.push(ev))

  store.trigger.inc()

  yield* expect(evs).toEqual([
    expect.objectContaining({
      type: '@xstate.transition',
      event: { type: '@xstate.init' },
      snapshot: expect.objectContaining({ context: { count: 0 } }),
    }),
    expect.objectContaining({
      type: '@xstate.transition',
      event: { type: 'inc' },
      snapshot: expect.objectContaining({ context: { count: 1 } }),
    }),
  ])
})

it.live('forwards store snapshots to @statelyai/inspect and unsubscribes', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: { inc: (context) => ({ count: context.count + 1 }) },
  })
  const sent: unknown[] = []
  const send = (message: unknown) => {
    sent.push(message)
  }
  const inspector = createBrowserInspector({ autoStart: false, send })
  const subscription = store.inspect((event) => {
    inspector.snapshot(event.actorRef, event.snapshot, { event: event.event })
  })

  try {
    store.trigger.inc()
    yield* Effect.promise(async () => {
      const forwarded = () =>
        sent.some((message) =>
          typeof message === 'object' && message !== null && 'type' in message &&
          message.type === '@xstate.snapshot'
        )
      const deadline = Date.now() + 1000
      while (!forwarded() && Date.now() < deadline) {
        const { promise, resolve } = Promise.withResolvers<void>()
        requestAnimationFrame(() => resolve())
        await promise
      }
    })
    yield* expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: '@xstate.snapshot',
          event: { type: 'inc' },
          snapshot: expect.objectContaining({ context: { count: 1 } }),
        }),
      ]),
    )
    subscription.unsubscribe()
    const sentCount = sent.length
    store.trigger.inc()
    yield* Effect.promise(() => {
      const { promise, resolve } = Promise.withResolvers<void>()
      requestAnimationFrame(() => resolve())
      return promise
    })
    yield* expect(sent.length).toEqual(sentCount)
  } finally {
    subscription.unsubscribe()
    inspector.stop()
  }
})

it('emitted events can be subscribed to', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })
        return {
          ...ctx,
          count: ctx.count + 1,
        }
      },
    },
  })

  const emitted: unknown[] = []

  store.on('increased', (event) => {
    emitted.push(event)
  })

  store.trigger.inc()

  yield* expect(emitted).toEqual([{ type: 'increased', upBy: 1 }])
})

it('emitted events can be unsubscribed to', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })

        return {
          ...ctx,
          count: ctx.count + 1,
        }
      },
    },
  })

  const emitted: unknown[] = []
  const sub = store.on('increased', (event) => {
    emitted.push(event)
  })
  store.trigger.inc()

  const afterFirst = [...emitted]

  sub.unsubscribe()
  store.trigger.inc()

  yield* expect({ afterFirst, afterUnsubscribe: emitted }).toEqual({
    afterFirst: [{ type: 'increased', upBy: 1 }],
    afterUnsubscribe: [{ type: 'increased', upBy: 1 }],
  })
})

it('emitted events occur after the snapshot is updated', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })

        return {
          ...ctx,
          count: ctx.count + 1,
        }
      },
    },
  })

  let seen: number | undefined

  store.on('increased', () => {
    seen = store.getSnapshot().context.count
  })

  store.trigger.inc()

  yield* expect(seen).toEqual(1)
})

it('events can be emitted with no payload', function*({ expect }) {
  const emitted: unknown[] = []

  const store = createStore({
    schemas: {
      emitted: {
        incremented: z.object({}),
        decremented: z.object({}),
        expectsPayload: z.object({ payload: z.string() }),
      },
    },
    context: {
      count: 0,
    },
    on: {
      inc: (_ctx, _ev, enq) => {
        enq.emit.incremented()
      },
      dec: (_ctx, _ev, enq) => {
        enq.emit.decremented({})
      },
      hasPayload: (_ctx, _ev, enq) => {
        enq.emit
          // @ts-expect-error Payload expected
          .expectsPayload()
      },
    },
  })

  store.on('incremented', (event) => {
    emitted.push(event)
  })

  store.trigger.inc()

  yield* expect(emitted).toEqual([{ type: 'incremented' }])
})

it('events can be emitted with optional payloads (type check)', function*({ expect }) {
  const store = createStore({
    schemas: {
      emitted: {
        optionalPayload: z.object({ payload: z.string().optional() }),
      },
    },
    context: {},
    on: {
      inc: (_ctx, _ev, enq) => {
        enq.emit.optionalPayload()

        enq.emit.optionalPayload({ payload: 'hello' })

        enq.emit.optionalPayload({})

        enq.emit.optionalPayload(
          // @ts-expect-error
          'foo',
        )
      },
    },
  })

  yield* expect(Object.keys(store.trigger)).toEqual(['inc'])
})

it.live('effects can be enqueued', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.effect(() => {
          setTimeout(() => {
            const decTrigger = store.trigger['dec']
            if (decTrigger === undefined) {
              throw new Error('expected a dec trigger')
            }
            decTrigger()
          }, 5)
        })

        return {
          ...ctx,
          count: ctx.count + 1,
        }
      },
      dec: (ctx) => ({
        ...ctx,
        count: ctx.count - 1,
      }),
    },
  })

  const incTrigger = store.trigger['inc']
  if (incTrigger === undefined) {
    throw new Error('expected an inc trigger')
  }
  incTrigger()

  yield* expect(store.getSnapshot().context.count).toEqual(1)

  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

  yield* expect(store.getSnapshot().context.count).toEqual(0)
})

it('events can be enqueued from transitions', function*({ expect }) {
  const store = createStore({
    context: {
      bears: 0,
      fishes: 0,
    },
    schemas: {
      events: {
        addBear: z.object({}),
        addFish: z.object({ amount: z.number() }),
        addBearAndFish: z.object({}),
      },
    },
    on: {
      addBear: (ctx) => ({
        ...ctx,
        bears: ctx.bears + 1,
      }),
      addFish: (ctx, event) => ({
        ...ctx,
        fishes: ctx.fishes + event.amount,
      }),
      addBearAndFish: (ctx, _, enq) => {
        enq.trigger.addBear()
        enq.trigger.addFish({ amount: 1 })

        return ctx
      },
    },
  })

  store.trigger.addBearAndFish()

  yield* expect(store.getSnapshot().context).toEqual({
    bears: 1,
    fishes: 1,
  })
})

it('effect-only transitions should execute effects', function*({ expect }) {
  const effectRuns: string[] = []
  const store = createStore({
    context: { count: 0 },
    on: {
      justEffect: (ctx, _, enq) => {
        enq.effect(() => {
          effectRuns.push('effect')
        })
      },
    },
  })

  const justEffectTrigger = store.trigger['justEffect']
  if (justEffectTrigger === undefined) {
    throw new Error('expected a justEffect trigger')
  }
  justEffectTrigger()

  yield* expect(effectRuns).toEqual(['effect'])
})

it('emits-only transitions should emit events', function*({ expect }) {
  const emitted: unknown[] = []
  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        emitted: z.object({}),
      },
    },
    on: {
      justEmit: (ctx, _, enq) => {
        enq.emit.emitted()
      },
    },
  })

  store.on('emitted', (event) => {
    emitted.push(event)
  })

  store.trigger.justEmit()

  yield* expect(emitted).toEqual([{ type: 'emitted' }])
})

it('checks whether events can transition', function*({ expect }) {
  const effectRuns: string[] = []
  const emittedEvents: unknown[] = []
  const store = createStore({
    context: { count: 9 },
    schemas: {
      events: {
        increment: z.object({ by: z.number() }),
        noop: z.object({}),
        effectOnly: z.object({}),
        emitOnly: z.object({}),
        triggerOnly: z.object({}),
        unavailable: z.object({}),
      },
      emitted: {
        emitted: z.object({}),
      },
    },
    on: {
      increment: (ctx, ev) => {
        if (ctx.count + ev.by > 10) {
          return
        }

        return { count: ctx.count + ev.by }
      },
      noop: (ctx) => ctx,
      effectOnly: (_, __, enq) => {
        enq.effect(() => {
          effectRuns.push('effect')
        })
      },
      emitOnly: (_, __, enq) => {
        enq.emit.emitted()
      },
      triggerOnly: (_, __, enq) => {
        enq.trigger.increment({ by: 1 })
      },
    },
  })

  store.on('emitted', (event) => {
    emittedEvents.push(event)
  })

  yield* expect({
    incrementBy1: store.can.increment({ by: 1 }),
    incrementBy2: store.can.increment({ by: 2 }),
    noop: store.can.noop(),
    effectOnly: store.can.effectOnly(),
    emitOnly: store.can.emitOnly(),
    triggerOnly: store.can.triggerOnly(),
    unavailable: store.can.unavailable(),
    context: store.getSnapshot().context,
    effectCalls: effectRuns,
    emittedCalls: emittedEvents,
  }).toEqual({
    incrementBy1: true,
    incrementBy2: false,
    noop: true,
    effectOnly: true,
    emitOnly: true,
    triggerOnly: true,
    unavailable: false,
    context: { count: 9 },
    effectCalls: [],
    emittedCalls: [],
  })
})

it('checks whether Immer transitions can transition without changing context', function*({ expect }) {
  const store = createStore({
    context: { count: 10 },
    on: {
      increment: (ctx, ev: { by: number }) => {
        if (ctx.count + ev.by > 10) {
          return
        }

        return produce(ctx, (draft) => {
          draft.count += ev.by
        })
      },
    },
  })

  const snapshot = store.getSnapshot()

  const canZero = store.can.increment({ by: 0 })
  const sameSnapshot = store.getSnapshot() === snapshot
  const canOne = store.can.increment({ by: 1 })

  store.trigger.increment({ by: 0 })
  const afterZero = store.getSnapshot().context

  store.trigger.increment({ by: 1 })
  const afterOne = store.getSnapshot().context

  yield* expect({ canZero, sameSnapshot, canOne, afterZero, afterOne }).toEqual({
    canZero: true,
    sameSnapshot: true,
    canOne: false,
    afterZero: { count: 10 },
    afterOne: { count: 10 },
  })
})

it('wildcard listener receives all emitted events', function*({ expect }) {
  const emitted: unknown[] = []
  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
        decreased: z.object({ downBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })
        return { ...ctx, count: ctx.count + 1 }
      },
      dec: (ctx, _, enq) => {
        enq.emit.decreased({ downBy: 1 })
        return { ...ctx, count: ctx.count - 1 }
      },
    },
  })

  store.on('*', (event) => {
    emitted.push(event)
  })

  store.trigger.inc()
  store.trigger.dec()

  yield* expect(emitted).toEqual([
    { type: 'increased', upBy: 1 },
    { type: 'decreased', downBy: 1 },
  ])
})

it('wildcard listener can be unsubscribed', function*({ expect }) {
  const emitted: unknown[] = []
  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })
        return { ...ctx, count: ctx.count + 1 }
      },
    },
  })

  const sub = store.on('*', (event) => {
    emitted.push(event)
  })
  store.trigger.inc()
  const afterFirst = [...emitted]

  sub.unsubscribe()
  store.trigger.inc()

  yield* expect({ afterFirst, afterUnsubscribe: emitted }).toEqual({
    afterFirst: [{ type: 'increased', upBy: 1 }],
    afterUnsubscribe: [{ type: 'increased', upBy: 1 }],
  })
})

it('wildcard listener is called after specific listener', function*({ expect }) {
  const order: string[] = []
  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })
        return { ...ctx, count: ctx.count + 1 }
      },
    },
  })

  store.on('increased', () => order.push('specific'))
  store.on('*', () => order.push('wildcard'))

  store.trigger.inc()

  yield* expect(order).toEqual(['specific', 'wildcard'])
})

it.live('async effects can be enqueued', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.effect(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          const decTrigger = store.trigger['dec']
          if (decTrigger === undefined) {
            throw new Error('expected a dec trigger')
          }
          decTrigger()
        })

        return {
          ...ctx,
          count: ctx.count + 1,
        }
      },
      dec: (ctx) => ({
        ...ctx,
        count: ctx.count - 1,
      }),
    },
  })

  const incTrigger = store.trigger['inc']
  if (incTrigger === undefined) {
    throw new Error('expected an inc trigger')
  }
  incTrigger()

  yield* expect(store.getSnapshot().context.count).toEqual(1)

  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

  yield* expect(store.getSnapshot().context.count).toEqual(0)
})

it.live('effects receive an enqueue object to trigger events (no closure needed)', function*({ expect }) {
  const logic = createStoreLogic({
    context: () => ({ count: 0, status: 'idle' }),
    on: {
      inc: (ctx, _, enq) => {
        enq.effect(async ({ trigger }) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          const doneTrigger = trigger['done']
          if (doneTrigger === undefined) {
            throw new Error('expected a done trigger')
          }
          doneTrigger()
        })
        return { ...ctx, status: 'loading' }
      },
      done: (ctx) => ({ count: ctx.count + 1, status: 'done' }),
    },
  })

  const store = logic.createStore()

  store.trigger.inc()
  yield* expect(store.getSnapshot().context).toEqual({ count: 0, status: 'loading' })

  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
  yield* expect(store.getSnapshot().context).toEqual({ count: 1, status: 'done' })
})

it.live('effects can read fresh state after awaiting via enq.getSnapshot()', function*({ expect }) {
  const seen: number[] = []
  const store = createStore({
    context: { count: 0 },
    on: {
      start: (ctx, _, enq) => {
        enq.effect(async ({ getSnapshot, trigger }) => {
          // `ctx` is stale by now; getSnapshot() reflects the bump below
          await new Promise((resolve) => setTimeout(resolve, 5))
          seen.push(getSnapshot().context.count)
          const doneTrigger = trigger['done']
          if (doneTrigger === undefined) {
            throw new Error('expected a done trigger')
          }
          doneTrigger()
        })
        return { ...ctx, count: ctx.count + 1 }
      },
      bump: (ctx) => ({ count: ctx.count + 10 }),
      done: (ctx) => ctx,
    },
  })

  const startTrigger = store.trigger['start']
  if (startTrigger === undefined) {
    throw new Error('expected a start trigger')
  }
  startTrigger() // count -> 1
  const bumpTrigger = store.trigger['bump']
  if (bumpTrigger === undefined) {
    throw new Error('expected a bump trigger')
  }
  bumpTrigger() // count -> 11 (after effect was enqueued, before it runs)

  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

  yield* expect(seen).toEqual([11])
})

it('sync effects read the current transition snapshot via enq.getSnapshot()', function*({ expect }) {
  const seen: number[] = []
  const store = createStore({
    context: { count: 0 },
    on: {
      start: (ctx, _, enq) => {
        enq.effect(({ trigger }) => {
          const bumpTrigger = trigger['bump']
          if (bumpTrigger === undefined) {
            throw new Error('expected a bump trigger')
          }
          bumpTrigger()
        })
        enq.effect(({ getSnapshot }) => {
          seen.push(getSnapshot().context.count)
        })
        return { count: ctx.count + 1 }
      },
      bump: (ctx) => ({ count: ctx.count + 10 }),
    },
  })

  const startTrigger = store.trigger['start']
  if (startTrigger === undefined) {
    throw new Error('expected a start trigger')
  }
  startTrigger()

  yield* expect({ seen, count: store.getSnapshot().context.count }).toEqual({ seen: [1], count: 11 })
})

it.live('effects can use enq.send to dispatch events', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx, _, enq) => {
        enq.effect(({ send }) => {
          send({ type: 'dec' })
        })
        return { ...ctx, count: ctx.count + 1 }
      },
      dec: (ctx) => ({ ...ctx, count: ctx.count - 1 }),
    },
  })

  const incTrigger = store.trigger['inc']
  if (incTrigger === undefined) {
    throw new Error('expected an inc trigger')
  }
  incTrigger()

  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
  yield* expect(store.getSnapshot().context.count).toEqual(0)
})

it('rejects async handlers in createStoreTransition(...)', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {},
  })
  const transition = store.transition

  const unknownResult = transition(store.getSnapshot(), {
    type: 'bad',
  } as any)

  const unsupportedTransition = createStoreTransition({
    bad: (async (ctx: { count: number }) => ({
      count: ctx.count + 1,
    })) as any,
  })

  let thrownMessage: string | undefined
  try {
    unsupportedTransition(
      {
        context: { count: 0 },
        status: 'active',
        output: undefined,
        error: undefined,
      },
      { type: 'bad' },
    )
  } catch (error) {
    thrownMessage = error instanceof Error ? error.message : String(error)
  }

  yield* expect({
    unchanged: unknownResult[0] === store.getSnapshot(),
    effects: unknownResult[1],
    thrownMessage,
  }).toEqual({
    unchanged: true,
    effects: [],
    thrownMessage: 'Async transition unsupported here',
  })
})

describe('store.trigger', () => {
  it('should allow triggering events with a fluent API', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        increment: (ctx, event: { by: number }) => ({
          count: ctx.count + event.by,
        }),
      },
    })

    store.trigger.increment({ by: 5 })

    yield* expect(store.getSnapshot().context.count).toBe(5)
  })

  it('should provide type safety for event payloads', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        increment: (ctx, event: { by: number }) => ({
          count: ctx.count + event.by,
        }),
        reset: () => ({ count: 0 }),
      },
    })

    if (false) {
      // @ts-expect-error - missing required 'by' property
      store.trigger.increment({})

      // @ts-expect-error - extra property not allowed
      store.trigger.increment({ by: 1, extra: true })

      // @ts-expect-error - unknown event
      store.trigger.unknown({})
    }

    // Valid usage with no payload
    store.trigger.reset()

    // Valid usage with payload
    store.trigger.increment({ by: 1 })

    yield* expect(store.getSnapshot().context).toEqual({ count: 1 })
  })

  it('should be equivalent to store.send', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        increment: (ctx, event: { by: number }) => ({
          count: ctx.count + event.by,
        }),
      },
    })

    const sent: unknown[] = []
    const originalSend = store.send
    store.send = (event) => {
      sent.push(event)
      originalSend(event)
    }

    store.trigger.increment({ by: 5 })

    yield* expect(sent).toEqual([{ type: 'increment', by: 5 }])
  })

  it('should fail fast for unknown trigger names on config-based stores', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        increment: (ctx, event: { by: number }) => ({
          count: ctx.count + event.by,
        }),
        reset: () => ({ count: 0 }),
      },
    })

    const triggerKeys = Object.keys(store.trigger)

    let thrown: unknown
    try {
      const unknownTrigger = store.trigger as any
      unknownTrigger.unknown()
    } catch (error) {
      thrown = error
    }

    yield* expect({
      keys: triggerKeys,
      threwTypeError: thrown instanceof TypeError,
      count: store.getSnapshot().context.count,
    }).toEqual({
      keys: ['increment', 'reset'],
      threwTypeError: true,
      count: 0,
    })
  })

  it('should include extension events in the concrete trigger object', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        increment: (ctx, event: { by: number }) => ({
          count: ctx.count + event.by,
        }),
      },
    }).with(reset())

    store.trigger.increment({ by: 2 })
    store.trigger.reset()

    yield* expect({ keys: Object.keys(store.trigger), count: store.getSnapshot().context.count }).toEqual({
      keys: ['increment', 'reset'],
      count: 0,
    })
  })

  it('should include schema-declared events in the concrete trigger object', function*({ expect }) {
    const store = createStore({
      schemas: {
        events: {
          increment: z.object({ by: z.number() }),
          reset: z.object({}),
        },
      },
      context: { count: 0 },
      on: {
        increment: (ctx, event) => ({
          count: ctx.count + event.by,
        }),
      },
    })

    store.trigger.increment({ by: 2 })
    store.trigger.reset()
    store.trigger.reset({})

    yield* expect({ keys: Object.keys(store.trigger), count: store.getSnapshot().context.count }).toEqual({
      keys: ['increment', 'reset'],
      count: 2,
    })
  })
})

it('works with typestates', function*({ expect }) {
  type ContextStates =
    | {
      status: 'loading'
      data: null
    }
    | {
      status: 'success'
      data: string
    }

  const store = createStore({
    context: {
      status: 'loading',
      data: null,
    } as ContextStates,
    on: {
      loaded: () => ({
        status: 'success' as const,
        data: 'hello',
      }),
      loading: () => ({
        status: 'loading' as const,
        data: null,
      }),
    },
  })

  const context = store.getSnapshot().context

  if (context.status === 'loading') {
    context.data satisfies null
    // @ts-expect-error
    context.data satisfies string
  } else {
    context.status satisfies 'success'
    // @ts-expect-error
    context.status satisfies 'loading'

    context.data satisfies string
    // @ts-expect-error
    context.data satisfies null
  }

  yield* expect(store.getSnapshot().context).toEqual({ status: 'loading', data: null })
})

it('the emit type is not overridden by the payload', function*({ expect }) {
  const emitted: unknown[] = []
  type Context = {
    drawer?: Drawer | null
  }

  type Drawer = {
    id: string
  }

  const context: Context = {
    drawer: null,
  }

  const drawersBridgeStore = createStore({
    schemas: {
      emitted: {
        drawerOpened: z.object({ drawer: z.object({ id: z.string() }) }),
      },
    },
    context,
    on: {
      openDrawer: (_, event: { drawer: Drawer }, enqueue) => {
        enqueue.emit.drawerOpened(event)

        return {
          drawer: event.drawer,
        }
      },
    },
  })

  drawersBridgeStore.on('drawerOpened', (event) => {
    emitted.push(event)
  })

  drawersBridgeStore.trigger.openDrawer({
    drawer: { id: 'a' },
  })

  yield* expect(emitted).toEqual([{ type: 'drawerOpened', drawer: { id: 'a' } }])
})

describe('store.transition', () => {
  it('returns next state and effects for a given state and event', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      schemas: {
        emitted: {
          increased: z.object({ by: z.number() }),
          nothing: z.object({}),
        },
      },
      on: {
        inc: (ctx, event: { by: number }, enq) => {
          enq.emit.increased({ by: event.by })
          return {
            count: ctx.count + event.by,
          }
        },
      },
    })

    const [nextState, effects] = store.transition(store.getSnapshot(), {
      type: 'inc',
      by: 2,
    })

    yield* expect({ context: nextState.context, effects }).toEqual({
      context: { count: 2 },
      effects: [{ type: 'increased', by: 2 }],
    })
  })

  it('returns unchanged state and empty effects for unknown events', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({
          count: ctx.count + 1,
        }),
      },
    })

    const currentState = store.getSnapshot()
    const [nextState, effects] = store.transition(currentState, {
      // @ts-expect-error
      type: 'unknown',
    })

    yield* expect({ same: nextState === currentState, effects }).toEqual({ same: true, effects: [] })
  })

  it('collects enqueued effects', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx, _, enq) => {
          enq.effect(() => {
            // This effect function would normally do something
          })
          return {
            count: ctx.count + 1,
          }
        },
      },
    })

    const [nextState, effects] = store.transition(store.getSnapshot(), {
      type: 'inc',
    })

    yield* expect({ context: nextState.context, effectKinds: effects.map((effect) => typeof effect) }).toEqual({
      context: { count: 1 },
      effectKinds: ['function'],
    })
  })

  it('resolves enqueued trigger events and collects effects in pure transitions', function*({ expect }) {
    const calls: string[] = []
    const store = createStore({
      context: { count: 0 },
      schemas: {
        events: {
          inc: z.object({}),
          incTwice: z.object({}),
        },
      },
      on: {
        inc: (ctx, _, enq) => {
          enq.effect(() => {
            calls.push('inc')
          })

          return {
            count: ctx.count + 1,
          }
        },
        incTwice: (ctx, _, enq) => {
          enq.effect(() => {
            calls.push('before')
          })
          enq.trigger.inc()
          enq.trigger.inc()
          enq.effect(() => {
            calls.push('after')
          })

          return ctx
        },
      },
    })

    const [nextState, effects] = store.transition(store.getSnapshot(), {
      type: 'incTwice',
    })

    const effectKinds = effects.map((effect) => typeof effect)

    for (const effect of effects) {
      if (typeof effect === 'function') {
        effect()
      }
    }
    const firstRunCalls = [...calls]
    calls.length = 0

    store.trigger.incTwice()

    yield* expect({
      context: nextState.context,
      effectKinds,
      firstRunCalls,
      afterTriggerContext: store.getSnapshot().context,
      secondRunCalls: [...calls],
    }).toEqual({
      context: { count: 2 },
      effectKinds: ['function', 'function', 'function', 'function'],
      firstRunCalls: ['before', 'after', 'inc', 'inc'],
      afterTriggerContext: { count: 2 },
      secondRunCalls: ['before', 'after', 'inc', 'inc'],
    })
  })
})

it('can be created with a logic object', function*({ expect }) {
  const store = createStore({
    getInitialSnapshot: () => ({
      context: { count: 0 },
      status: 'active' as const,
      output: undefined,
      error: undefined,
    }),
    transition: (
      snapshot,
      event: {
        type: 'inc'
      },
    ) => {
      if (event.type === 'inc') {
        return [
          { ...snapshot, context: { count: snapshot.context.count + 1 } },
          [],
        ]
      }
      return [snapshot, []]
    },
  })

  const initial = store.getSnapshot().context

  store.trigger.inc()

  yield* expect({ initial, afterInc: store.getSnapshot().context }).toEqual({
    initial: { count: 0 },
    afterInc: { count: 1 },
  })

  // @ts-expect-error
  store.trigger.unknown()

  store.getSnapshot().context.count satisfies number

  // @ts-expect-error
  store.getSnapshot().context.count satisfies string
})

it('can select from a store', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (context) => ({
        count: context.count + 1,
      }),
    },
  })

  const countCalls: number[] = []
  const evenCalls: boolean[] = []
  const count = store.select((context) => context.count)
  const isEven = store.select((context) => context.count % 2 === 0)

  count.subscribe((value) => {
    countCalls.push(value)
  })
  isEven.subscribe((value) => {
    evenCalls.push(value)
  })

  const initialCount = count.get()
  const initialEven = isEven.get()

  store.trigger.inc()

  yield* expect({
    initialCount,
    initialEven,
    afterCount: count.get(),
    afterEven: isEven.get(),
    countCalls,
    evenCalls,
  }).toEqual({
    initialCount: 0,
    initialEven: true,
    afterCount: 1,
    afterEven: false,
    countCalls: [1],
    evenCalls: [false],
  })
})

it('can create reusable store logic with selectors', function*({ expect }) {
  const counterLogic = createStoreLogic({
    context: (input: { initialCount: number }) => ({
      count: input.initialCount,
    }),
    selectors: {
      count: (context) => context.count,
      doubled: (context) => {
        // @ts-expect-error
        context.missing
        return context.count * 2
      },
    },
    on: {
      inc: (context) => {
        return {
          count: context.count + 1,
        }
      },
    },
  })

  const store = counterLogic.createStore({ initialCount: 2 })

  const initial = { count: store.selectors.count.get(), doubled: store.selectors.doubled.get() }

  store.trigger.inc()

  yield* expect({
    initial,
    afterInc: { count: store.selectors.count.get(), doubled: store.selectors.doubled.get() },
  }).toEqual({
    initial: { count: 2, doubled: 4 },
    afterInc: { count: 3, doubled: 6 },
  })
})

it('preserves selectors through store extensions', function*({ expect }) {
  const counterLogic = createStoreLogic({
    context: { count: 0 },
    selectors: {
      doubled: (context: { count: number }) => context.count * 2,
    },
    on: {
      inc: (context) => ({
        count: context.count + 1,
      }),
    },
  })

  const store = counterLogic.createStore().with(reset())

  const initial = store.selectors.doubled.get()

  store.trigger.inc()
  const afterInc = store.selectors.doubled.get()

  store.trigger.reset()
  const afterReset = store.selectors.doubled.get()

  yield* expect({ initial, afterInc, afterReset }).toEqual({ initial: 0, afterInc: 2, afterReset: 0 })
})

it('should not trigger update if the snapshot is the same', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      doNothing: (ctx) => ctx,
    },
  })

  const notifications: unknown[] = []
  store.subscribe((snapshot) => {
    notifications.push(snapshot)
  })

  store.trigger.doNothing()
  store.trigger.doNothing()

  yield* expect(notifications).toEqual([])
})

it('should not trigger update if the snapshot is the same even if there are effects', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      doNothing: (ctx, _, enq) => {
        enq.effect(() => {
          // …
        })
        return ctx
      },
    },
  })

  const notifications: unknown[] = []
  store.subscribe((snapshot) => {
    notifications.push(snapshot)
  })

  const doNothingTrigger = store.trigger['doNothing']
  if (doNothingTrigger === undefined) {
    throw new Error('expected a doNothing trigger')
  }
  doNothingTrigger()
  doNothingTrigger()

  yield* expect(notifications).toEqual([])
})

describe('types', () => {
  it('AnyStoreConfig', function*({ expect }) {
    function transformStoreConfig(_config: AnyStoreConfig): void {}

    transformStoreConfig({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    })

    // @ts-expect-error
    transformStoreConfig({})

    yield* expect(transformStoreConfig.length).toEqual(1)
  })

  it('EventFromStoreConfig', function*({ expect }) {
    const storeConfig = createStoreConfig({
      context: { count: 0 },
      on: {
        inc: (ctx, event: { by: number }) => ({ count: ctx.count + event.by }),
      },
    })

    let ev: EventFromStoreConfig<typeof storeConfig> = {
      type: 'inc',
      by: 1,
    }

    ev satisfies {
      type: 'inc'
      by: number
    }

    // @ts-expect-error
    ev satisfies { type: 'unknown' }

    yield* expect(ev).toEqual({ type: 'inc', by: 1 })
  })

  it('ContextFromStoreConfig', function*({ expect }) {
    const storeConfig = createStoreConfig({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    })

    type Context = ContextFromStoreConfig<typeof storeConfig>

    const context: Context = { count: 0 }

    context.count satisfies number

    // @ts-expect-error
    context.count satisfies string

    yield* expect(context).toEqual({ count: 0 })
  })

  it('generics can be provided', function*({ expect }) {
    type Context = {
      coffeeBeans: number
      water: number
    }

    type Events =
      | {
        type: 'addWater'
        amount: number
      }
      | {
        type: 'grindBeans'
      }

    type Emitted =
      | { type: 'brewing' }
      | { type: 'beansGround'; amount: number }

    const store = createStore<Context, Events, Emitted>({
      context: {
        coffeeBeans: 0,
        water: 0,
      },
      on: {
        addWater: (ctx, event) => ({
          ...ctx,
          water: ctx.water + event.amount,
        }),
        grindBeans: (ctx, _, enq) => {
          enq.emit.brewing()

          enq.emit.beansGround({ amount: 1 })

          // @ts-expect-error
          enq.emit.beansGround()

          enq.emit.brewing({})

          return {
            ...ctx,
            coffeeBeans: ctx.coffeeBeans + 1,
          }
        },
      },
    })

    store.trigger.addWater({ amount: 1 })

    store.trigger.grindBeans()

    if (false) {
      // @ts-expect-error
      store.trigger.unknown()
    }

    yield* expect(store.getSnapshot().context).toEqual({ coffeeBeans: 1, water: 1 })
  })

  it('localizes TypeScript errors to the specific transition', function*({ expect }) {
    // but now it's localized to the `changeSort` transition.
    const store = createStore({
      context: {
        sort: 'asc' as const,
      },
      on: {
        // @ts-expect-error
        changeSort: (_, event: { sort: 'desc' }) => ({
          sort: event.sort,
        }),
      },
    })

    yield* expect(store.getSnapshot().context).toEqual({ sort: 'asc' })
  })
})

it('emitted events work with store extensions', function*({ expect }) {
  const store = createStore({
    context: {
      count: 0,
    },
    schemas: {
      emitted: {
        increased: z.object({ upBy: z.number() }),
      },
    },
    on: {
      inc: (ctx, _, enq) => {
        enq.emit.increased({ upBy: 1 })
        return {
          ...ctx,
          count: ctx.count + 1,
        }
      },
    },
  }).with(reset())

  const emitted: unknown[] = []

  store.on('increased', (event) => {
    emitted.push(event)
  })

  store.trigger.inc()

  yield* expect(emitted).toEqual([{ type: 'increased', upBy: 1 }])
})
