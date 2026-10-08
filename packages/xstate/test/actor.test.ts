import { describe } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { EMPTY, firstValueFrom, interval, of } from 'rxjs'
import { map, skip } from 'rxjs/operators'
import z from 'zod'
import { type CallbackActorRef, createCallbackLogic } from '../src/actors/callback.js'
import { createEventObservableLogic, createObservableLogic } from '../src/actors/observable.js'
import { type AsyncActorLogic, type AsyncActorRef, createAsyncLogic } from '../src/actors/promise.js'
import {
  type ActorLogic,
  type ActorRef,
  type ActorRefFrom,
  type AnyActor,
  type AnyActorRef,
  createActor,
  createLogic,
  createMachine,
  type DoneActorEvent,
  type ErrorActorEvent,
  type EventObject,
  type Observer,
  type Snapshot,
  type SnapshotEvent,
  type Subscribable,
  waitFor,
} from '../src/index.js'
import { toSubscribable } from './utils.js'

function getThrown(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

const waitForTwoChildIntervalTicks = () => firstValueFrom(interval(10).pipe(skip(1)))

const eventually = (predicate: () => boolean) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const startedAt = Date.now()
    const tick = () => {
      if (predicate() || Date.now() - startedAt > 2000) {
        resolve()
        return
      }
      setTimeout(tick, 5)
    }
    tick()
    return promise
  })

