import { it, vi } from '@systemfsoftware/vitest'
import {
  Actor,
  createActor,
  createMachine,
  type Observer,
  type Snapshot,
  type SnapshotFrom,
  type Subscribable,
  type Subscription,
} from '@systemfsoftware/xstate'
import { createAsyncLogic, createCallbackLogic, createObservableLogic } from '@systemfsoftware/xstate'
import { act, fireEvent, within } from '@testing-library/react'
import { Effect } from 'effect'
import * as React from 'react'
import { useState } from 'react'
import { BehaviorSubject, type Observable } from 'rxjs'
import z from 'zod'
import { useActor, useSelector } from '../src/index.js'
import { describeEachReactMode } from './utils.js'

function toSubscribable<T>(source: Observable<T>): Subscribable<T> {
  return {
    subscribe(
      observerOrNext: Observer<T> | ((value: T) => void),
      error?: (error: unknown) => void,
      complete?: () => void,
    ): Subscription {
      if (typeof observerOrNext === 'function') {
        return source.subscribe(observerOrNext, error, complete)
      }
      return source.subscribe(
        (value) => observerOrNext.next?.(value),
        (err) => observerOrNext.error?.(err),
        () => observerOrNext.complete?.(),
      )
    },
  }
}

describeEachReactMode('useActor (%s)', ({ render }) => {
  const fetchMachine = createMachine({
    id: 'fetch',
    schemas: {
      context: z.object({
        data: z.string().optional(),
      }),
      events: z.object({
        type: z.literal('FETCH'),
      }) as any,
    },
    actors: {
      fetchData: createMachine({}),
    },
    initial: 'idle',
    context: {
      data: undefined as undefined | string,
    },
    states: {
      idle: {
        on: { FETCH: { target: 'loading' } },
      },
      loading: {
        invoke: {
          id: 'fetchData',
          src: ({ actors }: any) => actors.fetchData,
          onDone: ({ event }: any) => {
            if ((event.output as any).length > 0) {
              return {
                context: {
                  data: event.output,
                },
                target: 'success',
              }
            }
            return undefined
          },
        } as any,
      },
      success: {
        type: 'final',
      },
    },
  })

  const actorRef = createActor(
    fetchMachine.provide({
      actors: {
        fetchData: createMachine({
          initial: 'done',
          states: {
            done: {
              type: 'final',
            },
          },
          output: 'persisted data',
        }) as any,
      },
    }),
  ).start()
  actorRef.send({ type: 'FETCH' })

  const persistedSuccessFetchState = actorRef.getPersistedSnapshot()

  const Fetcher: React.FC<{
    onFetch: () => Promise<any>
    persistedState?: Snapshot<unknown>
  }> = ({
    onFetch = () => {
      return Promise.resolve('some data')
    },
    persistedState,
  }) => {
    const [current, send] = useActor(
      fetchMachine.provide({
        actors: {
          fetchData: createAsyncLogic({ run: onFetch }) as any,
        },
      }),
      {
        ...(persistedState === undefined ? {} : { snapshot: persistedState }),
      },
    )

    switch (current.value) {
      case 'idle':
        return <button onClick={(_) => send({ type: 'FETCH' })}>Fetch</button>
      case 'loading':
        return <div>Loading...</div>
      case 'success':
        return (
          <div>
            Success! Data: <div data-testid='data'>{current.context.data}</div>
          </div>
        )
      default:
        return null
    }
  }

  it('should work with the useActor hook', function*({ expect }) {
    const { container, unmount } = render(<Fetcher onFetch={() => Promise.resolve('fake data')} />)
    const view = within(container)
    try {
      const button = view.getByText('Fetch')
      yield* Effect.sync(() => fireEvent.click(button))
      yield* expect(view.getByText('Loading...').textContent).toBe('Loading...')
      yield* Effect.promise(() => view.findByText(/Success/))
      const dataEl = view.getByTestId('data')
      yield* expect(dataEl.textContent).toBe('fake data')
    } finally {
      unmount()
    }
  })

  it('should work with the useActor hook (rehydrated state)', function*({ expect }) {
    const { container, unmount } = render(
      <Fetcher
        onFetch={() => Promise.resolve('fake data')}
        persistedState={persistedSuccessFetchState}
      />,
    )
    const view = within(container)
    try {
      yield* Effect.promise(() => view.findByText(/Success/))
      const dataEl = view.getByTestId('data')
      yield* expect(dataEl.textContent).toBe('persisted data')
    } finally {
      unmount()
    }
  })

  it('should work with the useMachine hook (rehydrated state config)', function*({ expect }) {
    const persistedFetchStateConfig = JSON.parse(
      JSON.stringify(persistedSuccessFetchState),
    )
    const { container, unmount } = render(
      <Fetcher
        onFetch={() => Promise.resolve('fake data')}
        persistedState={persistedFetchStateConfig}
      />,
    )
    const view = within(container)
    try {
      yield* Effect.promise(() => view.findByText(/Success/))
      const dataEl = view.getByTestId('data')
      yield* expect(dataEl.textContent).toBe('persisted data')
    } finally {
      unmount()
    }
  })

  it('should provide the service', function*({ expect }) {
    let service: unknown

    const Test = () => {
      const [, , observed] = useActor(fetchMachine)
      service = observed
      return null
    }

    const { unmount } = render(<Test />)
    try {
      yield* expect(service).toSatisfy(
        (observed) => observed instanceof Actor,
        'the third value useActor returns is an Actor instance',
      )
    } finally {
      unmount()
    }
  })

  it('should accept input and provide it to the context factory', function*({ expect }) {
    const testMachine = createMachine({
      context: (({ input }: any) => ({
        foo: 'bar',
        test: input.test ?? false,
      })) as any,
      initial: 'idle',
      states: {
        idle: {},
      },
    })

    let observedContext: unknown

    const Test = () => {
      const [state] = useActor(testMachine, {
        input: { test: true },
      })

      observedContext = state.context

      return null
    }

    const { unmount } = render(<Test />)
    try {
      yield* expect(observedContext).toEqual({
        foo: 'bar',
        test: true,
      })
    } finally {
      unmount()
    }
  })

  it('should not spawn actors until service is started', function*({ expect }) {
    const spawnMachine = createMachine({
      id: 'spawn',
      initial: 'start',
      context: { ref: undefined } as any,
      states: {
        start: {
          entry: (_, enq) => ({
            context: {
              ref: enq.spawn(
                createAsyncLogic({
                  run: () => {
                    return Promise.resolve(42)
                  },
                }),
                { id: 'my-promise' },
              ),
            },
          }),
          on: {
            'xstate.done.actor.my-promise': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const Spawner = () => {
      const [current] = useActor(spawnMachine)

      switch (current.value) {
        case 'start':
          return <span data-testid='start' />
        case 'success':
          return <span data-testid='success' />
        default:
          return null
      }
    }

    const { container, unmount } = render(<Spawner />)
    const view = within(container)
    try {
      yield* Effect.promise(() => view.findByTestId('success'))
      yield* expect(view.getByTestId('success').tagName).toBe('SPAN')
    } finally {
      unmount()
    }
  })

  it('actions should not use stale data in a builtin transition action', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()

    const toggleMachine = createMachine({
      context: {
        latest: 0,
      } as any,
      actions: {
        getLatest: () => {},
      },
      on: {
        SET_LATEST: ({ actions }, enq) => {
          enq(actions.getLatest)
        },
      },
    })

    let observedCount: number | undefined

    const Component = () => {
      const [count, setCount] = useState(1)

      const [, send] = useActor(
        toggleMachine.provide({
          actions: {
            getLatest: () => {
              observedCount = count
              resolve()
            },
          },
        }),
      )

      return (
        <>
          <button
            data-testid='extbutton'
            onClick={(_) => {
              setCount(2)
            }}
          />
          <button
            data-testid='button'
            onClick={(_) => {
              send({ type: 'SET_LATEST' })
            }}
          />
        </>
      )
    }

    const { container, unmount } = render(<Component />)
    const view = within(container)
    try {
      const button = view.getByTestId('button')
      const extButton = view.getByTestId('extbutton')
      yield* Effect.sync(() => fireEvent.click(extButton))

      yield* Effect.sync(() => fireEvent.click(button))

      yield* Effect.promise(() => promise)
      yield* expect(observedCount).toBe(2)
    } finally {
      unmount()
    }
  })

  it('actions should not use stale data in a builtin entry action', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()

    const toggleMachine = createMachine({
      actions: {
        getLatest: () => {},
      },
      context: {
        latest: 0,
      } as any,
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          entry: ({ actions }, enq) => {
            enq(actions.getLatest)
          },
        },
      },
    })

    let observedCount: number | undefined

    const Component = () => {
      const [count, setCount] = useState(1)

      const [, send] = useActor(
        toggleMachine.provide({
          actions: {
            getLatest: () => {
              observedCount = count
              resolve()
            },
          },
        }),
      )

      return (
        <>
          <button
            data-testid='extbutton'
            onClick={(_) => {
              setCount(2)
            }}
          />
          <button
            data-testid='button'
            onClick={(_) => {
              send({ type: 'NEXT' })
            }}
          />
        </>
      )
    }

    const { container, unmount } = render(<Component />)
    const view = within(container)
    try {
      const button = view.getByTestId('button')
      const extButton = view.getByTestId('extbutton')
      yield* Effect.sync(() => fireEvent.click(extButton))

      yield* Effect.sync(() => fireEvent.click(button))

      yield* Effect.promise(() => promise)
      yield* expect(observedCount).toBe(2)
    } finally {
      unmount()
    }
  })

  it('actions should not use stale data in a custom entry action', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()

    const toggleMachine = createMachine({
      schemas: {
        events: z.object({
          type: z.literal('TOGGLE'),
        }) as any,
      },
      actions: {
        doAction: () => {},
      },
      initial: 'inactive',
      states: {
        inactive: {
          on: { TOGGLE: { target: 'active' } },
        },
        active: {
          entry: ({ actions }, enq) => {
            enq(actions.doAction)
          },
        },
      },
    })

    let observedExt: boolean | undefined

    const Toggle = () => {
      const [ext, setExt] = useState(false)

      const doAction = React.useCallback(() => {
        observedExt = ext
        resolve()
      }, [ext])

      const [, send] = useActor(
        toggleMachine.provide({
          actions: {
            doAction,
          },
        }),
      )

      return (
        <>
          <button
            data-testid='extbutton'
            onClick={(_) => {
              setExt(true)
            }}
          />
          <button
            data-testid='button'
            onClick={(_) => {
              send({ type: 'TOGGLE' })
            }}
          />
        </>
      )
    }

    const { container, unmount } = render(<Toggle />)
    const view = within(container)
    try {
      const button = view.getByTestId('button')
      const extButton = view.getByTestId('extbutton')
      yield* Effect.sync(() => fireEvent.click(extButton))

      yield* Effect.sync(() => fireEvent.click(button))

      yield* Effect.promise(() => promise)
      yield* expect({ observedExt }).toEqual({ observedExt: true })
    } finally {
      unmount()
    }
  })

  it('should successfully spawn actors from the lazily declared context', function*({ expect }) {
    let childSpawned = false

    const machine = createMachine({
      context: ({ spawn }) => ({
        ref: spawn(
          createCallbackLogic(() => {
            childSpawned = true
          }),
        ),
      }),
    })

    const App = () => {
      useActor(machine)
      return null
    }

    const { unmount } = render(<App />)
    try {
      yield* expect({ childSpawned }).toEqual({ childSpawned: true })
    } finally {
      unmount()
    }
  })

  it('should be able to use an action provided outside of React', function*({ expect }) {
    let actionCalled = false

    const machine = createMachine({
      on: {
        EV: (_, enq) => {
          enq(() => (actionCalled = true))
        },
      },
    })

    const App = () => {
      const [_state, send] = useActor(machine)
      React.useEffect(() => {
        send({ type: 'EV' })
      }, [])
      return null
    }

    const { unmount } = render(<App />)
    try {
      yield* expect({ actionCalled }).toEqual({ actionCalled: true })
    } finally {
      unmount()
    }
  })

  it('should be able to use a guard provided outside of React', function*({ expect }) {
    let guardCalled = false

    const machine = createMachine({
      initial: 'a',
      guards: {
        isAwesome: () => true,
      },
      states: {
        a: {
          on: {
            EV: ({ guards }) => {
              if (guards.isAwesome()) {
                return {
                  target: 'b',
                }
              }
              return undefined
            },
          },
        },
        b: {},
      },
    }).provide({
      guards: {
        isAwesome: () => {
          guardCalled = true
          return true
        },
      },
    })

    const App = () => {
      const [_state, send] = useActor(machine)
      React.useEffect(() => {
        send({ type: 'EV' })
      }, [])
      return null
    }

    const { unmount } = render(<App />)
    try {
      yield* expect({ guardCalled }).toEqual({ guardCalled: true })
    } finally {
      unmount()
    }
  })

  it('should be able to use a service provided outside of React', function*({ expect }) {
    let serviceCalled = false

    const machine = createMachine({
      actors: {
        foo: createAsyncLogic({
          run: () => {
            serviceCalled = true
            return Promise.resolve()
          },
        }),
      },
      initial: 'a',
      states: {
        a: {
          on: {
            EV: { target: 'b' },
          },
        },
        b: {
          invoke: {
            src: ({ actors }) => actors.foo,
          },
        },
      },
    })

    const App = () => {
      const [_state, send] = useActor(machine)
      React.useEffect(() => {
        send({ type: 'EV' })
      }, [])
      return null
    }

    const { unmount } = render(<App />)
    try {
      yield* expect({ serviceCalled }).toEqual({ serviceCalled: true })
    } finally {
      unmount()
    }
  })

  it('should be able to use a delay provided outside of React', function*({ expect }) {
    vi.useFakeTimers()
    let unmount: (() => void) | undefined

    try {
      const machine = createMachine({
        delays: {
          myDelay: () => {
            return 300
          },
        },
        initial: 'a',
        states: {
          a: {
            on: {
              EV: { target: 'b' },
            },
          },
          b: {
            after: {
              myDelay: { target: 'c' },
            },
          },
          c: {},
        },
      })

      const App = () => {
        const [state, send] = useActor(machine)
        return (
          <>
            <div data-testid='result'>{state.value as any}</div>
            <button onClick={() => send({ type: 'EV' })} />
          </>
        )
      }

      const rendered = render(<App />)
      unmount = rendered.unmount
      const view = within(rendered.container)

      const btn = view.getByRole('button')
      yield* Effect.sync(() => fireEvent.click(btn))

      yield* expect(view.getByTestId('result').textContent).toBe('b')

      yield* Effect.sync(() => {
        act(() => vi.advanceTimersByTime(310))
      })

      yield* expect(view.getByTestId('result').textContent).toBe('c')
    } finally {
      unmount?.()
      vi.useRealTimers()
    }
  })

  it('should not use stale data in a guard', function*({ expect }) {
    const machine = createMachine({
      guards: {
        isAwesome: () => false,
      },
      initial: 'a',
      states: {
        a: {
          on: {
            EV: ({ guards }) => {
              if (guards.isAwesome()) {
                return {
                  target: 'b',
                }
              }
              return undefined
            },
          },
        },
        b: {},
      },
    })

    const App = ({ isAwesome }: { isAwesome: boolean }) => {
      const [state, send] = useActor(
        machine.provide({
          guards: {
            isAwesome: (() => isAwesome) as any,
          },
        }),
      )
      return (
        <>
          <div data-testid='result'>{state.value as any}</div>
          <button onClick={() => send({ type: 'EV' })} />
        </>
      )
    }

    const { container, rerender, unmount } = render(<App isAwesome={false} />)
    const view = within(container)
    try {
      rerender(<App isAwesome={true} />)

      const btn = view.getByRole('button')
      fireEvent.click(btn)

      yield* expect(view.getByTestId('result').textContent).toBe('b')
    } finally {
      unmount()
    }
  })

  it('custom data should be available right away for the invoked actor', function*({ expect }) {
    const childMachine = createMachine({
      schemas: {
        context: z.object({
          value: z.number(),
        }),
        input: z.object({
          value: z.number(),
        }),
      },
      initial: 'initial',
      context: ({ input }) => {
        return {
          value: input.value,
        }
      },
      states: {
        initial: {},
      },
    })

    const machine = createMachine({
      actors: {
        child: childMachine,
      },
      initial: 'active',
      states: {
        active: {
          invoke: {
            src: ({ actors }: any) => actors.child,
            id: 'test',
            input: { value: 42 },
          } as any,
        },
      },
    })

    let observedValue: unknown

    const Test = () => {
      const [state] = useActor(machine)
      const childState = useSelector(state.children['test']!, (s) => s)

      observedValue = childState.context.value

      return null
    }

    const { unmount } = render(<Test />)
    try {
      yield* expect(observedValue).toBe(42)
    } finally {
      unmount()
    }
  })

  it('delayed transitions should work when initializing from a rehydrated state', function*({ expect }) {
    vi.useFakeTimers()
    let unmount: (() => void) | undefined

    try {
      const testMachine = createMachine({
        schemas: {
          events: z.object({
            type: z.literal('START'),
          }) as any,
        },
        id: 'app',
        initial: 'idle',
        states: {
          idle: {
            on: {
              START: { target: 'doingStuff' },
            },
          },
          doingStuff: {
            id: 'doingStuff',
            after: {
              100: { target: 'idle' },
            },
          },
        },
      })

      const actorRef = createActor(testMachine).start()
      const persistedState = JSON.stringify(actorRef.getPersistedSnapshot())
      actorRef.stop()

      let currentState: SnapshotFrom<typeof testMachine>

      const Test = () => {
        const [state, send] = useActor(testMachine, {
          snapshot: JSON.parse(persistedState),
        })

        currentState = state

        return (
          <button
            onClick={() => send({ type: 'START' })}
            data-testid='button'
          >
          </button>
        )
      }

      const rendered = render(<Test />)
      unmount = rendered.unmount
      const view = within(rendered.container)

      const button = view.getByTestId('button')

      fireEvent.click(button)
      act(() => {
        vi.advanceTimersByTime(110)
      })

      yield* expect(currentState!.value).toBe('idle')
    } finally {
      unmount?.()
      vi.useRealTimers()
    }
  })

  it('should not miss initial synchronous updates', function*({ expect }) {
    const m = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'idle',
      context: {
        count: 0,
      },
      entry: (_, enq) => {
        enq.raise({ type: 'INC' })
        return {
          context: {
            count: 1,
          },
        }
      },
      on: {
        INC: ({ context }, enq) => {
          enq.raise({ type: 'UNHANDLED' })
          return {
            context: {
              count: context.count + 1,
            },
          }
        },
      },
      states: {
        idle: {},
      },
    })

    const App = () => {
      const [state] = useActor(m)
      return <>{state.context.count}</>
    }

    const { container, unmount } = render(<App />)
    try {
      yield* expect(container.textContent).toBe('2')
    } finally {
      unmount()
    }
  })

  it('should work with `onSnapshot`', function*({ expect }) {
    const subject = new BehaviorSubject(0)

    const spy = vi.fn()

    const machine = createMachine({
      invoke: {
        src: createObservableLogic<number, undefined>(() => toSubscribable(subject)),
        onSnapshot: ({ event }) => {
          spy((event.snapshot as any).context)
        },
      },
    })

    const App = () => {
      useActor(machine)
      return null
    }

    const { unmount } = render(<App />)
    try {
      spy.mockClear()

      subject.next(42)
      subject.next(100)

      yield* expect(spy.mock.calls).toEqual([[42], [100]])
    } finally {
      unmount()
    }
  })

  it('should execute a delayed transition of the initial state', function*({ expect }) {
    vi.useFakeTimers()
    let unmount: (() => void) | undefined

    try {
      const machine = createMachine({
        initial: 'one',
        states: {
          one: {
            after: {
              10: { target: 'two' },
            },
          },
          two: {},
        },
      })

      const App = () => {
        const [state] = useActor(machine)
        return <>{state.value}</>
      }

      const rendered = render(<App />)
      unmount = rendered.unmount

      yield* expect(rendered.container.textContent).toEqual('one')

      yield* Effect.sync(() => {
        act(() => vi.advanceTimersByTime(10))
      })

      yield* expect(rendered.container.textContent).toEqual('two')
    } finally {
      unmount?.()
      vi.useRealTimers()
    }
  })

  it('should throw an error to an error boundary when the actor reaches an error state', function*({ expect }) {
    const errorMessage = 'test_useActor_error'

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
      const [state] = useActor(machine)
      return <div data-testid='value'>{String(state.value)}</div>
    }

    console.error = vi.fn()

    const { container, unmount } = render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>,
    )
    const view = within(container)
    try {
      yield* Effect.promise(() => view.findByTestId('error'))
      yield* expect(view.getByTestId('error').textContent).toEqual(errorMessage)
    } finally {
      unmount()
    }
  })
})
