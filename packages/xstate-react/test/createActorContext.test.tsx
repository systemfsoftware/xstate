import { describe, vi } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, type InspectionEvent, type Snapshot } from '@systemfsoftware/xstate'
import { fireEvent, render, type RenderResult, waitFor, within } from '@testing-library/react'
import { Effect } from 'effect'
import { z } from 'zod'
import { createActorContext, shallowEqual, useSelector } from '../src/index.js'

const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

describe('createActorContext', (it) => {
  it('should work with useSelector', function*({ expect }) {
    const { container, unmount } = render(
      <App1 />,
    )
    try {
      yield* expect(within(container).getByTestId('value').textContent).toBe('a')
    } finally {
      unmount()
    }
  })

  it('the actor should be able to receive events', function*({ expect }) {
    const { container, unmount } = render(<ReceiveEventsApp />)
    try {
      const view = within(container)
      yield* expect(view.getByTestId('value').textContent).toBe('a')

      yield* Effect.sync(() => fireEvent.click(view.getByTestId('next')))

      yield* expect(view.getByTestId('value').textContent).toBe('b')
    } finally {
      unmount()
    }
  })

  it('should work with useSelector and a custom comparator', function*({ expect }) {
    const rerenders = { value: 0 }
    const { container, unmount } = render(<ComparatorApp rerenders={rerenders} />)
    try {
      const view = within(container)
      yield* expect({
        value: view.getByTestId('value').textContent,
        rerenders: rerenders.value,
      }).toEqual({ value: '0', rerenders: 1 })

      yield* Effect.sync(() => fireEvent.click(view.getByText('Inc')))

      yield* expect({
        value: view.getByTestId('value').textContent,
        rerenders: rerenders.value,
      }).toEqual({ value: '1', rerenders: 2 })

      yield* Effect.sync(() => fireEvent.click(view.getByText('Push')))

      yield* expect(rerenders.value).toBe(2)

      yield* Effect.sync(() => fireEvent.click(view.getByText('Inc')))

      yield* expect({
        value: view.getByTestId('value').textContent,
        rerenders: rerenders.value,
      }).toEqual({ value: '2', rerenders: 3 })
    } finally {
      unmount()
    }
  })

  it('should work with useActorRef', function*({ expect }) {
    const { container, unmount } = render(<UseActorRefApp />)
    try {
      yield* expect(within(container).getByTestId('value').textContent).toBe('a')
    } finally {
      unmount()
    }
  })

  it('should work with a provided machine', function*({ expect }) {
    const { container, unmount } = render(<ProvidedMachineApp />)
    try {
      yield* expect(within(container).getByTestId('value').textContent).toBe('42')
    } finally {
      unmount()
    }
  })

  it('useActorRef should throw when the actor was not provided', function*({ expect }) {
    const SomeContext = createActorContext(createMachine({}))

    const App = () => {
      SomeContext.useActorRef()
      return null
    }

    const error = thrownBy(() => render(<App />))

    yield* expect(
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: typeof error, message: 'no error was thrown' },
    ).toEqual({
      name: 'Error',
      message: 'You used a hook from "ActorProvider" but it\'s not inside a <ActorProvider> component.',
    })
  })

  it('useSelector should throw when the actor was not provided', function*({ expect }) {
    const SomeContext = createActorContext(createMachine({}))

    const App = () => {
      SomeContext.useSelector((a) => a)
      return null
    }

    const error = thrownBy(() => render(<App />))

    yield* expect(
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: typeof error, message: 'no error was thrown' },
    ).toEqual({
      name: 'Error',
      message: 'You used a hook from "ActorProvider" but it\'s not inside a <ActorProvider> component.',
    })
  })

  it('should be able to pass interpreter options to the provider', function*({ expect }) {
    const stub = vi.fn()
    const { unmount } = render(<InterpreterOptionsApp stub={stub} />)
    try {
      yield* expect(stub.mock.calls).toEqual([[]])
    } finally {
      unmount()
    }
  })

  it('should work with other types of logic', function*({ expect }) {
    const { container, unmount } = render(<AsyncLogicApp />)
    try {
      const view = within(container)
      yield* Effect.promise(() => waitFor(() => view.getByTestId('value').textContent === '42'))

      yield* expect(view.getByTestId('value').textContent).toBe('42')
    } finally {
      unmount()
    }
  })

  it("should preserve machine's identity when swapping options using in-render `.provide`", function*({ expect }) {
    const { container, unmount } = render(<IdentityApp />)
    try {
      const view = within(container)
      yield* expect(view.getByTestId('count').textContent).toBe('0')

      yield* Effect.sync(() => fireEvent.click(view.getByTestId('button')))

      yield* expect(view.getByTestId('count').textContent).toBe('1')

      yield* Effect.sync(() => fireEvent.click(view.getByTestId('button')))

      yield* expect(view.getByTestId('count').textContent).toBe('2')
    } finally {
      unmount()
    }
  })

  it('options can be passed to the provider', function*({ expect }) {
    const persistedState: { value: Snapshot<unknown> | undefined } = { value: undefined }
    const first = render(<OptionsApp persistedState={persistedState} />)
    let second: RenderResult | undefined
    try {
      const firstView = within(first.container)
      yield* expect(firstView.getByTestId('value').textContent).toBe('a')

      yield* Effect.sync(() => fireEvent.click(firstView.getByTestId('value')))

      yield* expect(firstView.getByTestId('value').textContent).toBe('b')

      yield* Effect.sync(() => {
        first.unmount()
        second = render(<OptionsApp persistedState={persistedState} />)
      })

      yield* expect(within(second!.container).getByTestId('value').textContent).toBe('b')
    } finally {
      second ? second.unmount() : first.unmount()
    }
  })

  it('input can be passed to the provider', function*({ expect }) {
    const { container, unmount } = render(<InputApp />)
    try {
      yield* expect(within(container).getByTestId('value').textContent).toBe('84')
    } finally {
      unmount()
    }
  })

  it('should merge createActorContext options with options passed to the provider', function*({ expect }) {
    const events: InspectionEvent[] = []
    const { unmount } = render(<MergeOptionsApp events={events} />)
    try {
      yield* expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            snapshot: expect.objectContaining({ context: { count: 10 } }),
          }),
        ]),
      )
    } finally {
      unmount()
    }
  })
})

