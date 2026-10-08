import { describe, it } from '@systemfsoftware/vitest'

import { Effect } from 'effect'

import { createAsyncAtom, createAtom, createAtomConfig, createReducerAtom, createStore } from '../src/index.js'

const afterRealTime = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}

it('creates an atom', function*({ expect }) {
  const atom = createAtom(42)

  yield* expect(atom.get()).toBe(42)
})

it('creates an atom from atom config', function*({ expect }) {
  const config = createAtomConfig(42)
  const atom = config.createAtom()
  const otherAtom = config.createAtom()

  atom.set(100)

  yield* expect({ atom: atom.get(), otherAtom: otherAtom.get() }).toEqual({
    atom: 100,
    otherAtom: 42,
  })
})

it('creates an atom from atom config and input', function*({ expect }) {
  const config = createAtomConfig((input: { initialCount: number }) => {
    return input.initialCount
  })
  const atom = config.createAtom({ initialCount: 10 })

  yield* expect(atom.get()).toBe(10)
})

it('sets the value of the atom using a function', function*({ expect }) {
  const atom = createAtom(0)

  atom.set((prev) => prev + 1)
  const first = atom.get()

  atom.set((prev) => prev + 1)
  const second = atom.get()

  yield* expect({ first, second }).toEqual({ first: 1, second: 2 })
})

it('does not subscribe a writable atom to reads inside its updater', function*({ expect }) {
  const source = createAtom(1)
  const target = createAtom(10)
  const observerArgs: unknown[][] = []
  const observer = (...args: unknown[]) => {
    observerArgs.push(args)
  }
  const subscription = target.subscribe(observer)

  target.set((previous) => previous + source.get())
  source.set(2)

  const targetValue = target.get()
  const observerCalls = [...observerArgs]
  subscription.unsubscribe()

  yield* expect({ target: targetValue, observerCalls }).toEqual({
    target: 11,
    observerCalls: [[11]],
  })
})

it('drains notifications before rethrowing the first subscriber error', function*({ expect }) {
  const source = createAtom(0)
  const unrelated = createAtom(0)
  const error = new Error('subscriber failed')
  const first = source.subscribe(() => {
    throw error
  })
  const observerArgs: unknown[][] = []
  const observer = (...args: unknown[]) => {
    observerArgs.push(args)
  }
  const second = source.subscribe(observer)
  const other = unrelated.subscribe(() => {})

  const errors: unknown[] = []
  try {
    source.set(1)
  } catch (thrown) {
    errors.push(thrown)
  }
  const callsAfterFirst = [...observerArgs]

  unrelated.set(1)
  const callsAfterUnrelated = [...observerArgs]

  try {
    source.set(2)
  } catch (thrown) {
    errors.push(thrown)
  }
  const callsAfterSecond = [...observerArgs]

  first.unsubscribe()
  second.unsubscribe()
  other.unsubscribe()

  yield* expect({
    errors,
    callsAfterFirst,
    callsAfterUnrelated,
    callsAfterSecond,
  }).toEqual({
    errors: [error, error],
    callsAfterFirst: [[1]],
    callsAfterUnrelated: [[1]],
    callsAfterSecond: [[1], [2]],
  })
})

it('rethrows undefined and still delivers reentrant notifications', function*({ expect }) {
  const source = createAtom(0)
  const nested = createAtom(0)
  const order: string[] = []
  const subscriptions = [
    nested.subscribe(() => {
      order.push('nested')
      throw undefined
    }),
    nested.subscribe(() => {
      order.push('nested-second')
      throw new Error('later error')
    }),
    source.subscribe(() => {
      order.push('first')
      nested.set(1)
    }),
    source.subscribe(() => {
      order.push('second')
    }),
  ]
  let didThrow = false
  let thrown: unknown
  try {
    source.set(1)
  } catch (error) {
    didThrow = true
    thrown = error
  }
  const notifications = [...order]
  subscriptions.forEach((subscription) => subscription.unsubscribe())

  yield* expect({ didThrow, thrown, notifications }).toEqual({
    didThrow: true,
    thrown: undefined,
    notifications: ['first', 'second', 'nested', 'nested-second'],
  })
})

it('can set the value to undefined', function*({ expect }) {
  const atom = createAtom<number | undefined>(1)
  const initial = atom.get()

  atom.set(undefined)
  const updated = atom.get()

  yield* expect({ initial, updated }).toEqual({ initial: 1, updated: undefined })
})

