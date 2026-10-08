import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { of } from 'rxjs'
import z from 'zod'
import { createAsyncLogic, createCallbackLogic, createObservableLogic } from '../src/actors/index.js'
import { createActor, createLogic, createMachine, setup } from '../src/index.js'
import { standardSchemaValidator } from '../src/validation/index.js'
import { toSubscribable } from './utils.js'

const greetingFromInitEvent = (event: unknown): string | undefined => {
  if (event === null || typeof event !== 'object' || !('input' in event)) {
    return undefined
  }
  const input = event.input
  if (input === null || typeof input !== 'object' || !('greeting' in input)) {
    return undefined
  }
  const greeting = input.greeting
  return typeof greeting === 'string' ? greeting : undefined
}

describe('input', (it) => {
  it('should create a machine with input', function*({ expect }) {
    const calls: Array<ReadonlyArray<unknown>> = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }

    const machine = createMachine({
      // types: {} as {
      //   context: { count: number };
      //   input: { startCount: number };
      // },
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        input: z.object({
          startCount: z.number(),
        }),
      },
      context: ({ input }) => ({
        count: input.startCount,
      }),
      entry: ({ context }, enq) => {
        enq(record, context.count)
      },
    })

    createActor(machine, { input: { startCount: 42 } }).start()

    yield* expect(calls).toEqual([[42]])
  })

  it('initial event should have input property', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let greeting: string | undefined
    const machine = createMachine({
      schemas: {
        input: z.object({
          greeting: z.string(),
        }),
      },
      entry: ({ event }) => {
        greeting = greetingFromInitEvent(event)
        resolve()
      },
    })

    createActor(machine, { input: { greeting: 'hello' } }).start()

    yield* Effect.promise(() => promise)
    yield* expect(greeting).toEqual('hello')
  })

  it('should error if input is expected but not provided', function*({ expect }) {
    const machine = createMachine({
      // types: {} as {
      //   input: { greeting: string };
      //   context: { message: string };
      // },
      schemas: {
        input: z.object({
          greeting: z.string(),
        }),
        context: z.object({
          message: z.string(),
        }),
      },
      context: ({ input }) => {
        return { message: `Hello, ${input.greeting}` }
      },
    })

    // @ts-expect-error input is required
    const snapshot = createActor(machine).getSnapshot()

    yield* expect(snapshot.status).toBe('error')
  })

  it('should retain the machine snapshot interface when resolving input throws', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        input: z.object({
          greeting: z.string(),
        }),
        context: z.object({
          message: z.string(),
        }),
      },
      context: ({ input }) => ({
        message: `Hello, ${input.greeting}`,
      }),
      initial: 'saving',
      states: {
        saving: {},
      },
    })

    // @ts-expect-error input is required
    const snapshot = createActor(machine).getSnapshot()

    yield* expect({
      status: snapshot.status,
      matchesSaving: snapshot.matches('saving'),
    }).toEqual({ status: 'error', matchesSaving: true })
  })

  it(
    'should retain the machine snapshot interface and factory error when resolving input throws with result validation',
    function*({ expect }) {
      const factoryError = new Error('factory failed')
      const machine = setup({
        validator: standardSchemaValidator(),
        schemas: {
          context: z.object({
            message: z.string(),
          }),
        },
      }).createMachine({
        context: () => {
          throw factoryError
        },
        initial: 'saving',
        states: {
          saving: {},
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      yield* expect({
        matchesType: typeof snapshot.matches,
        status: snapshot.status,
        errorIsFactoryError: snapshot.error === factoryError,
      }).toEqual({
        matchesType: 'function',
        status: 'error',
        errorIsFactoryError: true,
      })
    },
  )

  it('should be a type error if input is not expected yet provided', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({ count: z.number() }),
      },
      context: { count: 42 },
    })

    // TODO: add ts-expect-errpr
    const actor = createActor(machine).start()

    yield* expect({
      status: actor.getSnapshot().status,
      context: actor.getSnapshot().context,
    }).toEqual({ status: 'active', context: { count: 42 } })
  })

  it('should provide input data to invoked machines', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let contextGreeting: string | undefined
    let eventInputGreeting: string | undefined

    const invokedMachine = createMachine({
      // types: {} as {
      //   input: { greeting: string };
      //   context: { greeting: string };
      // },
      schemas: {
        input: z.object({
          greeting: z.string(),
        }),
        context: z.object({
          greeting: z.string(),
        }),
      },
      context: ({ input }) => input,
      entry: ({ context, event }) => {
        contextGreeting = context.greeting
        eventInputGreeting = greetingFromInitEvent(event)
        resolve()
      },
    })

    const machine = createMachine({
      invoke: {
        src: invokedMachine,
        input: () => ({ greeting: 'hello' }),
      },
    })

    createActor(machine).start()

    yield* Effect.promise(() => promise)
    yield* expect({ contextGreeting, eventInputGreeting }).toEqual({
      contextGreeting: 'hello',
      eventInputGreeting: 'hello',
    })
  })

  it('should provide input data to spawned machines', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let contextGreeting: string | undefined
    let eventInputGreeting: string | undefined
    const spawnedMachine = createMachine({
      // types: {} as {
      //   input: { greeting: string };
      //   context: { greeting: string };
      // },
      schemas: {
        input: z.object({
          greeting: z.string(),
        }),
        context: z.object({
          greeting: z.string(),
        }),
        events: {
          greeting: z.object({ greeting: z.string() }),
        },
      },
      context({ input }) {
        return input
      },
      entry: ({ context, event }) => {
        contextGreeting = context.greeting
        eventInputGreeting = greetingFromInitEvent(event)
        resolve()
      },
    })

    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.object({}).optional(),
        }),
      },
      context: {
        ref: undefined,
      },
      entry: (_, enq) => ({
        context: {
          ref: enq.spawn(spawnedMachine, { input: { greeting: 'hello' } }),
        },
      }),
    })

    createActor(machine).start()

    yield* Effect.promise(() => promise)
    yield* expect({ contextGreeting, eventInputGreeting }).toEqual({
      contextGreeting: 'hello',
      eventInputGreeting: 'hello',
    })
  })

  it('should create a promise with input', function*({ expect }) {
    const promiseLogic = createAsyncLogic<{ count: number }, { count: number }>(
      {
        run: ({ input }) => Promise.resolve(input),
      },
    )

    const promiseActor = createActor(promiseLogic, {
      input: { count: 42 },
    })
    const settled = new Promise<void>((resolve) => {
      promiseActor.subscribe((snapshot) => {
        if (snapshot.status === 'done') resolve()
      })
    })
    promiseActor.start()

    yield* Effect.promise(() => settled)

    yield* expect(promiseActor.getSnapshot().output).toEqual({ count: 42 })
  })

  it('should infer async logic input from schemas', function*({ expect }) {
    const promiseLogic = createAsyncLogic({
      schemas: {
        input: z.object({ count: z.number() }),
      },
      run: ({ input }) => {
        input.count satisfies number

        // @ts-expect-error
        input.missing

        return Promise.resolve(input)
      },
    })

    const promiseActor = createActor(promiseLogic, {
      input: { count: 42 },
    })
    const settled = new Promise<void>((resolve) => {
      promiseActor.subscribe((snapshot) => {
        if (snapshot.status === 'done') resolve()
      })
    })
    promiseActor.start()

    // @ts-expect-error
    createActor(promiseLogic, { input: { count: 'not a number' } })

    yield* Effect.promise(() => settled)

    yield* expect(promiseActor.getSnapshot().output).toEqual({ count: 42 })
  })

  it('should create a transition function actor with input', function*({ expect }) {
    const transitionLogic = createLogic({
      context: ({ input }: { input: { count: number } }) => input,
      run: () => undefined,
    })

    const transitionActor = createActor(transitionLogic, {
      input: { count: 42 },
    }).start()

    yield* expect(transitionActor.getSnapshot().context).toEqual({ count: 42 })
  })

  it('should create an observable actor with input', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let observedContext: { count: number } | undefined
    const observableLogic = createObservableLogic<
      { count: number },
      { count: number }
    >(({ input }) => toSubscribable(of(input)))

    const observableActor = createActor(observableLogic, {
      input: { count: 42 },
    })

    const sub = observableActor.subscribe((state) => {
      if (state.context?.count !== 42) return
      observedContext = state.context
      sub.unsubscribe()
      resolve()
    })

    observableActor.start()

    yield* Effect.promise(() => promise)
    yield* expect(observedContext).toEqual({ count: 42 })
  })

  it('should create a callback actor with input', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let receivedInput: unknown
    const callbackLogic = createCallbackLogic(({ input }) => {
      receivedInput = input
      resolve()
    })

    createActor(callbackLogic, {
      input: { count: 42 },
    }).start()

    yield* Effect.promise(() => promise)
    yield* expect(receivedInput).toEqual({ count: 42 })
  })

  it('should provide a static inline input to the referenced actor', function*({ expect }) {
    const calls: Array<ReadonlyArray<unknown>> = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }

    const child = createMachine({
      schemas: {
        input: z.number(),
      },
      context: ({ input }) => {
        record(input)
        return {}
      },
    })

    const machine = createMachine({
      invoke: {
        src: child,
        input: () => 42,
      },
    })

    createActor(machine).start()

    yield* expect(calls).toEqual([[42]])
  })

  it('should provide a dynamic inline input to the referenced actor', function*({ expect }) {
    const calls: Array<ReadonlyArray<unknown>> = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }

    const child = createMachine({
      schemas: {
        input: z.number(),
      },
      context: ({ input }) => {
        record(input)
        return {}
      },
    })

    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        input: z.number(),
      },
      context: ({ input }) => ({
        count: input,
      }),
      invoke: {
        src: child,
        input: ({ context }) => {
          return context.count + 100
        },
      },
    })

    createActor(machine, { input: 42 }).start()

    yield* expect(calls).toEqual([[142]])
  })

  it('should call the input factory with self when invoking', function*({ expect }) {
    const selfs: unknown[] = []
    const record = (self: unknown): unknown => {
      selfs.push(self)
      return self
    }

    const machine = createMachine({
      invoke: {
        src: createMachine({}),
        input: ({ self }) => record(self),
      },
    })

    const actor = createActor(machine).start()

    yield* expect({
      calls: selfs.length,
      selfIsActor: selfs[0] === actor,
    }).toEqual({ calls: 1, selfIsActor: true })
  })
})
