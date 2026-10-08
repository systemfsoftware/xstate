import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { createStore } from '../src/index.js'
import {
  clearStorage,
  createJSONStorage,
  flushStorage,
  isHydrated,
  persist,
  rehydrateStore,
  type StateStorage,
} from '../src/persist.js'
import { StoreValidationError, validateSchemas } from '../src/validate.js'

function getThrown(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

const eventually = (predicate: () => boolean) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const startedAt = Date.now()
    const tick = () => {
      if (predicate() || Date.now() - startedAt > 2000) {
        resolve()
        return
      }
      setTimeout(tick, 5)
    }
    tick()
    return promise
  })

const realDelay = (ms: number) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, ms)
    return promise
  })

const localStorageSlot = globalThis as unknown as { localStorage?: Storage }

function createMockStorage(): StateStorage {
  const data: Record<string, string> = {}
  return {
    getItem: (name: string) => data[name] ?? null,
    setItem: (name: string, value: string) => {
      data[name] = value
    },
    removeItem: (name: string) => {
      delete data[name]
    },
  }
}

function createAsyncMockStorage(): StateStorage {
  const data: Record<string, string> = {}
  return {
    getItem: async (name: string) => data[name] ?? null,
    setItem: async (name: string, value: string) => {
      data[name] = value
    },
    removeItem: async (name: string) => {
      delete data[name]
    },
  }
}

describe('persistence lifecycle regressions', (it) => {
  it.each([0, 100])(
    'preserves an eligible snapshot when a nested event is filtered (throttle %i)',
    function*(throttle, { expect }) {
      const storage = createMockStorage()
      const store = createStore({
        context: { value: 0 },
        on: {
          outer: () => ({ value: 1 }),
          inner: () => ({ value: 2 }),
        },
      }).with(
        persist({
          name: 'filtered-nested',
          storage,
          throttle,
          filter: (event) => event.type === 'outer',
        }),
      )
      store.subscribe((snapshot) => {
        if (snapshot.context.value === 1) store.trigger.inner()
      })
      store.trigger.outer()

      yield* expect(store.getSnapshot().context.value).toBe(2)
      yield* Effect.promise(() => Promise.resolve(flushStorage(store)))
      yield* expect(
        JSON.parse(storage.getItem('filtered-nested') as string).context.value,
      ).toBe(1)
    },
  )

  it('orders new async writes after a queued clear', function*({ expect }) {
    const operations: string[] = []
    const store = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(
      persist({
        name: 'counter',
        storage: {
          getItem: () => null,
          setItem: async (_key, value) => {
            operations.push(`write ${JSON.parse(value).context.count}`)
          },
          removeItem: async () => {
            operations.push('clear')
          },
        },
      }),
    )

    store.trigger.inc()
    const cleared = clearStorage(store)
    store.trigger.inc()
    yield* Effect.promise(() => Promise.resolve(cleared))
    yield* Effect.promise(() => Promise.resolve(flushStorage(store)))
    yield* expect(operations).toEqual(['write 1', 'clear', 'write 2'])
  })

  it.each(['snapshot', 'event'] as const)(
    'reports a rejected initial async read (%s)',
    function*(strategy, { expect }) {
      const error = new Error('read failed')
      const rejected = Promise.reject(error)
      void rejected.catch(() => {})
      const errors: Array<[unknown]> = []
      const onError = (cause: unknown) => {
        errors.push([cause])
      }
      createStore({ context: {}, on: {} }).with(
        persist({
          name: 'counter',
          strategy,
          onError,
          storage: {
            getItem: () => rejected,
            setItem: () => {},
            removeItem: () => {},
          },
        }),
      )
      yield* Effect.promise(() => Promise.resolve())
      yield* expect(errors).toEqual([[error]])
    },
  )

  it('applies pick once when flushing a throttled update', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const pickCalls: Array<[unknown]> = []
    const pick = (context: { count: number }) => {
      pickCalls.push([context])
      return { count: context.count + 1 }
    }
    const store = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(persist({ name: 'counter', storage, throttle: 100, pick }))

    store.trigger.inc()
    flushStorage(store)
    yield* expect({
      pickCalls,
      stored: JSON.parse(storage.getItem('counter') as string),
    }).toEqual({
      pickCalls: [[{ count: 1 }]],
      stored: { context: { count: 2 }, version: 0 },
    })
  })

  it.each(['snapshot', 'event'] as const)(
    'preserves updates triggered by onDone during a throttled flush (%s)',
    function*(strategy, { expect }) {
      const storage = createMockStorage()
      let firstWrite = true
      const store = createStore({
        context: { count: 0 },
        on: { inc: (context) => ({ count: context.count + 1 }) },
      }).with(
        persist({
          name: 'counter',
          storage,
          strategy,
          throttle: 100,
          onDone: () => {
            if (firstWrite) {
              firstWrite = false
              store.trigger.inc()
            }
          },
        }),
      )

      store.trigger.inc()
      flushStorage(store)
      flushStorage(store)
      const saved = JSON.parse(storage.getItem('counter') as string)
      yield* expect(
        strategy === 'event' ? saved.events.length : saved.context.count,
      ).toBe(2)
    },
  )

  it.live.each(['snapshot', 'event'] as const)(
    'cancels buffered writes when storage is cleared (%s)',
    function*(strategy, { expect }) {
      const storage = createMockStorage()
      const store = createStore({
        context: { count: 0 },
        on: { inc: (context) => ({ count: context.count + 1 }) },
      }).with(persist({ name: 'counter', strategy, storage, throttle: 400 }))

      store.trigger.inc()
      yield* realDelay(300)

      const clearResult = clearStorage(store)
      store.trigger.inc()

      yield* realDelay(250)

      yield* expect({
        clearResult,
        stored: storage.getItem('counter'),
      }).toEqual({ clearResult: undefined, stored: null })
    },
  )

  it('removes storage after an in-flight async write finishes', function*({
    expect,
  }) {
    let completeWrite: () => void = () => {
      throw new Error('expected a write to start')
    }
    let saved: string | null = null
    const removeCalls: Array<[string]> = []
    const removeItem = (name: string) => {
      removeCalls.push([name])
      saved = null
    }
    const store = createStore({
      context: { count: 0 },
      on: { inc: (context) => ({ count: context.count + 1 }) },
    }).with(
      persist({
        name: 'counter',
        storage: {
          getItem: () => null,
          setItem: (_key, value) => {
            const { promise, resolve } = Promise.withResolvers<void>()
            completeWrite = () => {
              saved = value
              resolve()
            }
            return promise
          },
          removeItem,
        },
      }),
    )

    store.trigger.inc()
    const cleared = clearStorage(store)
    yield* expect(removeCalls).toEqual([])
    completeWrite()
    yield* Effect.promise(() => Promise.resolve(cleared))
    yield* expect({ removeCalls, saved }).toEqual({
      removeCalls: [['counter']],
      saved: null,
    })
  })
})