const App1 = () => {
  const someMachine = createMachine({
    initial: 'a',
    states: { a: {} },
  })

  const SomeContext = createActorContext(someMachine)

  const Component = () => {
    const value = SomeContext.useSelector((state) => state.value as string)

    return <div data-testid='value'>{value}</div>
  }

  return (
    <SomeContext.Provider>
      <Component />
    </SomeContext.Provider>
  )
}

const ReceiveEventsApp = () => {
  const someMachine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: {
          NEXT: { target: 'b' },
        },
      },
      b: {},
    },
  })

  const SomeContext = createActorContext(someMachine)

  const Component = () => {
    const actorRef = SomeContext.useActorRef()
    const state = SomeContext.useSelector((s) => s)

    return (
      <>
        <div data-testid='value'>{state.value as string}</div>
        <button
          data-testid='next'
          onClick={() => actorRef.send({ type: 'NEXT' })}
        >
          Next
        </button>
      </>
    )
  }

  return (
    <SomeContext.Provider>
      <Component />
    </SomeContext.Provider>
  )
}

const ComparatorApp = ({ rerenders }: { rerenders: { value: number } }) => {
  const someMachine = createMachine({
    schemas: {
      context: z.object({
        obj: z.object({
          counter: z.number(),
        }),
        arr: z.array(z.string()),
      }),
    },
    context: {
      obj: {
        counter: 0,
      },
      arr: [] as string[],
    },
    on: {
      INC: ({ context }) => ({
        context: {
          obj: {
            counter: context.obj.counter + 1,
          },
        },
      }),
      PUSH: ({ context }) => ({
        context: {
          arr: [...context.arr, Math.random().toString(36).slice(2)],
        },
      }),
    },
  })

  const SomeContext = createActorContext(someMachine)

  const Component = () => {
    const actor = SomeContext.useActorRef()
    const value = SomeContext.useSelector(
      (state) => state.context.obj,
      shallowEqual,
    )

    rerenders.value += 1

    return (
      <>
        <button onClick={() => actor.send({ type: 'INC' })}>Inc</button>
        <button onClick={() => actor.send({ type: 'PUSH' })}>Push</button>
        <div data-testid='value'>{value.counter}</div>;
      </>
    )
  }

  return (
    <SomeContext.Provider>
      <Component />
    </SomeContext.Provider>
  )
}

const UseActorRefApp = () => {
  const someMachine = createMachine({
    initial: 'a',
    states: { a: {} },
  })

  const SomeContext = createActorContext(someMachine)

  const Component = () => {
    const actor = SomeContext.useActorRef()
    const value = useSelector(actor, (state) => state.value)

    return <div data-testid='value'>{value as string}</div>
  }

  return (
    <SomeContext.Provider>
      <Component />
    </SomeContext.Provider>
  )
}

