import { describe, it } from '@systemfsoftware/vitest'
import { createAtom as upstreamCreateAtom, createStore as upstreamCreateStore } from '@systemfsoftware/xstate-store'
import { Effect } from 'effect'
import { type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { type Locator, page } from 'vitest/browser'
import {
  createAtom,
  createAtomConfig,
  createStore,
  createStoreHook,
  createStoreLogic,
  type StoreInspectionEvent,
  useAtom,
  useAtomState,
  useSelector,
  useStore,
} from './index.js'

interface Mounted {
  readonly container: HTMLDivElement
  readonly root: Root
  readonly view: Locator
}

const mount = (ui: ReactNode): Mounted => {
  const container = document.createElement('div')
  container.setAttribute('data-testid', `xstate-store-react-${crypto.randomUUID()}`)
  document.body.append(container)
  const root = createRoot(container)
  flushSync(() => root.render(ui))
  return { container, root, view: page.elementLocator(container) }
}

const unmount = ({ container, root }: Mounted): void => {
  flushSync(() => root.unmount())
  container.remove()
}

describe('@xstate/store-react', () => {
  describe('useSelector', () => {
    it('should work with a selector', function*({ expect }) {
      const store = createStore({
        context: { count: 0 },
        on: {
          inc: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
        },
      })

      const Counter = () => {
        const count = useSelector(store, (s) => s.context.count)
        return (
          <div data-testid='count' onClick={() => store.send({ type: 'inc' })}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        const before = screen.view.getByTestId('count').element().textContent
        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('1')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({ before, after }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount(screen)
      }
    })

    it('should work without a selector (full snapshot)', function*({ expect }) {
      const store = createStore({
        context: { count: 0 },
        on: {},
      })

      const Counter = () => {
        const snapshot = useSelector(store)
        return <div data-testid='count'>{snapshot.context.count}</div>
      }

      const screen = mount(<Counter />)
      try {
        yield* expect(screen.view.getByTestId('count').element().textContent).toBe('0')
      } finally {
        unmount(screen)
      }
    })

    it('should work with atoms', function*({ expect }) {
      const atom = createAtom(0)

      const Counter = () => {
        const count = useSelector(atom, (s) => s)
        return (
          <div data-testid='count' onClick={() => atom.set((prev) => prev + 1)}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        const before = screen.view.getByTestId('count').element().textContent
        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('1')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({ before, after }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount(screen)
      }
    })

    it('should run compare for falsy selected values', function*({ expect }) {
      const store = createStore({
        context: { count: 0, label: 'ready' },
        on: {
          rename: (ctx, ev: { label: string }) => ({ ...ctx, label: ev.label }),
        },
      })
      const calls: Array<[number | undefined, number]> = []
      const compare = (a: number | undefined, b: number) => {
        calls.push([a, b])
        return a === b
      }

      const Counter = () => {
        const count = useSelector(store, (s) => s.context.count, compare)
        return <div data-testid='count'>{count}</div>
      }

      const screen = mount(<Counter />)
      try {
        flushSync(() => store.send({ type: 'rename', label: 'done' }))

        const calledWith = calls.filter(
          (call, index) =>
            calls.findIndex(
              (other) => other[0] === call[0] && other[1] === call[1],
            ) === index,
        )

        yield* expect({ called: calls.length >= 1, calledWith }).toEqual({
          called: true,
          calledWith: [[0, 0]],
        })
      } finally {
        unmount(screen)
      }
    })
  })

  describe('useStore', () => {
    it('should create a stable store reference', function*({ expect }) {
      const storeRefs: object[] = []

      const Counter = () => {
        const store = useStore({
          context: { count: 0 },
          on: {
            inc: (ctx: { count: number }) => ({ ...ctx, count: ctx.count + 1 }),
          },
        })

        storeRefs.push(store)
        const count = useSelector(store, (s) => s.context.count)

        return (
          <div data-testid='count' onClick={() => store.send({ type: 'inc' })}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        const before = screen.view.getByTestId('count').element().textContent
        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('1')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({
          before,
          after,
          stableReference: storeRefs.every((ref) => ref === storeRefs[0]),
        }).toEqual({ before: '0', after: '1', stableReference: true })
      } finally {
        unmount(screen)
      }
    })

    it('should create a stable store from store logic and input', function*({ expect }) {
      const counterLogic = createStoreLogic({
        context: (input: { initialCount: number }) => ({
          count: input.initialCount,
        }),
        on: {
          inc: (ctx) => ({ count: ctx.count + 1 }),
        },
      })
      const storeRefs: object[] = []

      const Counter = () => {
        const store = useStore(counterLogic, { initialCount: 10 })
        storeRefs.push(store)
        const count = useSelector(store, (s) => s.context.count)

        return (
          <div data-testid='count' onClick={() => store.trigger.inc()}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        const before = screen.view.getByTestId('count').element().textContent
        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('11')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({
          before,
          after,
          stableReference: storeRefs.every((ref) => ref === storeRefs[0]),
        }).toEqual({ before: '10', after: '11', stableReference: true })
      } finally {
        unmount(screen)
      }
    })

    it('should subscribe an inspector via the inspect option', function*({ expect }) {
      const events: string[] = []

      const Counter = () => {
        const store = useStore(
          {
            context: { count: 0 },
            on: {
              inc: (ctx: { count: number }) => ({ count: ctx.count + 1 }),
            },
          },
          { inspect: (ev) => events.push(ev.event.type) },
        )
        const count = useSelector(store, (s) => s.context.count)

        return (
          <div data-testid='count' onClick={() => store.send({ type: 'inc' })}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      const onSubscribe: string[] = []
      const afterClick: string[] = []

      try {
        onSubscribe.push(...events)

        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        afterClick.push(...events)
      } finally {
        unmount(screen)
      }

      yield* expect({
        onSubscribe,
        afterClick,
        lengthAfterUnmount: events.length,
      }).toEqual({
        onSubscribe: ['@xstate.init'],
        afterClick: ['@xstate.init', 'inc'],
        lengthAfterUnmount: 2,
      })
    })

    it('should not resubscribe the inspector across re-renders', function*({ expect }) {
      const snapshotEvents: string[] = []

      const Counter = () => {
        const store = useStore(
          {
            context: { count: 0 },
            on: {
              inc: (ctx: { count: number }) => ({ count: ctx.count + 1 }),
            },
          },
          { inspect: (ev) => snapshotEvents.push(ev.event.type) },
        )
        const count = useSelector(store, (s) => s.context.count)

        return (
          <div data-testid='count' onClick={() => store.send({ type: 'inc' })}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        screen.view.getByTestId('count').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))

        yield* expect(snapshotEvents).toEqual(['@xstate.init', 'inc', 'inc'])
      } finally {
        unmount(screen)
      }
    })

    it('should subscribe an inspector enabled after mount', function*({ expect }) {
      const events: string[] = []

      const Counter = ({
        inspect,
      }: {
        inspect?: (event: StoreInspectionEvent) => void
      }) => {
        const store = useStore(
          {
            context: { count: 0 },
            on: {
              inc: (ctx: { count: number }) => ({ count: ctx.count + 1 }),
            },
          },
          { ...(inspect === undefined ? {} : { inspect }) },
        )

        return <button onClick={() => store.send({ type: 'inc' })}>inc</button>
      }

      const screen = mount(<Counter />)
      try {
        flushSync(() =>
          screen.root.render(
            <Counter inspect={(event) => events.push(event.event.type)} />,
          )
        )

        const afterMount = [...events]

        screen.view.getByRole('button').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))

        yield* expect({ afterMount, afterClick: [...events] }).toEqual({
          afterMount: ['@xstate.init'],
          afterClick: ['@xstate.init', 'inc'],
        })
      } finally {
        unmount(screen)
      }
    })

    it('should support the inspect option with store logic and input', function*({ expect }) {
      const counterLogic = createStoreLogic({
        context: (input: { initialCount: number }) => ({
          count: input.initialCount,
        }),
        on: {
          inc: (ctx) => ({ count: ctx.count + 1 }),
        },
      })
      const events: string[] = []

      const Counter = () => {
        const store = useStore(
          counterLogic,
          { initialCount: 10 },
          { inspect: (ev) => events.push(ev.event.type) },
        )
        const count = useSelector(store, (s) => s.context.count)

        return (
          <div data-testid='count' onClick={() => store.trigger.inc()}>
            {count}
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        yield* expect({
          text: screen.view.getByTestId('count').element().textContent,
          events,
        }).toEqual({ text: '10', events: ['@xstate.init'] })
      } finally {
        unmount(screen)
      }
    })
  })

  describe('useAtom', () => {
    it('should return the atom value', function*({ expect }) {
      const atom = createAtom(42)

      const TestComponent = () => {
        const value = useAtom(atom)
        return <div data-testid='value'>{value}</div>
      }

      const screen = mount(<TestComponent />)
      try {
        yield* expect(screen.view.getByTestId('value').element().textContent).toBe('42')
      } finally {
        unmount(screen)
      }
    })

    it('should update when atom changes', function*({ expect }) {
      const atom = createAtom(0)

      const TestComponent = () => {
        const count = useAtom(atom)
        return (
          <div>
            <div data-testid='count'>{count}</div>
            <button
              data-testid='increment'
              onClick={() => atom.set((c) => c + 1)}
            >
              +
            </button>
          </div>
        )
      }

      const screen = mount(<TestComponent />)
      try {
        const before = screen.view.getByTestId('count').element().textContent

        screen.view.getByTestId('increment').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('1')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({ before, after }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount(screen)
      }
    })

    it('should create a stable atom value from atom config and input', function*({ expect }) {
      const config = createAtomConfig((input: { initialCount: number }) => {
        return input.initialCount
      })

      const TestComponent = () => {
        const count = useAtom(config, { initialCount: 10 })

        return <div data-testid='count'>{count}</div>
      }

      const screen = mount(<TestComponent />)
      try {
        yield* expect(screen.view.getByTestId('count').element().textContent).toBe('10')
      } finally {
        unmount(screen)
      }
    })
  })

  describe('useAtomState', () => {
    it('should return the value and existing atom', function*({ expect }) {
      const atom = createAtom(0)
      const atomRefs: object[] = []

      const TestComponent = () => {
        const [count, countAtom] = useAtomState(atom)
        atomRefs.push(countAtom)
        return (
          <div>
            <div data-testid='count'>{count}</div>
            <button
              data-testid='increment'
              onClick={() => countAtom.set((c) => c + 1)}
            >
              +
            </button>
          </div>
        )
      }

      const screen = mount(<TestComponent />)
      try {
        const before = screen.view.getByTestId('count').element().textContent

        screen.view.getByTestId('increment').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('1')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({
          before,
          after,
          stableAtom: atomRefs.every((ref) => ref === atom),
        }).toEqual({ before: '0', after: '1', stableAtom: true })
      } finally {
        unmount(screen)
      }
    })

    it('should create a stable atom from atom config and input', function*({ expect }) {
      const config = createAtomConfig((input: { initialCount: number }) => {
        return input.initialCount
      })
      const atomRefs: object[] = []

      const TestComponent = () => {
        const [count, countAtom] = useAtomState(config, { initialCount: 10 })
        atomRefs.push(countAtom)
        return (
          <div>
            <div data-testid='count'>{count}</div>
            <button
              data-testid='increment'
              onClick={() => countAtom.set((c) => c + 1)}
            >
              +
            </button>
          </div>
        )
      }

      const screen = mount(<TestComponent />)
      try {
        const before = screen.view.getByTestId('count').element().textContent

        screen.view.getByTestId('increment').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('11')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({
          before,
          after,
          stableAtom: atomRefs.every((ref) => ref === atomRefs[0]),
        }).toEqual({ before: '10', after: '11', stableAtom: true })
      } finally {
        unmount(screen)
      }
    })
  })

  describe('createStoreHook', () => {
    it('should create a reusable store hook', function*({ expect }) {
      const useCountStore = createStoreHook({
        context: { count: 0 },
        on: {
          inc: (ctx: { count: number }) => ({ ...ctx, count: ctx.count + 1 }),
        },
      })

      const Counter = () => {
        const [count, store] = useCountStore((s) => s.context.count)
        return (
          <div>
            <div data-testid='count'>{count}</div>
            <button onClick={() => store.trigger.inc()}>+</button>
          </div>
        )
      }

      const screen = mount(<Counter />)
      try {
        const before = screen.view.getByTestId('count').element().textContent
        screen.view.getByRole('button').element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const after = yield* Effect.promise(() =>
          screen.view
            .getByText('1')
            .findElement()
            .then((element) => element.textContent)
        )

        yield* expect({ before, after }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount(screen)
      }
    })
  })

  describe('re-exports', () => {
    it('should re-export createStore from @xstate/store', function*({ expect }) {
      const store = createStore({
        context: { value: 'test' },
        on: {},
      })
      yield* expect({
        isUpstreamCreateStore: createStore === upstreamCreateStore,
        value: store.get().context.value,
      }).toEqual({ isUpstreamCreateStore: true, value: 'test' })
    })

    it('should re-export createAtom from @xstate/store', function*({ expect }) {
      const atom = createAtom(123)
      yield* expect({
        isUpstreamCreateAtom: createAtom === upstreamCreateAtom,
        value: atom.get(),
      }).toEqual({ isUpstreamCreateAtom: true, value: 123 })
    })
  })
})

it('honors a comparator when the selector is omitted', function*({ expect }) {
  const atom = createAtom({ count: 0, ignored: 0 })
  let renders = 0
  function View() {
    const value = useSelector(atom, undefined, (a, b) => a?.count === b?.count)
    renders++
    return <div>{value.count}</div>
  }

  const screen = mount(<View />)
  try {
    const initialRenders = renders

    flushSync(() => atom.set({ count: 0, ignored: 1 }))
    const rendersAfterIgnoredChange = renders

    flushSync(() => atom.set({ count: 1, ignored: 1 }))

    const text = yield* Effect.promise(() =>
      screen.view
        .getByText('1')
        .findElement()
        .then((element) => element.textContent)
    )

    yield* expect({
      rendersAfterIgnoredChange,
      text,
    }).toEqual({
      rendersAfterIgnoredChange: initialRenders,
      text: '1',
    })
  } finally {
    unmount(screen)
  }
})