describe('persist', (it) => {
  it('should persist context to storage after each event', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    store.trigger.inc()

    yield* expect(JSON.parse(storage.getItem('test') as string)).toEqual({
      context: { count: 1 },
      version: 0,
    })
  })

  it('should restore context from storage on creation', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 42 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    yield* expect(store.getSnapshot().context.count).toBe(42)
  })

  it('should set _persist.hydrated to true on sync hydration', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    yield* expect({ hydrated: isHydrated(store) }).toEqual({ hydrated: true })
  })

  it('should set _persist.hydrated to true when storage is empty', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    yield* expect({ hydrated: isHydrated(store) }).toEqual({ hydrated: true })
  })

  it('should preserve _persist metadata across transitions', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    store.trigger.inc()
    yield* expect({ hydrated: isHydrated(store) }).toEqual({ hydrated: true })
  })
})

describe('persist - pick', (it) => {
  it('should only persist selected fields', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0, secret: 'do-not-persist' },
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
      },
    }).with(
      persist({
        name: 'test',
        storage,
        pick: (ctx) => ({ count: ctx.count }),
      }),
    )

    store.trigger.inc()

    yield* expect(JSON.parse(storage.getItem('test') as string)).toEqual({
      context: { count: 1 },
      version: 0,
    })
  })

  it('should merge picked data with full context on restore', function*({
    expect,
  }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 42 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0, name: 'Ada' },
      on: { inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        pick: (ctx) => ({ count: ctx.count }),
      }),
    )

    yield* expect(store.getSnapshot().context).toEqual({ count: 42, name: 'Ada' })
  })
})

describe('persist - version + migrate', (it) => {
  it('should migrate persisted state when version differs', function*({
    expect,
  }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 10 },
        version: 1,
      }),
    )

    const store = createStore({
      context: { count: 0, label: 'default' },
      on: { inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        version: 2,
        migrate: (persisted, version) => {
          if (version === 1) {
            return { ...persisted, label: 'migrated' }
          }
          return persisted
        },
      }),
    )

    yield* expect({
      count: store.getSnapshot().context.count,
      label: store.getSnapshot().context.label,
    }).toEqual({ count: 10, label: 'migrated' })
  })

  it('should migrate with string versions', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 10 },
        version: '1.0.0',
      }),
    )

    const store = createStore({
      context: { count: 0, label: 'default' },
      on: { inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        version: '2.0.0',
        migrate: (persisted, version) => {
          if (version === '1.0.0') {
            return { ...persisted, label: 'migrated' }
          }
          return persisted
        },
      }),
    )

    yield* expect({
      count: store.getSnapshot().context.count,
      label: store.getSnapshot().context.label,
    }).toEqual({ count: 10, label: 'migrated' })
  })

  it('should not migrate when version matches', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 5 },
        version: 2,
      }),
    )

    const migrateCalls: Array<[unknown, unknown]> = []
    const migrateFn = (ctx: { count: number }, version: string | number) => {
      migrateCalls.push([ctx, version])
      return ctx
    }

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        version: 2,
        migrate: migrateFn,
      }),
    )

    yield* expect({
      migrateCalls,
      count: store.getSnapshot().context.count,
    }).toEqual({ migrateCalls: [], count: 5 })
  })
})