describe('spawning machines', (it) => {
  type TodoEvent =
    | {
      type: 'ADD'
      id: number
    }
    | {
      type: 'SET_COMPLETE'
      id: number
    }
    | {
      type: 'TODO_COMPLETED'
    }
  // Adaptation: https://github.com/p-org/P/wiki/PingPong-program
  type PingPongEvent =
    | {
      type: 'PING'
    }
    | {
      type: 'PONG'
    }
    | {
      type: 'SUCCESS'
    }
  const serverMachine = createMachine({
    // types: {} as {
    //   events: PingPongEvent;
    // },
    schemas: {
      events: {
        PING: z.object({}),
        PONG: z.object({}),
        SUCCESS: z.object({}),
      },
    },
    id: 'server',
    initial: 'waitPing',
    states: {
      waitPing: {
        on: {
          PING: { target: 'sendPong' },
        },
      },
      sendPong: {
        // entry: [sendParent({ type: 'PONG' }), raise({ type: 'SUCCESS' })],
        entry: ({ parent }, enq) => {
          enq.sendTo(parent, { type: 'PONG' })
          enq.raise({ type: 'SUCCESS' })
        },
        on: {
          SUCCESS: { target: 'waitPing' },
        },
      },
    },
  })
  interface ClientContext {
    server?: ActorRef<Snapshot<unknown>, PingPongEvent>
  }
  const clientMachine = createMachine({
    // types: {} as { context: ClientContext; events: PingPongEvent },
    schemas: {
      context: z.object({
        server: z.any(),
      }),
      events: {
        PING: z.object({}),
        PONG: z.object({}),
        SUCCESS: z.object({}),
      },
    },
    id: 'client',
    initial: 'init',
    context: {
      server: undefined,
    },
    states: {
      init: {
        entry: (_, enq) => {
          const server = enq.spawn(serverMachine)
          enq.raise({ type: 'SUCCESS' })
          return {
            context: {
              server,
            },
          }
        },
        on: {
          SUCCESS: { target: 'sendPing' },
        },
      },
      sendPing: {
        // entry: [
        //   sendTo(({ context }) => context.server!, { type: 'PING' }),
        //   raise({ type: 'SUCCESS' })
        // ],
        entry: ({ context }, enq) => {
          enq.sendTo(context.server, { type: 'PING' })
          enq.raise({ type: 'SUCCESS' })
        },
        on: {
          SUCCESS: { target: 'waitPong' },
        },
      },
      waitPong: {
        on: {
          PONG: { target: 'complete' },
        },
      },
      complete: {
        type: 'final',
      },
    },
  })
  it('should spawn machines', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const context = {
      todoRefs: {} as Record<string, AnyActorRef>,
    }
    const todoMachine = createMachine({
      id: 'todo',
      initial: 'incomplete',
      states: {
        incomplete: {
          on: { SET_COMPLETE: { target: 'complete' } },
        },
        complete: {
          // entry: sendParent({ type: 'TODO_COMPLETED' })
          entry: ({ parent }, enq) => {
            enq.sendTo(parent, { type: 'TODO_COMPLETED' })
          },
        },
      },
    })
    const todosMachine = createMachine({
      // types: {} as {
      //   context: typeof context;
      //   events: TodoEvent;
      // },
      schemas: {
        context: z.object({
          todoRefs: z.record(z.any()),
        }),
        events: {
          ADD: z.object({ id: z.number() }),
          SET_COMPLETE: z.object({ id: z.number() }),
          TODO_COMPLETED: z.object({}),
        },
      },
      id: 'todos',
      context,
      initial: 'active',
      states: {
        active: {
          on: {
            TODO_COMPLETED: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
      on: {
        ADD: ({ context, event }, enq) => ({
          context: {
            todoRefs: {
              ...context.todoRefs,
              [event.id]: enq.spawn(todoMachine),
            },
          },
        }),
        SET_COMPLETE: ({ context, event }, enq) => {
          enq.sendTo(context.todoRefs[event.id], { type: 'SET_COMPLETE' })
        },
      },
    })
    const service = createActor(todosMachine)
    service.subscribe({
      complete: () => {
        resolve()
      },
    })
    service.start()
    service.trigger.ADD({ id: 42 })
    service.trigger.SET_COMPLETE({ id: 42 })
    yield* Effect.promise(() => promise)
    yield* expect(service.getSnapshot().value).toBe('success')
  })
  it('should spawn referenced machines', function*({ expect }) {
    const childMachine = createMachine({
      // entry: sendParent({ type: 'DONE' })
      entry: ({ parent }, enq) => {
        enq.sendTo(parent, { type: 'DONE' })
      },
    })
    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          ref: z.custom<AnyActorRef>(),
        }),
      },
      context: {
        ref: null! as AnyActorRef,
      },
      actors: {
        childMachine,
      },
      initial: 'waiting',
      states: {
        waiting: {
          entry: ({ actors }, enq) => ({
            context: {
              ref: enq.spawn(actors.childMachine),
            },
          }),
          on: {
            DONE: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const actor = createActor(parentMachine)
    actor.start()
    yield* expect(actor.getSnapshot().value).toBe('success')
  })
  it('should allow bidirectional communication between parent/child actors', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const actor = createActor(clientMachine)
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    actor.start()
    yield* Effect.promise(() => promise)
    yield* expect(actor.getSnapshot().value).toBe('complete')
  })
})
describe('spawning promises', (it) => {
  it('should be able to spawn a promise', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const promiseMachine = createMachine({
      schemas: {
        context: z.object({
          promiseRef: z.custom<AsyncActorRef<string>>().optional(),
        }),
      },
      id: 'promise',
      initial: 'idle',
      context: {
        promiseRef: undefined,
      },
      states: {
        idle: {
          entry: (_: unknown, enq: any) => ({
            context: {
              promiseRef: enq.spawn(
                createAsyncLogic({ run: () => Promise.resolve('response') }),
                { id: 'my-promise' },
              ),
            },
          }),
          on: {
            'xstate.done.actor.my-promise': ({
              event,
            }: {
              event: DoneActorEvent<string>
            }) => {
              if (event.output === 'response') {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const promiseService = createActor(promiseMachine)
    promiseService.subscribe({
      complete: () => {
        resolve()
      },
    })
    promiseService.start()
    yield* Effect.promise(() => promise)
    yield* expect(promiseService.getSnapshot().value).toBe('success')
  })
  it('should be able to spawn a referenced promise', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const promiseMachine = createMachine({
      schemas: {
        context: z.object({
          promiseRef: z.custom<AsyncActorRef<string>>().optional(),
        }),
      },
      actors: {
        somePromise: createAsyncLogic({
          run: () => Promise.resolve('response'),
        }),
      },
      id: 'promise',
      initial: 'idle',
      context: {
        promiseRef: undefined,
      },
      states: {
        idle: {
          entry: ({ actors }: any, enq: any) => ({
            context: {
              promiseRef: enq.spawn(actors.somePromise, {
                id: 'my-promise',
              }),
            },
          }),
          on: {
            'xstate.done.actor.my-promise': ({
              event,
            }: {
              event: DoneActorEvent<string>
            }) => {
              if (event.output === 'response') {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const promiseService = createActor(promiseMachine)
    promiseService.subscribe({
      complete: () => {
        resolve()
      },
    })
    promiseService.start()
    yield* Effect.promise(() => promise)
    yield* expect(promiseService.getSnapshot().value).toBe('success')
  })
})
describe('spawning callbacks', (it) => {
  it('should be able to spawn an actor from a callback', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const callbackMachine = createMachine({
      schemas: {
        context: z.object({
          callbackRef: z
            .custom<
              CallbackActorRef<{
                type: 'START'
              }>
            >()
            .optional(),
        }),
        events: {
          START_CB: z.object({}),
          SEND_BACK: z.object({}),
        },
      },
      id: 'callback',
      initial: 'idle',
      context: {
        callbackRef: undefined,
      },
      states: {
        idle: {
          entry: (_, enq) => ({
            context: {
              callbackRef: enq.spawn(
                createCallbackLogic<{
                  type: 'START'
                }>(({ sendBack, receive }) => {
                  receive((event) => {
                    if (event.type === 'START') {
                      setTimeout(() => {
                        sendBack({ type: 'SEND_BACK' })
                      }, 10)
                    }
                  })
                }),
              ),
            },
          }),
          on: {
            // START_CB: {
            //   actions: sendTo(({ context }) => context.callbackRef!, {
            //     type: 'START'
            //   })
            // },
            START_CB: ({ context }, enq) => {
              enq.sendTo(context.callbackRef, {
                type: 'START',
              })
            },
            SEND_BACK: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const callbackService = createActor(callbackMachine)
    callbackService.subscribe({
      complete: () => {
        resolve()
      },
    })
    callbackService.start()
    callbackService.trigger.START_CB()
    yield* Effect.promise(() => promise)
    yield* expect(callbackService.getSnapshot().value).toBe('success')
  })
  it('should not deliver events sent to the parent after the callback actor gets stopped', function*({ expect }) {
    const calls: unknown[][] = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }
    let sendToParent: () => void
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createCallbackLogic(({ sendBack }) => {
              sendToParent = () =>
                sendBack({
                  type: 'FROM_CALLBACK',
                })
            }),
          },
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {},
      },
      on: {
        FROM_CALLBACK: (_, enq) => {
          enq(record)
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })
    sendToParent!()
    yield* expect(calls).toEqual([])
  })
})
describe('spawning observables', (it) => {
  it('should spawn an observable', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const observableLogic = createObservableLogic<number, undefined>(
      () => toSubscribable(interval(10)),
    )
    const observableMachine = createMachine({
      id: 'observable',
      initial: 'idle',
      schemas: {
        context: z.object({
          observableRef: z.custom<ActorRefFrom<typeof observableLogic>>(),
        }),
      },
      context: {
        observableRef: undefined! as ActorRefFrom<typeof observableLogic>,
      },
      states: {
        idle: {
          entry: (_: unknown, enq: any) => ({
            context: {
              observableRef: enq.spawn(observableLogic, {
                id: 'int',
                syncSnapshot: true,
              }),
            },
          }),
          on: {
            'xstate.snapshot.int': ({
              event,
            }: {
              event: SnapshotEvent<
                Snapshot<unknown> & {
                  context: number
                }
              >
            }) => {
              if (event.snapshot.context === 5) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const observableService = createActor(observableMachine)
    observableService.subscribe({
      complete: () => {
        resolve()
      },
    })
    observableService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observableService.getSnapshot().value).toBe('success')
  })
  it('should spawn a referenced observable', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const observableMachine = createMachine({
      id: 'observable',
      initial: 'idle',
      schemas: {
        context: z.object({
          observableRef: z.custom<AnyActorRef>(),
        }),
      },
      context: {
        observableRef: undefined! as AnyActorRef,
      },
      actors: {
        interval: createObservableLogic<number, undefined>(
          () => toSubscribable(interval(10)),
        ),
      },
      states: {
        idle: {
          entry: (_: unknown, enq: any) => ({
            context: {
              observableRef: enq.spawn(
                createObservableLogic<number, undefined>(
                  () => toSubscribable(interval(10)),
                ),
                { id: 'int', syncSnapshot: true },
              ),
            },
          }),
          on: {
            'xstate.snapshot.int': ({
              event,
            }: {
              event: SnapshotEvent<
                Snapshot<unknown> & {
                  context: number
                }
              >
            }) => {
              if (event.snapshot.context === 5) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const observableService = createActor(observableMachine)
    observableService.subscribe({
      complete: () => {
        resolve()
      },
    })
    observableService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observableService.getSnapshot().value).toBe('success')
  })
  it(`should read the latest snapshot of the event's origin while handling that event`, function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const observableLogic = createObservableLogic<number, undefined>(
      () => toSubscribable(interval(10)),
    )
    const observableMachine = createMachine({
      id: 'observable',
      schemas: {
        context: z.object({
          observableRef: z.custom<AnyActorRef>(),
        }),
        events: {
          COUNT: z.object({ val: z.number() }),
        },
      },
      initial: 'idle',
      context: {
        observableRef: undefined! as ActorRefFrom<typeof observableLogic>,
      },
      states: {
        idle: {
          entry: (_: any, enq: any) => ({
            context: {
              observableRef: enq.spawn(observableLogic, {
                id: 'int',
                syncSnapshot: true,
              }),
            },
          }),
          on: {
            'xstate.snapshot.int': ({
              event,
            }: {
              event: SnapshotEvent<
                Snapshot<unknown> & {
                  context: number
                }
              >
            }) => {
              if (event.snapshot.context === 1) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const observableService = createActor(observableMachine)
    observableService.subscribe({
      complete: () => {
        resolve()
      },
    })
    observableService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observableService.getSnapshot().value).toBe('success')
  })
  it.live('should notify direct child listeners with final snapshot before it gets stopped', function*({ expect }) {
    const intervalActor = createObservableLogic<number, undefined>(
      () => toSubscribable(interval(10)),
    )
    const parentMachine = createMachine({
      // types: {} as {
      //   actors: {
      //     src: 'interval';
      //     id: 'childActor';
      //     logic: typeof intervalActor;
      //   };
      // },
      actors: {
        interval: intervalActor,
      },
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'childActor',
            src: ({ actors }) => actors.interval,
            // onSnapshot: {
            //   target: 'success',
            //   guard: ({ event }) => {
            //     return event.snapshot.context === 3;
            //   }
            // }
            onSnapshot: ({
              event,
            }: {
              event: SnapshotEvent<
                Snapshot<unknown> & {
                  context: number
                }
              >
            }) => {
              if (event.snapshot.context === 3) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const actorRef = createActor(parentMachine)
    actorRef.start()
    yield* Effect.promise(() => waitFor(actorRef, (state) => state.matches('active')))
    const calls: unknown[][] = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }
    actorRef.getSnapshot().children['childActor']!.subscribe((data) => {
      record(data.context)
    })
    yield* Effect.promise(() => waitFor(actorRef, (state) => state.status !== 'active'))
    yield* expect(calls).toEqual(expect.arrayContaining([[3]]))
  })
  it.live('should not notify direct child listeners after it gets stopped', function*({ expect }) {
    const intervalActor = createObservableLogic<number, undefined>(
      () => toSubscribable(interval(10)),
    )
    const parentMachine = createMachine({
      // types: {} as {
      //   actors: {
      //     src: 'interval';
      //     id: 'childActor';
      //     logic: typeof intervalActor;
      //   };
      // },
      actors: {
        interval: intervalActor,
      },
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'childActor',
            src: ({ actors }) => actors.interval,
            // onSnapshot: {
            //   target: 'success',
            //   guard: ({ event }) => {
            //     return event.snapshot.context === 3;
            //   }
            // }
            onSnapshot: ({
              event,
            }: {
              event: SnapshotEvent<
                Snapshot<unknown> & {
                  context: number
                }
              >
            }) => {
              if (event.snapshot.context === 3) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const actorRef = createActor(parentMachine)
    actorRef.start()
    yield* Effect.promise(() => waitFor(actorRef, (state) => state.matches('active')))
    const calls: unknown[][] = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }
    actorRef.getSnapshot().children['childActor']!.subscribe((data) => {
      record(data)
    })
    yield* Effect.promise(() => waitFor(actorRef, (state) => state.status !== 'active'))
    calls.length = 0
    yield* Effect.promise(waitForTwoChildIntervalTicks)
    yield* expect(calls).toEqual([])
  })
})
describe('spawning event observables', (it) => {
  it('should spawn an event observable', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const eventObservableLogic = createEventObservableLogic<
      { type: string; val: number },
      undefined
    >(() =>
      toSubscribable(
        interval(10).pipe(map((val) => ({ type: 'COUNT', val }))),
      )
    )
    const observableMachine = createMachine({
      id: 'observable',
      schemas: {
        context: z.object({
          observableRef: z.custom<AnyActorRef>(),
        }),
        events: {
          COUNT: z.object({ val: z.number() }),
        },
      },
      initial: 'idle',
      context: {
        observableRef: undefined! as ActorRefFrom<typeof eventObservableLogic>,
      },
      states: {
        idle: {
          // entry: assign({
          //   observableRef: ({ spawn }) => {
          //     const ref = spawn(eventObservableLogic, { id: 'int' });
          //     return ref;
          //   }
          // }),
          entry: (_, enq) => ({
            context: {
              observableRef: enq.spawn(eventObservableLogic, { id: 'int' }),
            },
          }),
          on: {
            // COUNT: {
            //   target: 'success',
            //   guard: ({ event }) => event.val === 5
            // }
            COUNT: ({ event }) => {
              if (event.val === 5) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const observableService = createActor(observableMachine)
    observableService.subscribe({
      complete: () => {
        resolve()
      },
    })
    observableService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observableService.getSnapshot().value).toBe('success')
  })
  it('should spawn a referenced event observable', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const observableMachine = createMachine({
      id: 'observable',
      schemas: {
        context: z.object({
          observableRef: z.custom<AnyActorRef>(),
        }),
        events: {
          COUNT: z.object({ val: z.number() }),
        },
      },
      actors: {
        interval: createEventObservableLogic<
          { type: string; val: number },
          undefined
        >(() =>
          toSubscribable(
            interval(10).pipe(map((val) => ({ type: 'COUNT', val }))),
          )
        ),
      },
      initial: 'idle',
      context: {
        observableRef: undefined! as AnyActorRef,
      },
      states: {
        idle: {
          entry: (_, enq) => ({
            context: {
              observableRef: enq.spawn(
                createEventObservableLogic<
                  { type: string; val: number },
                  undefined
                >(() =>
                  toSubscribable(
                    interval(10).pipe(map((val) => ({ type: 'COUNT', val }))),
                  )
                ),
                { id: 'int' },
              ),
            },
          }),
          on: {
            COUNT: ({ event }) => {
              if (event.val === 5) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const observableService = createActor(observableMachine)
    observableService.subscribe({
      complete: () => {
        resolve()
      },
    })
    observableService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observableService.getSnapshot().value).toBe('success')
  })
})
describe('communicating with spawned actors', (it) => {
  it('should treat an interpreter as an actor', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let observedExistingRef: unknown
    const existingMachine = createMachine({
      schemas: {
        events: {
          ACTIVATE: z.object({ origin: z.custom<AnyActorRef>() }),
        },
      },
      initial: 'inactive',
      states: {
        inactive: {
          on: { ACTIVATE: { target: 'active' } },
        },
        // active: {
        //   entry: sendTo(({ event }) => event.origin, { type: 'EXISTING.DONE' })
        // }
        active: {
          entry: ({ event }, enq) => {
            enq.sendTo(event.origin, { type: 'EXISTING.DONE' })
          },
        },
      },
    })
    const existingService = createActor(existingMachine).start()
    const parentMachine: any = createMachine({
      schemas: {
        context: z.object({
          existingRef: z.custom<typeof existingService>().optional(),
        }),
        events: {
          ACTIVATE: z.object({ origin: z.custom<typeof parentService>() }),
          'EXISTING.DONE': z.object({}),
        },
      },
      initial: 'pending',
      context: {
        existingRef: existingService,
      },
      states: {
        pending: {
          entry: () => {
            return {
              context: {
                existingRef: existingService,
              },
            }
          },
          on: {
            'EXISTING.DONE': { target: 'success' },
          },
          after: {
            100: ({ context, self }, enq) => {
              observedExistingRef = context.existingRef
              enq.sendTo(context.existingRef, {
                type: 'ACTIVATE',
                origin: self,
              })
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })
    const parentService: any = createActor(parentMachine)
    parentService.subscribe({
      complete: () => {
        resolve()
      },
    })
    parentService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observedExistingRef).toBe(existingService)
  })
})
describe('actors', (it) => {
  it('should only spawn actors defined on initial state once', function*({ expect }) {
    let count = 0
    const startMachine = createMachine({
      // types: {} as { context: { items: number[]; refs: any[] } },
      schemas: {
        context: z.object({
          items: z.array(z.number()),
          refs: z.array(z.any()),
        }),
      },
      id: 'start',
      initial: 'start',
      context: {
        items: [0, 1, 2, 3],
        refs: [],
      },
      states: {
        start: {
          entry: ({ context }, enq) => {
            enq(() => count++)
            return {
              context: {
                refs: context.items.map((item) =>
                  enq.spawn(
                    createAsyncLogic({
                      run: () => new Promise((res) => res(item)),
                    }),
                  )
                ),
              },
            }
          },
        },
      },
    })
    const observedSpawnCounts: number[] = []
    const actor = createActor(startMachine)
    actor.subscribe(() => {
      observedSpawnCounts.push(count)
    })
    actor.start()
    yield* expect(observedSpawnCounts).toSatisfy(
      (counts) => counts.every((value) => value === 1),
      'every observer notification after start saw the spawned-actor count at 1',
    )
  })
  it(
    'should spawn an actor in an initial state of a child that gets invoked in the initial state of a parent when the parent gets started',
    function*({ expect }) {
      let spawnCounter = 0
      const child = createMachine({
        // types: {} as { context: TestContext },
        schemas: {
          context: z.object({
            promise: z
              .object({
                send: z.function().args(z.any()).returns(z.any()),
              })
              .optional(),
          }),
        },
        initial: 'bar',
        context: {},
        states: {
          bar: {
            // entry: assign({
            //   promise: ({ spawn }) => {
            //     return spawn(
            //       createAsyncLogic(() => {
            //         spawnCounter++;
            //         return Promise.resolve('answer');
            //       })
            //     );
            //   }
            // })
            entry: (_, enq) => ({
              context: {
                promise: enq.spawn(
                  createAsyncLogic({
                    run: () => {
                      spawnCounter++
                      return Promise.resolve('answer')
                    },
                  }),
                ),
              },
            }),
          },
        },
      })
      const parent = createMachine({
        initial: 'foo',
        states: {
          foo: {
            invoke: {
              src: child,
              onDone: { target: 'end' },
            },
          },
          end: { type: 'final' },
        },
      })
      createActor(parent).start()
      yield* expect(spawnCounter).toBe(1)
    },
  )
  // https://github.com/statelyai/xstate/issues/2565
  it('should only spawn an initial actor once when it synchronously responds with an event', function*({ expect }) {
    let spawnCalled = 0
    const anotherMachine = createMachine({
      initial: 'hello',
      states: {
        hello: {
          // entry: sendParent({ type: 'ping' })
          entry: ({ parent }, enq) => {
            enq.sendTo(parent, { type: 'ping' })
          },
        },
      },
    })
    const testMachine = createMachine({
      schemas: {
        context: z.object({
          ref: z.custom<ActorRefFrom<typeof anotherMachine>>().optional(),
        }),
      },
      initial: 'testing',
      context: ({ spawn }) => {
        spawnCalled++
        if (spawnCalled > 1) {
          throw new Error('the initial actor was spawned more than once')
        }
        return {
          ref: spawn(anotherMachine),
        }
      },
      states: {
        testing: {
          on: {
            ping: {
              target: 'done',
            },
          },
        },
        done: {},
      },
    })
    const service = createActor(testMachine).start()
    yield* expect({ value: service.getSnapshot().value, spawnCalled }).toEqual({
      value: 'done',
      spawnCalled: 1,
    })
  })
  it('should spawn null actors if not used within a service', function*({ expect }) {
    const nullActorMachine = createMachine({
      // types: {} as { context: { ref?: AsyncActorRef<number> } },
      schemas: {
        context: z.object({
          ref: z.custom<AsyncActorRef<number>>().optional(),
        }),
      },
      initial: 'foo',
      context: { ref: undefined },
      states: {
        foo: {
          // entry: assign({
          //   ref: ({ spawn }) => spawn(createAsyncLogic(() => Promise.resolve(42)))
          // })
          entry: (_, enq) => ({
            context: {
              ref: enq.spawn(
                createAsyncLogic({ run: () => Promise.resolve(42) }),
              ),
            },
          }),
        },
      },
    })
    const nullRef = createActor(nullActorMachine).getSnapshot().context.ref!
    yield* expect(typeof nullRef.send).toBe('function')
  })
  it('should stop multiple inline spawned actors that have no explicit ids', function*({ expect }) {
    const cleanup1Calls: unknown[][] = []
    const cleanup1 = (...args: unknown[]) => {
      cleanup1Calls.push(args)
    }
    const cleanup2Calls: unknown[][] = []
    const cleanup2 = (...args: unknown[]) => {
      cleanup2Calls.push(args)
    }
    const parent = createMachine({
      schemas: {
        context: z.object({
          ref1: z.custom<AnyActorRef>(),
          ref2: z.custom<AnyActorRef>(),
        }),
      },
      context: ({ spawn }) => ({
        ref1: spawn(createCallbackLogic(() => cleanup1)),
        ref2: spawn(createCallbackLogic(() => cleanup2)),
      }),
    })
    const actorRef = createActor(parent).start()
    const childCount = Object.keys(actorRef.getSnapshot().children).length
    actorRef.stop()
    yield* expect({
      childCount,
      cleanup1Calls,
      cleanup2Calls,
    }).toEqual({ childCount: 2, cleanup1Calls: [[]], cleanup2Calls: [[]] })
  })
  it('should stop multiple referenced spawned actors that have no explicit ids', function*({ expect }) {
    const cleanup1Calls: unknown[][] = []
    const cleanup1 = (...args: unknown[]) => {
      cleanup1Calls.push(args)
    }
    const cleanup2Calls: unknown[][] = []
    const cleanup2 = (...args: unknown[]) => {
      cleanup2Calls.push(args)
    }
    const parent = createMachine({
      schemas: {
        context: z.object({
          ref1: z.custom<AnyActorRef>(),
          ref2: z.custom<AnyActorRef>(),
        }),
      },
      context: ({ spawn, actors }) => ({
        ref1: spawn(actors.child1),
        ref2: spawn(actors.child2),
      }),
      actors: {
        child1: createCallbackLogic(() => cleanup1),
        child2: createCallbackLogic(() => cleanup2),
      },
    })
    const actorRef = createActor(parent).start()
    const childCount = Object.keys(actorRef.getSnapshot().children).length
    actorRef.stop()
    yield* expect({
      childCount,
      cleanup1Calls,
      cleanup2Calls,
    }).toEqual({ childCount: 2, cleanup1Calls: [[]], cleanup2Calls: [[]] })
  })
  describe('with actor logic', (it) => {
    it('should work with custom logic', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const countLogic = createLogic({
        context: 0,
        run: ({ context, event }) => {
          if (event.type === 'INC') {
            return { context: context + 1 }
          } else if (event.type === 'DEC') {
            return { context: context - 1 }
          }
          return
        },
      })
      const countMachine = createMachine({
        // types: {} as {
        //   context: { count: ActorRefFrom<typeof countLogic> | undefined };
        // },
        schemas: {
          context: z.object({
            count: z.custom<ActorRefFrom<typeof countLogic>>().optional(),
          }),
        },
        context: {
          count: undefined,
        },
        // entry: assign({
        //   count: ({ spawn }) => spawn(countLogic)
        // }),
        entry: (_, enq) => ({
          context: {
            count: enq.spawn(countLogic),
          },
        }),
        on: {
          // INC: {
          //   actions: forwardTo(({ context }) => context.count!)
          // }
          INC: ({ context, event }, enq) => {
            enq.sendTo(context.count, event)
          },
        },
      })
      const countService = createActor(countMachine)
      countService.subscribe((state) => {
        if (state.context.count?.getSnapshot().context === 2) {
          resolve()
        }
      })
      countService.start()
      countService.send({ type: 'INC' })
      countService.send({ type: 'INC' })
      yield* expect(countService.getSnapshot().context.count?.getSnapshot().context).toBe(2)
      yield* Effect.promise(() => promise)
    })
    it('should work with a promise logic (fulfill)', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const countMachine = createMachine({
        // types: {} as {
        //   context: {
        //     count: ActorRefFrom<AsyncActorLogic<number>> | undefined;
        //   };
        // },
        schemas: {
          context: z.object({
            count: z.custom<ActorRefFrom<AsyncActorLogic<number>>>().optional(),
          }),
        },
        context: {
          count: undefined,
        },
        // entry: assign({
        //   count: ({ spawn }) =>
        //     spawn(
        //       createAsyncLogic(
        //         () =>
        //           new Promise<number>((res) => {
        //             setTimeout(() => res(42));
        //           })
        //       ),
        //       { id: 'test' }
        //     )
        // }),
        entry: (_, enq) => ({
          context: {
            count: enq.spawn(
              createAsyncLogic({
                run: () =>
                  new Promise<number>((res) => {
                    setTimeout(() => res(42))
                  }),
              }),
              { id: 'test' },
            ),
          },
        }),
        initial: 'pending',
        states: {
          pending: {
            on: {
              // 'xstate.done.actor.test': {
              //   target: 'success',
              //   guard: ({ event }) => event.output === 42
              // }
              'xstate.done.actor.test': ({
                event,
              }: {
                event: DoneActorEvent<number>
              }) => {
                if (event.output === 42) {
                  return {
                    target: 'success',
                  }
                }
                return undefined
              },
            },
          },
          success: {
            type: 'final',
          },
        } as any,
      })
      const countService = createActor(countMachine)
      countService.subscribe({
        complete: () => {
          resolve()
        },
      })
      countService.start()
      yield* Effect.promise(() => promise)
      yield* expect(countService.getSnapshot().value).toBe('success')
    })
    it('should work with a promise logic (reject)', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const errorMessage = 'An error occurred'
      const countMachine = createMachine({
        // types: {} as {
        //   context: { count: ActorRefFrom<AsyncActorLogic<number>> };
        // },
        schemas: {
          context: z.object({
            count: z.custom<ActorRefFrom<AsyncActorLogic<number>>>(),
          }),
        },
        context: ({ spawn }) => ({
          count: spawn(
            createAsyncLogic({
              run: () =>
                new Promise<number>((_, rej) => {
                  setTimeout(() => rej(errorMessage), 1)
                }),
            }),
            { id: 'test' },
          ),
        }),
        initial: 'pending',
        states: {
          pending: {
            on: {
              // 'xstate.error.actor.test': {
              //   target: 'success',
              //   guard: ({ event }) => {
              //     return event.error === errorMessage;
              //   }
              // }
              'xstate.error.actor.test': ({
                event,
              }: {
                event: ErrorActorEvent
              }) => {
                if (event.error === errorMessage) {
                  return {
                    target: 'success',
                  }
                }
                return undefined
              },
            },
          },
          success: {
            type: 'final',
          },
        } as any,
      })
      const countService = createActor(countMachine)
      countService.subscribe({
        complete: () => {
          resolve()
        },
      })
      countService.start()
      yield* Effect.promise(() => promise)
      yield* expect(countService.getSnapshot().value).toBe('success')
    })
    it('actor logic should have reference to the parent', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const pongLogic: ActorLogic<Snapshot<undefined>, EventObject> = {
        transition: (state, event, { self }) => {
          if (event.type === 'PING') {
            self._parent?.send({ type: 'PONG' })
          }
          return [state, []]
        },
        getInitialSnapshot: () => ({
          status: 'active',
          output: undefined,
          error: undefined,
        }),
        initialTransition: () => [
          {
            status: 'active',
            output: undefined,
            error: undefined,
          },
          [],
        ],
        getPersistedSnapshot: (s) => s,
      }
      const pingMachine = createMachine({
        // types: {} as {
        //   context: { ponger: ActorRefFrom<typeof pongLogic> | undefined };
        // },
        schemas: {
          context: z.object({
            ponger: z.custom<ActorRefFrom<typeof pongLogic>>().optional(),
          }),
        },
        initial: 'waiting',
        context: {
          ponger: undefined,
        },
        // entry: assign({
        //   ponger: ({ spawn }) => spawn(pongLogic)
        // }),
        entry: (_, enq) => ({
          context: {
            ponger: enq.spawn(pongLogic),
          },
        }),
        states: {
          waiting: {
            // entry: sendTo(({ context }) => context.ponger!, { type: 'PING' }),
            entry: ({ context }, enq) => {
              enq.sendTo(context.ponger!, { type: 'PING' })
            },
            invoke: {
              id: 'ponger',
              src: pongLogic,
            },
            on: {
              PONG: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })
      const pingService = createActor(pingMachine)
      pingService.subscribe({
        complete: () => {
          resolve()
        },
      })
      pingService.start()
      yield* Effect.promise(() => promise)
      yield* expect(pingService.getSnapshot().value).toBe('success')
    })
  })
  it('should be able to spawn callback actors in (lazy) initial context', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      // types: {} as { context: { ref: CallbackActorRef<EventObject> } },
      schemas: {
        context: z.object({
          ref: z.custom<CallbackActorRef<EventObject>>(),
        }),
      },
      context: ({ spawn }) => ({
        ref: spawn(
          createCallbackLogic(({ sendBack }) => {
            sendBack({ type: 'TEST' })
          }),
        ),
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
    const actor = createActor(machine)
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    actor.start()
    yield* Effect.promise(() => promise)
    yield* expect(actor.getSnapshot().value).toBe('success')
  })
  it('should be able to spawn machines in (lazy) initial context', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const childMachine = createMachine({
      // entry: sendParent({ type: 'TEST' })
      entry: ({ parent }, enq) => {
        enq.sendTo(parent, { type: 'TEST' })
      },
    })
    const machine = createMachine({
      // types: {} as { context: { ref: ActorRefFrom<typeof childMachine> } },
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
    const actor = createActor(machine)
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    actor.start()
    yield* Effect.promise(() => promise)
    yield* expect(actor.getSnapshot().value).toBe('success')
  })
  // https://github.com/statelyai/xstate/issues/2507
  it('should not crash on child machine sync completion during self-initialization', function*({ expect }) {
    const childMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          always: {
            target: 'stopped',
          },
        },
        stopped: {
          type: 'final',
        },
      },
    })
    const parentMachine = createMachine({
      // types: {} as {
      //   context: { child: ActorRefFrom<typeof childMachine> | null };
      // },
      schemas: {
        context: z.object({
          child: z.custom<ActorRefFrom<typeof childMachine>>().nullable(),
        }),
      },
      context: {
        child: null,
      },
      entry: (_, enq) => ({
        context: {
          child: enq.spawn(childMachine),
        },
      }),
    })
    const service = createActor(parentMachine)
    const thrown = getThrown(() => service.start())
    yield* expect({ thrown, status: service.getSnapshot().status }).toEqual({ thrown: undefined, status: 'active' })
  })
  it('should not crash on child promise-like sync completion during self-initialization', function*({ expect }) {
    const promiseLogic = createAsyncLogic({
      run: () => ({ then: (fn: any) => fn(null) }) as any,
    })
    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          child: z
            .object({
              send: z.function().args(z.any()).returns(z.any()),
            })
            .nullable(),
        }),
      },
      context: {
        child: null,
      },
      // entry: assign({
      //   child: ({ spawn }) => spawn(promiseLogic)
      // })
      entry: (_, enq) => ({
        context: {
          child: enq.spawn(promiseLogic),
        },
      }),
    })
    const service = createActor(parentMachine)
    const thrown = getThrown(() => service.start())
    yield* expect({ thrown, status: service.getSnapshot().status }).toEqual({ thrown: undefined, status: 'active' })
  })
  it('should not crash on child observable sync completion during self-initialization', function*({ expect }) {
    const createEmptyObservable = (): Subscribable<any> => ({
      subscribe(observer) {
        ;(observer as Observer<any>).complete?.()
        return { unsubscribe: () => {} }
      },
    })
    const emptyObservableLogic = createObservableLogic(createEmptyObservable)
    const parentMachine = createMachine({
      // types: {} as {
      //   context: { child: ActorRefFrom<typeof emptyObservableLogic> | null };
      // },
      schemas: {
        context: z.object({
          child: z
            .object({
              send: z.function().args(z.any()).returns(z.any()),
            })
            .nullable(),
        }),
      },
      context: {
        child: null,
      },
      // entry: assign({
      //   child: ({ spawn }) => spawn(emptyObservableLogic)
      // })
      entry: (_, enq) => ({
        context: {
          child: enq.spawn(emptyObservableLogic),
        },
      }),
    })
    const service = createActor(parentMachine)
    const thrown = getThrown(() => service.start())
    yield* expect({ thrown, status: service.getSnapshot().status }).toEqual({ thrown: undefined, status: 'active' })
  })
  it(
    'should receive done event from an immediately completed observable when self-initializing',
    function*({ expect }) {
      const emptyObservable = createObservableLogic<never, undefined>(
        () => toSubscribable(EMPTY),
      )
      const parentMachine = createMachine({
        schemas: {
          context: z.object({
            child: z.custom<ActorRefFrom<typeof emptyObservable>>().nullable(),
          }),
        },
        context: {
          child: null,
        },
        // entry: assign({
        //   child: ({ spawn }) => spawn(emptyObservable, { id: 'myactor' })
        // }),
        entry: (_, enq) => ({
          context: {
            child: enq.spawn(emptyObservable, { id: 'myactor' }),
          },
        }),
        initial: 'init',
        states: {
          init: {
            on: {
              'xstate.done.actor.myactor': { target: 'done' },
            },
          },
          done: {},
        },
      })
      const service = createActor(parentMachine)
      service.start()
      yield* expect(service.getSnapshot().value).toBe('done')
    },
  )
  it('should not restart a completed observable', function*({ expect }) {
    let subscriptionCount = 0
    const machine = createMachine({
      invoke: {
        id: 'observable',
        src: createObservableLogic<number, undefined>(() => {
          subscriptionCount++
          return toSubscribable(of(42))
        }),
      },
    })
    const actor = createActor(machine).start()
    const persistedState = actor.getPersistedSnapshot()
    createActor(machine, {
      snapshot: persistedState,
    }).start()
    // Will be 2 if the observable is resubscribed
    yield* expect(subscriptionCount).toBe(1)
  })
  it('should not restart a completed event observable', function*({ expect }) {
    let subscriptionCount = 0
    const machine = createMachine({
      invoke: {
        id: 'observable',
        src: createEventObservableLogic<{ type: string }, undefined>(() => {
          subscriptionCount++
          return toSubscribable(of({ type: 'TEST' }))
        }),
      },
    })
    const actor = createActor(machine).start()
    const persistedState = actor.getPersistedSnapshot()
    createActor(machine, {
      snapshot: persistedState,
    }).start()
    // Will be 2 if the event observable is resubscribed
    yield* expect(subscriptionCount).toBe(1)
  })
  it('should be able to restart a spawned actor within a single macrostep', function*({ expect }) {
    const actual: string[] = []
    let invokeCounter = 0
    const machine = createMachine({
      // types: {} as {
      //   context: {
      //     actorRef: AnyActor;
      //   };
      // },
      schemas: {
        context: z.object({
          actorRef: z.custom<AnyActor>(),
        }),
      },
      initial: 'active',
      context: ({ spawn }) => {
        return {
          actorRef: spawn(
            createCallbackLogic(() => {
              const localId = ++invokeCounter
              actual.push(`start ${localId}`)
              return () => {
                actual.push(`stop ${localId}`)
              }
            }),
            { id: 'callback-1' },
          ),
        }
      },
      states: {
        active: {
          on: {
            //   update: {
            //     actions: [
            //       stopChild(({ context }) => {
            //         return context.actorRef;
            //       }),
            //       assign({
            //         actorRef: ({ spawn }) => {
            //           const localId = ++invokeCounter;
            //           return spawn(
            //             createCallbackLogic(() => {
            //               actual.push(`start ${localId}`);
            //               return () => {
            //                 actual.push(`stop ${localId}`);
            //               };
            //             }),
            //             { id: 'callback-2' }
            //           );
            //         }
            //       })
            //     ]
            //   }
            // }
            update: ({ context }, enq) => {
              enq.stop(context.actorRef)
              return {
                context: {
                  actorRef: enq.spawn(
                    createCallbackLogic(() => {
                      const localId = ++invokeCounter
                      actual.push(`start ${localId}`)
                      return () => {
                        actual.push(`stop ${localId}`)
                      }
                    }),
                    { id: 'callback-2' },
                  ),
                },
              }
            },
          },
        },
      },
    })
    const service = createActor(machine).start()
    actual.length = 0
    service.send({
      type: 'update',
    })
    yield* expect(actual).toEqual(['stop 1', 'start 2'])
  })
  it(
    'should be able to restart a named spawned actor within a single macrostep when stopping by a ref',
    function*({ expect }) {
      const actual: string[] = []
      let invokeCounter = 0
      const machine = createMachine({
        // types: {} as {
        //   context: {
        //     actorRef: AnyActor;
        //   };
        // },
        schemas: {
          context: z.object({
            actorRef: z.custom<AnyActor>(),
          }),
        },
        initial: 'active',
        context: ({ spawn }) => {
          return {
            actorRef: spawn(
              createCallbackLogic(() => {
                const localId = ++invokeCounter
                actual.push(`start ${localId}`)
                return () => {
                  actual.push(`stop ${localId}`)
                }
              }),
              { id: 'my_name' },
            ),
          }
        },
        states: {
          active: {
            on: {
              // update: {
              //   actions: [
              //     stopChild(({ context }) => context.actorRef),
              //     assign({
              //       actorRef: ({ spawn }) => {
              //         const localId = ++invokeCounter;
              //         return spawn(
              //           createCallbackLogic(() => {
              //             actual.push(`start ${localId}`);
              //             return () => {
              //               actual.push(`stop ${localId}`);
              //             };
              //           }),
              //           { id: 'my_name' }
              //         );
              //       }
              //     })
              //   ]
              // }
              update: ({ context }, enq) => {
                enq.stop(context.actorRef)
                return {
                  context: {
                    actorRef: enq.spawn(
                      createCallbackLogic(() => {
                        const localId = ++invokeCounter
                        actual.push(`start ${localId}`)
                        return () => {
                          actual.push(`stop ${localId}`)
                        }
                      }),
                      { id: 'my_name' },
                    ),
                  },
                }
              },
            },
          },
        },
      })
      const service = createActor(machine).start()
      actual.length = 0
      service.send({
        type: 'update',
      })
      yield* expect(actual).toEqual(['stop 1', 'start 2'])
    },
  )
  it(
    'should be able to restart a named spawned actor within a single macrostep when stopping by static name',
    function*({ expect }) {
      const actual: string[] = []
      let invokeCounter = 0
      const machine = createMachine({
        // types: {} as {
        //   context: {
        //     actorRef: AnyActor;
        //   };
        // },
        schemas: {
          context: z.object({
            actorRef: z.custom<AnyActor>(),
          }),
        },
        initial: 'active',
        context: ({ spawn }) => {
          return {
            actorRef: spawn(
              createCallbackLogic(() => {
                const localId = ++invokeCounter
                actual.push(`start ${localId}`)
                return () => {
                  actual.push(`stop ${localId}`)
                }
              }),
              { id: 'my_name' },
            ),
          }
        },
        states: {
          active: {
            on: {
              update: ({ context }, enq) => {
                enq.stop(context.actorRef)
                return {
                  context: {
                    actorRef: enq.spawn(
                      createCallbackLogic(() => {
                        const localId = ++invokeCounter
                        actual.push(`start ${localId}`)
                        return () => {
                          actual.push(`stop ${localId}`)
                        }
                      }),
                      { id: 'my_name' },
                    ),
                  },
                }
              },
            },
          },
        },
      })
      const service = createActor(machine).start()
      actual.length = 0
      service.send({
        type: 'update',
      })
      yield* expect(actual).toEqual(['stop 1', 'start 2'])
    },
  )
  it(
    'should be able to restart a named spawned actor within a single macrostep when stopping by resolved name',
    function*({ expect }) {
      const actual: string[] = []
      let invokeCounter = 0
      const machine = createMachine({
        // types: {} as {
        //   context: {
        //     actorRef: AnyActor;
        //   };
        // },
        schemas: {
          context: z.object({
            actorRef: z.custom<AnyActor>(),
          }),
        },
        initial: 'active',
        context: ({ spawn }) => {
          return {
            actorRef: spawn(
              createCallbackLogic(() => {
                const localId = ++invokeCounter
                actual.push(`start ${localId}`)
                return () => {
                  actual.push(`stop ${localId}`)
                }
              }),
              { id: 'my_name' },
            ),
          }
        },
        states: {
          active: {
            on: {
              update: ({ context }, enq) => {
                enq.stop(context.actorRef)
                return {
                  context: {
                    actorRef: enq.spawn(
                      createCallbackLogic(() => {
                        const localId = ++invokeCounter
                        actual.push(`start ${localId}`)
                        return () => {
                          actual.push(`stop ${localId}`)
                        }
                      }),
                      { id: 'my_name' },
                    ),
                  },
                }
              },
            },
          },
        },
      })
      const service = createActor(machine).start()
      actual.length = 0
      service.send({
        type: 'update',
      })
      yield* expect(actual).toEqual(['stop 1', 'start 2'])
    },
  )
  it(
    'should be possible to pass `self` as input to a child machine from within the context factory',
    function*({ expect }) {
      const calls: unknown[][] = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }
      const child = createMachine({
        schemas: {
          context: z.object({
            parent: z.custom<AnyActorRef>(),
          }),
          input: z.object({
            parent: z.custom<AnyActorRef>(),
          }),
        },
        context: ({ input }) => ({
          parent: input.parent,
        }),
        entry: ({ parent }, enq) => {
          enq.sendTo(parent, { type: 'GREET' })
        },
      })
      const machine = createMachine({
        schemas: {
          context: z.object({
            childRef: z.custom<ActorRefFrom<typeof child>>(),
          }),
        },
        context: ({ spawn, self }) => {
          return {
            childRef: spawn(child, { input: { parent: self } }),
          }
        },
        on: {
          GREET: (_, enq) => enq(record),
        },
      })
      createActor(machine).start()
      yield* expect(calls).toEqual([[]])
    },
  )
  it('catches errors from spawned promise actors', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      on: {
        event: (_, enq) => {
          enq.spawn(
            createAsyncLogic({
              run: () => Promise.reject(new Error('uh oh')),
            }),
          )
        },
      },
    })
    const actor = createActor(machine)
    let observedMessage: unknown
    actor.subscribe({
      error: (err) => {
        observedMessage = (err as Error).message
        resolve()
      },
    })
    actor.start()
    actor.send({ type: 'event' })
    yield* Effect.promise(() => promise)
    yield* expect(observedMessage).toBe('uh oh')
  })
  it.live('same-position invokes should not leak between machines', function*({ expect }) {
    const calls: unknown[][] = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }
    const sharedActors = {}
    const m1 = createMachine({
      invoke: {
        src: createAsyncLogic({ run: () => Promise.resolve('foo') }),
        onDone: ({ event }, enq) => {
          enq(record, event.output)
        },
      },
    }).provide({ actors: sharedActors })
    createMachine({
      invoke: { src: createAsyncLogic({ run: () => Promise.resolve(100) }) },
    }).provide({ actors: sharedActors })
    createActor(m1).start()
    yield* eventually(() => calls.length > 0)
    yield* expect(calls).toEqual([['foo']])
  })
  it('inline invokes should not leak into provided actors object', function*({ expect }) {
    const actors = {}
    const machine = createMachine({
      actors,
      invoke: {
        src: createAsyncLogic({ run: () => Promise.resolve('foo') }),
      },
    })
    createActor(machine).start()
    yield* expect(actors).toEqual({})
  })
  it('throws when a stopped root actor is started again', function*({ expect }) {
    const entryCalls: unknown[][] = []
    const entry = (...args: unknown[]) => {
      entryCalls.push(args)
    }
    const pingCalls: unknown[][] = []
    const pingAction = (...args: unknown[]) => {
      pingCalls.push(args)
    }
    const machine = createMachine({
      entry: (_, enq) => enq(entry),
      on: {
        PING: (_, enq) => {
          enq(pingAction)
        },
      },
    })

    const actor = createActor(machine).start()

    const initialStatus = actor.getSnapshot().status

    actor.stop()
    // Actors are single-use: restarting a stopped actor throws, and the
    // actor stays stopped.
    const restartError = getThrown(() => actor.start())
    const restartMessage = restartError instanceof Error ? restartError.message : restartError
    actor.send({ type: 'PING' })

    yield* expect({
      initialStatus,
      entryCalls,
      restartMessage,
      status: actor.getSnapshot().status,
      pingCalls,
    }).toEqual({
      initialStatus: 'active',
      entryCalls: [[]],
      restartMessage: `Actor ${actor.id} was stopped and cannot be restarted. Create a new actor with createActor().`,
      status: 'stopped',
      pingCalls: [],
    })
  })

  it('throws when an actor stopped before starting is started', function*({ expect }) {
    const actor = createActor(createMachine({}))
    actor.stop()

    yield* expect(() => actor.start()).toThrow(
      `Actor ${actor.id} was stopped and cannot be restarted. Create a new actor with createActor().`,
    )
  })
})