it('can subscribe to atom changes', function*({ expect }) {
  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }
  const atom = createAtom(0)

  atom.subscribe(log)

  atom.set(1)

  atom.set(2)

  yield* expect(logArgs).toEqual([[1], [2]])
})

it('can unsubscribe from atom changes', function*({ expect }) {
  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }
  const atom = createAtom(0)

  const sub = atom.subscribe(log)

  atom.set(1)

  sub.unsubscribe()

  atom.set(2)

  yield* expect({ calls: logArgs, value: atom.get() }).toEqual({
    calls: [[1]],
    value: 2,
  })
})

it('can create a combined atom', function*({ expect }) {
  const nameAtom = createAtom('a')
  const numAtom = createAtom(3)
  const combinedAtom = createAtom(() => nameAtom.get().repeat(numAtom.get()))

  const initial = combinedAtom.get()

  nameAtom.set('b')

  const afterName = combinedAtom.get()

  numAtom.set(5)

  yield* expect({ initial, afterName }).toEqual({ initial: 'aaa', afterName: 'bbb' })
})

it('allows updates to a computed dependency during a subscription callback', function*({ expect }) {
  const atom = createAtom({ a: 0, b: 0, c: 0 })

  const a0 = createAtom(() => atom.get().a)
  const a1 = createAtom(() => a0.get())
  a1.subscribe(() => atom.set((ctx) => ({ ...ctx, b: ctx.a })))

  const b0 = createAtom(() => atom.get().b)
  const b1 = createAtom(() => b0.get())
  b1.subscribe(() => atom.set((ctx) => ({ ...ctx, c: ctx.b })))

  atom.set((ctx) => ({ ...ctx, a: ctx.a + 1 }))
  atom.set((ctx) => ({ ...ctx, a: ctx.a + 1 }))
  atom.set((ctx) => ({ ...ctx, a: ctx.a + 1 }))

  const snapshot = atom.get()

  yield* expect({
    a0: a0.get(),
    a1: a1.get(),
    b0: b0.get(),
    b1: b1.get(),
    a: snapshot.a,
    b: snapshot.b,
    c: snapshot.c,
  }).toEqual({ a0: 3, a1: 3, b0: 3, b1: 3, a: 3, b: 3, c: 3 })
})

it('does not loop when updating a computed dependency which affects an atoms own state', function*({ expect }) {
  const count = createAtom(0)
  const a = createAtom(() => count.get())

  a.subscribe(() => count.set((val) => val + 1))

  count.set((val) => val + 1)

  yield* expect({ a: a.get(), count: count.get() }).toEqual({ a: 2, count: 2 })
})

it('works with a mix of atoms and stores', function*({ expect }) {
  const countAtom = createAtom(0)
  const store = createStore({
    context: { name: 'David' },
    on: {
      nameUpdated: (_, event: { name: string }) => ({
        name: event.name,
      }),
    },
  })

  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }

  const combinedAtom = createAtom(
    () => store.get().context.name + ` ${countAtom.get()}`,
  )

  combinedAtom.subscribe(log)

  const initial = combinedAtom.get()

  store.send({ type: 'nameUpdated', name: 'John' })

  const afterSend = combinedAtom.get()

  countAtom.set(1)

  yield* expect({
    initial,
    afterSend,
    count: countAtom.get(),
    combined: combinedAtom.get(),
    logCalls: logArgs,
  }).toEqual({
    initial: 'David 0',
    afterSend: 'John 0',
    count: 1,
    combined: 'John 1',
    logCalls: [['John 0'], ['John 1']],
  })
})

it('works with stores', function*({ expect }) {
  const nameStore = createStore({
    context: { name: 'David' },
    on: {
      nameUpdated: (context, event: { name: string }) => ({
        name: event.name,
      }),
    },
  })

  const countStore = createStore({
    context: { count: 0 },
    on: {
      increment: (context) => ({ count: context.count + 1 }),
    },
  })

  const combinedAtom = createAtom(
    () => nameStore.get().context.name + ` ${countStore.get().context.count}`,
  )

  const initial = combinedAtom.get()

  nameStore.trigger.nameUpdated({ name: 'John' })

  const afterName = combinedAtom.get()

  countStore.trigger.increment()

  const afterCount = combinedAtom.get()

  yield* expect({ initial, afterName, afterCount }).toEqual({
    initial: 'David 0',
    afterName: 'John 0',
    afterCount: 'John 1',
  })
})

