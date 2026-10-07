import { it } from '@systemfsoftware/vitest'
import { type ActorRefFrom, createAsyncLogic, createLogic, createMachine } from '@systemfsoftware/xstate'
import { fireEvent, waitFor as testWaitFor, within } from '@testing-library/react'
import { Effect } from 'effect'
import * as React from 'react'
import { vi } from 'vitest'
import { z } from 'zod'
import { useActorRef, useMachine, useSelector } from '../src/index.js'
import { describeEachReactMode } from './utils.js'

describeEachReactMode('useActorRef (%s)', ({ suiteKey, render }) => {
  it('rebinds a stable observer before a replacement actor starts', function*({ expect }) {
    const first = createMachine({ on: { PING: {} } })
    const second = createMachine({ on: { PING: {} } })
    const observer = vi.fn()
    let ref: ActorRefFrom<typeof first>
    const App = ({ machine }: { machine: typeof first }) => {
      ref = useActorRef(machine, undefined, observer)
      return null
    }
    const { unmount, rerender } = render(<App machine={first} />)

    try {
      const original = ref!
      observer.mockClear()
      rerender(<App key='second' machine={second} />)

      const rerenderCalls = observer.mock.calls.map((call) => [...call])
      const rerenderSnapshot = ref!.getSnapshot()
      const replaced = ref! !== original

      observer.mockClear()
      ref!.send({ type: 'PING' })

      yield* expect({
        replaced,
        rerenderCalls,
        pingCalls: observer.mock.calls.map((call) => [...call]),
      }).toEqual({ replaced: true, rerenderCalls: [[rerenderSnapshot]], pingCalls: [[ref!.getSnapshot()]] })
    } finally {
      unmount()
    }
  })

  it('should accept events from effects when mounted in strict mode', function*({ expect }) {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let received = 0
    const machine = createMachine({
      actions: {
        record: () => {
          received++
        },
      },
      on: {
        INC: ({ actions }, enq) => enq(actions.record),
      },
    })

    const App = () => {
      const actorRef = useActorRef(machine)

      React.useEffect(() => {
        actorRef.send({ type: 'INC' })
      }, [actorRef])

      return null
    }

    const { unmount } = render(<App />)

    try {
      const warnedStopped = warnSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('was not delivered (stopped)'),
      )

      yield* expect({ warnedStopped, received }).toEqual({
        warnedStopped: false,
        received: suiteKey === 'strict' ? 2 : 1,
      })
    } finally {
      unmount()
      vi.restoreAllMocks()
    }
  })

  it('should still warn when sending to an actor after unmount', function*({ expect }) {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const machine = createMachine({})
    let actorRef: ActorRefFrom<typeof machine>

    const App = () => {
      actorRef = useActorRef(machine)
      return null
    }

    const { unmount } = render(<App />)

    try {
      unmount()
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)))

      actorRef!.send({ type: 'INC' })

      const warnedStopped = warnSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('was not delivered (stopped)'),
      )

      yield* expect({ warnedStopped }).toEqual({ warnedStopped: true })
    } finally {
      unmount()
      vi.restoreAllMocks()
    }
  })

  it('observer should be called with next state', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      initial: 'inactive',
      states: {
        inactive: {
          on: {
            ACTIVATE: { target: 'active' },
          },
        },
        active: {},
      },
    })

    let observedValue: unknown

    const App = () => {
      const actorRef = useActorRef(machine)

      React.useEffect(() => {
        actorRef.subscribe((state) => {
          observedValue = state.value
          if (state.matches('active')) {
            resolve()
          }
        })
      }, [actorRef])

      return (
        <button
          data-testid='button'
          onClick={() => {
            actorRef.send({ type: 'ACTIVATE' })
          }}
        >
        </button>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      fireEvent.click(within(container).getByTestId('button'))
      yield* Effect.promise(() => promise)

      yield* expect(observedValue).toEqual('active')
    } finally {
      unmount()
    }
  })

  it('actions created by a layout effect should access the latest closure values', function*({ expect }) {
    const actual: number[] = []

    const machine = createMachine({
      initial: 'foo',
      actions: {
        recordProp: () => {},
      },
      states: {
        foo: {
          on: {
            EXEC_ACTION: ({ actions }, enq) => enq(actions.recordProp),
          },
        },
      },
    })

    const App = ({ value }: { value: number }) => {
      const service = useActorRef(
        machine.provide({
          actions: {
            recordProp: () => actual.push(value),
          },
        }),
      )

      React.useLayoutEffect(() => {
        service.send({ type: 'EXEC_ACTION' })
      })

      return null
    }

    const { rerender, unmount } = render(<App value={1} />)

    try {
      const observed: number[][] = [actual.slice()]

      actual.length = 0
      rerender(<App value={42} />)

      observed.push(actual.slice())

      yield* expect(observed).toEqual([suiteKey === 'strict' ? [1, 1] : [1], [42]])
    } finally {
      unmount()
    }
  })

  it('should rerender OK when only the provided machine sources have changed', function*({ expect }) {
    const machine = createMachine({
      initial: 'foo',
      schemas: {
        context: z.object({
          id: z.number(),
        }),
      },
      guards: {
        hasOverflown: () => false,
      },
      context: { id: 1 },
      states: {
        foo: {
          on: {
            CHECK: ({ guards }) => {
              if (guards.hasOverflown()) {
                return {
                  target: 'bar',
                }
              }
              return undefined
            },
          },
        },
        bar: {},
      },
    })

    const App = () => {
      const [id, setId] = React.useState(1)
      useMachine(
        machine.provide({
          guards: {
            hasOverflown: (() => id > 1) as any,
          },
        }),
      )

      return (
        <>
          <button
            onClick={() => {
              setId(2)
            }}
          >
            update id
          </button>
          <span>{id}</span>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      fireEvent.click(within(container).getByRole('button'))

      yield* expect(within(container).getByText('2').textContent).toEqual('2')
    } finally {
      unmount()
    }
  })

  it('should change state when started', function*({ expect }) {
    const childMachine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            EVENT: { target: 'received' },
          },
        },
        received: {},
      },
    })

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childRef: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        childRef: spawn(childMachine),
      }),
      on: {
        SEND_TO_CHILD: ({ context }, enq) => {
          enq.sendTo(context.childRef, { type: 'EVENT' })
        },
      },
    })

    const App = () => {
      const parentActor = useActorRef(parentMachine)
      const parentState = useSelector(parentActor, (s) => s)
      const childState = useSelector(parentState.context.childRef, (s) => s)

      return (
        <>
          <button
            data-testid='button'
            onClick={() => parentActor.send({ type: 'SEND_TO_CHILD' })}
          >
            Send to child
          </button>
          <div data-testid='child-state'>{childState.value as string}</div>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const button = within(container).getByTestId('button')
      const childState = within(container).getByTestId('child-state')

      const observed: Array<string | null> = [childState.textContent]

      fireEvent.click(button)

      observed.push(childState.textContent)

      yield* expect(observed).toEqual(['waiting', 'received'])
    } finally {
      unmount()
    }
  })

  it('should change state when started (useMachine)', function*({ expect }) {
    const childMachine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            EVENT: { target: 'received' },
          },
        },
        received: {},
      },
    })

    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          childRef: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        childRef: spawn(childMachine),
      }),
      on: {
        SEND_TO_CHILD: ({ context }, enq) => {
          enq.sendTo(context.childRef, { type: 'EVENT' })
        },
      },
    })

    const App = () => {
      const [parentState, parentSend] = useMachine(parentMachine)
      const childState = useSelector(parentState.context.childRef, (s) => s)

      return (
        <>
          <button
            data-testid='button'
            onClick={() => parentSend({ type: 'SEND_TO_CHILD' })}
          >
            Send to child
          </button>
          <div data-testid='child-state'>{childState.value as string}</div>
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const button = within(container).getByTestId('button')
      const childState = within(container).getByTestId('child-state')

      const observed: Array<string | null> = [childState.textContent]

      fireEvent.click(button)

      observed.push(childState.textContent)

      yield* expect(observed).toEqual(['waiting', 'received'])
    } finally {
      unmount()
    }
  })

  it('should work with custom logic', function*({ expect }) {
    const someLogic = createLogic({
      context: 0,
      run: ({ context, event }) => {
        if (event.type === 'inc') {
          return { context: context + 1 }
        }
        return
      },
    })

    const App = () => {
      const actorRef = useActorRef(someLogic)
      const count = useSelector(actorRef, (state) => state)

      return (
        <div data-testid='count' onClick={() => actorRef.send({ type: 'inc' })}>
          {count.context}
        </div>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      const count = within(container).getByTestId('count')

      const observed: Array<string | null> = [count.textContent]

      fireEvent.click(count)

      observed.push(count.textContent)

      yield* expect(observed).toEqual(['0', '1'])
    } finally {
      unmount()
    }
  })

  it('should work with a promise actor', function*({ expect }) {
    const promiseLogic = createAsyncLogic({
      run: () => new Promise<number>((resolve) => setTimeout(() => resolve(42), 10)),
    })

    const App = () => {
      const actorRef = useActorRef(promiseLogic)
      const count = useSelector(actorRef, (state) => state)

      return <div data-testid='count'>{count.output}</div>
    }

    const { container, unmount } = render(<App />)

    try {
      const count = within(container).getByTestId('count')
      const initial = count.textContent

      yield* Effect.promise(() =>
        testWaitFor(() => {
          if (count.textContent !== '42') {
            throw new Error(`promise actor output not rendered: ${String(count.textContent)}`)
          }
        })
      )

      yield* expect({ initial, final: count.textContent }).toEqual({ initial: '', final: '42' })
    } finally {
      unmount()
    }
  })

  it('should switch to a new machine when the component key changes', function*({ expect }) {
    const machine1 = createMachine({
      initial: 'a',
      states: { a: {} },
    })

    const machine2 = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {},
      },
    })

    function Test({ machine }: { machine: typeof machine2 }) {
      const actorRef = useActorRef(machine)
      const value = useSelector(actorRef, (state) => state.value)

      return (
        <>
          <button
            type='button'
            onClick={() => {
              actorRef.send({
                type: 'NEXT',
              })
            }}
          >
            Send event
          </button>
          <span>{value as string}</span>
        </>
      )
    }

    function App() {
      const [machine, setMachine] = React.useState(machine1)
      return (
        <>
          <button
            type='button'
            onClick={() => {
              setMachine(machine2 as any)
            }}
          >
            Reload machine
          </button>
          <Test
            key={machine === machine1 ? 'one' : 'two'}
            machine={machine as any}
          />
        </>
      )
    }

    const { container, unmount } = render(<App />)

    try {
      fireEvent.click(within(container).getByText('Reload machine'))
      fireEvent.click(within(container).getByText('Send event'))

      yield* expect(within(container).getByText('b').textContent).toEqual('b')
    } finally {
      unmount()
    }
  })

  it('should keep the first machine when a different machine is passed later', function*({ expect }) {
    const machine1 = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {},
      },
    })

    const machine2 = createMachine({
      initial: 'b',
      states: {
        b: {
          on: { NEXT: { target: 'c' } },
        },
        c: {},
      },
    })

    const refs = new Set<unknown>()

    function Test() {
      const [machine, setMachine] = React.useState(machine1)
      const actorRef = useActorRef(machine)
      refs.add(actorRef)
      const value = useSelector(actorRef, (state) => state.value)

      return (
        <>
          <button
            type='button'
            onClick={() => {
              setMachine(machine2 as any)
            }}
          >
            Reload machine
          </button>
          <button
            type='button'
            onClick={() => {
              actorRef.send({
                type: 'NEXT',
              })
            }}
          >
            Send event
          </button>
          <span>{value as string}</span>
        </>
      )
    }

    const { container, unmount } = render(<Test />)

    try {
      fireEvent.click(within(container).getByText('Send event'))
      fireEvent.click(within(container).getByText('Reload machine'))
      fireEvent.click(within(container).getByText('Send event'))

      yield* expect({ text: within(container).getByText('b').textContent, refs: refs.size }).toEqual({
        text: 'b',
        refs: 1,
      })
    } finally {
      unmount()
    }
  })

  it('should not loop or reset state when a machine factory is called on every render', function*({ expect }) {
    let renders = 0

    function Test() {
      renders++
      const [snapshot, send] = useMachine(
        createMachine({
          context: { count: 0 },
          on: {
            INC: ({ context }) => ({
              context: { count: context.count + 1 },
            }),
          },
        }),
      )

      return (
        <button type='button' onClick={() => send({ type: 'INC' })}>
          {snapshot.context.count}
        </button>
      )
    }

    const { container, unmount } = render(<Test />)

    try {
      const button = within(container).getByRole('button')

      fireEvent.click(button)
      fireEvent.click(button)
      fireEvent.click(button)

      yield* expect({ text: button.textContent, renders }).toSatisfy(
        (observed) => observed.text === '3' && observed.renders < 20,
        'the button shows the third count and the machine factory re-renders fewer than 20 times',
      )
    } finally {
      unmount()
    }
  })

  it(
    "should execute action bound to a specific machine's instance when the action is provided in render",
    function*({ expect }) {
      const spy1 = vi.fn()
      const spy2 = vi.fn()

      const machine = createMachine({
        actions: {
          stuff: spy1,
        },
        on: {
          DO: ({ actions }, enq) => enq(actions.stuff),
        },
      })

      const Test = () => {
        const actorRef1 = useActorRef(
          machine.provide({
            actions: {
              stuff: spy1,
            },
          }),
        )
        useActorRef(
          machine.provide({
            actions: {
              stuff: spy2,
            },
          }),
        )

        return (
          <button
            type='button'
            onClick={() => {
              actorRef1.send({
                type: 'DO',
              })
            }}
          >
            Click
          </button>
        )
      }

      const { container, unmount } = render(<Test />)

      try {
        within(container).getByRole('button').click()

        yield* expect({ spy1Calls: spy1.mock.calls.length, spy2Calls: spy2.mock.calls.length }).toEqual({
          spy1Calls: 1,
          spy2Calls: 0,
        })
      } finally {
        unmount()
      }
    },
  )
})