describe('persist - merge', (it) => {
  it('should use custom merge strategy', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 42, items: ['a'] },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0, items: ['b', 'c'] as string[] },
      on: { inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        merge: (persisted, current) => ({
          ...current,
          ...persisted,
          items: [...current.items, ...(persisted.items ?? [])],
        }),
      }),
    )

    yield* expect({
      count: store.getSnapshot().context.count,
      items: store.getSnapshot().context.items,
    }).toEqual({ count: 42, items: ['b', 'c', 'a'] })
  })
})

describe('persist - serialize / deserialize', (it) => {
  it('should use custom serializer and deserializer', function*({ expect }) {
    const storage = createMockStorage()
    const prefix = 'CUSTOM:'

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        serialize: (value) => prefix + JSON.stringify(value),
        deserialize: (str) => JSON.parse(str.slice(prefix.length)),
      }),
    )

    store.trigger.inc()

    const stored = storage.getItem('test')

    const store2 = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        serialize: (value) => prefix + JSON.stringify(value),
        deserialize: (str) => JSON.parse(str.slice(prefix.length)),
      }),
    )

    yield* expect({
      stored,
      restored: store2.getSnapshot().context.count,
    }).toEqual({
      stored: 'CUSTOM:{"context":{"count":1},"version":0}',
      restored: 1,
    })
  })
})

describe('persist - throttle', (it) => {
  it.live('should batch writes with throttle', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, throttle: 100 }))

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()

    yield* expect(storage.getItem('test')).toBeNull()

    yield* eventually(() => storage.getItem('test') !== null)

    yield* expect(
      JSON.parse(storage.getItem('test') as string).context.count,
    ).toBe(3)
  })

  it.live('should not write again if no events between throttle intervals', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const onDoneCalls: Array<[unknown]> = []
    const onDone = (data: unknown) => {
      onDoneCalls.push([data])
    }
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, throttle: 100, onDone }))

    store.trigger.inc()
    yield* eventually(() => onDoneCalls.length > 0)

    yield* expect(onDoneCalls).toEqual([[{ count: 1 }]])

    yield* realDelay(150)
    yield* expect(onDoneCalls).toEqual([[{ count: 1 }]])
  })
})

describe('persist - flushStorage', (it) => {
  it('should force immediate write of pending throttled context', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, throttle: 1000 }))

    store.trigger.inc()
    store.trigger.inc()

    const before = storage.getItem('test')

    flushStorage(store)

    yield* expect({
      before,
      after: JSON.parse(storage.getItem('test') as string),
    }).toEqual({
      before: null,
      after: { context: { count: 2 }, version: 0 },
    })
  })

  it('should throw when store has no persist extension', function*({
    expect,
  }) {
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    })

    yield* expect(() => flushStorage(store)).toThrow(
      'flushStorage: store does not have a persist extension',
    )
  })

  it('should return a promise for async storage flushes', function*({
    expect,
  }) {
    const storage = createAsyncMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, throttle: 1000 }))

    yield* Effect.promise(() => rehydrateStore(store))

    store.trigger.inc()
    store.trigger.inc()

    yield* Effect.promise(() => Promise.resolve(flushStorage(store)))

    const raw = yield* Effect.promise(() => Promise.resolve(storage.getItem('test')))

    yield* expect(JSON.parse(raw as string).context.count).toBe(2)
  })
})

describe('persist - onDone / onError', (it) => {
  it('should call onDone after successful write', function*({ expect }) {
    const storage = createMockStorage()
    const onDoneCalls: Array<[unknown]> = []
    const onDone = (data: unknown) => {
      onDoneCalls.push([data])
    }
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, onDone }))

    store.trigger.inc()

    yield* expect(onDoneCalls).toEqual([[{ count: 1 }]])
  })

  it('should call onDone with picked context when pick is used', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const onDoneCalls: Array<[unknown]> = []
    const onDone = (data: unknown) => {
      onDoneCalls.push([data])
    }
    const store = createStore({
      context: { count: 0, secret: 'hidden' },
      on: { inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        onDone,
        pick: (ctx) => ({ count: ctx.count }),
      }),
    )

    store.trigger.inc()

    yield* expect(onDoneCalls).toEqual([[{ count: 1 }]])
  })

  it('should call onError on write failure', function*({ expect }) {
    const error = new Error('quota exceeded')
    const failStorage: StateStorage = {
      getItem: () => null,
      setItem: () => {
        throw error
      },
      removeItem: () => {},
    }
    const onErrorCalls: Array<[unknown]> = []
    const onError = (cause: unknown) => {
      onErrorCalls.push([cause])
    }

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage: failStorage, onError }))

    store.trigger.inc()

    yield* expect(onErrorCalls).toEqual([[error]])
  })

  it('should call onError on read failure during hydration', function*({
    expect,
  }) {
    const readError = new Error('read failed')
    const failStorage: StateStorage = {
      getItem: () => {
        throw readError
      },
      setItem: () => {},
      removeItem: () => {},
    }
    const onErrorCalls: Array<[unknown]> = []
    const onError = (cause: unknown) => {
      onErrorCalls.push([cause])
    }

    createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage: failStorage, onError }))

    yield* expect(onErrorCalls).toEqual([[readError]])
  })
})