it('works with selectors', function*({ expect }) {
  const store = createStore({
    context: { name: 'David', count: 0 },
    on: {
      increment: (context) => ({ ...context, count: context.count + 1 }),
    },
  })

  const count = store.select((ctx) => ctx.count)

  const combinedAtom = createAtom(() => 2 * count.get())

  const initial = combinedAtom.get()

  store.trigger.increment()

  const after = combinedAtom.get()

  yield* expect({ initial, after }).toEqual({ initial: 0, after: 2 })
})

it('allows sending events to the store during a selector subscription', function*({ expect }) {
  const store = createStore({
    context: { a: 0, b: 0 },
    on: {
      a: (context) => ({ ...context, a: context.a + 1 }),
      b: (context) => ({ ...context, b: context.b + 1 }),
    },
  })

  const a = store.select((context) => context.a)
  a.subscribe(() => store.trigger.b())

  store.trigger.a()
  store.trigger.a()
  store.trigger.a()

  const snapshot = store.get()

  yield* expect({
    a: snapshot.context.a,
    b: snapshot.context.b,
  }).toEqual({ a: 3, b: 3 })
})

it('works with selectors (get API)', function*({ expect }) {
  const store = createStore({
    context: { name: 'David', count: 0 },
    on: {
      increment: (context) => ({ ...context, count: context.count + 1 }),
    },
  })

  const count = store.select((ctx) => ctx.count)

  const combinedAtom = createAtom(() => 2 * count.get())

  const initial = combinedAtom.get()

  store.trigger.increment()

  const after = combinedAtom.get()

  yield* expect({ initial, after }).toEqual({ initial: 0, after: 2 })
})

it('combined atoms should be read-only', function*({ expect }) {
  const atom1 = createAtom(0)
  const atom2 = createAtom(1)
  const combinedAtom = createAtom(() => atom1.get() + atom2.get())

  const before = combinedAtom.get()

  // @ts-expect-error
  combinedAtom.set?.(2)

  const after = combinedAtom.get()

  yield* expect({ before, after }).toEqual({ before: 1, after: 1 })
})

it('combined atom getters accept only prev as an argument', function*({ expect }) {
  const atom = createAtom(1)

  createAtom<number>(
    // @ts-expect-error — two-arg (read, prev) signature is no longer supported
    (_read, _prev) => atom.get(),
  )

  const combined = createAtom<number>((prev) => atom.get() + (prev ?? 0))

  yield* expect(combined.get()).toBe(1)
})

it('conditionally read atoms are properly read in combined atoms', function*({ expect }) {
  const atom1 = createAtom(true)
  const atom2 = createAtom(false)
  const activatorAtom = createAtom<'inactive' | 'active'>('inactive')
  const combinedAtom = createAtom(() => activatorAtom.get() === 'active' ? atom1.get() : atom2.get())

  const initial = combinedAtom.get()

  activatorAtom.set('active')
  const active = combinedAtom.get()

  activatorAtom.set('inactive')
  const inactive = combinedAtom.get()

  yield* expect({ initial, active, inactive }).toEqual({
    initial: false,
    active: true,
    inactive: false,
  })
})

it('conditionally read atoms are properly unsubscribed when no longer needed', function*({ expect }) {
  const atom1 = createAtom(true)
  const activatorAtom = createAtom<'inactive' | 'active'>('active')
  const combinedAtom = createAtom(() => activatorAtom.get() === 'active' ? atom1.get() : {})

  const vals: any[] = []

  combinedAtom.subscribe((val) => {
    vals.push(val)
  })

  const snapshots: unknown[][] = [[...vals]]

  atom1.set(false)
  snapshots.push([...vals])

  atom1.set(true)
  snapshots.push([...vals])

  activatorAtom.set('inactive')
  snapshots.push([...vals])

  atom1.set(false)
  snapshots.push([...vals])

  atom1.set(true)
  snapshots.push([...vals])

  activatorAtom.set('active')
  snapshots.push([...vals])

  atom1.set(false)
  snapshots.push([...vals])

  yield* expect(snapshots).toEqual([
    [],
    [false],
    [false, true],
    [false, true, {}],
    [false, true, {}],
    [false, true, {}],
    [false, true, {}, true],
    [false, true, {}, true, false],
  ])
})

