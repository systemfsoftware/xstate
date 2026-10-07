import { describe, it, vi } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createStore } from '../src/index.js'
import { flushStorage, isHydrated, persist } from '../src/persist.js'
import { undoRedo } from '../src/undo.js'

it.each(['persist-first', 'undo-first'] as const)(
  'preserves persistence metadata through snapshot undo and redo (%s)',
  function*(order, { expect }) {
    const storage = {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const base = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    })
    const store = order === 'persist-first'
      ? base
        .with(persist({ name: 'counter', storage }))
        .with(undoRedo({ strategy: 'snapshot' }))
      : base
        .with(undoRedo({ strategy: 'snapshot' }))
        .with(persist({ name: 'counter', storage }))

    store.trigger.inc()
    store.trigger.undo()
    const afterUndo = {
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }
    let flushError: unknown
    try {
      flushStorage(store)
    } catch (error) {
      flushError = error
    }
    store.trigger.redo()
    const afterRedo = {
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }

    yield* expect({ afterUndo, flushError, afterRedo }).toEqual({
      afterUndo: { count: 0, hydrated: true },
      flushError: undefined,
      afterRedo: { count: 1, hydrated: true },
    })
  },
)

it('preserves live extension metadata through custom restore triggers', function*({ expect }) {
  const writes = vi.fn()
  const store = createStore({
    context: { count: 0 },
    on: { inc: (context) => ({ count: context.count + 1 }) },
  })
    .with(
      persist({
        name: 'counter',
        storage: { getItem: () => null, setItem: writes, removeItem: vi.fn() },
      }),
    )
    .with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ next }, enqueue) => {
          enqueue.trigger.inc()
          return next
        },
      }),
    )

  store.trigger.inc()
  writes.mockClear()
  store.trigger.undo()

  yield* expect({
    hydrated: isHydrated(store),
    count: store.getSnapshot().context.count,
    writes: writes.mock.calls,
  }).toEqual({
    hydrated: true,
    count: 1,
    writes: [['counter', JSON.stringify({ context: { count: 1 }, version: 0 })]],
  })
})

it('keeps metadata updates produced by custom restore triggers', function*({ expect }) {
  const revision = Symbol('revision')
  const store = createStore({
    context: { count: 0 },
    on: { inc: (context) => ({ count: context.count + 1 }) },
  })
    .with<{}>((logic) => ({
      ...logic,
      getInitialSnapshot: () => ({
        ...logic.getInitialSnapshot(),
        [revision]: 0,
      }),
      transition: (snapshot, event) => {
        const [next, effects] = logic.transition(snapshot, event)
        return [
          {
            ...next,
            [revision]: (Reflect.get(snapshot, revision) as number) + 1,
          },
          effects,
        ]
      },
    }))
    .with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ next }, enqueue) => {
          enqueue.trigger.inc()
          return next
        },
      }),
    )

  store.trigger.inc()
  const afterInc = Reflect.get(store.getSnapshot(), revision)
  store.trigger.undo()
  const afterUndo = Reflect.get(store.getSnapshot(), revision)
  store.trigger.redo()
  const afterRedo = Reflect.get(store.getSnapshot(), revision)

  yield* expect({ afterInc, afterUndo, afterRedo }).toEqual({
    afterInc: 1,
    afterUndo: 2,
    afterRedo: 3,
  })
})

it('should undo a single event', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(undoRedo())

  store.trigger.inc()
  const afterInc = store.getSnapshot().context.count

  store.trigger.undo()
  const afterUndo = store.getSnapshot().context.count

  yield* expect({ afterInc, afterUndo }).toEqual({ afterInc: 1, afterUndo: 0 })
})

it('should redo a previously undone event', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(undoRedo())

  store.trigger.inc()
  store.trigger.undo()
  store.trigger.redo()

  yield* expect(store.getSnapshot().context.count).toBe(1)
})

