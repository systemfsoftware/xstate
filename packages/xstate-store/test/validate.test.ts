import { it, vi } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createStore } from '../src/index.js'
import { reset } from '../src/reset.js'
import { StoreValidationError, validateSchemas } from '../src/validate.js'

function getThrown(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function emitUnknown(enq: { emit: unknown }): void {
  const emit = enq.emit as Record<string, () => void>
  emit['unknown']!()
}

it('validates initial context when the extension is applied', function*({
  expect,
}) {
  yield* expect(() =>
    createStore({
      schemas: {
        context: z.object({ count: z.number() }),
      },
      context: { count: 'nope' } as unknown as { count: number },
      on: {},
    }).with(validateSchemas())
  ).toThrow(StoreValidationError)
})

it('validates event payloads before transitions', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        inc: z.object({ by: z.number() }),
      },
    },
    context: { count: 0 },
    on: {
      inc: (ctx, ev) => ({ count: ctx.count + ev.by }),
    },
  }).with(validateSchemas())

  const canInvalid = store.can.inc({ by: 'nope' } as unknown as { by: number })
  const invalidThrown = getThrown(() => store.trigger.inc({ by: 'nope' } as unknown as { by: number }))
  const afterInvalid = store.getSnapshot().context

  store.trigger.inc({ by: 2 })
  const afterValid = store.getSnapshot().context

  yield* expect({
    canInvalid,
    invalidThrown: invalidThrown instanceof StoreValidationError,
    afterInvalid,
    afterValid,
  }).toEqual({
    canInvalid: false,
    invalidThrown: true,
    afterInvalid: { count: 0 },
    afterValid: { count: 2 },
  })
})

it('validates final context after a macrostep', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        break: z.object({}),
      },
      context: z.object({ count: z.number() }),
    },
    context: { count: 0 },
    on: {
      break: () => ({ count: 'nope' }) as unknown as { count: number },
    },
  }).with(validateSchemas())

  const canBreak = store.can.break()
  const breakThrown = getThrown(() => store.trigger.break())

  yield* expect({
    canBreak,
    breakThrown: breakThrown instanceof StoreValidationError,
  }).toEqual({ canBreak: false, breakThrown: true })
})

it('validates emitted payloads before running effects', function*({ expect }) {
  const effectSpy = vi.fn()
  const store = createStore({
    schemas: {
      events: {
        send: z.object({}),
      },
      emitted: {
        sent: z.object({ value: z.number() }),
      },
    },
    context: {},
    on: {
      send: (ctx, _, enq) => {
        enq.effect(effectSpy)
        enq.emit.sent({ value: 'nope' } as unknown as { value: number })
        return ctx
      },
    },
  }).with(validateSchemas())

  const sendThrown = getThrown(() => store.trigger.send())

  yield* expect({
    sendThrown: sendThrown instanceof StoreValidationError,
    effectCalls: effectSpy.mock.calls,
  }).toEqual({ sendThrown: true, effectCalls: [] })
})

it('validates no-payload events and emitted events as empty objects', function*({
  expect,
}) {
  const emittedSpy = vi.fn()
  const store = createStore({
    schemas: {
      events: {
        reset: z.object({}),
      },
      emitted: {
        reset: z.object({}),
      },
    },
    context: { count: 1 },
    on: {
      reset: (_, __, enq) => {
        enq.emit.reset()
        return { count: 0 }
      },
    },
  }).with(validateSchemas())

  store.on('reset', emittedSpy)
  store.trigger.reset()

  yield* expect({
    afterReset: store.getSnapshot().context,
    emittedCalls: emittedSpy.mock.calls,
  }).toEqual({
    afterReset: { count: 0 },
    emittedCalls: [[{ type: 'reset' }]],
  })
})

it('throws for unknown events and emitted events by default', function*({
  expect,
}) {
  const store = createStore({
    schemas: {
      events: {
        send: z.object({}),
      },
      emitted: {
        known: z.object({}),
      },
    },
    context: {},
    on: {
      send: (ctx, _, enq) => {
        emitUnknown(enq)
        return ctx
      },
    },
  }).with(validateSchemas())

  yield* expect({
    unknownEvent: getThrown(() => store.send({ type: 'unknown' } as unknown as Parameters<typeof store.send>[0])),
    unknownEmitted: getThrown(() => store.trigger.send()),
  }).toMatchObject({
    unknownEvent: {
      reason: 'unknownEvent',
      eventType: 'unknown',
      payload: {},
    },
    unknownEmitted: {
      reason: 'unknownEmitted',
      eventType: 'unknown',
      payload: {},
    },
  })
})

