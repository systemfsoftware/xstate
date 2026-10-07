import { it } from '@systemfsoftware/vitest'
import {
  type ActorFromLogic,
  type ActorRef,
  type ActorRefFrom,
  type AnyMachineSnapshot,
  createActor,
  createAsyncLogic,
  createLogic,
  createMachine,
  type LogicSnapshot,
  setup,
  type SnapshotFrom,
  types,
} from '@systemfsoftware/xstate'
import { act, fireEvent, within } from '@testing-library/react'
import { Effect } from 'effect'
import * as React from 'react'
import { vi } from 'vitest'
import z from 'zod'
import { shallowEqual, useActorRef, useMachine, useSelector } from '../src/index.js'
import { describeEachReactMode } from './utils.js'

const originalConsoleError = console.error

describeEachReactMode('useSelector (%s)', ({ suiteKey, render }) => {
  it('only rerenders for selected values', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
          other: z.number(),
        }),
      },
      initial: 'active',
      context: {
        other: 0,
        count: 0,
      },
      states: {
        active: {},
      },
      on: {
        OTHER: ({ context }) => ({
          context: {
            other: context.other + 1,
          },
        }),
        INCREMENT: ({ context }) => ({
          context: {
            count: context.count + 1,
          },
        }),
      },
    })

    let rerenders = 0

    const App = () => {
      const service = useActorRef(machine)
      const count = useSelector(service, (state) => state.context.count)

      rerenders++

      return (
        <>
          <div data-testid='count'>{count}</div>
          <button
            data-testid='other'
            onClick={() => service.send({ type: 'OTHER' })}
          >
          </button>
          <button
            data-testid='increment'
            onClick={() => service.send({ type: 'INCREMENT' })}
          >
          </button>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const countButton = within(container).getByTestId('count')
      const otherButton = within(container).getByTestId('other')
      const incrementEl = within(container).getByTestId('increment')

      fireEvent.click(incrementEl)

      rerenders = 0

      fireEvent.click(otherButton)
      fireEvent.click(otherButton)
      fireEvent.click(otherButton)
      fireEvent.click(otherButton)

      const rerendersAfterOther = rerenders

      fireEvent.click(incrementEl)

      yield* expect({ rerendersAfterOther, finalCount: countButton.textContent }).toEqual({
        rerendersAfterOther: 0,
        finalCount: '2',
      })
    } finally {
      unmount()
    }
  })

  it('should work with a custom comparison function', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          name: z.string(),
        }),
        events: z.object({
          type: z.literal('CHANGE'),
          value: z.string(),
        }) as any,
      },
      initial: 'active',
      context: {
        name: 'david',
      },
      states: {
        active: {},
      },
      on: {
        CHANGE: ({ event }: any) => ({
          context: {
            name: event.value,
          },
        }),
      },
    })

    const App = () => {
      const service = useActorRef(machine)
      const name = useSelector(
        service,
        (state) => state.context.name,
        (a, b) => a.toUpperCase() === b.toUpperCase(),
      )

      return (
        <>
          <div data-testid='name'>{name}</div>
          <button
            data-testid='sendUpper'
            onClick={() => service.send({ type: 'CHANGE', value: 'DAVID' } as any)}
          >
          </button>
          <button
            data-testid='sendOther'
            onClick={() => service.send({ type: 'CHANGE', value: 'other' } as any)}
          >
          </button>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const nameEl = within(container).getByTestId('name')
      const sendUpperButton = within(container).getByTestId('sendUpper')
      const sendOtherButton = within(container).getByTestId('sendOther')

      const observed: Array<string | null> = [nameEl.textContent]

      fireEvent.click(sendUpperButton)
      observed.push(nameEl.textContent)

      fireEvent.click(sendOtherButton)
      observed.push(nameEl.textContent)

      fireEvent.click(sendUpperButton)
      observed.push(nameEl.textContent)

      yield* expect(observed).toEqual(['david', 'david', 'other', 'DAVID'])
    } finally {
      unmount()
    }
  })

  it('should work with the shallowEqual comparison function', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          user: z.object({
            name: z.string(),
          }),
        }),
      },
      initial: 'active',
      context: {
        user: { name: 'david' },
      },
      states: {
        active: {},
      },
      on: {
        'change.same': () => ({
          context: {
            user: { name: 'david' },
          },
        }),
        'change.other': () => ({
          context: {
            user: { name: 'other' },
          },
        }),
      },
    })

    const App = () => {
      const service = useActorRef(machine)
      const [userChanges, setUserChanges] = React.useState(0)
      const user = useSelector(
        service,
        (state) => state.context.user,
        shallowEqual,
      )
      const prevUser = React.useRef(user)

      React.useEffect(() => {
        if (user !== prevUser.current) {
          setUserChanges((c) => c + 1)
        }
        prevUser.current = user
      }, [user])

      return (
        <>
          <div data-testid='name'>{user.name}</div>
          <div data-testid='changes'>{userChanges}</div>
          <button
            data-testid='sendSame'
            onClick={() => service.send({ type: 'change.same' })}
          >
          </button>
          <button
            data-testid='sendOther'
            onClick={() => service.send({ type: 'change.other' })}
          >
          </button>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const nameEl = within(container).getByTestId('name')
      const changesEl = within(container).getByTestId('changes')
      const sendSameButton = within(container).getByTestId('sendSame')
      const sendOtherButton = within(container).getByTestId('sendOther')

      const observed: Array<Array<string | null>> = [[nameEl.textContent]]

      fireEvent.click(sendSameButton)
      observed.push([nameEl.textContent, changesEl.textContent])

      fireEvent.click(sendOtherButton)
      observed.push([nameEl.textContent, changesEl.textContent])

      fireEvent.click(sendSameButton)
      observed.push([nameEl.textContent, changesEl.textContent])

      fireEvent.click(sendSameButton)
      observed.push([nameEl.textContent, changesEl.textContent])

      yield* expect(observed).toEqual([
        ['david'],
        ['david', '0'],
        ['other', '1'],
        ['david', '2'],
        ['david', '2'],
      ])
    } finally {
      unmount()
    }
  })

  it('should work with selecting values from initially invoked actors', function*({ expect }) {
    const childMachine = createMachine({
      id: 'childMachine',
      initial: 'active',
      states: {
        active: {},
      },
    })
    const machine = createMachine({
      initial: 'active',
      invoke: {
        id: 'child',
        src: childMachine,
      },
      states: {
        active: {},
      },
    })

    let childValue: unknown

    const ChildTest: React.FC<{
      actor: ActorRefFrom<typeof childMachine>
    }> = ({ actor }) => {
      const state = useSelector(actor, (s) => s)

      childValue = state.value

      return null
    }

    const Test = () => {
      const actorRef = useActorRef(machine)
      const childActor = useSelector(
        actorRef,
        (s) => s.children['child'] as ActorRefFrom<typeof childMachine>,
      )
      return <ChildTest actor={childActor} />
    }

    const { unmount } = render(<Test />)

    try {
      yield* expect(childValue).toEqual('active')
    } finally {
      unmount()
    }
  })

  it('should work with selecting values from initially spawned actors', function*({ expect }) {
    const childMachine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      on: {
        UPDATE_COUNT: ({ context }) => ({
          context: {
            count: context.count + 1,
          },
        }),
      },
    })

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childActor: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        childActor: spawn(childMachine),
      }),
    })
    const App = () => {
      const [state] = useMachine(parentMachine)
      const actor = state.context.childActor
      const count = useSelector(actor, (state) => state.context['count'])

      return (
        <>
          <div data-testid='count'>{count}</div>

          <button
            onClick={() => actor.send({ type: 'UPDATE_COUNT' })}
            data-testid='button'
          />
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const buttonEl = within(container).getByTestId('button')
      const countEl = within(container).getByTestId('count')

      const observed: Array<string | null> = [countEl.textContent]
      fireEvent.click(buttonEl)
      observed.push(countEl.textContent)

      yield* expect(observed).toEqual(['0', '1'])
    } finally {
      unmount()
    }
  })

  it('can call trigger on a spawned actor passed to a child component', function*({ expect }) {
    const todoMachine = setup({
      schemas: {
        context: types<{
          label: string
          done: boolean
        }>(),
        events: {
          rename: types<{ value: string }>(),
          toggle: types<{}>(),
        },
      },
    }).createMachine({
      context: {
        label: 'Draft',
        done: false,
      },
      on: {
        rename: ({ context, event }) => ({
          context: {
            ...context,
            label: event.value,
          },
        }),
        toggle: ({ context }) => ({
          context: {
            ...context,
            done: !context.done,
          },
        }),
      },
    })

    type TodoActor = ActorFromLogic<typeof todoMachine>

    const parentMachine = setup({
      schemas: {
        context: types<{
          todo: TodoActor | undefined
        }>(),
      },
      actors: {
        todo: todoMachine,
      },
    }).createMachine({
      context: {
        todo: undefined,
      },
      entry: ({ actors }, enq) => ({
        context: {
          todo: enq.spawn(actors.todo),
        },
      }),
    })

    function Parent() {
      const [state] = useMachine(parentMachine)
      const todo = state.context.todo

      if (!todo) {
        return null
      }

      return <TodoItem actor={todo} />
    }

    function TodoItem({ actor }: { actor: TodoActor }) {
      const todo = useSelector(actor, (state) => state.context)

      return (
        <>
          <div data-testid='label'>{todo.label}</div>
          <div data-testid='done'>{String(todo.done)}</div>
          <button
            data-testid='rename'
            onClick={() => actor.trigger.rename({ value: 'Buy milk' })}
          />
          <button data-testid='toggle' onClick={() => actor.trigger.toggle()} />
        </>
      )
    }

    const { container, unmount } = render(<Parent />)

    try {
      const labels: Array<string | null> = [within(container).getByTestId('label').textContent]
      const dones: Array<string | null> = [within(container).getByTestId('done').textContent]

      fireEvent.click(within(container).getByTestId('rename'))
      labels.push(within(container).getByTestId('label').textContent)

      fireEvent.click(within(container).getByTestId('toggle'))
      dones.push(within(container).getByTestId('done').textContent)

      yield* expect({ labels, dones }).toEqual({
        labels: ['Draft', 'Buy milk'],
        dones: ['false', 'true'],
      })
    } finally {
      unmount()
    }
  })

  it('should immediately render snapshot of initially spawned custom actor', function*({ expect }) {
    const createCustomActor = (latestValue: string) =>
      createActor(
        createLogic({
          context: latestValue,
          run: () => undefined,
        }),
      )

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childActor: z.custom<ReturnType<typeof createCustomActor>>(),
        }),
      },
      context: () => ({
        childActor: createCustomActor('foo'),
      }),
    })

    const identitySelector = (value: any) => value

    const App = () => {
      const [state] = useMachine(parentMachine)
      const actor = state.context.childActor

      const value = useSelector(actor, identitySelector)

      return <>{value.context}</>
    }

    const { container, unmount } = render(<App />)

    try {
      yield* expect(container.textContent).toEqual('foo')
    } finally {
      unmount()
    }
  })

  it('should rerender with a new value when the selector changes', function*({ expect }) {
    const childMachine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      on: {
        INC: ({ context }) => ({
          context: {
            count: context.count + 1,
          },
        }),
      },
    })

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childActor: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        childActor: spawn(childMachine),
      }),
    })

    const App = ({ prop }: { prop: string }) => {
      const [state] = useMachine(parentMachine)
      const actor = state.context.childActor
      const value = useSelector(
        actor,
        (state) => `${prop} ${state.context['count']}`,
      )

      return <div data-testid='value'>{value}</div>
    }

    const { container, rerender, unmount } = render(<App prop='first' />)

    try {
      const observed: Array<string | null> = [container.textContent]

      rerender(<App prop='second' />)
      observed.push(container.textContent)

      yield* expect(observed).toEqual(['first 0', 'second 0'])
    } finally {
      unmount()
    }
  })

  it('should use a fresh selector for subscription updates after selector change', function*({ expect }) {
    const childMachine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      on: {
        INC: ({ context }) => ({
          context: {
            count: context.count + 1,
          },
        }),
      },
    })

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childActor: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        childActor: spawn(childMachine),
      }),
    })

    const App = ({ prop }: { prop: string }) => {
      const [state] = useMachine(parentMachine)
      const actor = state.context.childActor
      const value = useSelector(
        actor,
        (state) => `${prop} ${state.context['count']}`,
      )

      return (
        <>
          <div data-testid='value'>{value}</div>

          <button
            onClick={() => {
              actor.send({ type: 'INC' })
            }}
          />
        </>
      )
    }

    const { container, rerender, unmount } = render(<App prop='first' />)

    try {
      const buttonEl = within(container).getByRole('button')
      const valueEl = within(container).getByTestId('value')

      const observed: Array<string | null> = [valueEl.textContent]

      rerender(<App prop='second' />)
      fireEvent.click(buttonEl)
      observed.push(valueEl.textContent)

      yield* expect(observed).toEqual(['first 0', 'second 1'])
    } finally {
      unmount()
    }
  })

  it("should render snapshot value when actor doesn't emit anything", function*({ expect }) {
    const createCustomLogic = (latestValue: string) =>
      createLogic({
        context: latestValue,
        run: () => undefined,
      })

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childActor: z.custom<ActorRefFrom<ReturnType<typeof createCustomLogic>>>(),
        }),
      },
      context: ({ spawn }) => ({
        childActor: spawn(createCustomLogic('foo')),
      }),
    })

    const identitySelector = (value: any) => value

    const App = () => {
      const [state] = useMachine(parentMachine)
      const actor = state.context.childActor

      const value = useSelector(actor, identitySelector)

      return <>{value.context}</>
    }

    const { container, unmount } = render(<App />)

    try {
      yield* expect(container.textContent).toEqual('foo')
    } finally {
      unmount()
    }
  })

  it('should render snapshot state when actor changes', function*({ expect }) {
    const createCustomActor = (latestValue: string) =>
      createActor(
        createLogic({
          context: latestValue,
          run: () => undefined,
        }),
      )

    const actor1 = createCustomActor('foo')
    const actor2 = createCustomActor('bar')

    const identitySelector = (value: any) => value

    const App = ({ prop }: { prop: string }) => {
      const value = useSelector(
        prop === 'first' ? actor1 : actor2,
        identitySelector,
      )

      return <>{value.context}</>
    }

    const { container, rerender, unmount } = render(<App prop='first' />)

    try {
      const observed: Array<string | null> = [container.textContent]

      rerender(<App prop='second' />)
      observed.push(container.textContent)

      yield* expect(observed).toEqual(['foo', 'bar'])
    } finally {
      unmount()
    }
  })

  it(
    "should keep rendering a new selected value after selector change when the actor doesn't emit",
    function*({ expect }) {
      const actor = createActor(
        createLogic({
          context: undefined,
          run: () => undefined,
        }),
      )
      actor.subscribe = () => ({ unsubscribe: () => {} })

      const App = ({ selector }: { selector: any }) => {
        const [, forceRerender] = React.useState(0)
        const value = useSelector(actor, selector)

        return (
          <>
            {value as number}
            <button
              type='button'
              onClick={() => forceRerender((s) => s + 1)}
            >
            </button>
          </>
        )
      }

      const { container, rerender, unmount } = render(<App selector={() => 'foo'} />)

      try {
        const observed: Array<string | null> = [container.textContent]

        rerender(<App selector={() => 'bar'} />)
        observed.push(container.textContent)

        yield* expect(observed).toEqual(['foo', 'bar'])

        const button = yield* Effect.promise(() => within(container).findByRole('button'))
        fireEvent.click(button)

        yield* expect(container.textContent).toEqual('bar')
      } finally {
        unmount()
      }
    },
  )

  it('should only rerender once when the selected value changes', function*({ expect }) {
    const selector = (state: any) => state.context.foo

    const machine = createMachine({
      schemas: {
        context: z.object({
          foo: z.number(),
        }),
        events: z.object({
          type: z.literal('INC'),
        }) as any,
      },
      context: {
        foo: 0,
      },
      on: {
        INC: ({ context }) => ({
          context: {
            foo: context.foo + 1,
          },
        }),
      },
    })

    const service = createActor(machine).start()

    let renders = 0

    const App = () => {
      ++renders
      useSelector(service, selector)

      return null
    }

    const { unmount } = render(<App />)

    try {
      renders = 0
      act(() => {
        service.send({ type: 'INC' })
      })

      yield* expect(renders).toEqual(suiteKey === 'strict' ? 2 : 1)
    } finally {
      unmount()
    }
  })

  it('should compute a stable snapshot internally when selecting from uninitialized service', function*({ expect }) {
    const child = createMachine({})
    const machine = createMachine({
      invoke: {
        id: 'child',
        src: child,
      },
    })

    const snapshots: AnyMachineSnapshot[] = []

    function App() {
      const service = useActorRef(machine)
      useSelector(service, (state) => {
        snapshots.push(state)
        return state.children['child']
      })
      return null
    }

    const errorSpy = vi.fn()
    console.error = errorSpy

    const { unmount } = render(<App />)

    try {
      const [snapshot1] = snapshots

      yield* expect({
        allSame: snapshots.every((s) => s === snapshot1),
        errorCalls: errorSpy.mock.calls,
      }).toEqual({ allSame: true, errorCalls: [] })
    } finally {
      unmount()
      console.error = originalConsoleError
    }
  })

  it('should work with initially deferred actors spawned in lazy context', function*({ expect }) {
    const childMachine = createMachine({
      initial: 'one',
      states: {
        one: {
          on: { NEXT: { target: 'two' } },
        },
        two: {},
      },
    })

    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        ref: spawn(childMachine),
      }),
      initial: 'waiting',
      states: {
        waiting: {
          on: { TEST: { target: 'success' } },
        },
        success: {
          type: 'final',
        },
      },
    })

    const App = () => {
      const actorRef = useActorRef(machine)
      const childRef = useSelector(actorRef, (s) => s.context.ref)
      const childState = useSelector(childRef, (s) => s)

      return (
        <>
          <div data-testid='child-state'>{childState.value as string}</div>
          <button
            data-testid='child-send'
            onClick={() => childRef.send({ type: 'NEXT' })}
          >
          </button>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const elState = within(container).getByTestId('child-state')
      const elSend = within(container).getByTestId('child-send')

      const observed: Array<string | null> = [elState.textContent]
      fireEvent.click(elSend)
      observed.push(elState.textContent)

      yield* expect(observed).toEqual(['one', 'two'])
    } finally {
      unmount()
    }
  })

  it('should not log any spurious errors when used with a not-started actor', function*({ expect }) {
    const spy = vi.fn()
    console.error = spy

    const machine = createMachine({})
    const App = () => {
      useSelector(useActorRef(machine), (s) => s)

      return null
    }

    const { unmount } = render(<App />)

    try {
      yield* expect(spy.mock.calls).toEqual([])
    } finally {
      unmount()
      console.error = originalConsoleError
    }
  })

  it('should work with an optional actor', function*({ expect }) {
    const Child = (props: {
      actor:
        | ActorRef<LogicSnapshot<{ count: number }, undefined, unknown>, any>
        | undefined
    }) => {
      const state = useSelector(props.actor, (s) => s) // @ts-expect-error
      ;((_accept: { count: number }) => {})(state?.context)
      ;((_accept: { count: number } | undefined) => {})(state?.context)

      return <div data-testid='state'>{state?.context?.count ?? 'undefined'}</div>
    }

    const App = () => {
      const [actor, setActor] = React.useState<
        ActorRef<LogicSnapshot<{ count: number }, undefined, unknown>, any>
      >()

      return (
        <>
          <button
            data-testid='button'
            onClick={() =>
              setActor(
                createActor(
                  createLogic<{ count: number }, undefined>({
                    context: { count: 42 },
                    run: () => undefined,
                  }),
                ),
              )}
          >
            Set actor
          </button>
          <Child actor={actor} />
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const button = within(container).getByTestId('button')
      const stateEl = within(container).getByTestId('state')

      const observed: Array<string | null> = [stateEl.textContent]

      fireEvent.click(button)
      observed.push(stateEl.textContent)

      yield* expect(observed).toEqual(['undefined', '42'])
    } finally {
      unmount()
    }
  })

  it('should throw an error to an error boundary when the actor reaches an error state', function*({ expect }) {
    const errorMessage = 'test_useSelector_error'

    const machine = createMachine({
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: createAsyncLogic({
              run: () => Promise.reject(new Error(errorMessage)),
            }),
          },
        },
      },
    })

    class ErrorBoundary extends React.Component<
      { children: React.ReactNode },
      { error: Error | null }
    > {
      override state = { error: null as Error | null }
      static getDerivedStateFromError(error: Error) {
        return { error }
      }
      override render() {
        if (this.state.error) {
          return <div data-testid='error'>{this.state.error.message}</div>
        }
        return this.props.children
      }
    }

    const App = () => {
      const actorRef = useActorRef(machine)
      const value = useSelector(actorRef, (s) => s.value)
      return <div data-testid='value'>{String(value)}</div>
    }

    console.error = vi.fn()

    const { container, unmount } = render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    )

    try {
      const errorElement = yield* Effect.promise(() => within(container).findByTestId('error'))

      yield* expect(errorElement.textContent).toEqual(errorMessage)
    } finally {
      unmount()
      console.error = originalConsoleError
    }
  })
})