describe('persist - filter', (it) => {
  it('should skip persisting when filter returns false', function*({ expect }) {
    const storage = createMockStorage()
    const onDoneCalls: Array<[unknown]> = []
    const onDone = (data: unknown) => {
      onDoneCalls.push([data])
    }
    const store = createStore({
      context: { count: 0, mouse: { x: 0, y: 0 } },
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
        mousemove: (ctx, e: { x: number; y: number }) => ({
          ...ctx,
          mouse: { x: e.x, y: e.y },
        }),
      },
    }).with(
      persist({
        name: 'test',
        storage,
        onDone,
        filter: (event) => event.type !== 'mousemove',
      }),
    )

    store.trigger.mousemove({ x: 10, y: 20 })
    const afterFiltered = [...onDoneCalls]

    store.trigger.inc()

    yield* expect({ afterFiltered, allCalls: onDoneCalls }).toEqual({
      afterFiltered: [],
      allCalls: [[{ count: 1, mouse: { x: 10, y: 20 } }]],
    })
  })
})

describe('persist - skipHydration', (it) => {
  it('should not hydrate when skipHydration is true', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 99 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, skipHydration: true }))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 0, hydrated: false })
  })
})

describe('persist - rehydrateStore', (it) => {
  it('should rehydrate from sync storage', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 99 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, skipHydration: true }))

    yield* expect(store.getSnapshot().context.count).toBe(0)

    yield* Effect.promise(() => rehydrateStore(store))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 99, hydrated: true })
  })

  it('should rehydrate from async storage', function*({ expect }) {
    const storage = createAsyncMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 77 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, skipHydration: true }))

    yield* expect(store.getSnapshot().context.count).toBe(0)

    yield* Effect.promise(() => rehydrateStore(store))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 77, hydrated: true })
  })

  it('should merge with events sent before rehydration', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 10 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, skipHydration: true }))

    store.trigger.inc()

    yield* Effect.promise(() => rehydrateStore(store))

    yield* expect(store.getSnapshot().context.count).toBe(10)
  })

  it('should handle empty storage gracefully', function*({ expect }) {
    const storage = createMockStorage()

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, skipHydration: true }))

    yield* Effect.promise(() => rehydrateStore(store))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 0, hydrated: true })
  })

  it('should apply migration during rehydration', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 5 },
        version: 1,
      }),
    )

    const store = createStore({
      context: { count: 0, label: '' },
      on: { inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        version: 2,
        skipHydration: true,
        migrate: (persisted, version) => {
          if (version === 1) {
            return { ...persisted, label: 'migrated' }
          }
          return persisted
        },
      }),
    )

    yield* Effect.promise(() => rehydrateStore(store))

    yield* expect({
      count: store.getSnapshot().context.count,
      label: store.getSnapshot().context.label,
    }).toEqual({ count: 5, label: 'migrated' })
  })

  it('should throw when store has no persist extension', function*({
    expect,
  }) {
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    })

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () => rehydrateStore(store),
        catch: (cause) => cause as Error,
      }),
    )

    yield* expect({ name: error.name, message: error.message }).toEqual({
      name: 'Error',
      message: 'rehydrateStore: store does not have a persist extension',
    })
  })
})

describe('persist - clearStorage', (it) => {
  it('should remove persisted data from storage', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    store.trigger.inc()
    const before = JSON.parse(storage.getItem('test') as string)

    clearStorage(store)

    yield* expect({ before, after: storage.getItem('test') }).toEqual({
      before: { context: { count: 1 }, version: 0 },
      after: null,
    })
  })

  it('should throw when store has no persist extension', function*({
    expect,
  }) {
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    })

    yield* expect(() => clearStorage(store)).toThrow(
      'clearStorage: store does not have a persist extension',
    )
  })

  it('should return a promise for async storage removals', function*({
    expect,
  }) {
    const storage = createAsyncMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    store.trigger.inc()
    yield* Effect.promise(() => Promise.resolve())

    const cleared = clearStorage(store)

    yield* Effect.promise(() => Promise.resolve(cleared))

    const raw = yield* Effect.promise(() => Promise.resolve(storage.getItem('test')))

    yield* expect(raw).toBeNull()
  })
})