it('should undo/redo multiple events, non-transactional', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(undoRedo())

  store.trigger.inc()
  store.trigger.inc()
  store.trigger.inc()
  const afterIncs = store.getSnapshot().context.count
  store.trigger.undo()
  const afterFirstUndo = store.getSnapshot().context.count
  store.trigger.undo()
  const afterSecondUndo = store.getSnapshot().context.count
  store.trigger.redo()
  const afterFirstRedo = store.getSnapshot().context.count
  store.trigger.redo()
  const afterSecondRedo = store.getSnapshot().context.count

  yield* expect([
    afterIncs,
    afterFirstUndo,
    afterSecondUndo,
    afterFirstRedo,
    afterSecondRedo,
  ]).toEqual([3, 2, 1, 2, 3])
})

it('should group events by transaction ID', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
      dec: (ctx) => ({ count: ctx.count - 1 }),
    },
  }).with(undoRedo({ getTransactionId: (event) => event.type }))

  store.trigger.inc()
  store.trigger.inc()
  const afterFirstTransaction = store.getSnapshot().context.count

  store.trigger.dec()
  store.trigger.dec()
  const afterSecondTransaction = store.getSnapshot().context.count

  store.trigger.undo()
  const afterFirstUndo = store.getSnapshot().context.count

  store.trigger.undo()
  const afterSecondUndo = store.getSnapshot().context.count

  yield* expect([
    afterFirstTransaction,
    afterSecondTransaction,
    afterFirstUndo,
    afterSecondUndo,
  ]).toEqual([2, 0, 2, 0])
})

it('should maintain correct state when interleaving undo/redo with new events', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
      dec: (ctx) => ({ count: ctx.count - 1 }),
    },
  }).with(undoRedo())

  store.trigger.inc()
  const afterFirstInc = store.getSnapshot().context.count
  store.trigger.inc()
  const afterSecondInc = store.getSnapshot().context.count
  store.trigger.undo()
  const afterFirstUndo = store.getSnapshot().context.count
  store.trigger.dec()
  const afterDec = store.getSnapshot().context.count
  store.trigger.undo()
  const afterSecondUndo = store.getSnapshot().context.count
  store.trigger.redo()
  const afterRedo = store.getSnapshot().context.count
  const atEnd = store.getSnapshot().context.count

  yield* expect([
    afterFirstInc,
    afterSecondInc,
    afterFirstUndo,
    afterDec,
    afterSecondUndo,
    afterRedo,
    atEnd,
  ]).toEqual([1, 2, 1, 0, 1, 0, 0])
})

it('should do nothing when undoing with empty history', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(undoRedo())

  const initialSnapshot = store.getSnapshot()
  store.trigger.undo()

  yield* expect(store.getSnapshot()).toEqual(initialSnapshot)
})

it('should do nothing when redoing with empty undo stack', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(undoRedo())

  const initialSnapshot = store.getSnapshot()
  store.trigger.redo()

  yield* expect(store.getSnapshot()).toEqual(initialSnapshot)
})

it('should clear redo stack when new events occur after undo', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
      dec: (ctx) => ({ count: ctx.count - 1 }),
    },
  }).with(undoRedo())

  store.trigger.inc()
  const afterFirstInc = store.getSnapshot().context.count
  store.trigger.inc()
  const afterSecondInc = store.getSnapshot().context.count
  store.trigger.undo()
  const afterUndo = store.getSnapshot().context.count
  store.trigger.dec()

  store.trigger.redo()
  const afterRedo = store.getSnapshot().context.count

  yield* expect([afterFirstInc, afterSecondInc, afterUndo, afterRedo]).toEqual([1, 2, 1, 0])
})

it('should preserve emitted events during undo/redo', function*({ expect }) {
  type Events = { type: 'inc' }

  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        changed: z.object({ value: z.number() }),
      },
    },
    on: {
      inc: (ctx, _: Events, enq) => {
        enq.emit.changed({ value: ctx.count + 1 })
        return { count: ctx.count + 1 }
      },
    },
  }).with(undoRedo())

  const emittedEvents: any[] = []
  store.on('changed', (event) => {
    emittedEvents.push(event)
  })

  store.trigger.inc()
  store.trigger.undo()
  store.trigger.redo()

  yield* expect(emittedEvents).toEqual([
    { type: 'changed', value: 1 },
    { type: 'changed', value: 1 },
  ])
})