it('returns false from can for validation errors', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        inc: z.object({ by: z.number() }),
      },
    },
    context: { count: 0 },
    on: {
      inc: (ctx, ev) => ({ count: ctx.count + ev.by }),
    },
  }).with(validateSchemas())

  yield* expect({ can: store.can.inc({ by: 'nope' } as unknown as { by: number }) }).toEqual({
    can: false,
  })
})

it('exposes validation error details', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        inc: z.object({ by: z.number() }),
      },
    },
    context: { count: 0 },
    on: {
      inc: (ctx, ev) => ({ count: ctx.count + ev.by }),
    },
  }).with(validateSchemas())

  yield* expect(
    getThrown(() => store.trigger.inc({ by: 'nope' } as unknown as { by: number })),
  ).toMatchObject({
    name: 'StoreValidationError',
    reason: 'invalidEvent',
    eventType: 'inc',
    payload: { by: 'nope' },
    issues: expect.any(Array),
  })
})

it('throws for unknown emitted events by default', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        send: z.object({}),
      },
      emitted: {
        known: z.object({}),
      },
    },
    context: {},
    on: {
      send: (ctx, _, enq) => {
        emitUnknown(enq)
        return ctx
      },
    },
  }).with(validateSchemas())

  yield* expect(getThrown(() => store.trigger.send())).toMatchObject({
    reason: 'unknownEmitted',
    eventType: 'unknown',
    payload: {},
  })
})

it('throws for unknown events by default', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        send: z.object({}),
      },
    },
    context: {},
    on: {},
  }).with(validateSchemas())

  yield* expect(
    getThrown(() => store.send({ type: 'unknown' } as unknown as Parameters<typeof store.send>[0])),
  ).toMatchObject({
    reason: 'unknownEvent',
    eventType: 'unknown',
    payload: {},
  })
})

it('can ignore unknown events and emitted events', function*({ expect }) {
  const emittedSpy = vi.fn()
  const store = createStore({
    schemas: {
      events: {
        send: z.object({}),
      },
      emitted: {
        known: z.object({}),
      },
    },
    context: {},
    on: {
      send: (ctx, _, enq) => {
        emitUnknown(enq)
        return ctx
      },
    },
  }).with(
    validateSchemas({
      unknownEvents: 'ignore',
      unknownEmitted: 'ignore',
    }),
  )

  store.on('*', emittedSpy)
  store.send({ type: 'unknown' } as unknown as Parameters<typeof store.send>[0])
  store.trigger.send()

  yield* expect(emittedSpy.mock.calls).toEqual([[{ type: 'unknown' }]])
})

it('allows extension-added event types without schemas', function*({
  expect,
}) {
  const store = createStore({
    schemas: {
      context: z.object({ count: z.number() }),
      events: {
        inc: z.object({}),
      },
    },
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  })
    .with(reset())
    .with(validateSchemas())

  store.trigger.inc()
  store.trigger.reset()

  yield* expect(store.getSnapshot().context).toEqual({ count: 0 })
})

it('can opt out of individual validation areas', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        inc: z.object({ by: z.number() }),
      },
      context: z.object({ count: z.number() }),
    },
    context: { count: 0 },
    on: {
      inc: (ctx, ev) => ({ count: ctx.count + ev.by }),
    },
  }).with(validateSchemas({ context: false, events: false }))

  store.trigger.inc({ by: 1 })

  yield* expect(store.getSnapshot().context).toEqual({ count: 1 })
})

it('warns and no-ops in dev when there are no schemas', function*({ expect }) {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(validateSchemas())

    store.trigger.inc()

    yield* expect({
      warns: warnSpy.mock.calls,
      afterInc: store.getSnapshot().context,
    }).toEqual({
      warns: [
        [
          'The "validateSchemas" store extension was used, but the store has no schemas to validate.',
        ],
      ],
      afterInc: { count: 1 },
    })
  } finally {
    warnSpy.mockRestore()
  }
})

it('throws a validation error for async schemas', function*({ expect }) {
  const store = createStore({
    schemas: {
      events: {
        ping: z.object({}).refine(async () => true),
      },
    },
    context: {},
    on: {
      ping: (ctx) => ctx,
    },
  }).with(validateSchemas())

  yield* expect(getThrown(() => store.trigger.ping())).toMatchObject({
    reason: 'asyncValidationUnsupported',
    eventType: 'ping',
  })
})
