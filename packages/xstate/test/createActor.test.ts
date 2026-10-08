import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import z from 'zod'
import { createAsyncLogic, createCallbackLogic, createObservableLogic } from '../src/actors/index.js'
import { createActor, createLogic, createMachine, type DoneActorEvent, waitFor } from '../src/index.js'
describe('createActor()', () => {
  it('throws in development for the removed `state` option', function*({ expect }) {
    const logic = createMachine({})
    const persisted = createActor(logic).getPersistedSnapshot()
    yield* expect(() =>
      // @ts-expect-error removed; use `snapshot`
      createActor(logic, { state: persisted })
    ).toThrow('"snapshot"')
  })

  it('reserves explicit IDs in the generated ID namespace', function*({ expect }) {
    const logic = createMachine({})
    const root = createActor(logic)
    const explicitlyNamed = createActor(logic, {
      id: 'x:1',
      parent: root,
    })
    const automaticallyNamed = createActor(logic, { parent: root })

    yield* expect({
      explicit: explicitlyNamed.id,
      automatic: automaticallyNamed.id,
    }).toEqual({ explicit: 'x:1', automatic: 'x:2' })
  })

  describe('createAsyncLogic', () => {
    it('should create an unstarted actor from promise logic', function*({ expect }) {
      const promiseLogic = createAsyncLogic({ run: async () => 42 })
      const actor = createActor(promiseLogic)
      yield* expect({
        id: actor.id,
        status: actor.getSnapshot().status,
      }).toMatchObject({ id: 'x:0', status: 'active' })
    })
    it('should accept input when creating actor', function*({ expect }) {
      const promiseLogic = createAsyncLogic<
        number,
        {
          value: number
        }
      >({ run: async ({ input }) => input.value * 2 })
      const actor = createActor(promiseLogic, { input: { value: 21 } })
      actor.start()
      const snapshot = yield* Effect.promise(() => waitFor(actor, (emitted) => emitted.output !== undefined))
      yield* expect(snapshot.output).toBe(42)
    })
    it('should accept options when creating actor', function*({ expect }) {
      const promiseLogic = createAsyncLogic({ run: async () => 42 })
      const actor = createActor(promiseLogic, { id: 'my-promise' })
      yield* expect(actor.id).toBe('my-promise')
    })
  })
  describe('createCallbackLogic', () => {
    it('should create an unstarted actor from callback logic', function*({ expect }) {
      const callbackLogic = createCallbackLogic(() => {})
      const actor = createActor(callbackLogic)
      yield* expect({
        id: actor.id,
        status: actor.getSnapshot().status,
      }).toMatchObject({ id: 'x:0', status: 'active' })
    })
    it('should accept input when creating actor', function*({ expect }) {
      let capturedInput: string | undefined
      const callbackLogic = createCallbackLogic<{ type: string }, string>(
        ({ input }) => {
          capturedInput = input
        },
      )
      const actor = createActor(callbackLogic, { input: 'hello' })
      actor.start()
      yield* expect(capturedInput).toBe('hello')
    })
  })
  describe('createObservableLogic', () => {
    it('should create an unstarted actor from observable logic', function*({ expect }) {
      const observableLogic = createObservableLogic(() => ({
        subscribe: () => ({ unsubscribe: () => {} }),
      }))
      const actor = createActor(observableLogic)
      yield* expect({
        id: actor.id,
        status: actor.getSnapshot().status,
      }).toMatchObject({ id: 'x:0', status: 'active' })
    })
  })
  describe('createLogic', () => {
    it('should create an unstarted actor from custom logic', function*({ expect }) {
      const logic = createLogic({
        context: { count: 0 },
        run: () => undefined,
      })
      const actor = createActor(logic)
      yield* expect({
        id: actor.id,
        status: actor.getSnapshot().status,
        count: actor.getSnapshot().context.count,
      }).toMatchObject({ id: 'x:0', status: 'active', count: 0 })
    })
    it('should accept input when creating actor', function*({ expect }) {
      const logic = createLogic<
        { count: number },
        undefined,
        { type: string },
        { initialCount: number }
      >({
        context: ({ input }) => ({ count: input.initialCount }),
        run: () => undefined,
      })
      const actor = createActor(logic, {
        input: { initialCount: 10 },
      })
      yield* expect(actor.getSnapshot().context.count).toBe(10)
    })
  })
  describe('StateMachine', () => {
    it('should create an unstarted actor from machine logic', function*({ expect }) {
      const machine = createMachine({
        initial: 'idle',
        states: {
          idle: {},
        },
      })
      const actor = createActor(machine)
      yield* expect({
        id: actor.id,
        status: actor.getSnapshot().status,
        value: actor.getSnapshot().value,
      }).toMatchObject({ id: 'x:0', status: 'active', value: 'idle' })
    })
    it('should accept input when creating actor', function*({ expect }) {
      const machine = createMachine({
        schemas: {
          context: z.object({ value: z.number() }),
          input: z.object({ initialValue: z.number() }),
        },
        context: ({ input }) => ({ value: input.initialValue }),
        initial: 'idle',
        states: {
          idle: {},
        },
      })
      const actor = createActor(machine, { input: { initialValue: 42 } })
      yield* expect(actor.getSnapshot().context.value).toBe(42)
    })
    it('should accept options when creating actor', function*({ expect }) {
      const machine = createMachine({
        initial: 'idle',
        states: {
          idle: {},
        },
      })
      const actor = createActor(machine, { id: 'my-machine' })
      yield* expect(actor.id).toBe('my-machine')
    })
  })
})
describe('invoke.src accepting actor logic', () => {
  it('should accept a function returning actor logic', function*({ expect }) {
    const promiseLogic = createAsyncLogic({ run: async () => 'done' })
    const machine = createMachine({
      schemas: {
        context: z.object({ result: z.string().optional() }),
      },
      context: { result: undefined },
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: () => promiseLogic,
            onDone: ({ event }: { event: DoneActorEvent<string> }) => ({
              target: 'success',
              context: { result: event.output },
            }),
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const actor = createActor(machine)
    actor.start()
    yield* Effect.promise(() => waitFor(actor, (snapshot) => snapshot.matches('success')))
    yield* expect({
      value: actor.getSnapshot().value,
      result: actor.getSnapshot().context.result,
    }).toEqual({ value: 'success', result: 'done' })
  })
  it('should pass mapped input to returned actor logic', function*({ expect }) {
    const promiseLogic = createAsyncLogic<
      string,
      {
        message: string
      }
    >({ run: async ({ input }) => input.message })
    const machine = createMachine({
      schemas: {
        context: z.object({
          message: z.string(),
          result: z.string().optional(),
        }),
      },
      context: { message: 'hello', result: undefined },
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: ({
              actors,
            }: {
              actors: {
                promiseLogic: typeof promiseLogic
              }
            }) => actors.promiseLogic,
            input: ({
              context,
            }: {
              context: {
                message: string
                result?: string
              }
            }) => ({ message: context.message }),
            onDone: ({
              context,
              event,
            }: {
              context: {
                message: string
                result?: string
              }
              event: DoneActorEvent<string>
            }) => ({
              target: 'success',
              context: { result: event.output },
            }),
          },
        },
        success: {
          type: 'final',
        },
      } as any,
      actors: {
        promiseLogic,
      },
    })
    const actor = createActor(machine)
    actor.start()
    yield* Effect.promise(() => waitFor(actor, (snapshot) => snapshot.matches('success')))
    yield* expect({
      value: actor.getSnapshot().value,
      result: actor.getSnapshot().context.result,
    }).toEqual({ value: 'success', result: 'hello' })
  })
  it('should accept a string actor logic reference', function*({ expect }) {
    const promiseLogic = createAsyncLogic({ run: async () => 'from-actors' })
    const machine = createMachine({
      actors: {
        myPromise: promiseLogic,
      },
      schemas: {
        context: z.object({ result: z.string().optional() }),
      },
      context: { result: undefined },
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src: 'myPromise',
            onDone: ({ event }: { event: DoneActorEvent<string> }) => ({
              target: 'success',
              context: { result: event.output },
            }),
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const actor = createActor(machine)
    actor.start()
    yield* Effect.promise(() => waitFor(actor, (snapshot) => snapshot.matches('success')))
    yield* expect({
      value: actor.getSnapshot().value,
      result: actor.getSnapshot().context.result,
    }).toEqual({ value: 'success', result: 'from-actors' })
  })
})