describe('persist - createJSONStorage', (it) => {
  it('should return noop storage when getStorage throws', function*({
    expect,
  }) {
    const storage = createJSONStorage(() => {
      throw new Error('no localStorage')
    })

    const results = {
      get: storage.getItem('test'),
      set: storage.setItem('test', 'value'),
      remove: storage.removeItem('test'),
    }

    yield* expect(results).toEqual({
      get: null,
      set: undefined,
      remove: undefined,
    })
  })

  it('should wrap a working storage adapter', function*({ expect }) {
    const mockStorage = createMockStorage()
    const storage = createJSONStorage(() => mockStorage)

    storage.setItem('foo', 'bar')
    const afterSet = storage.getItem('foo')

    storage.removeItem('foo')

    yield* expect({ afterSet, afterRemove: storage.getItem('foo') }).toEqual({
      afterSet: 'bar',
      afterRemove: null,
    })
  })

  it('should preserve async storage semantics', function*({ expect }) {
    const mockStorage = createAsyncMockStorage()
    const storage = createJSONStorage(() => mockStorage)

    yield* Effect.promise(() => Promise.resolve(storage.setItem('foo', 'bar')))

    const afterSet = yield* Effect.promise(() => Promise.resolve(storage.getItem('foo')))

    yield* expect(afterSet).toBe('bar')

    yield* Effect.promise(() => Promise.resolve(storage.removeItem('foo')))

    const afterRemove = yield* Effect.promise(() => Promise.resolve(storage.getItem('foo')))

    yield* expect(afterRemove).toBeNull()
  })
})

describe('persist - SSR-safe defaults', (it) => {
  it('should not require localStorage when using default storage', function*({
    expect,
  }) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'localStorage',
    )

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('no localStorage')
      },
    })

    try {
      const store = createStore({
        context: { count: 0 },
        on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
      }).with(persist({ name: 'test' }))

      const hydrated = isHydrated(store)
      store.trigger.inc()

      yield* expect({
        hydrated,
        afterInc: store.getSnapshot().context.count,
      }).toEqual({ hydrated: true, afterInc: 1 })
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
      } else {
        delete localStorageSlot.localStorage
      }
    }
  })

  it('should detect persist rehydrate event collisions in development', function*({
    expect,
  }) {
    const storage = createMockStorage()

    const error = getThrown(() =>
      createStore({
        context: { count: 0 },
        on: {
          ['__persist.rehydrate']: (ctx) => ctx,
        },
      }).with(persist({ name: 'test', storage }))
    ) as Error

    yield* expect({ name: error.name, message: error.message }).toEqual({
      name: 'Error',
      message:
        'The "persist" store extension uses reserved event type(s): "__persist.rehydrate". Rename the conflicting store event(s) before applying the extension.',
    })
  })
})

describe('persist - async storage auto-detection', (it) => {
  it('should detect async storage and skip sync hydration', function*({
    expect,
  }) {
    const storage = createAsyncMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        context: { count: 50 },
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 0, hydrated: false })
  })
})

describe('persist - composability', (it) => {
  it('should work with undoRedo extension', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage }))

    store.trigger.inc()
    store.trigger.inc()

    const stored = JSON.parse(storage.getItem('test') as string)
    yield* expect({
      stored: stored.context.count,
      count: store.getSnapshot().context.count,
    }).toEqual({ stored: 2, count: 2 })
  })

  it('should persist and restore correctly across store instances', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const config = {
      name: 'test' as const,
      storage,
    }

    const store1 = createStore({
      context: { count: 0, name: 'test' },
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
        setName: (ctx, e: { name: string }) => ({ ...ctx, name: e.name }),
      },
    }).with(persist(config))

    store1.trigger.inc()
    store1.trigger.inc()
    store1.trigger.setName({ name: 'updated' })

    const store2 = createStore({
      context: { count: 0, name: 'test' },
      on: {
        inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
        setName: (ctx, e: { name: string }) => ({ ...ctx, name: e.name }),
      },
    }).with(persist(config))

    yield* expect({
      count: store2.getSnapshot().context.count,
      name: store2.getSnapshot().context.name,
    }).toEqual({ count: 2, name: 'updated' })
  })
})

