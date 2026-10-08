import { describe } from '@systemfsoftware/vitest'
import { createStore } from '../src/index.js'
import { reset } from '../src/reset.js'
import { undoRedo } from '../src/undo.js'

describe('reset extension', (it) => {
  it('should reset to initial context', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(reset())

    store.trigger.inc()
    store.trigger.inc()
    const afterIncs = store.getSnapshot().context.count

    store.trigger.reset()
    const afterReset = store.getSnapshot().context.count

    yield* expect({ afterIncs, afterReset }).toEqual({
      afterIncs: 2,
      afterReset: 0,
    })
  })

  it('should reset multiple fields to initial context', function*({ expect }) {
    const store = createStore({
      context: { count: 0, name: 'Ada' },
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
        setName: (ctx, e: { name: string }) => ({ ...ctx, name: e.name }),
      },
    }).with(reset())

    store.trigger.inc()
    store.trigger.setName({ name: 'Bob' })
    const afterOps = store.getSnapshot().context

    store.trigger.reset()
    const afterReset = store.getSnapshot().context

    yield* expect({ afterOps, afterReset }).toEqual({
      afterOps: { count: 1, name: 'Bob' },
      afterReset: { count: 0, name: 'Ada' },
    })
  })

  it('should support partial reset via `to` option', function*({ expect }) {
    const store = createStore({
      context: { count: 0, user: null as string | null },
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
        login: (ctx, e: { user: string }) => ({ ...ctx, user: e.user }),
      },
    }).with(
      reset({
        to: (initial, current) => ({ ...initial, user: current.user }),
      }),
    )

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.login({ user: 'Alice' })
    const afterOps = store.getSnapshot().context

    store.trigger.reset()
    const afterReset = store.getSnapshot().context

    yield* expect({ afterOps, afterReset }).toEqual({
      afterOps: { count: 2, user: 'Alice' },
      afterReset: { count: 0, user: 'Alice' },
    })
  })

  it('should be idempotent when no changes have been made', function*({
    expect,
  }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(reset())

    store.trigger.reset()

    yield* expect(store.getSnapshot().context).toEqual({ count: 0 })
  })

  it('should preserve snapshot status', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(reset())

    store.trigger.inc()
    store.trigger.reset()

    yield* expect(store.getSnapshot().status).toBe('active')
  })

  it('should notify subscribers on reset', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(reset())

    const snapshots: number[] = []
    store.subscribe((snap) => snapshots.push(snap.context.count))

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.reset()

    yield* expect(snapshots).toEqual([1, 2, 0])
  })

  it('should work with undoRedo (reset is undoable)', function*({ expect }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    })
      .with(reset())
      .with(undoRedo())

    store.trigger.inc()
    store.trigger.inc()
    const afterIncs = store.getSnapshot().context.count

    store.trigger.reset()
    const afterReset = store.getSnapshot().context.count

    store.trigger.undo()
    const afterUndo = store.getSnapshot().context.count

    yield* expect({ afterIncs, afterReset, afterUndo }).toEqual({
      afterIncs: 2,
      afterReset: 0,
      afterUndo: 2,
    })
  })

  it('should allow resetting after multiple operations', function*({
    expect,
  }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        dec: (ctx) => ({ count: ctx.count - 1 }),
      },
    }).with(reset())

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.dec()
    store.trigger.inc()
    const afterOps = store.getSnapshot().context.count

    store.trigger.reset()
    const afterReset = store.getSnapshot().context.count

    store.trigger.inc()
    const afterResetInc = store.getSnapshot().context.count

    yield* expect({ afterOps, afterReset, afterResetInc }).toEqual({
      afterOps: 2,
      afterReset: 0,
      afterResetInc: 1,
    })
  })

  it('should detect reset event collisions in development', function*({
    expect,
  }) {
    yield* expect(() =>
      createStore({
        context: { count: 0 },
        on: {
          reset: (ctx) => ctx,
        },
      }).with(reset())
    ).toThrow(
      'The "reset" store extension uses reserved event type(s): "reset".',
    )
  })

  it('should return initial snapshot from getInitialSnapshot', function*({
    expect,
  }) {
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
    }).with(reset())

    store.trigger.inc()
    store.trigger.inc()

    yield* expect(store.getInitialSnapshot().context.count).toBe(0)
  })
})
