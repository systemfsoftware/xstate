import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { setTimeout as sleep } from 'node:timers/promises'
import { interval, of } from 'rxjs'
import { map, take } from 'rxjs/operators'
import z from 'zod'
import {
  createAsyncLogic,
  createCallbackLogic,
  createEventObservableLogic,
  createObservableLogic,
} from '../src/actors/index.js'
import {
  type ActorLogic,
  type ActorRef,
  type ActorScope,
  type AnyEventObject,
  assertEvent,
  createActor,
  createLogic,
  createMachine,
  type EventObject,
  type Snapshot,
  type StateValue,
  types,
} from '../src/index.js'
import { toSubscribable } from './utils.js'

const user = { name: 'David' }

describe('invoke', () => {
  it('starts invoked actors after committing the parent snapshot', function*({ expect }) {
    let observedParentValue: StateValue | undefined
    const child = createCallbackLogic(
      ({
        input,
      }: {
        input: { parent: { getSnapshot: () => { value: StateValue } } }
      }) => {
        observedParentValue = input.parent.getSnapshot().value
      },
    )
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            START: {
              target: 'active',
            },
          },
        },
        active: {
          invoke: {
            src: child,
            input: ({ self }) => ({ parent: self }),
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'START' })

    yield* expect(observedParentValue).toBe('active')
  })

  it('should not provide output directly for arbitrary output events', function*({ expect }) {
    let receivedOutput: unknown = 'unset'
    const machine = createMachine({
      on: {
        CUSTOM: ({ output }) => {
          receivedOutput = output
        },
      },
    })

    createActor(machine)
      .start()
      .send({
        type: 'CUSTOM',
        output: 'not a done event output',
      } as AnyEventObject)

    yield* expect(receivedOutput).toBeUndefined()
  })

  it('child can immediately respond to the parent with multiple events', function*({ expect }) {
    const childMachine = createMachine({
      // types: {} as {
      //   events: { type: 'FORWARD_DEC' };
      // },
      id: 'child',
      initial: 'init',
      states: {
        init: {
          on: {
            FORWARD_DEC: ({ parent }, enq) => {
              enq.sendTo(parent, { type: 'DEC' })
              enq.sendTo(parent, { type: 'DEC' })
              enq.sendTo(parent, { type: 'DEC' })
            },
          },
        },
      },
    })

    const someParentMachine = createMachine(
      {
        id: 'parent',
        // types: {} as {
        //   context: { count: number };
        //   actors: {
        //     src: 'child';
        //     id: 'someService';
        //     logic: typeof childMachine;
        //   };
        // },
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        context: { count: 0 },
        initial: 'start',
        states: {
          start: {
            invoke: {
              src: childMachine,
              id: 'someService',
            },
            always: ({ context }) => {
              if (context.count === -3) {
                return { target: 'stop' }
              }
              return undefined
            },
            on: {
              DEC: ({ context }) => ({
                context: {
                  count: context.count - 1,
                },
              }),
              FORWARD_DEC: ({ children }) => {
                const someService = children['someService']
                if (someService === undefined) {
                  throw new Error('expected someService')
                }
                someService.send({ type: 'FORWARD_DEC' })
              },
            },
          },
          stop: {
            type: 'final',
          },
        },
      },
      // {
      //   actors: {
      //     child: childMachine
      //   }
      // }
    )

    const actorRef = createActor(someParentMachine).start()
    actorRef.send({ type: 'FORWARD_DEC' })

    // 1. The 'parent' machine will not do anything (inert transition)
    // 2. The 'FORWARD_DEC' event will be "forwarded" to the child machine
    // 3. On the child machine, the 'FORWARD_DEC' event sends the 'DEC' action to the parent thrice
    // 4. The context of the 'parent' machine will be updated from 0 to -3
    yield* expect(actorRef.getSnapshot().context).toEqual({ count: -3 })
  })

  it('should start services (explicit machine, invoke = config)', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const childMachine = createMachine({
      id: 'fetch',
      schemas: {
        context: z.object({
          userId: z.string().optional(),
          user: z.object({ name: z.string() }).optional(),
        }),
        events: {
          RESOLVE: z.object({ user: z.object({ name: z.string() }) }),
        },
        input: z.object({ userId: z.string() }),
      },
      context: ({ input }) => ({
        userId: input.userId,
      }),
      initial: 'pending',
      states: {
        pending: {
          entry: (_, enq) => {
            enq.raise({ type: 'RESOLVE', user })
          },
          on: {
            RESOLVE: ({ context }) => {
              if (context.userId !== undefined) {
                return { target: 'success' }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
          entry: ({ context, event }) => ({
            context: {
              user: event.user,
            },
          }),
        },
        failure: {
          entry: ({ parent }, enq) => {
            enq.sendTo(parent, { type: 'REJECT' })
          },
        },
      },
      output: ({ context }) => ({ user: context.user }),
    })

    const machine = createMachine({
      // types: {} as {
      //   context: {
      //     selectedUserId: string;
      //     user?: typeof user;
      //   };
      // },
      schemas: {
        context: z.object({
          selectedUserId: z.string(),
          user: z.object({ name: z.string() }).optional(),
        }),
      },
      id: 'fetcher',
      initial: 'idle',
      context: {
        selectedUserId: '42',
        user: undefined,
      },
      states: {
        idle: {
          on: {
            GO_TO_WAITING: { target: 'waiting' },
          },
        },
        waiting: {
          invoke: {
            src: childMachine,
            input: ({ context }) => ({
              userId: context.selectedUserId,
            }),
            onDone: ({ event }) => {
              // Should receive { user: { name: 'David' } } as event data
              if (
                (event.output as { user: { name: string } }).user.name ===
                  'David'
              ) {
                return { target: 'received' }
              }
              return undefined
            },
          },
        },
        received: {
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
    actor.send({ type: 'GO_TO_WAITING' })
    yield* Effect.promise(() => promise)

    yield* expect(actor.getSnapshot().status).toBe('done')
  })

  it('should start services (explicit machine, invoke = machine)', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const childMachine = createMachine({
      // types: {} as {
      //   events: { type: 'RESOLVE' };
      //   input: { userId: string };
      // },
      schemas: {
        events: {
          RESOLVE: z.object({}),
        },
        input: z.object({ userId: z.string() }),
      },
      initial: 'pending',
      states: {
        pending: {
          entry: (_, enq) => {
            enq.raise({ type: 'RESOLVE' })
          },
          on: {
            RESOLVE: {
              target: 'success',
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO_TO_WAITING: { target: 'waiting' },
          },
        },
        waiting: {
          invoke: {
            src: childMachine,
            onDone: { target: 'received' },
          },
        },
        received: {
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
    actor.send({ type: 'GO_TO_WAITING' })
    yield* Effect.promise(() => promise)

    yield* expect(actor.getSnapshot().status).toBe('done')
  })

  it('should start services (machine as invoke config)', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const machineInvokeMachine = createMachine({
      // types: {} as {
      //   events: {
      //     type: 'SUCCESS';
      //     data: number;
      //   };
      // },
      schemas: {
        events: {
          SUCCESS: z.object({ data: z.number() }),
        },
      },
      id: 'machine-invoke',
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createMachine({
              id: 'child',
              initial: 'sending',
              states: {
                sending: {
                  entry: ({ parent }) => {
                    parent?.send({ type: 'SUCCESS', data: 42 })
                  },
                },
              },
            }),
          },
          on: {
            SUCCESS: ({ event }) => {
              if (event.data === 42) {
                return { target: 'success' }
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
    const actor = createActor(machineInvokeMachine)
    actor.subscribe({ complete: () => resolve() })
    actor.start()
    yield* Effect.promise(() => promise)

    yield* expect(actor.getSnapshot().status).toBe('done')
  })

  it('should start deeply nested service (machine as invoke config)', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const machineInvokeMachine = createMachine({
      // types: {} as {
      //   events: {
      //     type: 'SUCCESS';
      //     data: number;
      //   };
      // },
      schemas: {
        events: {
          SUCCESS: z.object({ data: z.number() }),
        },
      },
      id: 'parent',
      initial: 'a',
      states: {
        a: {
          initial: 'b',
          states: {
            b: {
              invoke: {
                src: createMachine({
                  id: 'child',
                  initial: 'sending',
                  states: {
                    sending: {
                      entry: ({ parent }) => {
                        parent?.send({ type: 'SUCCESS', data: 42 })
                      },
                    },
                  },
                }),
              },
            },
          },
        },
        success: {
          id: 'success',
          type: 'final',
        },
      },
      on: {
        SUCCESS: ({ event }) => {
          if (event.data === 42) {
            return { target: '.success' }
          }
          return undefined
        },
      },
    })
    const actor = createActor(machineInvokeMachine)
    actor.subscribe({ complete: () => resolve() })
    actor.start()
    yield* Effect.promise(() => promise)

    yield* expect(actor.getSnapshot().status).toBe('done')
  })

  it.skip('should use the service overwritten by .provide(...)', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const childMachine = createMachine({
      id: 'child',
      initial: 'init',
      states: {
        init: {},
      },
    })

    const someParentMachine = createMachine({
      id: 'parent',
      schemas: {
        context: z.object({ count: z.number() }),
      },
      context: { count: 0 },
      initial: 'start',
      states: {
        start: {
          invoke: {
            src: childMachine,
            id: 'someService',
          },
          on: {
            STOP: { target: 'stop' },
          },
        },
        stop: {
          type: 'final',
        },
      },
    })

    const actor = createActor(
      someParentMachine.provide({
        actors: {
          child: createMachine({
            id: 'child',
            initial: 'init',
            states: {
              init: {
                entry: ({ parent }) => {
                  parent?.send({ type: 'STOP' })
                },
              },
            },
          }),
        },
      }),
    )
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    actor.start()
    yield* Effect.promise(() => promise)

    yield* expect(actor.getSnapshot().status).toBe('done')
  })

  describe('parent to child', () => {
    const subMachine = createMachine({
      id: 'child',
      initial: 'one',
      states: {
        one: {
          on: { NEXT: { target: 'two' } },
        },
        two: {
          entry: ({ parent }) => {
            parent?.send({ type: 'NEXT' })
          },
        },
      },
    })

    it.skip('should communicate with the child machine (invoke on machine)', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const mainMachine = createMachine({
        id: 'parent',
        initial: 'one',
        invoke: {
          id: 'foo-child',
          src: subMachine,
        },
        states: {
          one: {
            entry: ({ children }) => {
              // TODO: foo-child is invoked after entry is executed so it does not exist yet
              children['fooChild']?.send({ type: 'NEXT' })
            },
            on: { NEXT: { target: 'two' } },
          },
          two: {
            type: 'final',
          },
        },
      })

      const actor = createActor(mainMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().value).toBe('two')
    })

    it('should communicate with the child machine (invoke on state)', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const mainMachine = createMachine({
        id: 'parent',
        initial: 'one',
        states: {
          one: {
            invoke: {
              id: 'foo-child',
              src: subMachine,
            },
            entry: ({ children }) => {
              children['foo-child']?.send({ type: 'NEXT' })
            },
            on: { NEXT: { target: 'two' } },
          },
          two: {
            type: 'final',
          },
        },
      })

      const actor = createActor(mainMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect({ status: actor.getSnapshot().status, value: actor.getSnapshot().value }).toEqual({
        status: 'done',
        value: 'two',
      })
    })

    it(
      'should transition correctly if child invocation causes it to directly go to final state',
      function*({ expect }) {
        const doneSubMachine = createMachine({
          id: 'child',
          initial: 'one',
          states: {
            one: {
              on: { NEXT: { target: 'two' } },
            },
            two: {
              type: 'final',
            },
          },
        })

        const mainMachine = createMachine({
          id: 'parent',
          initial: 'one',
          states: {
            one: {
              invoke: {
                id: 'foo-child',
                src: doneSubMachine,
                onDone: { target: 'two' },
              },
              entry: ({ children }) => {
                children['foo-child']?.send({ type: 'NEXT' })
              },
            },
            two: {
              on: { NEXT: { target: 'three' } },
            },
            three: {
              type: 'final',
            },
          },
        })

        const actor = createActor(mainMachine).start()

        yield* expect(actor.getSnapshot().value).toBe('two')
      },
    )

    it('should work with invocations defined in orthogonal state nodes', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const pongMachine = createMachine({
        id: 'pong',
        initial: 'active',
        states: {
          active: {
            type: 'final',
          },
        },
        output: { secret: 'pingpong' },
      })

      const pingMachine = createMachine({
        id: 'ping',
        type: 'parallel',
        actors: {
          pongMachine,
        },
        states: {
          one: {
            initial: 'active',
            states: {
              active: {
                invoke: {
                  id: 'pong',
                  src: pongMachine,
                  onDone: ({ event }) => {
                    if (
                      (event.output as { secret: string }).secret === 'pingpong'
                    ) {
                      return { target: 'success' }
                    }
                    return undefined
                  },
                },
              },
              success: {
                type: 'final',
              },
            },
          },
        },
      })

      const actor = createActor(pingMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should not reinvoke root-level invocations on root non-reentering transitions', function*({ expect }) {
      // https://github.com/statelyai/xstate/issues/2147

      let invokeCount = 0
      let invokeDisposeCount = 0
      let actionsCount = 0
      let entryActionsCount = 0

      const machine = createMachine({
        invoke: {
          src: createCallbackLogic(() => {
            invokeCount++

            return () => {
              invokeDisposeCount++
            }
          }),
        },
        entry: (_, enq) => {
          enq(() => {
            entryActionsCount++
          })
        },
        on: {
          UPDATE: (_, enq) => {
            enq(() => {
              actionsCount++
            })
          },
        },
      })

      const service = createActor(machine).start()
      const afterStart = {
        entryActionsCount,
        invokeCount,
        invokeDisposeCount,
        actionsCount,
      }

      service.send({ type: 'UPDATE' })
      const afterFirstUpdate = {
        entryActionsCount,
        invokeCount,
        invokeDisposeCount,
        actionsCount,
      }

      service.send({ type: 'UPDATE' })
      const afterSecondUpdate = {
        entryActionsCount,
        invokeCount,
        invokeDisposeCount,
        actionsCount,
      }

      yield* expect({
        afterStart,
        afterFirstUpdate,
        afterSecondUpdate,
      }).toEqual({
        afterStart: {
          entryActionsCount: 1,
          invokeCount: 1,
          invokeDisposeCount: 0,
          actionsCount: 0,
        },
        afterFirstUpdate: {
          entryActionsCount: 1,
          invokeCount: 1,
          invokeDisposeCount: 0,
          actionsCount: 1,
        },
        afterSecondUpdate: {
          entryActionsCount: 1,
          invokeCount: 1,
          invokeDisposeCount: 0,
          actionsCount: 2,
        },
      })
    })

    it('should stop a child actor when reaching a final state', function*({ expect }) {
      let actorStopped = false

      const machine = createMachine({
        id: 'machine',
        invoke: {
          src: createCallbackLogic(() => {
            return () => {
              actorStopped = true
            }
          }),
          id: 'test',
        },
        initial: 'running',
        states: {
          running: {
            on: {
              finished: { target: 'complete' },
            },
          },
          complete: {
            type: 'final',
          },
        },
      })

      const service = createActor(machine).start()

      const childIdsBeforeFinishing = Object.keys(
        service.getSnapshot().children,
      )

      service.send({
        type: 'finished',
      })

      yield* expect({
        childIdsBeforeFinishing,
        status: service.getSnapshot().status,
        actorStopped,
      }).toEqual({
        childIdsBeforeFinishing: ['test'],
        status: 'done',
        actorStopped: true,
      })
    })

    it(
      'child should not invoke an actor when it transitions to an invoking state when it gets stopped by its parent',
      function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        let invokeCount = 0
        let invokeCountAtCompletion: number | undefined

        const child = createMachine({
          id: 'child',
          initial: 'idle',
          states: {
            idle: {
              invoke: {
                src: createCallbackLogic(({ sendBack }) => {
                  invokeCount++

                  if (invokeCount > 1) {
                    // prevent a potential infinite loop
                    throw new Error('This should be impossible.')
                  }

                  // it's important for this test to send the event back when the parent is *not* currently processing an event
                  // this ensures that the parent can process the received event immediately and can stop the child immediately
                  setTimeout(() => sendBack({ type: 'STARTED' }))
                }),
              },
              on: {
                STARTED: { target: 'active' },
              },
            },
            active: {
              invoke: {
                src: createCallbackLogic(({ sendBack }) => {
                  sendBack({ type: 'STOPPED' })
                }),
              },
              on: {
                STOPPED: ({ parent, event }) => {
                  parent?.send(event)
                  return { target: 'idle' }
                },
              },
            },
          },
        })
        const parent = createMachine({
          id: 'parent',
          initial: 'idle',
          states: {
            idle: {
              on: {
                START: { target: 'active' },
              },
            },
            active: {
              invoke: { src: child },
              on: {
                STOPPED: { target: 'done' },
              },
            },
            done: {
              type: 'final',
            },
          },
        })

        const service = createActor(parent)
        service.subscribe({
          complete: () => {
            invokeCountAtCompletion = invokeCount
            resolve()
          },
        })
        service.start()

        service.send({ type: 'START' })
        yield* Effect.promise(() => promise)

        yield* expect(invokeCountAtCompletion).toBe(1)
      },
    )
  })

  type PromiseExecutor = (
    resolve: (value?: any) => void,
    reject: (reason?: any) => void,
  ) => void

  const promiseTypes = [
    {
      type: 'Promise',
      createPromise(executor: PromiseExecutor): Promise<any> {
        return new Promise(executor)
      },
    },
    {
      type: 'PromiseLike',
      createPromise(executor: PromiseExecutor): PromiseLike<any> {
        // Simulate a Promise/A+ thenable / polyfilled Promise.
        function createThenable(promise: Promise<any>): PromiseLike<any> {
          return {
            then(onfulfilled, onrejected) {
              return createThenable(promise.then(onfulfilled, onrejected))
            },
          }
        }
        return createThenable(new Promise(executor))
      },
    },
  ]

  promiseTypes.forEach(({ type, createPromise }) => {
    describe(`with promises (${type})`, () => {
      const invokePromiseMachine = createMachine({
        schemas: {
          context: z.object({
            id: z.number(),
            succeed: z.boolean(),
          }),
        },
        id: 'invokePromise',
        initial: 'pending',
        context: ({
          input,
        }: {
          input: { id?: number; succeed?: boolean }
        }) => ({
          id: 42,
          succeed: true,
          ...input,
        }),
        states: {
          pending: {
            invoke: {
              src: createAsyncLogic({
                run: ({ input }) =>
                  createPromise((resolve) => {
                    if (input.succeed) {
                      resolve(input.id)
                    } else {
                      throw new Error(`failed on purpose for: ${input.id}`)
                    }
                  }),
              }),
              input: ({
                context,
              }: {
                context: { id: number; succeed: boolean }
              }) => context,
              onDone: ({ context, event }) => {
                if (event.output === context.id) {
                  return { target: 'success' }
                }
                return undefined
              },
              onError: { target: 'failure' },
            },
          },
          success: {
            type: 'final',
          },
          failure: {
            type: 'final',
          },
        },
      })

      it('should be invoked with a promise factory and resolve through onDone', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const machine = createMachine({
          initial: 'pending',
          states: {
            pending: {
              invoke: {
                src: createAsyncLogic({
                  run: () =>
                    createPromise((resolve) => {
                      resolve()
                    }),
                }),
                onDone: { target: 'success' },
              },
            },
            success: {
              type: 'final',
            },
          },
        })
        const service = createActor(machine)
        service.subscribe({
          complete: () => {
            resolve()
          },
        })
        service.start()
        yield* Effect.promise(() => promise)

        yield* expect(service.getSnapshot().status).toBe('done')
      })

      it('should be invoked with a promise factory and reject with ErrorExecution', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const actor = createActor(invokePromiseMachine, {
          input: { id: 31, succeed: false },
        })
        actor.subscribe({ complete: () => resolve() })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect(actor.getSnapshot().value).toBe('failure')
      })

      it('should be invoked with a promise factory and surface any unhandled errors', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const promiseMachine = createMachine({
          id: 'invokePromise',
          initial: 'pending',
          states: {
            pending: {
              invoke: {
                src: createAsyncLogic({
                  run: () =>
                    createPromise(() => {
                      throw new Error('test')
                    }),
                }),
                onDone: { target: 'success' },
              },
            },
            success: {
              type: 'final',
            },
          },
        })

        let receivedErrorMessage: string | undefined
        const service = createActor(promiseMachine)
        service.subscribe({
          error(err) {
            receivedErrorMessage = (err as Error).message
            resolve()
          },
        })

        service.start()
        yield* Effect.promise(() => promise)

        yield* expect(receivedErrorMessage).toEqual(
          expect.stringMatching(/test/),
        )
      })

      it('should be invoked with a promise factory and stop on unhandled onError target', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const completeCalls: Array<void> = []

        const promiseMachine = createMachine({
          id: 'invokePromise',
          initial: 'pending',
          states: {
            pending: {
              invoke: {
                src: createAsyncLogic({
                  run: () =>
                    createPromise(() => {
                      throw new Error('test')
                    }),
                }),
                onDone: { target: 'success' },
              },
            },
            success: {
              type: 'final',
            },
          },
        })

        const actor = createActor(promiseMachine)

        let receivedError: unknown
        actor.subscribe({
          error: (err) => {
            receivedError = err
            resolve()
          },
          complete: () => {
            completeCalls.push(undefined)
          },
        })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect({
          isError: receivedError instanceof Error,
          message: (receivedError as Error).message,
          completeCalls,
        }).toEqual({
          isError: true,
          message: 'test',
          completeCalls: [],
        })
      })

      it(
        'should be invoked with a promise factory and resolve through onDone for compound state nodes',
        function*({ expect }) {
          const { promise, resolve } = Promise.withResolvers<void>()
          const promiseMachine = createMachine({
            id: 'promise',
            initial: 'parent',
            states: {
              parent: {
                initial: 'pending',
                states: {
                  pending: {
                    invoke: {
                      src: createAsyncLogic({
                        run: () => createPromise((resolve) => resolve()),
                      }),
                      onDone: { target: 'success' },
                    },
                  },
                  success: {
                    type: 'final',
                  },
                },
                onDone: { target: 'success' },
              },
              success: {
                type: 'final',
              },
            },
          })
          const actor = createActor(promiseMachine)
          actor.subscribe({ complete: () => resolve() })
          actor.start()
          yield* Effect.promise(() => promise)

          yield* expect(actor.getSnapshot().status).toBe('done')
        },
      )

      it(
        'should be invoked with a promise service and resolve through onDone for compound state nodes',
        function*({ expect }) {
          const { promise, resolve } = Promise.withResolvers<void>()

          const somePromise = createAsyncLogic({
            run: () => createPromise((resolve) => resolve()),
          })
          const promiseMachine = createMachine(
            {
              id: 'promise',
              initial: 'parent',
              states: {
                parent: {
                  initial: 'pending',
                  states: {
                    pending: {
                      invoke: {
                        src: somePromise,
                        onDone: { target: 'success' },
                      },
                    },
                    success: {
                      type: 'final',
                    },
                  },
                  onDone: { target: 'success' },
                },
                success: {
                  type: 'final',
                },
              },
            },
            // {
            //   actors: {
            //     somePromise: createAsyncLogic(() =>
            //       createPromise((resolve) => resolve())
            //     )
            //   }
            // }
          )
          const actor = createActor(promiseMachine)
          actor.subscribe({ complete: () => resolve() })
          actor.start()
          yield* Effect.promise(() => promise)

          yield* expect(actor.getSnapshot().status).toBe('done')
        },
      )
      it('should assign the resolved data when invoked with a promise factory', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const promiseMachine = createMachine({
          schemas: {
            context: z.object({
              count: z.number(),
            }),
          },
          id: 'promise',
          context: { count: 0 },
          initial: 'pending',
          states: {
            pending: {
              invoke: {
                src: createAsyncLogic({
                  run: () => createPromise((resolve) => resolve({ count: 1 })),
                }),
                onDone: ({ context, event }) => ({
                  context: {
                    count: (event.output as { count: number }).count,
                  },
                  target: 'success',
                }),
              },
            },
            success: {
              type: 'final',
            },
          },
        })

        const actor = createActor(promiseMachine)
        actor.subscribe({
          complete: () => {
            resolve()
          },
        })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect(actor.getSnapshot().context.count).toEqual(1)
      })

      it('should provide resolved output directly to onDone', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const promiseMachine = createMachine({
          context: { userName: undefined as string | undefined },
          initial: 'pending',
          states: {
            pending: {
              invoke: {
                src: createAsyncLogic({
                  run: () => Promise.resolve({ name: 'David' }),
                }),
                onDone: ({ output }) => ({
                  context: {
                    userName: output.name,
                  },
                  target: 'success',
                }),
              },
            },
            success: {
              type: 'final',
            },
          },
        })

        const actor = createActor(promiseMachine)
        actor.subscribe({
          complete: () => {
            resolve()
          },
        })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect(actor.getSnapshot().context.userName).toBe('David')
      })

      it('should assign the resolved data when invoked with a promise service', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const somePromise = createAsyncLogic({
          run: () => createPromise((resolve) => resolve({ count: 1 })),
        })
        const promiseMachine = createMachine(
          {
            schemas: {
              context: z.object({
                count: z.number(),
              }),
            },
            id: 'promise',
            context: { count: 0 },
            initial: 'pending',
            states: {
              pending: {
                invoke: {
                  src: somePromise,
                  onDone: ({ context, event }) => ({
                    context: {
                      count: (event.output as { count: number }).count,
                    },
                    target: 'success',
                  }),
                },
              },
              success: {
                type: 'final',
              },
            },
          },
          // {
          //   actors: {
          //     somePromise: createAsyncLogic(() =>
          //       createPromise((resolve) => resolve({ count: 1 }))
          //     )
          //   }
          // }
        )

        const actor = createActor(promiseMachine)
        actor.subscribe({
          complete: () => {
            resolve()
          },
        })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect(actor.getSnapshot().context.count).toEqual(1)
      })

      it('should provide the resolved data when invoked with a promise factory', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        let count = 0

        const promiseMachine = createMachine({
          id: 'promise',
          schemas: {
            context: z.object({
              count: z.number(),
            }),
          },
          context: { count: 0 },
          initial: 'pending',
          states: {
            pending: {
              invoke: {
                src: createAsyncLogic({
                  run: () => createPromise((resolve) => resolve({ count: 1 })),
                }),
                onDone: ({ context, event }) => {
                  count = (event.output as { count: number }).count
                  return {
                    context: {
                      count: (event.output as { count: number }).count,
                    },
                    target: 'success',
                  }
                },
              },
            },
            success: {
              type: 'final',
            },
          },
        })

        const actor = createActor(promiseMachine)
        actor.subscribe({
          complete: () => {
            resolve()
          },
        })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect(count).toEqual(1)
      })

      it('should provide the resolved data when invoked with a promise service', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        let count = 0
        const somePromise = createAsyncLogic({
          run: () => createPromise((resolve) => resolve({ count: 1 })),
        })

        const promiseMachine = createMachine(
          {
            id: 'promise',
            initial: 'pending',
            states: {
              pending: {
                invoke: {
                  src: somePromise,
                  onDone: ({ event }, enq) => {
                    enq(() => {
                      count = (event.output as { count: number }).count
                    })
                    return {
                      target: 'success',
                    }
                  },
                },
              },
              success: {
                type: 'final',
              },
            },
          },
          // {
          //   actors: {
          //     somePromise: createAsyncLogic(() =>
          //       createPromise((resolve) => resolve({ count: 1 }))
          //     )
          //   }
          // }
        )

        const actor = createActor(promiseMachine)
        actor.subscribe({
          complete: () => {
            resolve()
          },
        })
        actor.start()
        yield* Effect.promise(() => promise)

        yield* expect(count).toEqual(1)
      })

      it('should be able to specify a Promise as a service', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()

        const promiseActor = createAsyncLogic({
          run: ({
            input,
          }: {
            input: { foo: boolean; event: { payload: any } }
          }) => {
            return createPromise((resolve, reject) => {
              input.foo && input.event.payload ? resolve() : reject()
            })
          },
        })

        const promiseMachine = createMachine(
          {
            id: 'promise',
            schemas: {
              context: z.object({
                foo: z.boolean(),
              }),
              events: {
                BEGIN: z.object({ payload: z.any() }),
              },
            },
            initial: 'pending',
            context: {
              foo: true,
            },
            states: {
              pending: {
                on: {
                  BEGIN: { target: 'first' },
                },
              },
              first: {
                invoke: {
                  src: promiseActor,
                  input: ({ context, event }) => (
                    assertEvent(event, 'BEGIN'), {
                      foo: context.foo,
                      event: event,
                    }
                  ),
                  onDone: { target: 'last' },
                },
              },
              last: {
                type: 'final',
              },
            },
          },
          // {
          //   actors: {
          //     somePromise: promiseActor
          //   }
          // }
        )

        const actor = createActor(promiseMachine)
        actor.subscribe({ complete: () => resolve() })
        actor.start()
        actor.send({
          type: 'BEGIN',
          payload: true,
        })
        yield* Effect.promise(() => promise)

        yield* expect(actor.getSnapshot().status).toBe('done')
      })

      it(
        'should be able to reuse the same promise logic multiple times and create unique promise for each created actor',
        function*({ expect }) {
          const { promise, resolve } = Promise.withResolvers<void>()
          const getRandomNumber = createAsyncLogic({
            run: () => createPromise((resolve) => resolve({ result: Math.random() })),
          })
          const machine = createMachine(
            {
              // types: {} as {
              //   context: {
              //     result1: number | null;
              //     result2: number | null;
              //   };
              //   actors: {
              //     src: 'getRandomNumber';
              //     logic: AsyncActorLogic<{ result: number }>;
              //   };
              // },
              schemas: {
                context: z.object({
                  result1: z.number().nullable(),
                  result2: z.number().nullable(),
                }),
              },
              context: {
                result1: null,
                result2: null,
              },
              initial: 'pending',
              states: {
                pending: {
                  type: 'parallel',
                  states: {
                    state1: {
                      initial: 'active',
                      states: {
                        active: {
                          invoke: {
                            src: getRandomNumber,
                            onDone: ({ context, event }) => {
                              // TODO: we get DoneInvokeEvent<any> here, this gets fixed with https://github.com/microsoft/TypeScript/pull/48838
                              return {
                                context: {
                                  result1: (event.output as { result: number })
                                    .result,
                                },
                                target: 'success',
                              }
                            },
                          },
                        },
                        success: {
                          type: 'final',
                        },
                      },
                    },
                    state2: {
                      initial: 'active',
                      states: {
                        active: {
                          invoke: {
                            src: getRandomNumber,
                            onDone: ({ context, event }) => ({
                              context: {
                                result2: (event.output as { result: number })
                                  .result,
                              },
                              target: 'success',
                            }),
                          },
                        },
                        success: {
                          type: 'final',
                        },
                      },
                    },
                  },
                  onDone: { target: 'done' },
                },
                done: {
                  type: 'final',
                },
              },
            },
            // {
            //   actors: {
            //     // it's important for this actor to be reused, this test shouldn't use a factory or anything like that
            //     getRandomNumber: createAsyncLogic(() => {
            //       return createPromise((resolve) =>
            //         resolve({ result: Math.random() })
            //       );
            //     })
            //   }
            // }
          )

          const service = createActor(machine)
          service.subscribe({
            complete: () => {
              resolve()
            },
          })
          service.start()
          yield* Effect.promise(() => promise)

          const snapshot = service.getSnapshot()
          yield* expect({
            result1Type: typeof snapshot.context.result1,
            result2Type: typeof snapshot.context.result2,
            distinct: snapshot.context.result1 !== snapshot.context.result2,
          }).toEqual({
            result1Type: 'number',
            result2Type: 'number',
            distinct: true,
          })
        },
      )

      it('should not emit onSnapshot if stopped', function*({ expect }) {
        const { promise, resolve } = Promise.withResolvers<void>()
        const machine = createMachine({
          initial: 'active',
          states: {
            active: {
              invoke: {
                src: createAsyncLogic({
                  run: () =>
                    createPromise((res) => {
                      setTimeout(() => res(42), 5)
                    }),
                }),
                onSnapshot: {},
              },
              on: {
                deactivate: { target: 'inactive' },
              },
            },
            inactive: {
              on: {
                '*': ({ event }) => {
                  if ('snapshot' in event) {
                    throw new Error(`Received unexpected event: ${event.type}`)
                  }
                },
              },
            },
          },
        })

        const actor = createActor(machine).start()
        actor.send({ type: 'deactivate' })

        setTimeout(() => {
          resolve()
        }, 10)
        yield* Effect.promise(() => promise)

        yield* expect({ status: actor.getSnapshot().status, value: actor.getSnapshot().value }).toEqual({
          status: 'active',
          value: 'inactive',
        })
      })
    })
  })

  describe('with callbacks', () => {
    it('should be able to specify a callback as a service', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      interface BeginEvent {
        type: 'BEGIN'
        payload: boolean
      }
      interface CallbackEvent {
        type: 'CALLBACK'
        data: number
      }

      const someCallback = createCallbackLogic(
        ({
          sendBack,
          input,
        }: {
          sendBack: (event: BeginEvent | CallbackEvent) => void
          input: { foo: boolean; event: BeginEvent | CallbackEvent }
        }) => {
          if (input.foo && input.event.type === 'BEGIN') {
            sendBack({
              type: 'CALLBACK',
              data: 40,
            })
            sendBack({
              type: 'CALLBACK',
              data: 41,
            })
            sendBack({
              type: 'CALLBACK',
              data: 42,
            })
          }
        },
      )

      const callbackMachine = createMachine(
        {
          id: 'callback',
          // types: {} as {
          //   context: { foo: boolean };
          //   events: BeginEvent | CallbackEvent;
          //   actors: {
          //     src: 'someCallback';
          //     logic: typeof someCallback;
          //   };
          // },
          schemas: {
            context: z.object({
              foo: z.boolean(),
            }),

            events: {
              BEGIN: z.object({ payload: z.any() }),
              CALLBACK: z.object({ data: z.number() }),
            },
          },
          initial: 'pending',
          context: {
            foo: true,
          },
          states: {
            pending: {
              on: {
                BEGIN: { target: 'first' },
              },
            },
            first: {
              invoke: {
                src: someCallback,
                input: ({ context, event }) => ({
                  foo: context.foo,
                  event: event,
                }),
              },
              on: {
                CALLBACK: ({ event }) => {
                  if (event.data === 42) {
                    return { target: 'last' }
                  }
                  return undefined
                },
              },
            },
            last: {
              type: 'final',
            },
          },
        },
        // {
        //   actors: {
        //     someCallback
        //   }
        // }
      )

      const actor = createActor(callbackMachine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()
      actor.send({
        type: 'BEGIN',
        payload: true,
      })
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should transition correctly if callback function sends an event', function*({ expect }) {
      const someCallback = createCallbackLogic(({ sendBack }) => {
        sendBack({ type: 'CALLBACK' })
      })
      const callbackMachine = createMachine({
        id: 'callback',
        schemas: {
          context: z.object({
            foo: z.boolean(),
          }),
        },
        initial: 'pending',
        context: { foo: true },
        states: {
          pending: {
            on: { BEGIN: { target: 'first' } },
          },
          first: {
            invoke: {
              src: someCallback,
            },
            on: { CALLBACK: { target: 'intermediate' } },
          },
          intermediate: {
            on: { NEXT: { target: 'last' } },
          },
          last: {
            type: 'final',
          },
        },
      })

      const expectedStateValues = ['pending', 'first', 'intermediate']
      const stateValues: StateValue[] = []
      const actor = createActor(callbackMachine)
      actor.subscribe((current) => stateValues.push(current.value))
      actor.start().send({ type: 'BEGIN' })
      yield* expect(stateValues.slice(0, expectedStateValues.length)).toEqual(
        expectedStateValues,
      )
    })

    it('should transition correctly if callback function invoked from start and sends an event', function*({ expect }) {
      const someCallback = createCallbackLogic(({ sendBack }) => {
        sendBack({ type: 'CALLBACK' })
      })
      const callbackMachine = createMachine({
        id: 'callback',
        schemas: {
          context: z.object({
            foo: z.boolean(),
          }),
        },
        initial: 'idle',
        context: { foo: true },
        states: {
          idle: {
            invoke: {
              src: someCallback,
            },
            on: { CALLBACK: { target: 'intermediate' } },
          },
          intermediate: {
            on: { NEXT: { target: 'last' } },
          },
          last: {
            type: 'final',
          },
        },
      })

      const expectedStateValues = ['idle', 'intermediate']
      const stateValues: StateValue[] = []
      const actor = createActor(callbackMachine)
      actor.subscribe((current) => stateValues.push(current.value))
      actor.start().send({ type: 'BEGIN' })
      yield* expect(stateValues.slice(0, expectedStateValues.length)).toEqual(
        expectedStateValues,
      )
    })

    // tslint:disable-next-line:max-line-length
    it(
      'should transition correctly if transient transition happens before current state invokes callback function and sends an event',
      function*({ expect }) {
        const someCallback = createCallbackLogic(({ sendBack }) => {
          sendBack({ type: 'CALLBACK' })
        })
        const callbackMachine = createMachine(
          {
            id: 'callback',
            schemas: {
              context: z.object({
                foo: z.boolean(),
              }),
            },
            initial: 'pending',
            context: { foo: true },
            states: {
              pending: {
                on: { BEGIN: { target: 'first' } },
              },
              first: {
                always: { target: 'second' },
              },
              second: {
                invoke: {
                  src: someCallback,
                },
                on: { CALLBACK: { target: 'third' } },
              },
              third: {
                on: { NEXT: { target: 'last' } },
              },
              last: {
                type: 'final',
              },
            },
          },
          // {
          //   actors: {
          //     someCallback: createCallbackLogic(({ sendBack }) => {
          //       sendBack({ type: 'CALLBACK' });
          //     })
          //   }
          // }
        )

        const expectedStateValues = ['pending', 'second', 'third']
        const stateValues: StateValue[] = []
        const actor = createActor(callbackMachine)
        actor.subscribe((current) => {
          stateValues.push(current.value)
        })
        actor.start().send({ type: 'BEGIN' })

        yield* expect(stateValues.slice(0, expectedStateValues.length)).toEqual(
          expectedStateValues,
        )
      },
    )

    it('should treat a callback source as an event stream', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const intervalMachine = createMachine({
        // types: {} as { context: { count: number } },
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        id: 'interval',
        initial: 'counting',
        context: {
          count: 0,
        },
        states: {
          counting: {
            invoke: {
              id: 'intervalService',
              src: createCallbackLogic(({ sendBack }) => {
                const ivl = setInterval(() => {
                  sendBack({ type: 'INC' })
                }, 10)

                return () => clearInterval(ivl)
              }),
            },
            always: ({ context }) => {
              if (context.count === 3) {
                return { target: 'finished' }
              }
              return undefined
            },
            on: {
              INC: ({ context }) => ({
                context: {
                  count: context.count + 1,
                },
              }),
            },
          },
          finished: {
            type: 'final',
          },
        },
      })
      const actor = createActor(intervalMachine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should dispose of the callback (if disposal function provided)', function*({ expect }) {
      const disposalCalls: number[] = []
      let disposals = 0
      const intervalMachine = createMachine({
        id: 'interval',
        initial: 'counting',
        states: {
          counting: {
            invoke: {
              id: 'intervalService',
              src: createCallbackLogic(() => () => {
                disposals += 1
                disposalCalls.push(disposals)
              }),
            },
            on: {
              NEXT: { target: 'idle' },
            },
          },
          idle: {},
        },
      })
      const actorRef = createActor(intervalMachine).start()

      actorRef.send({ type: 'NEXT' })

      yield* expect(disposalCalls).toEqual([1])
    })

    it('callback should be able to receive messages from parent', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const pingPongMachine = createMachine({
        id: 'ping-pong',
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'child',
              src: createCallbackLogic(({ sendBack, receive }) => {
                receive((e) => {
                  if (e.type === 'PING') {
                    sendBack({ type: 'PONG' })
                  }
                })
              }),
            },
            entry: ({ children }) => {
              children['child']?.send({ type: 'PING' })
            },
            on: {
              PONG: { target: 'done' },
            },
          },
          done: {
            type: 'final',
          },
        },
      })
      const actor = createActor(pingPongMachine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should call onError upon error (sync)', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const errorMachine = createMachine({
        id: 'error',
        initial: 'safe',
        states: {
          safe: {
            invoke: {
              src: createCallbackLogic(() => {
                throw new Error('test')
              }),
              onError: ({ event }) => {
                if (
                  event.error instanceof Error &&
                  event.error.message === 'test'
                ) {
                  return { target: 'failed' }
                }
                return undefined
              },
            },
          },
          failed: {
            type: 'final',
          },
        },
      })
      const actor = createActor(errorMachine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should transition correctly upon error (sync)', function*({ expect }) {
      const errorMachine = createMachine({
        id: 'error',
        initial: 'safe',
        states: {
          safe: {
            invoke: {
              src: createCallbackLogic(() => {
                throw new Error('test')
              }),
              onError: { target: 'failed' },
            },
          },
          failed: {
            on: { RETRY: { target: 'safe' } },
          },
        },
      })

      const expectedStateValue = 'failed'
      const service = createActor(errorMachine).start()
      yield* expect(service.getSnapshot().value).toEqual(expectedStateValue)
    })

    it('should call onError only on the state which has invoked failed service', function*({ expect }) {
      const errorMachine = createMachine({
        initial: 'start',
        states: {
          start: {
            on: {
              FETCH: { target: 'fetch' },
            },
          },
          fetch: {
            type: 'parallel',
            states: {
              first: {
                initial: 'waiting',
                states: {
                  waiting: {
                    invoke: {
                      src: createCallbackLogic(() => {
                        throw new Error('test')
                      }),
                      onError: {
                        target: 'failed',
                      },
                    },
                  },
                  failed: {},
                },
              },
              second: {
                initial: 'waiting',
                states: {
                  waiting: {
                    invoke: {
                      src: createCallbackLogic(() => {
                        // empty
                        return () => {}
                      }),
                      onError: {
                        target: 'failed',
                      },
                    },
                  },
                  failed: {},
                },
              },
            },
          },
        },
      })

      const actorRef = createActor(errorMachine).start()
      actorRef.send({ type: 'FETCH' })

      yield* expect(actorRef.getSnapshot().value).toEqual({
        fetch: { first: 'failed', second: 'waiting' },
      })
    })

    it('should be able to be stringified', function*({ expect }) {
      const machine = createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: {
              GO_TO_WAITING: { target: 'waiting' },
            },
          },
          waiting: {
            invoke: {
              src: createCallbackLogic(() => {}),
            },
          },
        },
      })
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'GO_TO_WAITING' })
      const waitingState = actorRef.getSnapshot()

      const serializedWaitingState = JSON.stringify(waitingState)

      yield* expect(serializedWaitingState).toSatisfy(
        (json: string) => json.length > 0,
        'the waiting state serializes to a non-empty string',
      )
    })

    it(
      'should result in an error notification if callback actor throws when it starts and the error stays unhandled by the machine',
      function*({ expect }) {
        const errorMachine = createMachine({
          initial: 'safe',
          states: {
            safe: {
              invoke: {
                src: createCallbackLogic(() => {
                  throw new Error('test')
                }),
              },
            },
            failed: {
              type: 'final',
            },
          },
        })
        const errorCalls: Array<Array<{ isError: boolean; message: string }>> = []

        const actorRef = createActor(errorMachine)
        actorRef.subscribe({
          error: (err) => {
            errorCalls.push([
              { isError: err instanceof Error, message: (err as Error).message },
            ])
          },
        })
        actorRef.start()
        yield* expect(errorCalls).toEqual([[{ isError: true, message: 'test' }]])
      },
    )

    it('should work with input', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let receivedInput: unknown
      const machine = createMachine({
        // types: {} as {
        //   context: { foo: string };
        // },
        schemas: {
          context: z.object({
            foo: z.string(),
          }),
        },
        initial: 'start',
        context: { foo: 'bar' },
        states: {
          start: {
            invoke: {
              src: createCallbackLogic(({ input }) => {
                receivedInput = input
                resolve()
              }),
              input: ({ context }: { context: { foo: string } }) => context,
            },
          },
        },
      })

      createActor(machine).start()
      yield* Effect.promise(() => promise)

      yield* expect(receivedInput).toEqual({ foo: 'bar' })
    })

    it('sub invoke race condition ends on the completed state', function*({ expect }) {
      const anotherChildMachine = createMachine({
        id: 'child',
        initial: 'start',
        states: {
          start: {
            on: { STOP: { target: 'end' } },
          },
          end: {
            type: 'final',
          },
        },
      })

      const anotherParentMachine = createMachine({
        id: 'parent',
        initial: 'begin',
        states: {
          begin: {
            invoke: {
              src: anotherChildMachine,
              id: 'invoked.child',
              onDone: { target: 'completed' },
            },
            on: {
              STOPCHILD: ({ children }) => {
                const invokedChild = children['invoked.child']
                if (invokedChild === undefined) {
                  throw new Error('expected invoked.child')
                }
                invokedChild.send({ type: 'STOP' })
              },
            },
          },
          completed: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(anotherParentMachine).start()
      actorRef.send({ type: 'STOPCHILD' })

      yield* expect(actorRef.getSnapshot().value).toEqual('completed')
    })
  })

  describe('with observables', () => {
    it('should work with an infinite observable', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const obsMachine = createMachine({
        // types: {} as { context: { count: number | undefined }; events: Events },
        schemas: {
          context: z.object({
            count: z.number().optional(),
          }),
        },
        id: 'infiniteObs',
        initial: 'counting',
        context: { count: undefined },
        states: {
          counting: {
            invoke: {
              src: createObservableLogic<number, undefined>(() => toSubscribable(interval(10))),
              onSnapshot: ({ event }) => ({
                context: {
                  count: event.snapshot.context,
                },
              }),
            },
            always: ({ context }) => {
              if (context.count === 5) {
                return { target: 'counted' }
              }
              return undefined
            },
          },
          counted: {
            type: 'final',
          },
        },
      })

      const service = createActor(obsMachine)
      service.subscribe({
        complete: () => {
          resolve()
        },
      })
      service.start()
      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().status).toBe('done')
    })

    it('should work with a finite observable', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const obsMachine = createMachine({
        // types: {} as { context: Ctx; events: Events },
        schemas: {
          context: z.object({
            count: z.number().optional(),
          }),
        },
        id: 'obs',
        initial: 'counting',
        context: {
          count: undefined,
        },
        states: {
          counting: {
            invoke: {
              src: createObservableLogic<number, undefined>(() => toSubscribable(interval(10).pipe(take(5)))),
              onSnapshot: ({ event }) => ({
                context: {
                  count: event.snapshot.context,
                },
              }),
              onDone: ({ context }) => {
                if (context.count === 4) {
                  return { target: 'counted' }
                }
                return undefined
              },
            },
          },
          counted: {
            type: 'final',
          },
        },
      })

      const actor = createActor(obsMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should receive an emitted error', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let receivedErrorMessage: string | undefined
      const obsMachine = createMachine({
        // types: {} as { context: Ctx; events: Events },
        schemas: {
          context: z.object({
            count: z.number().optional(),
          }),
        },
        id: 'obs',
        initial: 'counting',
        context: { count: undefined },
        states: {
          counting: {
            invoke: {
              src: createObservableLogic<number, undefined>(() =>
                toSubscribable(
                  interval(10).pipe(
                    map((value) => {
                      if (value === 5) {
                        throw new Error('some error')
                      }

                      return value
                    }),
                  ),
                )
              ),
              onSnapshot: ({ event }) => ({
                context: {
                  count: event.snapshot.context,
                },
              }),
              onError: ({ context, event }) => {
                receivedErrorMessage = (event.error as Error).message
                if (
                  context.count === 4 &&
                  (event.error as Error).message === 'some error'
                ) {
                  return { target: 'success' }
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

      const actor = createActor(obsMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(receivedErrorMessage).toEqual('some error')
    })

    it('should work with input', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let observedSnapshotContext: unknown
      const childLogic = createObservableLogic<number, number>(({ input }: { input: number }) =>
        toSubscribable(of(input))
      )

      const machine = createMachine({
        schemas: {
          context: z.object({
            received: z.number().optional(),
          }),
        },
        context: { received: undefined },
        invoke: {
          src: childLogic,
          input: () => 42,
          onSnapshot: ({ event }, enq) => {
            observedSnapshotContext = event.snapshot.context
            if (
              event.snapshot.status === 'active' &&
              event.snapshot.context === 42
            ) {
              enq(() => {
                resolve()
              })
            }
          },
        },
      })

      createActor(machine).start()
      yield* Effect.promise(() => promise)

      yield* expect(observedSnapshotContext).toEqual(42)
    })
  })

  describe('with event observables', () => {
    it('should work with an infinite event observable', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const obsMachine = createMachine({
        // types: {} as { context: { count: number | undefined }; events: Events },
        schemas: {
          context: z.object({
            count: z.number().optional(),
          }),
          events: {
            COUNT: z.object({ value: z.number() }),
          },
        },
        id: 'obs',
        initial: 'counting',
        context: { count: undefined },
        states: {
          counting: {
            invoke: {
              src: createEventObservableLogic<
                { type: string; value: number },
                undefined
              >(() =>
                toSubscribable(
                  interval(10).pipe(map((value) => ({ type: 'COUNT', value }))),
                )
              ),
            },
            on: {
              COUNT: ({ context, event }) => ({
                context: {
                  count: event.value,
                },
              }),
            },
            always: ({ context }) => {
              if (context.count === 5) {
                return { target: 'counted' }
              }
              return undefined
            },
          },
          counted: {
            type: 'final',
          },
        },
      })

      const service = createActor(obsMachine)
      service.subscribe({
        complete: () => {
          resolve()
        },
      })
      service.start()
      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().status).toBe('done')
    })

    it('should work with a finite event observable', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const obsMachine = createMachine({
        // types: {} as { context: Ctx; events: Events },
        schemas: {
          context: z.object({
            count: z.number().optional(),
          }),
          events: {
            COUNT: z.object({ value: z.number() }),
          },
        },
        id: 'obs',
        initial: 'counting',
        context: {
          count: undefined,
        },
        states: {
          counting: {
            invoke: {
              src: createEventObservableLogic<
                { type: string; value: number },
                undefined
              >(() =>
                toSubscribable(
                  interval(10).pipe(
                    take(5),
                    map((value) => ({ type: 'COUNT', value })),
                  ),
                )
              ),
              onDone: ({ context }) => {
                if (context.count === 4) {
                  return { target: 'counted' }
                }
                return undefined
              },
            },
            on: {
              COUNT: ({ context, event }) => ({
                context: {
                  count: event.value,
                },
              }),
            },
          },
          counted: {
            type: 'final',
          },
        },
      })

      const actor = createActor(obsMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should receive an emitted error', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let receivedErrorMessage: string | undefined
      const obsMachine = createMachine({
        // types: {} as { context: Ctx; events: Events },
        schemas: {
          context: z.object({
            count: z.number().optional(),
          }),
          events: {
            COUNT: z.object({ value: z.number() }),
          },
        },
        id: 'obs',
        initial: 'counting',
        context: { count: undefined },
        states: {
          counting: {
            invoke: {
              src: createEventObservableLogic<
                { type: string; value: number },
                undefined
              >(() =>
                toSubscribable(
                  interval(10).pipe(
                    map((value) => {
                      if (value === 5) {
                        throw new Error('some error')
                      }

                      return { type: 'COUNT', value }
                    }),
                  ),
                )
              ),
              onError: ({ context, event }) => {
                receivedErrorMessage = (event.error as Error).message
                if (
                  context.count === 4 &&
                  (event.error as Error).message === 'some error'
                ) {
                  return { target: 'success' }
                }
                return undefined
              },
            },
            on: {
              COUNT: ({ context, event }) => ({
                context: {
                  count: event.value,
                },
              }),
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const actor = createActor(obsMachine)
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(receivedErrorMessage).toEqual('some error')
    })

    it('should work with input', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let receivedValue: number | undefined
      const childLogic = createEventObservableLogic<
        { type: string; value: number },
        number
      >(({ input }) =>
        toSubscribable(
          of({
            type: 'obs.event',
            value: input,
          }),
        )
      )
      const machine = createMachine({
        schemas: {
          events: {
            'obs.event': z.object({ value: z.number() }),
          },
        },
        invoke: {
          src: () => childLogic,
          input: () => 42,
        },
        on: {
          'obs.event': ({ event }, enq) => {
            receivedValue = event.value
            enq(() => {
              resolve()
            })
          },
        },
      })

      createActor(machine).start()
      yield* Effect.promise(() => promise)

      yield* expect(receivedValue).toEqual(42)
    })
  })

  describe('with logic', () => {
    it('should work with actor logic', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const countLogic: ActorLogic<
        Snapshot<undefined> & { context: number },
        EventObject
      > = {
        transition: (state, event) => {
          if (event.type === 'INC') {
            return [
              {
                ...state,
                context: state.context + 1,
              },
              [],
            ]
          } else if (event.type === 'DEC') {
            return [
              {
                ...state,
                context: state.context - 1,
              },
              [],
            ]
          }
          return [state, []]
        },
        getInitialSnapshot: () => ({
          status: 'active',
          output: undefined,
          error: undefined,
          context: 0,
        }),
        initialTransition: () => [
          {
            status: 'active',
            output: undefined,
            error: undefined,
            context: 0,
          },
          [],
        ],
        getPersistedSnapshot: (s) => s,
      }

      const countMachine = createMachine({
        invoke: {
          id: 'count',
          src: countLogic,
        },
        on: {
          INC: ({ children, event }) => {
            const countChild = children['count']
            if (countChild === undefined) {
              throw new Error('expected count child')
            }
            countChild.send(event)
          },
        },
      })

      const countService = createActor(countMachine)
      countService.subscribe((state) => {
        if (state.children['count']?.getSnapshot().context === 2) {
          resolve()
        }
      })
      countService.start()

      countService.send({ type: 'INC' })
      countService.send({ type: 'INC' })
      yield* Effect.promise(() => promise)

      yield* expect(countService.getSnapshot().children['count']?.getSnapshot().context).toEqual(2)
    })

    it('logic should have reference to the parent', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
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
        initial: 'waiting',
        states: {
          waiting: {
            entry: ({ children }) => {
              children['ponger']?.send({ type: 'PING' })
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

      yield* expect(pingService.getSnapshot().status).toBe('done')
    })
  })

  describe('with transition functions', () => {
    it('should work with a transition function', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const countReducer = (
        count: number,
        event: { type: 'INC' } | { type: 'DEC' },
      ): number => {
        if (event.type === 'INC') {
          return count + 1
        } else if (event.type === 'DEC') {
          return count - 1
        }
        return count
      }

      const countMachine = createMachine({
        invoke: {
          id: 'count',
          src: createLogic({
            context: 0,
            run: ({ context, event }) => ({
              context: countReducer(context, event as any),
            }),
          }),
        },
        on: {
          INC: ({ children, event }) => {
            const countChild = children['count']
            if (countChild === undefined) {
              throw new Error('expected count child')
            }
            countChild.send(event)
          },
        },
      })

      const countService = createActor(countMachine)
      countService.subscribe((state) => {
        if (state.children['count']?.getSnapshot().context === 2) {
          resolve()
        }
      })
      countService.start()

      countService.send({ type: 'INC' })
      countService.send({ type: 'INC' })
      yield* Effect.promise(() => promise)

      yield* expect(countService.getSnapshot().children['count']?.getSnapshot().context).toEqual(2)
    })

    it('should schedule events in a FIFO queue', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      type CountEvents = { type: 'INC' } | { type: 'DOUBLE' }

      const countReducer = (
        count: number,
        event: CountEvents,
        { self }: ActorScope<Snapshot<unknown>, CountEvents>,
      ): number => {
        if (event.type === 'INC') {
          self.send({ type: 'DOUBLE' })
          return count + 1
        }
        if (event.type === 'DOUBLE') {
          return count * 2
        }

        return count
      }

      const countMachine = createMachine({
        invoke: {
          id: 'count',
          src: createLogic<number, undefined, CountEvents>({
            context: 0,
            run: ({ context, event, self }) => ({
              context: countReducer(context, event, { self } as any),
            }),
          }),
        },
        on: {
          INC: ({ children, event }) => {
            const countChild = children['count']
            if (countChild === undefined) {
              throw new Error('expected count child')
            }
            countChild.send(event)
          },
        },
      })

      const countService = createActor(countMachine)
      countService.subscribe((state) => {
        if (state.children['count']?.getSnapshot().context === 2) {
          resolve()
        }
      })
      countService.start()

      countService.send({ type: 'INC' })
      yield* Effect.promise(() => promise)

      yield* expect(countService.getSnapshot().children['count']?.getSnapshot().context).toEqual(2)
    })

    it('should emit onSnapshot', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let observedContext: number | undefined
      const doublerLogic = createLogic({
        context: 0,
        run: ({ event }: { event: { type: 'update'; value: number } }) => ({
          context: event.value * 2,
        }),
      })
      const machine = createMachine({
        invoke: {
          id: 'doubler',
          src: doublerLogic,
          onSnapshot: ({ event }, enq) => {
            observedContext = event.snapshot.context
            if (event.snapshot.context === 42) {
              enq(() => {
                resolve()
              })
            }
          },
        },
        entry: ({ children }) => {
          children['doubler']?.send({ type: 'update', value: 21 })
        },
      })

      createActor(machine).start()
      yield* Effect.promise(() => promise)

      yield* expect(observedContext).toEqual(42)
    })
  })

  describe('with machines', () => {
    const pongMachine = createMachine({
      id: 'pong',
      initial: 'active',
      states: {
        active: {
          on: {
            PING: ({ parent }) => {
              // Sends 'PONG' event to parent machine
              parent?.send({ type: 'PONG' })
            },
          },
        },
      },
    })

    // Parent machine
    const pingMachine = createMachine({
      id: 'ping',
      initial: 'innerMachine',
      states: {
        innerMachine: {
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'pong',
                src: pongMachine,
              },
              // Sends 'PING' event to child machine with ID 'pong'
              entry: ({ children }) => {
                children['pong']?.send({ type: 'PING' })
              },
              on: {
                PONG: { target: 'innerSuccess' },
              },
            },
            innerSuccess: {
              type: 'final',
            },
          },
          onDone: { target: 'success' },
        },
        success: { type: 'final' },
      },
    })

    it('should create invocations from machines in nested states', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const actor = createActor(pingMachine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()
      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().status).toBe('done')
    })

    it('should emit onSnapshot', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let observedValue: unknown
      const childMachine = createMachine({
        initial: 'a',
        states: {
          a: {
            after: {
              10: { target: 'b' },
            },
          },
          b: {},
        },
      })
      const machine = createMachine({
        invoke: {
          src: childMachine,
          onSnapshot: ({ event }, enq) => {
            observedValue = event.snapshot.value
            if (event.snapshot.value === 'b') {
              enq(() => {
                resolve()
              })
            }
          },
        },
      })

      createActor(machine).start()
      yield* Effect.promise(() => promise)

      yield* expect(observedValue).toEqual('b')
    })
  })

  describe('multiple simultaneous services', () => {
    const multiple = createMachine({
      schemas: {
        context: z.object({
          one: z.string().optional(),
          two: z.string().optional(),
        }),
      },
      id: 'machine',
      initial: 'one',
      context: {},
      on: {
        ONE: ({ context }) => ({
          context: {
            one: 'one',
          },
        }),

        TWO: {
          context: {
            two: 'two',
          },
          target: '.three',
        },
      },

      states: {
        one: {
          initial: 'two',
          states: {
            two: {
              invoke: [
                {
                  id: 'child',
                  src: createCallbackLogic(({ sendBack }) => sendBack({ type: 'ONE' })),
                },
                {
                  id: 'child2',
                  src: createCallbackLogic(({ sendBack }) => sendBack({ type: 'TWO' })),
                },
              ],
            },
          },
        },
        three: {
          type: 'final',
        },
      },
    })

    it('should start all services at once', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const service = createActor(multiple)
      service.subscribe({
        complete: () => {
          resolve()
        },
      })

      service.start()
      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().context).toEqual({
        one: 'one',
        two: 'two',
      })
    })

    const parallel = createMachine({
      schemas: {
        context: z.object({
          one: z.string().optional(),
          two: z.string().optional(),
        }),
      },
      id: 'machine',
      initial: 'one',

      context: {},

      on: {
        ONE: ({ context }) => ({
          context: {
            one: 'one',
          },
        }),

        TWO: ({ context }) => ({
          context: {
            two: 'two',
          },
        }),
      },

      after: {
        // allow both invoked services to get a chance to send their events
        // and don't depend on a potential race condition (with an immediate transition)
        10: { target: '.three' },
      },

      states: {
        one: {
          initial: 'two',
          states: {
            two: {
              type: 'parallel',
              states: {
                a: {
                  invoke: {
                    id: 'child',
                    src: createCallbackLogic(({ sendBack }) => sendBack({ type: 'ONE' })),
                  },
                },
                b: {
                  invoke: {
                    id: 'child2',
                    src: createCallbackLogic(({ sendBack }) => sendBack({ type: 'TWO' })),
                  },
                },
              },
            },
          },
        },
        three: {
          type: 'final',
        },
      },
    })

    it('should run services in parallel', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const service = createActor(parallel)
      service.subscribe({
        complete: () => {
          resolve()
        },
      })

      service.start()
      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().context).toEqual({
        one: 'one',
        two: 'two',
      })
    })

    it(
      'should not invoke an actor if it gets stopped immediately by transitioning away in immediate microstep',
      function*({ expect }) {
        // Since an actor will be canceled when the state machine leaves the invoking state
        // it does not make sense to start an actor in a state that will be exited immediately
        let actorStarted = false

        const transientMachine = createMachine({
          id: 'transient',
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'doNotInvoke',
                src: createCallbackLogic(() => {
                  actorStarted = true
                }),
              },
              always: { target: 'inactive' },
            },
            inactive: {},
          },
        })

        const service = createActor(transientMachine)

        service.start()

        yield* expect({ actorStarted }).toEqual({ actorStarted: false })
      },
    )

    // tslint:disable-next-line: max-line-length
    it(
      'should not invoke an actor if it gets stopped immediately by transitioning away in subsequent microstep',
      function*({ expect }) {
        // Since an actor will be canceled when the state machine leaves the invoking state
        // it does not make sense to start an actor in a state that will be exited immediately
        let actorStarted = false

        const transientMachine = createMachine({
          initial: 'withNonLeafInvoke',
          states: {
            withNonLeafInvoke: {
              invoke: {
                id: 'doNotInvoke',
                src: createCallbackLogic(() => {
                  actorStarted = true
                }),
              },
              initial: 'first',
              states: {
                first: {
                  always: { target: 'second' },
                },
                second: {
                  always: { target: '#inactive' },
                },
              },
            },
            inactive: {
              id: 'inactive',
            },
          },
        })

        const service = createActor(transientMachine)

        service.start()

        yield* expect({ actorStarted }).toEqual({ actorStarted: false })
      },
    )

    it('should invoke a service if other service gets stopped in subsequent microstep (#1180)', function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      const machine = createMachine({
        initial: 'running',
        states: {
          running: {
            type: 'parallel',
            states: {
              one: {
                initial: 'active',
                on: {
                  STOP_ONE: { target: '.idle' },
                },
                states: {
                  idle: {},
                  active: {
                    invoke: {
                      id: 'active',
                      src: createCallbackLogic(() => {
                        /* ... */
                      }),
                    },
                    on: {
                      NEXT: (_, enq) => {
                        enq.raise({ type: 'STOP_ONE' })
                      },
                    },
                  },
                },
              },
              two: {
                initial: 'idle',
                on: {
                  NEXT: { target: '.active' },
                },
                states: {
                  idle: {},
                  active: {
                    invoke: {
                      id: 'post',
                      src: createAsyncLogic({ run: () => Promise.resolve(42) }),
                      onDone: { target: '#done' },
                    },
                  },
                },
              },
            },
          },
          done: {
            id: 'done',
            type: 'final',
          },
        },
      })

      const service = createActor(machine)
      service.subscribe({ complete: () => resolve() })
      service.start()

      service.send({ type: 'NEXT' })
      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().status).toBe('done')
    })

    it.skip('should invoke an actor when reentering invoking state within a single macrostep', function*({ expect }) {
      let actorStartedCount = 0

      const transientMachine = createMachine({
        // types: {} as { context: { counter: number } },
        schemas: {
          context: z.object({
            counter: z.number(),
          }),
        },
        initial: 'active',
        context: { counter: 0 },
        states: {
          active: {
            invoke: {
              src: createCallbackLogic(() => {
                actorStartedCount++
              }),
            },
            always: ({ context }) => {
              if (context.counter === 0) {
                return { target: 'inactive' }
              }
              return undefined
            },
          },
          inactive: {
            entry: ({ context }) => ({
              context: {
                counter: context.counter + 1,
              },
            }),
            always: { target: 'active' },
          },
        },
      })

      const service = createActor(transientMachine)

      service.start()

      yield* expect(actorStartedCount).toBe(1)
    })
  })

  it('invoke `src` can be used with invoke `input`', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let receivedEndpoint: string | undefined
    const machine = createMachine({
      initial: 'searching',
      states: {
        searching: {
          invoke: {
            src: createAsyncLogic({
              run: ({ input }: { input: { endpoint: string } }) => {
                receivedEndpoint = input.endpoint

                return Promise.resolve(42)
              },
            }),
            input: {
              endpoint: 'example.com',
            },
            onDone: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      } as any,
    })
    const actor = createActor(machine)
    actor.subscribe({ complete: () => resolve() })
    actor.start()
    yield* Effect.promise(() => promise)

    yield* expect(receivedEndpoint).toEqual('example.com')
  })

  it('invoke `src` can be used with dynamic invoke `input`', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let receivedEndpoint: string | undefined
    const machine = createMachine({
      initial: 'searching',
      schemas: {
        context: z.object({
          url: z.string(),
        }),
      },
      context: {
        url: 'example.com',
      },
      states: {
        searching: {
          invoke: {
            src: createAsyncLogic({
              run: ({ input }) => {
                receivedEndpoint = input.endpoint

                return Promise.resolve(42)
              },
            }),
            input: ({ context }: { context: { url: string } }) => ({
              endpoint: context.url,
            }),
            onDone: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actor = createActor(machine)
    actor.subscribe({ complete: () => resolve() })
    actor.start()
    yield* Effect.promise(() => promise)

    yield* expect(receivedEndpoint).toEqual('example.com')
  })

  it('dynamic invoke `input` should receive the context updated by the same transition', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let receivedValue: number | undefined
    const machine = createMachine({
      initial: 'idle',
      schemas: {
        context: z.object({
          value: z.number(),
        }),
      },
      context: {
        value: 0,
      },
      states: {
        idle: {
          on: {
            start: {
              target: 'active',
              context: { value: 100 },
            },
          },
        },
        active: {
          invoke: {
            src: createAsyncLogic({
              run: ({ input }: { input: { val: number } }) => {
                receivedValue = input.val
                return Promise.resolve(input.val)
              },
            }),
            input: ({ context }: { context: { value: number } }) => ({
              val: context.value,
            }),
            onDone: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actor = createActor(machine)
    actor.subscribe({ complete: () => resolve() })
    actor.start()
    actor.send({ type: 'start' })
    yield* Effect.promise(() => promise)

    yield* expect(receivedValue).toEqual(100)
  })

  it('invoke generated ID should be predictable based on the state node where it is defined', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let receivedDoneEvent: unknown
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve() }),
            onDone: ({ event }) => {
              // invoke ID should not be 'someSrc'
              receivedDoneEvent = event
              return { target: 'b' }
            },
          },
        },
        b: {
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

    yield* expect(receivedDoneEvent).toMatchObject({
      type: 'xstate.done.actor',
      actorId: '0.(machine).a',
    })
  })

  it.each(
    [
      // ['src with string reference', { src: 'someSrc' }],
      // ['machine', createMachine({ id: 'someId' })],
      [
        'src containing a machine directly',
        { src: createMachine({ id: 'someId' }) },
      ],
      [
        'src containing a callback actor directly',
        {
          src: createCallbackLogic(() => {
            /* ... */
          }),
        },
      ],
    ] as const,
  )(
    'invoke config defined as %s should register unique and predictable child in state',
    function*([_type, invokeConfig], { expect }) {
      const machine = createMachine(
        {
          id: 'machine',
          initial: 'a',
          states: {
            a: {
              invoke: invokeConfig,
            },
          },
        },
        // {
        //   actors: {
        //     someSrc: createCallbackLogic(() => {
        //       /* ... */
        //     })
        //   }
        // }
      )

      yield* expect(
        Object.keys(createActor(machine).getSnapshot().children),
      ).toEqual(['0.machine.a'])
    },
  )

  // https://github.com/statelyai/xstate/issues/464
  it(
    'xstate.done.actor events should only select onDone transition on the invoking state when invokee is referenced using a string',
    function*({ expect }) {
      const { promise, resolve } = Promise.withResolvers<void>()
      let counter = 0
      let invoked = false

      const handleSuccess = () => {
        ++counter
      }

      const createSingleState = (): any => ({
        initial: 'fetch',
        states: {
          fetch: {
            invoke: {
              src: createAsyncLogic({
                run: () => {
                  if (invoked) {
                    // create a promise that won't ever resolve for the second invoking state
                    return new Promise(() => {
                      /* ... */
                    })
                  }
                  invoked = true
                  return Promise.resolve(42)
                },
              }),
              onDone: (
                _args: unknown,
                enq: (action: typeof handleSuccess) => void,
              ) => {
                enq(handleSuccess)
              },
            },
          },
        },
      })

      const testMachine = createMachine({
        type: 'parallel',
        states: {
          first: createSingleState(),
          second: createSingleState(),
        },
      })

      createActor(testMachine).start()

      // check within a macrotask so all promise-induced microtasks have a chance to resolve first
      setTimeout(() => {
        resolve()
      }, 0)
      yield* Effect.promise(() => promise)

      yield* expect(counter).toEqual(1)
    },
  )

  it('xstate.done.actor events should identify each invokee', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const actual: AnyEventObject[] = []

    const childMachine = createMachine({
      id: 'child',
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createAsyncLogic({
              run: () => {
                return Promise.resolve(42)
              },
            }),
            onDone: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })

    const createSingleState = (): any => ({
      initial: 'fetch',
      states: {
        fetch: {
          invoke: {
            src: childMachine,
          },
        },
      },
    })

    const testMachine = createMachine({
      type: 'parallel',
      states: {
        first: createSingleState(),
        second: createSingleState(),
      },
      on: {
        '*': ({ event }, enq) => {
          enq(() => {
            actual.push(event)
          })
        },
      },
    })

    createActor(testMachine).start()

    // check within a macrotask so all promise-induced microtasks have a chance to resolve first
    setTimeout(() => {
      resolve()
    }, 100)
    yield* Effect.promise(() => promise)

    yield* expect(actual).toEqual([
      {
        type: 'xstate.done.actor',
        output: undefined,
        actorId: '0.(machine).first.fetch',
        sessionId: expect.any(String),
      },
      {
        type: 'xstate.done.actor',
        output: undefined,
        actorId: '0.(machine).second.fetch',
        sessionId: expect.any(String),
      },
    ])
  })

  it('should get reinstantiated after reentering the invoking state in a microstep', function*({ expect }) {
    let invokeCount = 0

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createCallbackLogic(() => {
              invokeCount++
            }),
          },
          on: {
            GO_AWAY_AND_REENTER: { target: 'b' },
          },
        },
        b: {
          always: { target: 'a' },
        },
      },
    })
    const service = createActor(machine).start()

    service.send({ type: 'GO_AWAY_AND_REENTER' })

    yield* expect(invokeCount).toBe(2)
  })

  it('invocations should be stopped when the machine reaches done state', function*({ expect }) {
    let disposed = false
    const machine = createMachine({
      initial: 'a',
      invoke: {
        src: createCallbackLogic(() => {
          return () => {
            disposed = true
          }
        }),
      },
      states: {
        a: {
          on: {
            FINISH: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })
    const service = createActor(machine).start()

    service.send({ type: 'FINISH' })
    yield* expect({ disposed }).toEqual({ disposed: true })
  })

  it('deep invocations should be stopped when the machine reaches done state', function*({ expect }) {
    let disposed = false
    const childMachine = createMachine({
      invoke: {
        src: createCallbackLogic(() => {
          return () => {
            disposed = true
          }
        }),
      },
    })

    const machine = createMachine({
      initial: 'a',
      invoke: {
        src: childMachine,
      },
      states: {
        a: {
          on: {
            FINISH: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })
    const service = createActor(machine).start()

    service.send({ type: 'FINISH' })
    yield* expect({ disposed }).toEqual({ disposed: true })
  })

  it('root invocations should restart on root reentering transitions', function*({ expect }) {
    let count = 0

    const machine = createMachine({
      id: 'root',
      invoke: {
        src: createAsyncLogic({
          run: () => {
            count++
            return Promise.resolve(42)
          },
        }),
      },
      on: {
        EVENT: {
          target: '#two',
          reenter: true,
        },
      },
      initial: 'one',
      states: {
        one: {},
        two: {
          id: 'two',
        },
      },
    })

    const service = createActor(machine).start()

    service.send({ type: 'EVENT' })

    yield* expect(count).toEqual(2)
  })

  it('should be able to restart an invoke when reentering the invoking state', function*({ expect }) {
    const actual: string[] = []
    let invokeCounter = 0

    const machine = createMachine({
      initial: 'inactive',
      states: {
        inactive: {
          on: { ACTIVATE: { target: 'active' } },
        },
        active: {
          invoke: {
            src: createCallbackLogic(() => {
              const localId = ++invokeCounter
              actual.push(`start ${localId}`)
              return () => {
                actual.push(`stop ${localId}`)
              }
            }),
          },
          on: {
            REENTER: {
              target: 'active',
              reenter: true,
            },
          },
        },
      },
    })

    const service = createActor(machine).start()

    service.send({
      type: 'ACTIVATE',
    })

    actual.length = 0

    service.send({
      type: 'REENTER',
    })

    yield* expect(actual).toEqual(['stop 1', 'start 2'])
  })

  it.skip(
    'should be able to receive a delayed event sent by the entry action of the invoking state',
    function*({ expect }) {
      const child = createMachine({
        schemas: {
          events: {
            PING: types<{
              origin: ActorRef<Snapshot<unknown>, { type: 'PONG' }>
            }>(),
          },
        },
        on: {
          PING: ({ event }) => {
            event.origin.send({ type: 'PONG' })
          },
        },
      })
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {
            invoke: {
              id: 'foo',
              src: child,
            },
            entry: ({ children, self }, enq) => {
              // TODO: invoke gets called after entry so children.foo does not exist yet
              enq.sendTo(
                children['foo'],
                { type: 'PING', origin: self },
                { delay: 1 },
              )
            },
            on: {
              PONG: { target: 'c' },
            },
          },
          c: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })
      yield* Effect.promise(() => sleep(3))
      yield* expect(actorRef.getSnapshot().status).toBe('done')
    },
  )
})

describe('invoke input', () => {
  it('should provide input to an actor creator', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let receivedInput: unknown
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'pending',
      context: {
        count: 42,
      },
      states: {
        pending: {
          invoke: {
            src: createAsyncLogic({
              run: ({ input }) => {
                receivedInput = input

                return Promise.resolve(true)
              },
            }),
            input: ({ context }) => {
              return {
                staticVal: 'hello',
                newCount: context.count * 2,
              }
            },
            onDone: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine)
    service.subscribe({
      complete: () => {
        resolve()
      },
    })

    service.start()
    yield* Effect.promise(() => promise)

    yield* expect(receivedInput).toEqual({ newCount: 84, staticVal: 'hello' })
  })

  it('should provide self to input mapper', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let receivedInput: { responder: { send: unknown } } | undefined
    const machine = createMachine({
      invoke: {
        src: createCallbackLogic(({ input }) => {
          receivedInput = input
          resolve()
        }),
        input: ({ self }) => ({
          responder: self,
        }),
      },
    })

    createActor(machine).start()
    yield* Effect.promise(() => promise)

    yield* expect(receivedInput?.responder.send).toSatisfy(
      (send: unknown) => typeof send === 'function',
      'the self input exposes the actor send method',
    )
  })
})
