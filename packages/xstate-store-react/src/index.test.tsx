import { describe, it, vi } from '@systemfsoftware/vitest'
import { createAtom as upstreamCreateAtom, createStore as upstreamCreateStore } from '@systemfsoftware/xstate-store'
import { act, fireEvent, render, within } from '@testing-library/react'
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

      const { container, unmount } = render(<Counter />)
      try {
        const view = within(container)

        const countDiv = view.getByTestId('count')
        const before = countDiv.textContent
        fireEvent.click(countDiv)

        yield* expect({ before, after: countDiv.textContent }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        yield* expect(within(container).getByTestId('count').textContent).toBe('0')
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        const view = within(container)

        const countDiv = view.getByTestId('count')
        const before = countDiv.textContent
        fireEvent.click(countDiv)

        yield* expect({ before, after: countDiv.textContent }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount()
      }
    })

    it('should run compare for falsy selected values', function*({ expect }) {
      const store = createStore({
        context: { count: 0, label: 'ready' },
        on: {
          rename: (ctx, ev: { label: string }) => ({ ...ctx, label: ev.label }),
        },
      })
      const compare = vi.fn((a: number | undefined, b: number) => a === b)

      const Counter = () => {
        const count = useSelector(store, (s) => s.context.count, compare)
        return <div data-testid='count'>{count}</div>
      }

      const { unmount } = render(<Counter />)
      try {
        act(() => {
          store.send({ type: 'rename', label: 'done' })
        })

        yield* expect(compare).toHaveBeenCalledWith(0, 0)
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        const countDiv = within(container).getByTestId('count')

        const before = countDiv.textContent
        fireEvent.click(countDiv)

        yield* expect({
          before,
          after: countDiv.textContent,
          stableReference: storeRefs.every((ref) => ref === storeRefs[0]),
        }).toEqual({ before: '0', after: '1', stableReference: true })
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        const countDiv = within(container).getByTestId('count')

        const before = countDiv.textContent
        fireEvent.click(countDiv)

        yield* expect({
          before,
          after: countDiv.textContent,
          stableReference: storeRefs.every((ref) => ref === storeRefs[0]),
        }).toEqual({ before: '10', after: '11', stableReference: true })
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      const onSubscribe: string[] = []
      const afterClick: string[] = []

      try {
        const view = within(container)
        onSubscribe.push(...events)

        fireEvent.click(view.getByTestId('count'))
        afterClick.push(...events)
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        const countDiv = within(container).getByTestId('count')

        fireEvent.click(countDiv)
        fireEvent.click(countDiv)

        yield* expect(snapshotEvents).toEqual(['@xstate.init', 'inc', 'inc'])
      } finally {
        unmount()
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

      const { container, rerender, unmount } = render(<Counter />)
      try {
        const view = within(container)
        rerender(<Counter inspect={(event) => events.push(event.event.type)} />)

        const afterMount = [...events]

        fireEvent.click(view.getByRole('button'))

        yield* expect({ afterMount, afterClick: [...events] }).toEqual({
          afterMount: ['@xstate.init'],
          afterClick: ['@xstate.init', 'inc'],
        })
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        yield* expect({
          text: within(container).getByTestId('count').textContent,
          events,
        }).toEqual({ text: '10', events: ['@xstate.init'] })
      } finally {
        unmount()
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

      const { container, unmount } = render(<TestComponent />)
      try {
        yield* expect(within(container).getByTestId('value').textContent).toBe('42')
      } finally {
        unmount()
      }
    })

    it('should update when atom changes', function*({ expect }) {
      const atom = createAtom(0)

      const TestComponent = () => {
        const count = useAtom(atom)
        return (
          <div>
            <div data-testid='count'>{count}</div>
            <button data-testid='increment' onClick={() => atom.set((c) => c + 1)}>
              +
            </button>
          </div>
        )
      }

      const { container, unmount } = render(<TestComponent />)
      try {
        const view = within(container)

        const countDiv = view.getByTestId('count')
        const before = countDiv.textContent

        act(() => {
          fireEvent.click(view.getByTestId('increment'))
        })

        yield* expect({ before, after: countDiv.textContent }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount()
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

      const { container, unmount } = render(<TestComponent />)
      try {
        yield* expect(within(container).getByTestId('count').textContent).toBe('10')
      } finally {
        unmount()
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
            <button data-testid='increment' onClick={() => countAtom.set((c) => c + 1)}>
              +
            </button>
          </div>
        )
      }

      const { container, unmount } = render(<TestComponent />)
      try {
        const view = within(container)

        const countDiv = view.getByTestId('count')
        const before = countDiv.textContent

        act(() => {
          fireEvent.click(view.getByTestId('increment'))
        })

        yield* expect({
          before,
          after: countDiv.textContent,
          stableAtom: atomRefs.every((ref) => ref === atom),
        }).toEqual({ before: '0', after: '1', stableAtom: true })
      } finally {
        unmount()
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
            <button data-testid='increment' onClick={() => countAtom.set((c) => c + 1)}>
              +
            </button>
          </div>
        )
      }

      const { container, unmount } = render(<TestComponent />)
      try {
        const view = within(container)

        const countDiv = view.getByTestId('count')
        const before = countDiv.textContent

        act(() => {
          fireEvent.click(view.getByTestId('increment'))
        })

        yield* expect({
          before,
          after: countDiv.textContent,
          stableAtom: atomRefs.every((ref) => ref === atomRefs[0]),
        }).toEqual({ before: '10', after: '11', stableAtom: true })
      } finally {
        unmount()
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

      const { container, unmount } = render(<Counter />)
      try {
        const view = within(container)

        const countDiv = view.getByTestId('count')
        const before = countDiv.textContent
        fireEvent.click(view.getByRole('button'))

        yield* expect({ before, after: countDiv.textContent }).toEqual({
          before: '0',
          after: '1',
        })
      } finally {
        unmount()
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

  const { container, unmount } = render(<View />)
  try {
    const view = within(container)
    const initialRenders = renders

    act(() => atom.set({ count: 0, ignored: 1 }))
    const rendersAfterIgnoredChange = renders

    act(() => atom.set({ count: 1, ignored: 1 }))

    yield* expect({
      rendersAfterIgnoredChange,
      text: view.getByText('1').textContent,
    }).toEqual({
      rendersAfterIgnoredChange: initialRenders,
      text: '1',
    })
  } finally {
    unmount()
  }
})
