import { describe, it, vi } from '@systemfsoftware/vitest'
import { createStore } from './index.js'

interface TestContext {
  user: {
    name: string
    age: number
  }
  settings: {
    theme: 'light' | 'dark'
    notifications: boolean
  }
}

describe('select', () => {
  it('should get current value', function*({ expect }) {
    const store = createStore({
      context: {
        user: { name: 'John', age: 30 },
        settings: { theme: 'dark', notifications: true },
      } as TestContext,
      on: {
        UPDATE_NAME: (context, event: { name: string }) => ({
          ...context,
          user: { ...context.user, name: event.name },
        }),
        UPDATE_THEME: (context, event: { theme: 'light' | 'dark' }) => ({
          ...context,
          settings: { ...context.settings, theme: event.theme },
        }),
      },
    })

    const name = store.select((state) => state.user.name).get()
    yield* expect(name).toBe('John')
  })

  it('should subscribe to changes', function*({ expect }) {
    const store = createStore({
      context: {
        user: { name: 'John', age: 30 },
        settings: { theme: 'dark', notifications: true },
      } as TestContext,
      on: {
        UPDATE_NAME: (context, event: { name: string }) => ({
          ...context,
          user: { ...context.user, name: event.name },
        }),
        UPDATE_THEME: (context, event: { theme: 'light' | 'dark' }) => ({
          ...context,
          settings: { ...context.settings, theme: event.theme },
        }),
      },
    })

    const callback = vi.fn()
    store.select((state) => state.user.name).subscribe(callback)
    store.send({ type: 'UPDATE_NAME', name: 'Jane' })

    yield* expect(callback.mock.calls).toEqual([['Jane']])
  })

  it('should not notify if selected value has not changed', function*({ expect }) {
    const store = createStore({
      context: {
        user: { name: 'John', age: 30 },
        settings: { theme: 'dark', notifications: true },
      } as TestContext,
      on: {
        UPDATE_NAME: (context, event: { name: string }) => ({
          ...context,
          user: { ...context.user, name: event.name },
        }),
        UPDATE_THEME: (context, event: { theme: 'light' | 'dark' }) => ({
          ...context,
          settings: { ...context.settings, theme: event.theme },
        }),
      },
    })

    const callback = vi.fn()
    store.select((state) => state.user.name).subscribe(callback)
    store.send({ type: 'UPDATE_THEME', theme: 'light' })

    yield* expect(callback.mock.calls).toEqual([])
  })

  it('should support custom equality function', function*({ expect }) {
    const store = createStore({
      context: {
        user: { name: 'John', age: 30 },
        settings: { theme: 'dark', notifications: true },
      } as TestContext,
      on: {
        UPDATE_NAME: (context, event: { name: string }) => ({
          ...context,
          user: { ...context.user, name: event.name },
        }),
        UPDATE_THEME: (context, event: { theme: 'light' | 'dark' }) => ({
          ...context,
          settings: { ...context.settings, theme: event.theme },
        }),
      },
    })

    const callback = vi.fn()
    const selector = (context: TestContext) => ({
      name: context.user.name,
      theme: context.settings.theme,
    })
    const equalityFn = (a: { name: string }, b: { name: string }) => a.name === b.name // Only compare names

    store.select(selector, equalityFn).subscribe(callback)

    store.send({ type: 'UPDATE_THEME', theme: 'light' })
    const callsAfterTheme = [...callback.mock.calls]

    store.send({ type: 'UPDATE_NAME', name: 'Jane' })
    yield* expect({ callsAfterTheme, callsAfterName: callback.mock.calls }).toEqual({
      callsAfterTheme: [],
      callsAfterName: [[{ name: 'Jane', theme: 'light' }]],
    })
  })

  it('should unsubscribe correctly', function*({ expect }) {
    const store = createStore({
      context: {
        user: { name: 'John', age: 30 },
        settings: { theme: 'dark', notifications: true },
      } as TestContext,
      on: {
        UPDATE_NAME: (context, event: { name: string }) => ({
          ...context,
          user: { ...context.user, name: event.name },
        }),
        UPDATE_THEME: (context, event: { theme: 'light' | 'dark' }) => ({
          ...context,
          settings: { ...context.settings, theme: event.theme },
        }),
      },
    })

    const callback = vi.fn()
    const subscription = store
      .select((state) => state.user.name)
      .subscribe(callback)
    subscription.unsubscribe()
    store.send({ type: 'UPDATE_NAME', name: 'Jane' })

    yield* expect(callback.mock.calls).toEqual([])
  })

  it('should handle updates with multiple subscribers', function*({ expect }) {
    interface PositionContext {
      position: {
        x: number
        y: number
      }
    }

    const store = createStore({
      context: {
        position: { x: 0, y: 0 },
        user: { name: 'John', age: 30 },
      } as PositionContext,
      on: {
        positionUpdated: (
          context,
          event: { position: { x: number; y: number } },
        ) => ({
          ...context,
          position: event.position,
        }),
        userUpdated: (
          context,
          event: { user: { name: string; age: number } },
        ) => ({
          ...context,
          user: event.user,
        }),
      },
    })

    // Mock DOM manipulation callback
    const renderCallback = vi.fn()
    store
      .select((state) => state.position)
      .subscribe((position) => {
        renderCallback(position)
      })

    // Mock logger callback for x position only
    const loggerCallback = vi.fn()
    store
      .select((state) => state.position.x)
      .subscribe((x) => {
        loggerCallback(x)
      })

    // Simulate position update
    store.trigger.positionUpdated({
      position: { x: 100, y: 200 },
    })

    // Simulate another update
    store.trigger.positionUpdated({
      position: { x: 150, y: 300 },
    })

    // Simulate changing only the y position
    store.trigger.positionUpdated({
      position: { x: 150, y: 400 },
    })

    // Simulate changing only the user
    store.trigger.userUpdated({
      user: { name: 'Jane', age: 25 },
    })

    yield* expect({
      render: renderCallback.mock.calls,
      logger: loggerCallback.mock.calls,
    }).toEqual({
      render: [[{ x: 100, y: 200 }], [{ x: 150, y: 300 }], [{ x: 150, y: 400 }]],
      logger: [[100], [150]],
    })
  })
})