describe('persist - strategy: event', (it) => {
  it('should persist events to storage', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    store.trigger.inc()
    store.trigger.inc()

    yield* expect(JSON.parse(storage.getItem('test') as string)).toEqual({
      events: [{ type: 'inc' }, { type: 'inc' }],
      version: 0,
      checkpoint: null,
    })
  })

  it('should restore state by replaying events', function*({ expect }) {
    const storage = createMockStorage()

    const store1 = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    store1.trigger.inc()
    store1.trigger.inc()
    store1.trigger.inc()

    const store2 = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    yield* expect(store2.getSnapshot().context.count).toBe(3)
  })

  it('should restore state with event payloads', function*({ expect }) {
    const storage = createMockStorage()

    const store1 = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        add: (ctx, e: { amount: number }) => ({ count: ctx.count + e.amount }),
      },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    store1.trigger.inc()
    store1.trigger.add({ amount: 10 })

    const store2 = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
        add: (ctx, e: { amount: number }) => ({ count: ctx.count + e.amount }),
      },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    yield* expect(store2.getSnapshot().context.count).toBe(11)
  })

  it('should set _persist.hydrated to true on sync hydration', function*({
    expect,
  }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    yield* expect({ hydrated: isHydrated(store) }).toEqual({ hydrated: true })
  })

  it('should respect maxEvents option', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'test', storage, strategy: 'event', maxEvents: 2 }),
    )

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()

    const stored = JSON.parse(storage.getItem('test') as string)

    const store2 = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'test', storage, strategy: 'event', maxEvents: 2 }),
    )

    yield* expect({ stored, restored: store2.getSnapshot().context.count }).toEqual(
      {
        stored: {
          events: [{ type: 'inc' }, { type: 'inc' }],
          version: 0,
          checkpoint: { count: 1 },
        },
        restored: 3,
      },
    )
  })

  it('should not hydrate when skipHydration is true', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        events: [{ type: 'inc' }, { type: 'inc' }],
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'test', storage, strategy: 'event', skipHydration: true }),
    )

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 0, hydrated: false })
  })

  it('should rehydrate from async storage', function*({ expect }) {
    const storage = createAsyncMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        events: [{ type: 'inc' }, { type: 'inc' }, { type: 'inc' }],
        version: 0,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'test', storage, strategy: 'event', skipHydration: true }),
    )

    yield* expect(store.getSnapshot().context.count).toBe(0)

    yield* Effect.promise(() => rehydrateStore(store))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 3, hydrated: true })
  })

  it('should continue accumulating events after rehydration', function*({
    expect,
  }) {
    const storage = createMockStorage()

    const store1 = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    store1.trigger.inc()
    store1.trigger.inc()

    const store2 = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    const restored = store2.getSnapshot().context.count

    store2.trigger.inc()

    const stored = JSON.parse(storage.getItem('test') as string)
    yield* expect({
      restored,
      stored: stored.events,
      count: store2.getSnapshot().context.count,
    }).toEqual({
      restored: 2,
      stored: [{ type: 'inc' }, { type: 'inc' }, { type: 'inc' }],
      count: 3,
    })
  })

  it('should migrate events when version differs', function*({ expect }) {
    const storage = createMockStorage()
    storage.setItem(
      'test',
      JSON.stringify({
        events: [{ type: 'increment' }, { type: 'increment' }],
        version: 1,
      }),
    )

    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage,
        strategy: 'event',
        version: 2,
        migrate: (events, _version) =>
          events.map((e: { type: string }) => e.type === 'increment' ? { ...e, type: 'inc' } : e),
      }),
    )

    yield* expect(store.getSnapshot().context.count).toBe(2)
  })

  it('should work with clearStorage', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    store.trigger.inc()
    const before = JSON.parse(storage.getItem('test') as string)

    clearStorage(store)

    yield* expect({ before, after: storage.getItem('test') }).toEqual({
      before: {
        events: [{ type: 'inc' }],
        version: 0,
        checkpoint: null,
      },
      after: null,
    })
  })

  it('should handle empty storage gracefully', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'test', storage, strategy: 'event' }))

    yield* expect({
      count: store.getSnapshot().context.count,
      hydrated: isHydrated(store),
    }).toEqual({ count: 0, hydrated: true })
  })

  it('should call onError on read failure during hydration', function*({
    expect,
  }) {
    const readError = new Error('read failed')
    const failStorage: StateStorage = {
      getItem: () => {
        throw readError
      },
      setItem: () => {},
      removeItem: () => {},
    }
    const onErrorCalls: Array<[unknown]> = []
    const onError = (cause: unknown) => {
      onErrorCalls.push([cause])
    }

    createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'test',
        storage: failStorage,
        strategy: 'event',
        onError,
      }),
    )

    yield* expect(onErrorCalls).toEqual([[readError]])
  })

  it.live('should work with throttle', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'test', storage, strategy: 'event', throttle: 100 }),
    )

    store.trigger.inc()
    store.trigger.inc()
    store.trigger.inc()

    yield* expect(storage.getItem('test')).toBeNull()

    yield* eventually(() => storage.getItem('test') !== null)

    yield* expect(JSON.parse(storage.getItem('test') as string)).toEqual({
      events: [{ type: 'inc' }, { type: 'inc' }, { type: 'inc' }],
      version: 0,
      checkpoint: null,
    })
  })

  it('should work with flushStorage', function*({ expect }) {
    const storage = createMockStorage()
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'test', storage, strategy: 'event', throttle: 1000 }),
    )

    store.trigger.inc()
    store.trigger.inc()

    const before = storage.getItem('test')

    flushStorage(store)

    yield* expect({
      before,
      after: JSON.parse(storage.getItem('test') as string),
    }).toEqual({
      before: null,
      after: {
        events: [{ type: 'inc' }, { type: 'inc' }],
        version: 0,
        checkpoint: null,
      },
    })
  })
})