it('should preserve context and event types', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(undoRedo())

  store.getSnapshot().context satisfies { count: number }
  store.trigger.inc()
  store.trigger.undo()
  store.trigger.redo()

  // @ts-expect-error
  store.getSnapshot().context.foo

  if (false) {
    // @ts-expect-error
    store.trigger.dec()
  }

  yield* expect(store.getSnapshot().context).toEqual({ count: 1 })
})

it('should skip non-undoable events during undo', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
      log: (ctx) => ctx,
    },
  }).with(undoRedo({ skipEvent: (event) => event.type === 'log' }))

  store.trigger.inc()
  store.trigger.log()
  store.trigger.inc()
  const afterEvents = store.getSnapshot().context.count

  store.trigger.undo()
  const afterUndo = store.getSnapshot().context.count

  yield* expect({ afterEvents, afterUndo }).toEqual({ afterEvents: 2, afterUndo: 1 })
})

it('should skip non-redoable events during redo', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
      log: (ctx) => ctx,
    },
  }).with(undoRedo({ skipEvent: (event) => event.type === 'log' }))

  store.trigger.inc()
  store.trigger.log()
  store.trigger.inc()
  store.trigger.undo()
  const afterUndo = store.getSnapshot().context.count

  store.trigger.redo()
  const afterRedo = store.getSnapshot().context.count

  yield* expect({ afterUndo, afterRedo }).toEqual({ afterUndo: 1, afterRedo: 2 })
})

it('should skip events with transaction grouping', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
      log: (ctx) => ctx,
    },
  }).with(
    undoRedo({
      getTransactionId: (event) => event.type,
      skipEvent: (event) => event.type === 'log',
    }),
  )

  store.trigger.inc()
  store.trigger.inc()
  const afterFirstTransaction = store.getSnapshot().context.count

  store.trigger.log()
  store.trigger.log()
  const afterLogs = store.getSnapshot().context.count

  store.trigger.inc()
  store.trigger.inc()
  const afterSecondTransaction = store.getSnapshot().context.count

  store.trigger.undo()
  const afterUndo = store.getSnapshot().context.count

  yield* expect([
    afterFirstTransaction,
    afterLogs,
    afterSecondTransaction,
    afterUndo,
  ]).toEqual([2, 2, 4, 0])
})

it('should handle mixed undoable and non-undoable events', function*({ expect }) {
  const store = createStore({
    context: { count: 0, logs: [] as string[] },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1, logs: ctx.logs }),
      log: (ctx, event: { type: 'log'; message: string }) => ({
        logs: [...(ctx.logs || []), event.message],
        count: ctx.count,
      }),
    },
  }).with(
    undoRedo({
      skipEvent: (event) => event.type === 'log',
    }),
  )

  store.trigger.inc()
  store.trigger.log({ message: 'first log' })
  store.trigger.inc()
  store.trigger.log({ message: 'second log' })
  store.trigger.inc()

  const afterEvents = {
    count: store.getSnapshot().context.count,
    logs: store.getSnapshot().context.logs,
  }

  store.trigger.undo()
  const afterFirstUndo = {
    count: store.getSnapshot().context.count,
    logs: store.getSnapshot().context.logs,
  }
  store.trigger.undo()
  const afterSecondUndo = {
    count: store.getSnapshot().context.count,
    logs: store.getSnapshot().context.logs,
  }
  store.trigger.undo()
  const afterThirdUndo = {
    count: store.getSnapshot().context.count,
    logs: store.getSnapshot().context.logs,
  }

  yield* expect({ afterEvents, afterFirstUndo, afterSecondUndo, afterThirdUndo }).toEqual({
    afterEvents: { count: 3, logs: ['first log', 'second log'] },
    afterFirstUndo: { count: 2, logs: [] },
    afterSecondUndo: { count: 1, logs: [] },
    afterThirdUndo: { count: 0, logs: [] },
  })
})