it('handles diamond dependencies with single update', function*({ expect }) {
  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }
  const sourceAtom = createAtom(1)

  const pathA = createAtom(() => sourceAtom.get() * 2)
  const pathB = createAtom(() => sourceAtom.get() * 3)

  const bottomAtom = createAtom(() => pathA.get() + pathB.get())

  bottomAtom.subscribe((x) => {
    log(x)
  })

  const initial = bottomAtom.get()
  const logCallsBefore = [...logArgs]

  sourceAtom.set(2)

  const result = bottomAtom.get()

  yield* expect({ initial, logCallsBefore, result, logCalls: logArgs })
    .toEqual({ initial: 5, logCallsBefore: [], result: 10, logCalls: [[10]] })
})

it('handles complex diamond dependencies correctly', function*({ expect }) {
  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }

  const atomD = createAtom(1)

  const atomC = createAtom(() => atomD.get() * 2)

  const atomB = createAtom(() => atomC.get() + atomD.get())

  const atomA = createAtom(() => atomB.get() + atomC.get() + atomD.get())

  atomA.subscribe(log)

  const initial = atomA.get()
  const logCallsBefore = [...logArgs]

  atomD.set(2)

  const afterA = atomA.get()

  yield* expect({
    initial,
    logCallsBefore,
    afterA,
    atomB: atomB.get(),
    atomC: atomC.get(),
    atomD: atomD.get(),
    logCalls: logArgs,
  }).toEqual({
    initial: 6,
    logCallsBefore: [],
    afterA: 12,
    atomB: 6,
    atomC: 4,
    atomD: 2,
    logCalls: [[12]],
  })
})

it('supports custom equality functions through compare option', function*({ expect }) {
  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }

  const coordAtom = createAtom(
    { x: 0, y: 0 },
    {
      compare: (prev, next) => prev.x === next.x && prev.y === next.y,
    },
  )

  coordAtom.subscribe(log)

  const initial = coordAtom.get()

  coordAtom.set({ x: 0, y: 0 })

  coordAtom.set({ x: 1, y: 0 })

  coordAtom.set({ x: 1, y: 2 })

  coordAtom.set({ x: 1, y: 2 })

  yield* expect({ initial, logCalls: logArgs }).toEqual({
    initial: { x: 0, y: 0 },
    logCalls: [[{ x: 1, y: 0 }], [{ x: 1, y: 2 }]],
  })
})

it('uses Object.is as default equality function', function*({ expect }) {
  const logArgs: unknown[][] = []
  const log = (...args: unknown[]) => {
    logArgs.push(args)
  }
  const objAtom = createAtom({ value: 0 })

  objAtom.subscribe(log)

  const initial = objAtom.get()

  objAtom.set({ value: 0 })

  const obj = { value: 1 }
  objAtom.set(obj)
  objAtom.set(obj)

  yield* expect({ initial, logCalls: logArgs }).toEqual({
    initial: { value: 0 },
    logCalls: [[{ value: 0 }], [obj]],
  })
})

it('Atom-specific properties should not be exposed', function*({ expect }) {
  const atom = createAtom(0)

  // @ts-expect-error
  atom._subs
  // @ts-expect-error
  atom._subsTail
  // @ts-expect-error
  atom._snapshot
  // @ts-expect-error
  atom._flags
  // @ts-expect-error
  atom._deps
  // @ts-expect-error
  atom._depsTail

  const computed = createAtom(() => atom.get())

  // @ts-expect-error
  computed._subs
  // @ts-expect-error
  computed._subsTail
  // @ts-expect-error
  computed._snapshot
  // @ts-expect-error
  computed._flags
  // @ts-expect-error
  computed._deps
  // @ts-expect-error
  computed._depsTail

  const store = createStore({
    context: {},
    on: {},
  })

  // @ts-expect-error
  store._subs
  // @ts-expect-error
  store._subsTail
  // @ts-expect-error
  store._snapshot
  // @ts-expect-error
  store._flags
  // @ts-expect-error
  store._deps
  // @ts-expect-error
  store._depsTail

  yield* expect({
    atom: atom.get(),
    computed: computed.get(),
    context: store.getSnapshot().context,
  }).toEqual({ atom: 0, computed: 0, context: {} })
})

it('computed atoms can use their previous value in the getter', function*({ expect }) {
  const count = createAtom(1)
  const accumulated = createAtom<number>((prev) => count.get() + (prev ?? 0))

  const initial = accumulated.get()

  count.set(2)
  const second = accumulated.get()

  count.set(3)
  const third = accumulated.get()

  yield* expect({ initial, second, third }).toEqual({
    initial: 1,
    second: 3,
    third: 6,
  })
})