it.each(
  [
    ['snapshot', 0, 'effect'],
    ['snapshot', 100, 'effect'],
    ['snapshot', 0, 'subscriber'],
    ['snapshot', 100, 'subscriber'],
    ['event', 0, 'effect'],
    ['event', 100, 'effect'],
    ['event', 0, 'subscriber'],
    ['event', 100, 'subscriber'],
  ] as const,
)(
  'persist committed %s writes persists nested events in commit order (throttle %i, %s)',
  function*([strategy, throttle, nestedFrom], { expect }) {
    const storage = createMockStorage()
    const makeStore = () =>
      createStore({
        context: { value: 0 },
        on: {
          outer: (context, _event, enqueue) => {
            if (nestedFrom === 'effect') {
              enqueue.effect(({ trigger }) => {
                const innerTrigger = trigger['inner']
                if (innerTrigger === undefined) {
                  throw new Error('expected an inner trigger')
                }
                innerTrigger()
              })
            }
            return { value: context.value * 10 + 1 }
          },
          inner: (context) => ({ value: context.value * 10 + 2 }),
        },
      }).with(
        persist({
          name: 'nested',
          strategy,
          storage,
          throttle,
          ...(strategy === 'event' ? { maxEvents: 1 } : {}),
        }),
      )
    const store = makeStore()
    const canOuter = store.can['outer']
    if (canOuter === undefined) {
      throw new Error('expected an outer can')
    }
    yield* expect({ canOuter: canOuter() }).toEqual({ canOuter: true })

    store.transition(store.getSnapshot(), { type: 'outer' })
    yield* Effect.promise(() => Promise.resolve(flushStorage(store)))

    const notYetWritten = storage.getItem('nested')

    const subscription = store.subscribe((snapshot) => {
      if (nestedFrom === 'subscriber' && snapshot.context.value === 1) {
        const innerTrigger = store.trigger['inner']
        if (innerTrigger === undefined) {
          throw new Error('expected an inner trigger')
        }
        innerTrigger()
      }
    })
    const outerTrigger = store.trigger['outer']
    if (outerTrigger === undefined) {
      throw new Error('expected an outer trigger')
    }
    outerTrigger()
    subscription.unsubscribe()

    yield* expect({
      notYetWritten,
      value: store.getSnapshot().context.value,
    }).toEqual({ notYetWritten: null, value: 12 })

    yield* Effect.promise(() => Promise.resolve(flushStorage(store)))

    const saved = JSON.parse(storage.getItem('nested') as string)
    const replayed = makeStore().getSnapshot().context.value

    yield* expect({
      saved: strategy === 'snapshot' ? saved.context.value : saved,
      replayed,
    }).toEqual({
      saved: strategy === 'snapshot'
        ? 12
        : {
          events: [{ type: 'inner' }],
          version: 0,
          checkpoint: { value: 1 },
        },
      replayed: 12,
    })

    yield* Effect.promise(() => rehydrateStore(store))

    const innerTrigger = store.trigger['inner']
    if (innerTrigger === undefined) {
      throw new Error('expected an inner trigger')
    }
    innerTrigger()
    yield* Effect.promise(() => Promise.resolve(flushStorage(store)))

    yield* expect(makeStore().getSnapshot().context.value).toBe(122)
  },
)