it('should not replay emitted events for skipped events during undo/redo', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        changed: z.object({ value: z.number() }),
        logged: z.object({ message: z.string() }),
      },
    },
    on: {
      inc: (ctx, _event, enq) => {
        enq.emit.changed({ value: ctx.count + 1 })
        return { count: ctx.count + 1 }
      },
      log: (ctx, event: { message: string }, enq) => {
        enq.emit.logged({ message: (event as any).message })
        return ctx
      },
    },
  }).with(
    undoRedo({
      skipEvent: (event) => event.type === 'log',
    }),
  )

  const emittedEvents: any[] = []
  store.on('changed', (event) => {
    emittedEvents.push(event)
  })
  store.on('logged', (event) => {
    emittedEvents.push(event)
  })

  store.trigger.inc()
  store.trigger.log({ message: 'test log' })
  store.trigger.inc()

  const beforeUndo = [...emittedEvents]

  emittedEvents.length = 0
  store.trigger.undo()
  store.trigger.undo()
  store.trigger.redo()
  store.trigger.redo()

  const afterRedo = [...emittedEvents]

  yield* expect({ beforeUndo, afterRedo }).toEqual({
    beforeUndo: [
      { type: 'changed', value: 1 },
      { type: 'logged', message: 'test log' },
      { type: 'changed', value: 2 },
    ],
    afterRedo: [
      { type: 'changed', value: 1 },
      { type: 'changed', value: 2 },
    ],
  })
})

it('should skip events with transaction grouping', function*({ expect }) {
  const store = createStore({
    context: { count: 0, transactionId: null as string | null },
    on: {
      inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
      transactionIdUpdated: (ctx, event: { id: string }) => ({
        ...ctx,
        transactionId: event.id,
      }),
    },
  }).with(
    undoRedo({
      getTransactionId: (_, snapshot) => snapshot.context.transactionId,
    }),
  )

  store.trigger.inc()
  store.trigger.transactionIdUpdated({ id: '1' })
  store.trigger.inc()
  store.trigger.inc()
  store.trigger.inc()
  store.trigger.transactionIdUpdated({ id: '2' })
  store.trigger.inc()
  store.trigger.inc()
  store.trigger.inc()

  store.trigger.undo()
  const afterFirstUndo = store.getSnapshot().context.count
  store.trigger.undo()
  const afterSecondUndo = store.getSnapshot().context.count
  store.trigger.redo()
  const afterFirstRedo = store.getSnapshot().context.count
  store.trigger.redo()
  const afterSecondRedo = store.getSnapshot().context.count

  yield* expect([afterFirstUndo, afterSecondUndo, afterFirstRedo, afterSecondRedo])
    .toEqual([4, 1, 4, 7])
})

it('should use the snapshot in the skipEvent function', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    on: {
      inc: (ctx) => ({ count: ctx.count + 1 }),
    },
  }).with(
    undoRedo({
      skipEvent: (_event, snapshot) => {
        return snapshot.context.count >= 3
      },
    }),
  )

  store.trigger.inc()
  store.trigger.inc()
  store.trigger.inc()
  store.trigger.inc()
  const afterIncs = store.getSnapshot().context.count

  store.trigger.undo()
  const afterUndo = store.getSnapshot().context.count

  yield* expect({ afterIncs, afterUndo }).toEqual({ afterIncs: 4, afterUndo: 2 })
})

it('emit event types should be correct', function*({ expect }) {
  const store = createStore({
    context: { count: 0 },
    schemas: {
      emitted: {
        changed: z.object({ value: z.number() }),
      },
    },
    on: {
      inc: (ctx, _: {}, enq) => {
        enq.emit.changed({ value: ctx.count + 1 })
        // @ts-expect-error
        enq.emit.whatever()
        return { count: ctx.count + 1 }
      },
    },
  }).with(undoRedo())

  store.on('changed', (event) => {
    event.value satisfies number
    // @ts-expect-error
    event.value satisfies string
    // @ts-expect-error
    event.unknown
  })

  store.on(
    // @ts-expect-error
    'whatever',
    () => {},
  )

  yield* expect(store.getSnapshot().context).toEqual({ count: 0 })
})

