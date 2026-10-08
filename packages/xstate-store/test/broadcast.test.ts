import { describe } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createStore } from '../src/index.js'
import {
  createBroadcastStorage,
  flushStorage,
  persist,
  type StateStorage,
  subscribeToBroadcastStorage,
} from '../src/persist.js'

const broadcastChannelSlot = globalThis as unknown as {
  BroadcastChannel?: unknown
}

function createBroadcastWorld() {
  type Listener = (event: { data: unknown }) => void

  const channels = new Map<string, Set<MockBroadcastChannel>>()

  class MockBroadcastChannel {
    public listeners = new Set<Listener>()

    constructor(public name: string) {
      let entries = channels.get(name)
      if (!entries) {
        entries = new Set()
        channels.set(name, entries)
      }
      entries.add(this)
    }

    postMessage(data: unknown) {
      const entries = channels.get(this.name)
      if (!entries) {
        return
      }

      for (const channel of entries) {
        if (channel === this) {
          continue
        }

        for (const listener of channel.listeners) {
          listener({ data })
        }
      }
    }

    addEventListener(_type: 'message', listener: Listener) {
      this.listeners.add(listener)
    }

    removeEventListener(_type: 'message', listener: Listener) {
      this.listeners.delete(listener)
    }

    close() {
      channels.get(this.name)?.delete(this)
      this.listeners.clear()
    }
  }

  return { MockBroadcastChannel }
}

function installBroadcastChannel(MockBroadcastChannel: unknown): () => void {
  const original = broadcastChannelSlot.BroadcastChannel
  broadcastChannelSlot.BroadcastChannel = MockBroadcastChannel

  return () => {
    if (original === undefined) {
      delete broadcastChannelSlot.BroadcastChannel
    } else {
      broadcastChannelSlot.BroadcastChannel = original
    }
  }
}

function createMemoryStorage(): StateStorage {
  const data: Record<string, string> = {}

  return {
    getItem: (name) => data[name] ?? null,
    setItem: (name, value) => {
      data[name] = value
    },
    removeItem: (name) => {
      delete data[name]
    },
  }
}

function createCounterStore(storage: StateStorage) {
  return createStore({
    context: { count: 0 },
    on: {
      inc: (context) => ({ count: context.count + 1 }),
    },
  }).with(persist({ name: 'counter', storage }))
}

function waitForMicrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

describe('broadcast storage', (it) => {
  it.live('broadcasts queued persisted writes only after each async write completes', function*({
    expect,
  }) {
    const { MockBroadcastChannel } = createBroadcastWorld()
    const restore = installBroadcastChannel(MockBroadcastChannel)
    try {
      const completions: Array<() => void> = []
      let saved: string | null = null
      const baseStorage: StateStorage = {
        getItem: () => saved,
        removeItem: () => {},
        setItem: (_name, value) =>
          new Promise<void>((resolve) => {
            completions.push(() => {
              saved = value
              resolve()
            })
          }),
      }
      const storage = createBroadcastStorage(baseStorage)
      const receiver = new MockBroadcastChannel('xstate-store')
      const counts: number[] = []
      receiver.addEventListener('message', () => {
        counts.push(JSON.parse(saved!).context.count)
      })
      const store = createCounterStore(storage)
      store.trigger.inc()
      store.trigger.inc()

      yield* expect({
        completions: completions.length,
        counts: [...counts],
      }).toEqual({ completions: 1, counts: [] })

      const flushed = flushStorage(store)
      const firstCompletion = completions[0]
      if (firstCompletion === undefined) {
        throw new Error('expected a first completion')
      }
      firstCompletion()
      yield* Effect.promise(() => waitForMicrotask())

      yield* expect({ counts: [...counts], completions: completions.length }).toEqual(
        { counts: [1], completions: 2 },
      )

      const secondCompletion = completions[1]
      if (secondCompletion === undefined) {
        throw new Error('expected a second completion')
      }
      secondCompletion()
      yield* Effect.promise(() => Promise.resolve(flushed))

      yield* expect(counts).toEqual([1, 2])
    } finally {
      restore()
    }
  })

  it('broadcasts writes to other storage adapters on the same channel', function*({
    expect,
  }) {
    const { MockBroadcastChannel } = createBroadcastWorld()
    const restore = installBroadcastChannel(MockBroadcastChannel)
    try {
      const baseStorage = createMemoryStorage()
      const storage = createBroadcastStorage(baseStorage)
      const receiver = new MockBroadcastChannel('xstate-store')
      const messages: unknown[] = []

      receiver.addEventListener('message', (event) => {
        messages.push(event.data)
      })

      storage.setItem('counter', JSON.stringify({ context: { count: 1 } }))

      yield* expect(messages).toEqual([
        { type: 'xstate-store-update', name: 'counter' },
      ])
    } finally {
      restore()
    }
  })

  it.live('rehydrates subscribed stores when another tab writes persisted state', function*({
    expect,
  }) {
    const { MockBroadcastChannel } = createBroadcastWorld()
    const restore = installBroadcastChannel(MockBroadcastChannel)
    try {
      const baseStorage = createMemoryStorage()
      const storage1 = createBroadcastStorage(baseStorage)
      const storage2 = createBroadcastStorage(baseStorage)
      const store1 = createCounterStore(storage1)
      const store2 = createCounterStore(storage2)
      const unsubscribe = subscribeToBroadcastStorage(store2)

      store1.trigger.inc()
      yield* Effect.promise(() => waitForMicrotask())

      yield* expect({
        store1: store1.getSnapshot().context.count,
        store2: store2.getSnapshot().context.count,
      }).toEqual({ store1: 1, store2: 1 })

      unsubscribe()
    } finally {
      restore()
    }
  })

  it.live('does not rehydrate from unrelated storage names', function*({
    expect,
  }) {
    const { MockBroadcastChannel } = createBroadcastWorld()
    const restore = installBroadcastChannel(MockBroadcastChannel)
    try {
      const baseStorage = createMemoryStorage()
      const storage = createBroadcastStorage(baseStorage)
      const store = createCounterStore(storage)
      const unsubscribe = subscribeToBroadcastStorage(store)
      const sender = new MockBroadcastChannel('xstate-store')

      baseStorage.setItem(
        'other',
        JSON.stringify({ context: { count: 100 }, version: 0 }),
      )
      sender.postMessage({ type: 'xstate-store-update', name: 'other' })
      yield* Effect.promise(() => waitForMicrotask())

      yield* expect(store.getSnapshot().context.count).toEqual(0)

      unsubscribe()
      sender.close()
    } finally {
      restore()
    }
  })

  it('throws when subscribing a store without broadcast storage', function*({
    expect,
  }) {
    const store = createCounterStore(createMemoryStorage())

    yield* expect(() => subscribeToBroadcastStorage(store)).toThrow(
      'subscribeToBroadcastStorage: store storage must be wrapped with createBroadcastStorage()',
    )
  })
})