const ProvidedMachineApp = () => {
  const createSomeMachine = (context: { count: number }) =>
    createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context,
    })

  const SomeContext = createActorContext(createSomeMachine({ count: 0 }))

  const Component = () => {
    const actor = SomeContext.useActorRef()
    const count = useSelector(actor, (state) => state.context.count)

    return <div data-testid='value'>{count}</div>
  }

  const otherMachine = createSomeMachine({ count: 42 })

  return (
    <SomeContext.Provider logic={otherMachine}>
      <Component />
    </SomeContext.Provider>
  )
}

const InterpreterOptionsApp = ({ stub }: { stub: () => void }) => {
  const someMachine = createMachine({
    initial: 'a',
    actions: {
      testAction: () => {},
    },
    states: {
      a: {
        entry: ({ actions }, enq) => {
          enq(actions.testAction)
        },
      },
    },
  })
  const SomeContext = createActorContext(someMachine)

  const Component = () => {
    return null
  }

  return (
    <SomeContext.Provider
      logic={someMachine.provide({
        actions: {
          testAction: stub,
        },
      }) as any}
    >
      <Component />
    </SomeContext.Provider>
  )
}

const AsyncLogicApp = () => {
  const PromiseContext = createActorContext(
    createAsyncLogic({ run: () => Promise.resolve(42) }),
  )

  const Component = () => {
    const value = PromiseContext.useSelector((data) => data)

    return <div data-testid='value'>{value.output}</div>
  }

  return (
    <PromiseContext.Provider>
      <Component />
    </PromiseContext.Provider>
  )
}

const IdentityApp = () => {
  const someMachine = createMachine({
    schemas: {
      context: z.object({
        count: z.number(),
      }),
    },
    context: { count: 0 },
    on: {
      inc: ({ context }) => ({
        context: {
          count: context.count + 1,
        },
      }),
    },
  })
  const SomeContext = createActorContext(someMachine)

  const Component = () => {
    const { send } = SomeContext.useActorRef()
    const count = SomeContext.useSelector((state) => state.context.count)
    return (
      <>
        <span data-testid='count'>{count}</span>
        <button data-testid='button' onClick={() => send({ type: 'inc' })}>
          Inc
        </button>
      </>
    )
  }

  return (
    <SomeContext.Provider
      logic={someMachine.provide({
        actions: {
          testAction: vi.fn(),
        },
      }) as any}
    >
      <Component />
    </SomeContext.Provider>
  )
}

const OptionsApp = ({ persistedState }: { persistedState: { value: Snapshot<unknown> | undefined } }) => {
  const machine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: {
          next: { target: 'b' },
        },
      },
      b: {},
    },
  })
  const SomeContext = createActorContext(machine)

  const Component = () => {
    const actorRef = SomeContext.useActorRef()
    const state = SomeContext.useSelector((state) => state)

    persistedState.value = actorRef.getPersistedSnapshot()

    return (
      <div
        data-testid='value'
        onClick={() => {
          actorRef.send({ type: 'next' })
        }}
      >
        {state.value as string}
      </div>
    )
  }

  return (
    <SomeContext.Provider
      options={persistedState.value === undefined
        ? {}
        : { snapshot: persistedState.value }}
    >
      <Component />
    </SomeContext.Provider>
  )
}

const InputApp = () => {
  const SomeContext = createActorContext(
    createMachine({
      schemas: {
        context: z.object({
          doubled: z.number(),
        }),
        input: z.number(),
      },
      context: ({ input }) => ({
        doubled: input * 2,
      }),
    }),
  )

  const Component = () => {
    const doubled = SomeContext.useSelector((state) => state.context.doubled)

    return <div data-testid='value'>{doubled}</div>
  }

  return (
    <SomeContext.Provider options={{ input: 42 }}>
      <Component />
    </SomeContext.Provider>
  )
}

const MergeOptionsApp = ({ events }: { events: InspectionEvent[] }) => {
  const SomeContext = createActorContext(
    createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        input: z.number(),
      },
      context: ({ input }) => ({ count: input }),
    }),
    {
      inspect: (ev) => {
        events.push(ev)
      },
    },
  )

  const Component = () => {
    const count = SomeContext.useSelector((state) => state.context.count)

    return <div data-testid='value'>{count}</div>
  }

  return (
    <SomeContext.Provider options={{ input: 10 }}>
      <Component />
    </SomeContext.Provider>
  )
}
