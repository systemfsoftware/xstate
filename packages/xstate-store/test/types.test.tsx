import { describe, it } from '@systemfsoftware/vitest'
import { createActor } from '@systemfsoftware/xstate'
import { z } from 'zod'
import { createStore, createStoreLogic, fromStore, type StoreSchemas } from '../src/index.js'

describe('emitted', () => {
  it('can emit a known event', function*({ expect }) {
    const store = createStore({
      context: {},
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
        },
      },
      on: {
        inc: (ctx, _, enq) => {
          enq.emit.increased({ upBy: 1 })
          return ctx
        },
      },
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it("can't emit an unknown event", function*({ expect }) {
    const store = createStore({
      context: {},
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
          decreased: z.object({ downBy: z.number() }),
        },
      },
      on: {
        inc: (ctx, _, enq) => {
          enq.emit
            // @ts-expect-error
            .unknown()
          return ctx
        },
      },
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it("can't emit a known event with wrong payload", function*({ expect }) {
    const store = createStore({
      context: {},
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
          decreased: z.object({ downBy: z.number() }),
        },
      },
      on: {
        inc: (ctx, _, enq) => {
          enq.emit.increased({
            // @ts-expect-error
            upBy: 'bazinga',
          })
          return ctx
        },
      },
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it('can subscribe to a known event', function*({ expect }) {
    const store = createStore<
      {},
      {},
      {
        increased: { upBy: number }
        decreased: { downBy: number }
      }
    >({
      context: {},
      on: {},
    })

    store.on('increased', (ev) => {
      ev satisfies { type: 'increased'; upBy: number }
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it("can't subscribe to a unknown event", function*({ expect }) {
    const store = createStore({
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
        },
      },
      context: {},
      on: {},
    })

    store.on('increased', (ev) => {})

    store.on(
      // @ts-expect-error
      'unknown',
      (ev) => {},
    )

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it('wildcard listener receives union of all emitted events', function*({ expect }) {
    const store = createStore({
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
          decreased: z.object({ downBy: z.number() }),
        },
      },
      context: {},
      on: {},
    })

    store.on('*', (ev) => {
      ev satisfies
        | { type: 'increased'; upBy: number }
        | { type: 'decreased'; downBy: number }

      // @ts-expect-error
      ev satisfies { type: 'unknown' }
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it('works with a discriminated union event payload', function*({ expect }) {
    const store = createStore({
      context: {},
      schemas: {
        emitted: {
          log: z.discriminatedUnion('level', [
            z.object({ level: z.literal('warn'), message: z.string() }),
            z.object({ level: z.literal('error'), error: z.string() }),
          ]),
        },
      },
      on: {
        log: (ctx, _ev, enq) => {
          enq.emit.log({ level: 'warn', message: 'hmm' })
          enq.emit.log({ level: 'error', error: 'uh oh' })
          enq.emit.log({
            level: 'error',
            // @ts-expect-error
            message: 'foo',
          })
          return ctx
        },
      },
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })
})

describe('trigger', () => {
  it('works with a distributive event payload', function*({ expect }) {
    const store = createStore({
      context: {},
      on: {
        log: (
          ctx,
          _ev:
            | { level: 'warn'; message: string }
            | { level: 'error'; error: string },
        ) => {
          return ctx
        },
      },
    })

    store.trigger.log({ level: 'warn', message: 'hmm' })
    store.trigger.log({ level: 'error', error: 'uh oh' })

    store.trigger.log({
      level: 'error',
      // @ts-expect-error
      message: 'foo',
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it('uses schema-declared events for trigger typing', function*({ expect }) {
    const store = createStore({
      schemas: {
        events: {
          log: z.discriminatedUnion('level', [
            z.object({ level: z.literal('warn'), message: z.string() }),
            z.object({ level: z.literal('error'), error: z.string() }),
          ]),
        },
      },
      context: {},
      on: {},
    })

    store.trigger.log({ level: 'warn', message: 'hmm' })
    store.trigger.log({ level: 'error', error: 'uh oh' })

    store.trigger.log({
      level: 'error',
      // @ts-expect-error
      message: 'foo',
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it('preserves inferred trigger typing when only emitted schemas are declared', function*({ expect }) {
    const store = createStore({
      schemas: {
        emitted: {
          logged: z.object({ message: z.string() }),
        },
      },
      context: {},
      on: {
        log: (ctx, ev: { message: string }, enq) => {
          enq.emit.logged({ message: ev.message })
          return ctx
        },
      },
    })

    store.trigger.log({ message: 'hello' })

    if (false) {
      // @ts-expect-error
      store.trigger.log({})

      // @ts-expect-error
      store.trigger.unknown()
    }

    yield* expect(store.getSnapshot().context).toEqual({})
  })

  it('uses schema-declared events for enqueued trigger typing', function*({ expect }) {
    const store = createStore({
      schemas: {
        events: {
          log: z.discriminatedUnion('level', [
            z.object({ level: z.literal('warn'), message: z.string() }),
            z.object({ level: z.literal('error'), error: z.string() }),
          ]),
          flush: z.object({}),
        },
      },
      context: {},
      on: {
        flush: (ctx, _event, enq) => {
          enq.trigger.flush()
          enq.trigger.flush({})
          enq.trigger.log({ level: 'warn', message: 'hmm' })
          enq.trigger.log({ level: 'error', error: 'uh oh' })

          enq.trigger.log({
            level: 'error',
            // @ts-expect-error
            message: 'foo',
          })

          // @ts-expect-error
          enq.trigger.unknown()

          return ctx
        },
      },
    })

    yield* expect(store.getSnapshot().context).toEqual({})
  })
})

describe('can', () => {
  it('uses event payload types', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      schemas: {
        events: {
          increment: z.object({ by: z.number() }),
          reset: z.object({}),
        },
      },
      on: {
        increment: (ctx, ev) => ({ count: ctx.count + ev.by }),
        reset: () => ({ count: 0 }),
      },
    })

    store.can.increment({ by: 1 }) satisfies boolean
    store.can.reset() satisfies boolean
    store.can.reset({}) satisfies boolean

    // @ts-expect-error
    store.can.increment()
    store.can.increment({
      // @ts-expect-error
      by: 'one',
    })

    yield* expect({
      context: store.getSnapshot().context,
      incrementAllowed: store.can.increment({ by: 1 }),
    }).toEqual({ context: { count: 0 }, incrementAllowed: true })
  })
})

describe('logic selectors', () => {
  it('infers selected values from a store', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (context) => ({ count: context.count + 1 }),
      },
    })
    const count = store.select((context) => context.count)
    const label = store.select((context) => `Count: ${context.count}`)

    count.get() satisfies number
    label.get() satisfies string

    if (false) {
      // @ts-expect-error
      count.get() satisfies string
    }

    yield* expect({ count: count.get(), label: label.get() }).toEqual({
      count: 0,
      label: 'Count: 0',
    })
  })

  it('infers input and selector values from reusable store logic', function*({ expect }) {
    const counterLogic = createStoreLogic({
      context: (input: { initialCount: number }) => ({
        count: input.initialCount,
      }),
      selectors: {
        count: (context: { count: number }) => context.count,
        label: (context: { count: number }) => `Count: ${context.count}`,
      },
      on: {
        inc: (context) => ({ count: context.count + 1 }),
      },
    })

    const store = counterLogic.createStore({ initialCount: 1 })

    store.selectors.count.get() satisfies number
    store.selectors.label.get() satisfies string

    if (false) {
      // @ts-expect-error
      counterLogic.createStore()

      // @ts-expect-error
      counterLogic.createStore(undefined)

      // @ts-expect-error
      counterLogic.createStore({ initialCount: 'one' })

      // @ts-expect-error
      store.selectors.label.get() satisfies number
    }

    yield* expect({
      count: store.selectors.count.get(),
      label: store.selectors.label.get(),
    }).toEqual({ count: 1, label: 'Count: 1' })
  })
})

describe('schemas', () => {
  const stringSchema = z.string()

  it('requires event and emitted schemas to define object payloads', function*({ expect }) {
    // @ts-expect-error event schemas must describe object payloads
    createStore({
      schemas: {
        events: {
          bad: stringSchema,
        },
      },
      context: {},
      on: {},
    })

    // @ts-expect-error emitted schemas must describe object payloads
    createStore({
      schemas: {
        emitted: {
          bad: stringSchema,
        },
      },
      context: {},
      on: {},
    })

    yield* expect(createStore({ context: {}, on: {} }).getSnapshot().context).toEqual({})
  })

  it('uses schema-declared context for snapshot typing', function*({ expect }) {
    const schemas = {
      context: z.object({ count: z.number(), label: z.string() }),
    }
    const store = createStore({
      schemas,
      context: {
        count: 0,
        label: 'ready',
      },
      on: {},
    })

    store.getSnapshot().context.label satisfies string
    store.schemas satisfies StoreSchemas | undefined

    // @ts-expect-error
    store.getSnapshot().context.label satisfies number

    yield* expect(store.getSnapshot().context).toEqual({
      count: 0,
      label: 'ready',
    })
  })

  it('merges schema-declared context with inferred event types', function*({ expect }) {
    const store = createStore({
      schemas: {
        context: z.object({ count: z.number(), label: z.string() }),
      },
      context: {
        count: 0,
        label: 'ready',
      },
      on: {
        rename: (ctx, ev: { label: string }) => ({
          ...ctx,
          label: ev.label,
        }),
      },
    })

    store.trigger.rename({ label: 'done' })
    store.getSnapshot().context.label satisfies string

    if (false) {
      // @ts-expect-error
      store.trigger.rename({})
    }

    yield* expect(store.getSnapshot().context).toEqual({
      count: 0,
      label: 'done',
    })
  })
})

describe('fromStore schemas', () => {
  it('preserves inferred event types when only emitted schemas are declared', function*({ expect }) {
    const logic = fromStore({
      context: (count: number) => ({ count }),
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
        },
      },
      on: {
        inc: (ctx, ev: { by: number }, enq) => {
          enq.emit.increased({ upBy: ev.by })
          return {
            count: ctx.count + ev.by,
          }
        },
      },
    })

    const actor = createActor(logic, {
      input: 1,
    })

    actor.send({ type: 'inc', by: 2 })
    actor.on('increased', (event) => {
      event.upBy satisfies number
    })

    if (false) {
      actor.send({
        type: 'inc',
        // @ts-expect-error
        message: 'nope',
      })

      actor.on(
        // @ts-expect-error
        'unknown',
        () => {},
      )
    }

    yield* expect(actor.getSnapshot().context).toEqual({ count: 1 })
  })

  it('uses schema-declared events for send typing', function*({ expect }) {
    const logic = fromStore({
      context: {
        count: 0,
      },
      schemas: {
        events: {
          inc: z.object({ by: z.number() }),
          reset: z.object({}),
        },
      },
      on: {
        inc: (ctx, ev) => ({
          count: ctx.count + ev.by,
        }),
      },
    })

    const actor = createActor(logic)

    actor.send({ type: 'inc', by: 1 })
    actor.send({ type: 'reset' })

    if (false) {
      // @ts-expect-error
      actor.send({ type: 'inc' })

      // @ts-expect-error
      actor.send({ type: 'unknown' })
    }

    yield* expect(actor.getSnapshot().context).toEqual({ count: 0 })
  })

  it('uses schema-declared context for snapshot typing', function*({ expect }) {
    const logic = fromStore({
      schemas: {
        context: z.object({ count: z.number(), label: z.string() }),
      },
      context: {
        count: 0,
        label: 'ready',
      },
      on: {},
    })

    const snapshot = logic.getInitialSnapshot({} as any, undefined as never)

    snapshot.context.label satisfies string

    // @ts-expect-error
    snapshot.context.label satisfies number

    yield* expect(snapshot.context).toEqual({ count: 0, label: 'ready' })
  })
})