it.live.each(
  [
    ['snapshot', 'can'],
    ['snapshot', 'transition'],
    ['snapshot', 'validation'],
    ['event', 'can'],
    ['event', 'transition'],
    ['event', 'validation'],
  ] as const,
)(
  'persist committed %s writes does not buffer %s evaluations',
  function*([strategy, evaluation], { expect }) {
    const storage = createMockStorage()
    const base = createStore({
      schemas: { context: z.object({ count: z.number().max(1) }) },
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({
        name: 'committed',
        strategy,
        storage,
        throttle: 100,
        ...(strategy === 'event' ? { maxEvents: 1 } : {}),
      }),
    )
    const store = evaluation === 'validation' ? base.with(validateSchemas()) : base

    store.trigger.inc()
    const canResult = evaluation === 'can' ? store.can.inc() : undefined
    if (evaluation === 'transition') {
      store.transition(store.getSnapshot(), { type: 'inc' })
    }
    const validationThrown = evaluation === 'validation'
      ? getThrown(() => store.trigger.inc())
      : undefined
    const validationFailed = validationThrown instanceof StoreValidationError

    yield* eventually(() => storage.getItem('committed') !== null)

    const saved = JSON.parse(storage.getItem('committed') as string)

    yield* expect({
      canResult,
      validationFailed,
      count: store.getSnapshot().context.count,
      saved,
    }).toEqual({
      canResult: evaluation === 'can' ? true : undefined,
      validationFailed: evaluation === 'validation',
      count: 1,
      saved: strategy === 'snapshot'
        ? { context: { count: 1 }, version: 0 }
        : { events: [{ type: 'inc' }], version: 0, checkpoint: null },
    })
  },
)

it.live.each(['snapshot', 'event'] as const)(
  'persist committed %s writes flushes throttled data after an already pending asynchronous write',
  function*(strategy, { expect }) {
    const writes: Array<{ value: string; resolve: () => void }> = []
    const storage: StateStorage = {
      getItem: () => null,
      removeItem: () => {},
      setItem: (_name, value) => {
        const { promise, resolve } = Promise.withResolvers<void>()
        writes.push({ value, resolve })
        return promise
      },
    }
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(persist({ name: 'throttled', storage, strategy, throttle: 100 }))

    store.trigger.inc()
    yield* eventually(() => writes.length >= 1)

    store.trigger.inc()
    const flushed = flushStorage(store)

    const firstExpected = strategy === 'snapshot'
      ? { context: { count: 1 }, version: 0 }
      : { events: [{ type: 'inc' }], version: 0, checkpoint: null }

    yield* expect(writes.map((write) => JSON.parse(write.value))).toEqual([
      firstExpected,
    ])

    const firstWrite = writes[0]
    if (firstWrite === undefined) {
      throw new Error('expected a first write')
    }
    firstWrite.resolve()
    yield* eventually(() => writes.length >= 2)

    const secondWrite = writes[1]
    if (secondWrite === undefined) {
      throw new Error('expected a second write')
    }

    const secondExpected = strategy === 'snapshot'
      ? { context: { count: 2 }, version: 0 }
      : {
        events: [{ type: 'inc' }, { type: 'inc' }],
        version: 0,
        checkpoint: null,
      }

    yield* expect({
      count: writes.length,
      second: JSON.parse(secondWrite.value),
    }).toEqual({ count: 2, second: secondExpected })

    secondWrite.resolve()
    const flushedValue = yield* Effect.promise(() => Promise.resolve(flushed))
    yield* realDelay(150)

    yield* expect({
      flushedValue,
      writes: writes.map((write) => JSON.parse(write.value)),
    }).toEqual({
      flushedValue: undefined,
      writes: [firstExpected, secondExpected],
    })
  },
)

it.live.each(
  [
    ['snapshot', false],
    ['snapshot', true],
    ['event', false],
    ['event', true],
  ] as const,
)(
  'persist committed %s writes orders asynchronous writes and recovers after failure: %s',
  function*([strategy, failFirst], { expect }) {
    const writes: Array<{
      value: string
      resolve: () => void
      reject: (error: unknown) => void
    }> = []
    let saved: string | null = null
    const onDoneCalls: Array<[unknown]> = []
    const onDone = (data: unknown) => {
      onDoneCalls.push([data])
    }
    const onErrorCalls: Array<[unknown]> = []
    const onError = (cause: unknown) => {
      onErrorCalls.push([cause])
    }
    const storage: StateStorage = {
      getItem: () => saved,
      removeItem: () => {},
      setItem: (_key, value) => {
        const { promise, resolve, reject } = Promise.withResolvers<void>()
        writes.push({
          value,
          resolve: () => {
            saved = value
            resolve()
          },
          reject,
        })
        return promise
      },
    }
    const store = createStore({
      context: { count: 0 },
      on: { inc: (ctx) => ({ count: ctx.count + 1 }) },
    }).with(
      persist({ name: 'ordered', strategy, storage, onDone, onError }),
    )

    store.trigger.inc()
    store.trigger.inc()
    const flushed = flushStorage(store)
    const completedCalls: Array<[]> = []
    const completed = () => {
      completedCalls.push([])
    }
    void Promise.resolve(flushed).then(completed)

    const firstWrite = writes[0]
    if (firstWrite === undefined) {
      throw new Error('expected a first write')
    }
    const firstExpected = strategy === 'snapshot'
      ? { context: { count: 1 }, version: 0 }
      : { events: [{ type: 'inc' }], version: 0, checkpoint: null }

    yield* expect({
      pending: writes.map((write) => JSON.parse(write.value)),
      flushedIsPromise: flushed instanceof Promise,
    }).toEqual({ pending: [firstExpected], flushedIsPromise: true })

    const writtenError = new Error('write failed')
    if (failFirst) {
      firstWrite.reject(writtenError)
    } else {
      firstWrite.resolve()
    }
    yield* eventually(() => writes.length >= 2)

    const secondWrite = writes[1]
    if (secondWrite === undefined) {
      throw new Error('expected a second write')
    }
    const secondExpected = strategy === 'snapshot'
      ? { context: { count: 2 }, version: 0 }
      : {
        events: [{ type: 'inc' }, { type: 'inc' }],
        version: 0,
        checkpoint: null,
      }

    yield* expect({
      completed: completedCalls,
      second: JSON.parse(secondWrite.value),
    }).toEqual({ completed: [], second: secondExpected })

    secondWrite.resolve()
    const flushedValue = yield* Effect.promise(() => Promise.resolve(flushed))

    const value = JSON.parse(saved!)
    const firstCall = strategy === 'snapshot' ? [{ count: 1 }] : [[{ type: 'inc' }]]
    const secondCall = strategy === 'snapshot'
      ? [{ count: 2 }]
      : [[{ type: 'inc' }, { type: 'inc' }]]

    yield* expect({
      value,
      flushedValue,
      onErrorCalls,
      onDoneCalls,
    }).toEqual({
      value: secondExpected,
      flushedValue: undefined,
      onErrorCalls: failFirst ? [[writtenError]] : [],
      onDoneCalls: failFirst ? [secondCall] : [firstCall, secondCall],
    })
  },
)