it('should detect undo/redo event collisions in development', function*({ expect }) {
  yield* expect(() =>
    createStore({
      context: { count: 0 },
      on: {
        undo: (ctx) => ctx,
      },
    }).with(undoRedo())
  ).toThrow(
    'The "undoRedo" store extension uses reserved event type(s): "undo".',
  )
})

describe('undoRedo with snapshot strategy', () => {
  it('should undo a single event', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    const afterInc = store.getSnapshot().context.count

    store.trigger.undo()
    const afterUndo = store.getSnapshot().context.count

    yield* expect({ afterInc, afterUndo }).toEqual({ afterInc: 1, afterUndo: 0 })
  })

  it('should redo a previously undone event', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    store.trigger.undo()
    store.trigger.redo()

    yield* expect(store.getSnapshot().context.count).toBe(1)
  })

  it('should undo/redo multiple events, non-transactional', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()
    const afterIncs = store.getSnapshot().context.count
    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count
    store.trigger.redo()
    const afterFirstRedo = store.getSnapshot().context.count
    store.trigger.redo()
    const afterSecondRedo = store.getSnapshot().context.count

    yield* expect([
      afterIncs,
      afterFirstUndo,
      afterSecondUndo,
      afterFirstRedo,
      afterSecondRedo,
    ]).toEqual([3, 2, 1, 2, 3])
  })

  it('should undo back into history after a redo', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()
    store.trigger.undo()
    store.trigger.undo()
    const afterUndos = store.getSnapshot().context.count
    store.trigger.redo()
    const afterRedo = store.getSnapshot().context.count

    store.trigger.undo()
    const afterSecondRedoUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterThirdUndo = store.getSnapshot().context.count
    store.trigger.redo()
    const afterSecondRedo = store.getSnapshot().context.count

    yield* expect([afterUndos, afterRedo, afterSecondRedoUndo, afterThirdUndo, afterSecondRedo])
      .toEqual([1, 2, 1, 0, 1])
  })

  it('should group events by transaction ID', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        dec: (ctx) => ({ count: ctx.count - 1 }),
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        getTransactionId: (event) => {
          return event.type
        },
      }),
    )

    store.trigger.inc()
    store.trigger.inc()
    const afterFirstTransaction = store.getSnapshot().context.count

    store.trigger.dec()
    store.trigger.dec()
    const afterSecondTransaction = store.getSnapshot().context.count

    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count

    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count

    yield* expect([
      afterFirstTransaction,
      afterSecondTransaction,
      afterFirstUndo,
      afterSecondUndo,
    ]).toEqual([2, 0, 2, 0])
  })

  it('should undo back into history after redoing a transaction', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        dec: (ctx) => ({ count: ctx.count - 1 }),
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        getTransactionId: (event) => {
          return event.type
        },
      }),
    )

    store.trigger.inc()
    store.trigger.inc()

    store.trigger.dec()
    store.trigger.dec()

    store.trigger.undo()
    store.trigger.undo()
    const afterUndos = store.getSnapshot().context.count

    store.trigger.redo()
    const afterRedo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count

    yield* expect({ afterUndos, afterRedo, afterSecondUndo }).toEqual({
      afterUndos: 0,
      afterRedo: 2,
      afterSecondUndo: 0,
    })
  })

  it('should maintain correct state when interleaving undo/redo with new events', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        dec: (ctx) => ({ count: ctx.count - 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    const afterFirstInc = store.getSnapshot().context.count
    store.trigger.inc()
    const afterSecondInc = store.getSnapshot().context.count
    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count
    store.trigger.dec()
    const afterDec = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count
    store.trigger.redo()
    const afterRedo = store.getSnapshot().context.count
    const atEnd = store.getSnapshot().context.count

    yield* expect([
      afterFirstInc,
      afterSecondInc,
      afterFirstUndo,
      afterDec,
      afterSecondUndo,
      afterRedo,
      atEnd,
    ]).toEqual([1, 2, 1, 0, 1, 0, 0])
  })

  it('should do nothing when undoing with empty history', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    const initialSnapshot = store.getSnapshot()
    store.trigger.undo()

    yield* expect(store.getSnapshot().context).toEqual(initialSnapshot.context)
  })

  it('should do nothing when redoing with empty future stack', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    const initialSnapshot = store.getSnapshot()
    store.trigger.redo()

    yield* expect(store.getSnapshot().context).toEqual(initialSnapshot.context)
  })

  it('should clear redo stack when new events occur after undo', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        dec: (ctx) => ({ count: ctx.count - 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    const afterFirstInc = store.getSnapshot().context.count
    store.trigger.inc()
    const afterSecondInc = store.getSnapshot().context.count
    store.trigger.undo()
    const afterUndo = store.getSnapshot().context.count
    store.trigger.dec()

    store.trigger.redo()
    const afterRedo = store.getSnapshot().context.count

    yield* expect([afterFirstInc, afterSecondInc, afterUndo, afterRedo]).toEqual([1, 2, 1, 0])
  })

  it('should skip non-undoable events', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        log: (ctx) => ctx,
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        skipEvent: (event) => event.type === 'log',
      }),
    )

    store.trigger.inc()
    store.trigger.log()
    store.trigger.inc()
    const afterEvents = store.getSnapshot().context.count

    store.trigger.undo()
    const afterUndo = store.getSnapshot().context.count

    yield* expect({ afterEvents, afterUndo }).toEqual({ afterEvents: 2, afterUndo: 1 })
  })

  it('should respect historyLimit', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot', historyLimit: 2 }))

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()

    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterThirdUndo = store.getSnapshot().context.count

    yield* expect([afterFirstUndo, afterSecondUndo, afterThirdUndo]).toEqual([3, 2, 2])
  })

  it('should apply historyLimit during redo', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(undoRedo({ strategy: 'snapshot', historyLimit: 2 }))

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.undo()
    store.trigger.undo()
    store.trigger.redo()
    store.trigger.redo()
    store.trigger.inc()
    store.trigger.inc()

    store.trigger.undo()
    store.trigger.undo()
    store.trigger.undo()

    yield* expect(store.getSnapshot().context.count).toBe(2)
  })

  it('should preserve context with skipped events', function*({ expect }) {
    const store = createStore({
      context: { count: 0, logs: [] as string[] },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1, logs: ctx.logs }),
        log: (ctx, event: { type: 'log'; message: string }) => ({
          logs: [...(ctx.logs || []), event.message],
          count: ctx.count,
        }),
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        skipEvent: (event) => event.type === 'log',
      }),
    )

    store.trigger.inc()
    store.trigger.log({ message: 'first log' })
    store.trigger.inc()

    const afterEvents = {
      count: store.getSnapshot().context.count,
      logs: store.getSnapshot().context.logs,
    }

    store.trigger.undo()
    const afterUndo = {
      count: store.getSnapshot().context.count,
      logs: store.getSnapshot().context.logs,
    }

    yield* expect({ afterEvents, afterUndo }).toEqual({
      afterEvents: { count: 2, logs: ['first log'] },
      afterUndo: { count: 1, logs: ['first log'] },
    })
  })

  it('should handle transaction grouping with historyLimit', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        dec: (ctx) => ({ count: ctx.count - 1 }),
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        getTransactionId: (event) => event.type,
        historyLimit: 3,
      }),
    )

    store.trigger.inc()
    store.trigger.inc()

    store.trigger.dec()
    store.trigger.dec()

    store.trigger.inc()
    store.trigger.inc()

    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count

    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count

    store.trigger.undo()
    const afterThirdUndo = store.getSnapshot().context.count

    yield* expect([afterFirstUndo, afterSecondUndo, afterThirdUndo]).toEqual([0, 1, 1])
  })

  it('should use compare function to skip duplicate snapshots', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        noop: (ctx) => ctx,
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        compare: (past, current) => past.context.count === current.context.count,
      }),
    )

    store.trigger.inc()
    store.trigger.noop()
    store.trigger.noop()
    store.trigger.inc()

    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterThirdUndo = store.getSnapshot().context.count

    yield* expect([afterFirstUndo, afterSecondUndo, afterThirdUndo]).toEqual([1, 0, 0])
  })

  it('should save all snapshots when no compare function is provided', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        noop: (ctx) => ctx,
      },
    }).with(undoRedo({ strategy: 'snapshot' }))

    store.trigger.inc()
    store.trigger.noop()
    store.trigger.noop()
    store.trigger.inc()

    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterThirdUndo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterFourthUndo = store.getSnapshot().context.count

    yield* expect([afterFirstUndo, afterSecondUndo, afterThirdUndo, afterFourthUndo])
      .toEqual([1, 1, 1, 0])
  })

  it('should preserve orthogonal context during undo and redo', function*({ expect }) {
    const store = createStore({
      context: { document: 'a', viewport: 0 },
      on: {
        updateDocument: (context, event: { document: string }) => ({
          ...context,
          document: event.document,
        }),
        updateViewport: (context, event: { viewport: number }) => ({
          ...context,
          viewport: event.viewport,
        }),
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        skipEvent: (event) => event.type === 'updateViewport',
        restore: ({ current, next }) => ({
          ...next,
          viewport: current.viewport,
        }),
      }),
    )

    store.trigger.updateDocument({ document: 'b' })
    store.trigger.updateViewport({ viewport: 10 })
    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context

    store.trigger.redo()
    const afterRedo = store.getSnapshot().context

    store.trigger.updateViewport({ viewport: 20 })
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context

    yield* expect({ afterFirstUndo, afterRedo, afterSecondUndo }).toEqual({
      afterFirstUndo: { document: 'a', viewport: 10 },
      afterRedo: { document: 'b', viewport: 10 },
      afterSecondUndo: { document: 'a', viewport: 20 },
    })
  })

  it('should pass current, next, and direction to restore', function*({ expect }) {
    const restore = vi.fn(({ next }) => next)
    const store = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(undoRedo({ strategy: 'snapshot', restore }))

    store.trigger.inc()
    store.trigger.undo()
    store.trigger.redo()

    yield* expect(restore.mock.calls.map(([args]) => args)).toEqual([
      { current: { count: 1 }, next: { count: 0 }, direction: 'undo' },
      { current: { count: 0 }, next: { count: 1 }, direction: 'redo' },
    ])
  })

  it('should restore once for a transaction group', function*({ expect }) {
    const restore = vi.fn(({ next }) => next)
    const store = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        getTransactionId: () => 'transaction',
        restore,
      }),
    )

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.undo()
    const afterFirstUndo = store.getSnapshot().context.count
    store.trigger.redo()
    const afterRedo = store.getSnapshot().context.count
    store.trigger.undo()
    const afterSecondUndo = store.getSnapshot().context.count

    yield* expect({
      afterFirstUndo,
      afterRedo,
      afterSecondUndo,
      restoreCalls: restore.mock.calls.map(([args]) => args),
    }).toEqual({
      afterFirstUndo: 0,
      afterRedo: 2,
      afterSecondUndo: 0,
      restoreCalls: [
        { current: { count: 2 }, next: { count: 0 }, direction: 'undo' },
        { current: { count: 0 }, next: { count: 2 }, direction: 'redo' },
        { current: { count: 2 }, next: { count: 0 }, direction: 'undo' },
      ],
    })
  })

  it('should run emitted events after restored context commits', function*({ expect }) {
    const observed: number[] = []
    const store = createStore({
      schemas: {
        emitted: { restored: z.object({ count: z.number() }) },
      },
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ next }, enqueue) => {
          enqueue.emit.restored({ count: next.count })
          return next
        },
      }),
    )
    store.on('restored', () => observed.push(store.getSnapshot().context.count))

    store.trigger.inc()
    store.trigger.undo()

    yield* expect(observed).toEqual([0])
  })

  it('should run effects after restored context commits', function*({ expect }) {
    const observed: number[] = []
    const store = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ next }, enqueue) => {
          enqueue.effect((enq) => {
            observed.push(enq.getSnapshot().context.count)
          })
          return next
        },
      }),
    )

    store.trigger.inc()
    store.trigger.undo()

    yield* expect(observed).toEqual([0])
  })

  it('should apply triggered transitions and effects once without history', function*({ expect }) {
    const effect = vi.fn()
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (context) => ({ count: context.count + 1 }),
        add: (context, event: { by: number }, enqueue) => {
          enqueue.effect(effect)
          return { count: context.count + event.by }
        },
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ next }, enqueue) => {
          enqueue.trigger.add({ by: 10 })
          return next
        },
      }),
    )

    store.trigger.inc()
    const canUndoBefore = store.can.undo()
    const effectCallsBefore = [...effect.mock.calls]
    store.trigger.undo()
    const count = store.getSnapshot().context.count
    const effectCalls = effect.mock.calls.map(([enq]) => enq.getSnapshot().context.count)
    const canUndoAfter = store.can.undo()

    yield* expect({ canUndoBefore, effectCallsBefore, count, effectCalls, canUndoAfter })
      .toEqual({ canUndoBefore: true, effectCallsBefore: [], count: 10, effectCalls: [10], canUndoAfter: false })
  })

  it('should not execute enqueued effects when checking can', function*({ expect }) {
    const effect = vi.fn()
    const emitted = vi.fn()
    const store = createStore({
      schemas: { emitted: { restored: z.object({}) } },
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ next }, enqueue) => {
          enqueue.effect(effect)
          enqueue.emit.restored({})
          return next
        },
      }),
    )
    store.on('restored', emitted)

    store.trigger.inc()
    const canUndo = store.can.undo()
    const effectCallsBefore = [...effect.mock.calls]
    const emittedCallsBefore = [...emitted.mock.calls]
    store.trigger.undo()
    const canRedo = store.can.redo()
    const effectCalls = effect.mock.calls.map(([enq]) => enq.getSnapshot().context.count)
    const emittedCalls = emitted.mock.calls

    yield* expect({
      canUndo,
      effectCallsBefore,
      emittedCallsBefore,
      canRedo,
      effectCalls,
      emittedCalls,
    }).toEqual({
      canUndo: true,
      effectCallsBefore: [],
      emittedCallsBefore: [],
      canRedo: true,
      effectCalls: [0],
      emittedCalls: [[{ type: 'restored' }]],
    })
  })

  it('should infer restore context, emitted events, and triggers', function*({ expect }) {
    yield* expect(createStore({ context: {}, on: {} }).getSnapshot().context).toEqual({})

    createStore({
      schemas: {
        emitted: { restored: z.object({ count: z.number() }) },
      },
      context: { count: 0 },
      on: {
        add: (context, event: { by: number }) => ({
          count: context.count + event.by,
        }),
      },
    }).with(
      undoRedo({
        strategy: 'snapshot',
        restore: ({ current, next, direction }, enqueue) => {
          current.count satisfies number
          next.count satisfies number
          direction satisfies 'undo' | 'redo'
          enqueue.emit.restored({ count: next.count })
          enqueue.trigger.add({ by: 1 })

          if (false) {
            // @ts-expect-error
            enqueue.emit.restored({ count: 'wrong' })
            // @ts-expect-error
            enqueue.trigger.add({ by: 'wrong' })
          }

          return next
        },
      }),
    )

    if (false) {
      undoRedo({
        strategy: 'event',
        // @ts-expect-error restore is only available for snapshot strategy
        restore: () => ({ count: 0 }),
      })
    }
  })
})