describe('reducer atoms', () => {
  it('updates from current state and sent event', function*({ expect }) {
    const counter = createReducerAtom(0, (state, event: number) => Math.min(10, state + event))

    counter.send(13)

    yield* expect(counter.get()).toBe(10)
  })

  it('can receive arbitrary event values', function*({ expect }) {
    const value = createReducerAtom(
      '',
      (state, event: string | number) => state + event,
    )

    value.send('x')
    value.send(1)

    yield* expect(value.get()).toBe('x1')
  })

  it('notifies subscribers when the reducer changes state', function*({ expect }) {
    const counter = createReducerAtom(
      0,
      (state, event: number) => state + event,
    )
    const listenerArgs: unknown[][] = []
    const listener = (...args: unknown[]) => {
      listenerArgs.push(args)
    }

    counter.subscribe(listener)
    counter.send(1)
    counter.send(0)
    counter.send(2)

    yield* expect({ calls: listenerArgs, value: counter.get() }).toEqual({
      calls: [[1], [3]],
      value: 3,
    })
  })

  it('can be used by derived atoms', function*({ expect }) {
    const counter = createReducerAtom(
      0,
      (state, event: number) => state + event,
    )
    const doubled = createAtom(() => counter.get() * 2)

    const initial = doubled.get()

    counter.send(2)

    const after = doubled.get()

    yield* expect({ initial, after }).toEqual({ initial: 0, after: 4 })
  })

  it('does not track atom reads inside the reducer', function*({ expect }) {
    const multiplier = createAtom(2)
    const counter = createReducerAtom(
      1,
      (state, event: number) => state + event * multiplier.get(),
    )
    const listenerArgs: unknown[][] = []
    const listener = (...args: unknown[]) => {
      listenerArgs.push(args)
    }

    counter.subscribe(listener)
    counter.send(3)
    multiplier.set(10)

    yield* expect({ counter: counter.get(), listenerCalls: listenerArgs })
      .toEqual({ counter: 7, listenerCalls: [[7]] })
  })
})

describe('async atoms', () => {
  it.each(['done', 'error'] as const)(
    'should recompute after a dependency changes following %s settlement',
    function*(status, { expect }) {
      const count = createAtom(1)
      const error = new Error('initial failure')
      const atom = createAsyncAtom(async () => {
        const value = count.get()
        if (status === 'error' && value === 1) {
          throw error
        }
        return value * 2
      })
      const selected = createAtom(() => {
        const state = atom.get()
        return state.status === 'done' ? state.data : state.status
      })
      const observerArgs: unknown[][] = []
      const observer = (...args: unknown[]) => {
        observerArgs.push(args)
      }
      const subscription = selected.subscribe(observer)

      yield* Effect.promise(() => Promise.resolve())
      const afterFirstSettlement = atom.get()
      observerArgs.length = 0

      count.set(2)
      const afterCountSet = atom.get()

      yield* Effect.promise(() => Promise.resolve())

      const afterSecondSettlement = atom.get()
      const observerCalls = [...observerArgs]
      subscription.unsubscribe()

      yield* expect({
        afterFirstSettlement,
        afterCountSet,
        afterSecondSettlement,
        observerCalls,
      }).toEqual({
        afterFirstSettlement: status === 'done' ? { status, data: 2 } : { status, error },
        afterCountSet: { status: 'pending' },
        afterSecondSettlement: { status: 'done', data: 4 },
        observerCalls: [['pending'], [4]],
      })
    },
  )

  it('should recompute lazily after a settled dependency changes', function*({ expect }) {
    const count = createAtom(1)
    const getterArgs: unknown[][] = []
    const getter = async (...args: unknown[]) => {
      getterArgs.push(args)
      return count.get() * 2
    }
    const atom = createAsyncAtom(getter)

    const getterCallsBeforeFirstRead = [...getterArgs]
    const firstRead = atom.get()

    yield* Effect.promise(() => Promise.resolve())
    const afterFirstSettlement = atom.get()
    const getterCallsAfterFirstSettlement = [...getterArgs]

    count.set(2)
    const afterCountSet = atom.get()
    const getterCallsAfterCountSet = [...getterArgs]

    yield* Effect.promise(() => Promise.resolve())
    const afterSecondSettlement = atom.get()
    const getterCallsAtEnd = [...getterArgs]

    yield* expect({
      getterCallsBeforeFirstRead,
      firstRead,
      afterFirstSettlement,
      getterCallsAfterFirstSettlement,
      afterCountSet,
      getterCallsAfterCountSet,
      afterSecondSettlement,
      getterCallsAtEnd,
    }).toEqual({
      getterCallsBeforeFirstRead: [],
      firstRead: { status: 'pending' },
      afterFirstSettlement: { status: 'done', data: 2 },
      getterCallsAfterFirstSettlement: [[expect.objectContaining({ signal: expect.any(AbortSignal) })]],
      afterCountSet: { status: 'pending' },
      getterCallsAfterCountSet: [
        [expect.objectContaining({ signal: expect.any(AbortSignal) })],
        [expect.objectContaining({ signal: expect.any(AbortSignal) })],
      ],
      afterSecondSettlement: { status: 'done', data: 4 },
      getterCallsAtEnd: [
        [expect.objectContaining({ signal: expect.any(AbortSignal) })],
        [expect.objectContaining({ signal: expect.any(AbortSignal) })],
      ],
    })
  })

  it('should retain dependencies when the async comparator suppresses a result', function*({ expect }) {
    const count = createAtom(1)
    const atom = createAsyncAtom(async () => count.get() % 2, {
      compare: (previous, next) =>
        next.status === 'pending' ||
        (previous.status === 'done' &&
          next.status === 'done' &&
          previous.data === next.data),
    })
    const observerArgs: unknown[][] = []
    const observer = (...args: unknown[]) => {
      observerArgs.push(args)
    }
    const subscription = atom.subscribe(observer)

    yield* Effect.promise(() => Promise.resolve())
    const afterFirstSettlement = atom.get()
    observerArgs.length = 0

    count.set(3)
    yield* Effect.promise(() => Promise.resolve())
    const observerCallsAfterSuppressed = [...observerArgs]

    count.set(4)
    yield* Effect.promise(() => Promise.resolve())
    const finalState = atom.get()
    const observerCallsAtEnd = [...observerArgs]
    subscription.unsubscribe()

    yield* expect({
      afterFirstSettlement,
      observerCallsAfterSuppressed,
      finalState,
      observerCallsAtEnd,
    }).toEqual({
      afterFirstSettlement: { status: 'done', data: 1 },
      observerCallsAfterSuppressed: [],
      finalState: { status: 'done', data: 0 },
      observerCallsAtEnd: [[{ status: 'done', data: 0 }]],
    })
  })

  it.live('async atoms should work (fulfilled)', function*({ expect }) {
    const atom = createAsyncAtom(async () => 'hello')

    const initial = atom.get()

    yield* Effect.promise(() => afterRealTime(0))

    yield* expect({ initial, settled: atom.get() }).toEqual({
      initial: { status: 'pending' },
      settled: { status: 'done', data: 'hello' },
    })
  })

  it.live('async atoms should work (rejected)', function*({ expect }) {
    const error = new Error('test')
    const atom = createAsyncAtom(async () => {
      throw error
    })

    const initial = atom.get()

    yield* Effect.promise(() => afterRealTime(0))

    yield* expect({ initial, settled: atom.get() }).toEqual({
      initial: { status: 'pending' },
      settled: { status: 'error', error },
    })
  })

  it.live('should only call getValue once for multiple concurrent reads', function*({ expect }) {
    let getValueCallCount = 0
    const RESOLVED_VALUE = 'test-value'

    const myAsyncAtom = createAsyncAtom(async () => {
      getValueCallCount++
      return RESOLVED_VALUE
    })

    const firstRead = myAsyncAtom.get()
    const secondRead = myAsyncAtom.get()

    yield* Effect.promise(() => afterRealTime(0))

    const thirdRead = myAsyncAtom.get()
    const fourthRead = myAsyncAtom.get()

    const callCountAfterResolution = getValueCallCount

    const fifthRead = myAsyncAtom.get()
    const callCountAtEnd = getValueCallCount

    yield* expect({
      firstRead,
      secondRead,
      thirdRead,
      fourthRead,
      callCountAfterResolution,
      fifthRead,
      callCountAtEnd,
    }).toEqual({
      firstRead: { status: 'pending' },
      secondRead: { status: 'pending' },
      thirdRead: { status: 'done', data: RESOLVED_VALUE },
      fourthRead: { status: 'done', data: RESOLVED_VALUE },
      callCountAfterResolution: 1,
      fifthRead: { status: 'done', data: RESOLVED_VALUE },
      callCountAtEnd: 1,
    })
  })

  it.live('should only call getValue once even when error occurs', function*({ expect }) {
    let getValueCallCount = 0
    const ERROR_MESSAGE = 'test error'
    const error = new Error(ERROR_MESSAGE)

    const myAsyncAtom = createAsyncAtom(async () => {
      getValueCallCount++
      throw error
    })

    const firstRead = myAsyncAtom.get()
    const secondRead = myAsyncAtom.get()

    yield* Effect.promise(() => afterRealTime(0))

    const thirdRead = myAsyncAtom.get()
    const fourthRead = myAsyncAtom.get()

    const callCountAfterRejection = getValueCallCount

    const fifthRead = myAsyncAtom.get()
    const callCountAtEnd = getValueCallCount

    yield* expect({
      firstRead,
      secondRead,
      thirdRead,
      fourthRead,
      callCountAfterRejection,
      fifthRead,
      callCountAtEnd,
    }).toEqual({
      firstRead: { status: 'pending' },
      secondRead: { status: 'pending' },
      thirdRead: { status: 'error', error },
      fourthRead: { status: 'error', error },
      callCountAfterRejection: 1,
      fifthRead: { status: 'error', error },
      callCountAtEnd: 1,
    })
  })

  it('async atoms should not have a .set() method', function*({ expect }) {
    const atom = createAsyncAtom(async () => 'hello')

    yield* expect({ hasSet: 'set' in atom }).toEqual({ hasSet: false })
  })

  it('should pass an abort signal to async atoms', function*({ expect }) {
    const signals: AbortSignal[] = []
    const atom = createAsyncAtom(async ({ signal }) => {
      signals.push(signal)
      return 'hello'
    })

    const initial = atom.get()

    yield* expect({
      initial,
      signalIsAbortSignal: signals[0] instanceof AbortSignal,
    }).toEqual({ initial: { status: 'pending' }, signalIsAbortSignal: true })
  })

  it.live('should abort and ignore stale async atom results', function*({ expect }) {
    const count = createAtom(1)
    const signals: AbortSignal[] = []
    const resolvers: Array<(value: number) => void> = []
    const atom = createAsyncAtom(({ signal }) => {
      const currentCount = count.get()
      signals.push(signal)

      const { promise, resolve } = Promise.withResolvers<number>()
      resolvers.push(resolve)
      return promise.then(() => currentCount)
    })

    const firstRead = atom.get()

    count.set(2)
    const secondRead = atom.get()
    const firstSignal = signals[0]
    if (firstSignal === undefined) {
      throw new Error('expected a first signal')
    }
    const firstSignalAborted = firstSignal.aborted

    const resolveFirst = resolvers[0]
    if (resolveFirst === undefined) {
      throw new Error('expected a first resolver')
    }
    resolveFirst(1)
    yield* Effect.promise(() => afterRealTime(0))
    const afterFirstResolution = atom.get()

    const resolveSecond = resolvers[1]
    if (resolveSecond === undefined) {
      throw new Error('expected a second resolver')
    }
    resolveSecond(2)
    yield* Effect.promise(() => afterRealTime(0))
    const afterSecondResolution = atom.get()

    yield* expect({
      firstRead,
      secondRead,
      firstSignalAborted,
      afterFirstResolution,
      afterSecondResolution,
    }).toEqual({
      firstRead: { status: 'pending' },
      secondRead: { status: 'pending' },
      firstSignalAborted: true,
      afterFirstResolution: { status: 'pending' },
      afterSecondResolution: { status: 'done', data: 2 },
    })
  })

  it.live('should ignore stale async atom errors', function*({ expect }) {
    const count = createAtom(1)
    const rejectors: Array<(error: unknown) => void> = []
    const resolvers: Array<(value: number) => void> = []
    const atom = createAsyncAtom(({ signal }) => {
      const currentCount = count.get()

      const { promise, resolve, reject } = Promise.withResolvers<number>()
      resolvers.push(resolve)
      rejectors.push(reject)
      return promise.then(() => {
        if (signal.aborted) {
          throw new Error('aborted')
        }
        return currentCount
      })
    })

    const initial = atom.get()

    count.set(2)
    const afterCountSet = atom.get()

    const rejectFirst = rejectors[0]
    if (rejectFirst === undefined) {
      throw new Error('expected a first rejector')
    }
    rejectFirst(new Error('stale'))
    yield* Effect.promise(() => afterRealTime(0))
    const afterRejection = atom.get()

    const resolveSecond = resolvers[1]
    if (resolveSecond === undefined) {
      throw new Error('expected a second resolver')
    }
    resolveSecond(2)
    yield* Effect.promise(() => afterRealTime(0))
    const afterSecondResolution = atom.get()

    yield* expect({
      initial,
      afterCountSet,
      afterRejection,
      afterSecondResolution,
    }).toEqual({
      initial: { status: 'pending' },
      afterCountSet: { status: 'pending' },
      afterRejection: { status: 'pending' },
      afterSecondResolution: { status: 'done', data: 2 },
    })
  })

  it.live('should notify subscribers when async operation completes successfully', function*({ expect }) {
    const logArgs: unknown[][] = []
    const log = (...args: unknown[]) => {
      logArgs.push(args)
    }
    const atom = createAsyncAtom(async () => {
      await afterRealTime(10)
      return 'test-value'
    })

    atom.subscribe(log)

    const initial = atom.get()
    const callsBeforeSettlement = [...logArgs]

    yield* Effect.promise(() => afterRealTime(20))

    const callsAtEnd = [...logArgs]
    const settled = atom.get()

    yield* expect({ initial, callsBeforeSettlement, callsAtEnd, settled })
      .toEqual({
        initial: { status: 'pending' },
        callsBeforeSettlement: [],
        callsAtEnd: [[{ status: 'done', data: 'test-value' }]],
        settled: { status: 'done', data: 'test-value' },
      })
  })

  it.live('should notify subscribers when async operation fails', function*({ expect }) {
    const logArgs: unknown[][] = []
    const log = (...args: unknown[]) => {
      logArgs.push(args)
    }
    const error = new Error('test error')
    const atom = createAsyncAtom(async () => {
      await afterRealTime(10)
      throw error
    })

    atom.subscribe(log)

    const initial = atom.get()
    const callsBeforeSettlement = [...logArgs]

    yield* Effect.promise(() => afterRealTime(20))

    const callsAtEnd = [...logArgs]
    const settled = atom.get()

    yield* expect({ initial, callsBeforeSettlement, callsAtEnd, settled })
      .toEqual({
        initial: { status: 'pending' },
        callsBeforeSettlement: [],
        callsAtEnd: [[{ status: 'error', error }]],
        settled: { status: 'error', error },
      })
  })

  it.live('should notify multiple subscribers when async operation completes', function*({ expect }) {
    const log1Args: unknown[][] = []
    const log1 = (...args: unknown[]) => {
      log1Args.push(args)
    }
    const log2Args: unknown[][] = []
    const log2 = (...args: unknown[]) => {
      log2Args.push(args)
    }
    const atom = createAsyncAtom(async () => {
      await afterRealTime(10)
      return 'multi-test'
    })

    atom.subscribe(log1)
    atom.subscribe(log2)

    const initial = atom.get()
    const callsBeforeSettlement = [[...log1Args], [...log2Args]]

    yield* Effect.promise(() => afterRealTime(20))

    const callsAtEnd = [[...log1Args], [...log2Args]]

    yield* expect({ initial, callsBeforeSettlement, callsAtEnd }).toEqual({
      initial: { status: 'pending' },
      callsBeforeSettlement: [[], []],
      callsAtEnd: [
        [[{ status: 'done', data: 'multi-test' }]],
        [[{ status: 'done', data: 'multi-test' }]],
      ],
    })
  })

  it('subscribe callback should not track dependencies from .get() calls', function*({ expect }) {
    const items = createAtom<number[]>([])
    const ids = createAtom(() => Array.from(items.get()).sort().join(','))
    const logArgs: unknown[][] = []
    const log = (...args: unknown[]) => {
      logArgs.push(args)
    }

    ids.subscribe(() => {
      void items.get()
      log()
    })

    items.set([1])
    items.set([1])
    items.set([1, 2])
    items.set([1, 2])

    yield* expect(logArgs).toEqual([[], []])
  })

  it('subscribe callback should not track deps on non-computed atoms', function*({ expect }) {
    const ids = createAtom('')
    const items = createAtom<number[]>([])
    items.subscribe((value) => ids.set(Array.from(value).sort().join(',')))
    const logArgs: unknown[][] = []
    const log = (...args: unknown[]) => {
      logArgs.push(args)
    }

    ids.subscribe(() => {
      void items.get()
      log()
    })

    items.set([1])
    items.set([1])
    items.set([1, 2])
    items.set([1, 2])

    yield* expect(logArgs).toEqual([[], []])
  })
})
