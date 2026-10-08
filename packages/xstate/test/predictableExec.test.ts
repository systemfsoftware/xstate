import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { createCallbackLogic } from '../src/actors/index.js'
import { createAsyncLogic } from '../src/actors/index.js'
import { createActor, createMachine, waitFor } from '../src/index.js'

describe('predictableExec', () => {
  it('should call mixed custom and builtin actions in the definitions order', function*({ expect }) {
    const actual: string[] = []

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          entry: (_, enq) => {
            enq(() => actual.push('custom'))
            enq(() => actual.push('assign'))
          },
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    yield* expect(actual).toEqual(['custom', 'assign'])
  })

  it('should call initial custom actions when starting a service', function*({ expect }) {
    let called = false
    const machine = createMachine({
      entry: (_, enq) => {
        enq(() => {
          called = true
        })
      },
    })

    const beforeStart = called

    createActor(machine).start()

    const afterStart = called

    yield* expect({ beforeStart, afterStart }).toEqual({
      beforeStart: false,
      afterStart: true,
    })
  })

  it('should resolve initial assign actions before starting a service', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          called: z.boolean(),
        }),
      },
      context: {
        called: false,
      },
      entry: () => ({
        context: {
          called: true,
        },
      }),
    })

    yield* expect({ called: createActor(machine).getSnapshot().context.called }).toEqual({ called: true })
  })

  it('should call raised transition custom actions with raised event', function*({ expect }) {
    let eventArg: { type: string } | undefined
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            RAISED: ({ event }, enq) => {
              enq(() => (eventArg = event))
              return { target: 'c' }
            },
          },
          entry: (_, enq) => {
            enq.raise({ type: 'RAISED' })
          },
        },
        c: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    yield* expect(eventArg?.type).toBe('RAISED')
  })

  it('should call raised transition builtin actions with raised event', function*({ expect }) {
    let eventArg: { type: string } | undefined
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            RAISED: ({ event }, enq) => {
              enq(() => (eventArg = event))
              return { target: 'c' }
            },
          },
          entry: (_, enq) => {
            enq.raise({ type: 'RAISED' })
          },
        },
        c: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    yield* expect(eventArg?.type).toBe('RAISED')
  })

  it('should call invoke creator with raised event', function*({ expect }) {
    let eventArg: { type: string } | undefined
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            RAISED: { target: 'c' },
          },
          entry: (_, enq) => {
            enq.raise({ type: 'RAISED' })
          },
        },
        c: {
          invoke: {
            src: createCallbackLogic(({ input }) => {
              eventArg = input.event
            }),
            input: ({ event }) => ({ event }),
          },
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    yield* expect(eventArg?.type).toBe('RAISED')
  })

  it('invoked child should be available on the new state', function*({ expect }) {
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
            id: 'myChild',
            src: createCallbackLogic(() => {}),
          },
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    yield* expect(service.getSnapshot().children['myChild']).toSatisfy(
      (child) => child !== undefined,
      'the invoked child actor is present on the new state',
    )
  })

  it('invoked child should not be available on the state after leaving invoking state', function*({ expect }) {
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
            id: 'myChild',
            src: createCallbackLogic(() => {}),
          },
          on: {
            NEXT: { target: 'c' },
          },
        },
        c: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })
    service.send({ type: 'NEXT' })

    yield* expect(service.getSnapshot().children['myChild']).toBe(undefined)
  })

  it(
    'should correctly provide intermediate context value to a custom action executed in between assign actions',
    function*({ expect }) {
      let calledWith = 0
      const machine = createMachine({
        schemas: {
          context: z.object({
            counter: z.number(),
          }),
        },
        context: {
          counter: 0,
        },
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {
            entry: (_, enq) => {
              const context1 = { counter: 1 }
              enq(() => {
                calledWith = context1.counter
              })
              return {
                context: {
                  counter: 2,
                },
              }
            },
          },
        },
      })

      const service = createActor(machine).start()
      service.send({ type: 'NEXT' })

      yield* expect(calledWith).toBe(1)
    },
  )

  it('initial actions should receive context updated only by preceding assign actions', function*({ expect }) {
    const actual: number[] = []

    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: { count: 0 },
      entry: ({ context }, enq) => {
        const count0 = context.count
        enq(() => actual.push(count0))
        const count1 = count0 + 1
        enq(() => actual.push(count1))
        const count2 = count1 + 1
        enq(() => actual.push(count2))
        return {
          context: {
            count: count2,
          },
        }
      },
    })

    createActor(machine).start()

    yield* expect(actual).toEqual([0, 1, 2])
  })

  it.live(
    'parent should be able to read the updated state of a child when receiving an event from it',
    function*({ expect }) {
      const child = createMachine({
        initial: 'a',
        states: {
          a: {
            // we need to clear the call stack before we send the event to the parent
            after: {
              1: { target: 'b' },
            },
          },
          b: {
            // entry: sendParent({ type: 'CHILD_UPDATED' })
            entry: ({ parent }, enq) => {
              enq.sendTo(parent, { type: 'CHILD_UPDATED' })
            },
          },
        },
      })

      const machine = createMachine({
        invoke: {
          id: 'myChild',
          src: child,
        },
        initial: 'initial',
        states: {
          initial: {
            on: {
              CHILD_UPDATED: ({ children }) => {
                if (children['myChild']?.getSnapshot().value === 'b') {
                  return { target: 'success' }
                }
                return { target: 'fail' }
              },
            },
          },
          success: {
            type: 'final',
          },
          fail: {
            type: 'final',
          },
        },
      })

      const service = createActor(machine)

      const finalValue = yield* Effect.promise(() =>
        new Promise<unknown>((resolve) => {
          service.subscribe({
            complete: () => {
              resolve(service.getSnapshot().value)
            },
          })
          service.start()
        })
      )

      yield* expect(finalValue).toEqual('success')
    },
  )

  it('should be possible to send immediate events to initially invoked actors', function*({ expect }) {
    const child = createMachine({
      on: {
        PING: ({ parent }) => {
          parent?.send({ type: 'PONG' })
        },
      },
    })

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          invoke: {
            id: 'ponger',
            src: child,
          },
          entry: ({ children }) => {
            children['ponger']?.send({ type: 'PING' })
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

    const service = createActor(machine).start()

    yield* expect(service.getSnapshot().value).toBe('done')
  })

  it.skip('should create invoke based on context updated by entry actions of the same state', function*({ expect }) {
    let invokeInput: unknown
    const machine = createMachine({
      schemas: {
        context: z.object({
          updated: z.boolean(),
        }),
      },
      context: {
        updated: false,
      },
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          entry: () => ({
            context: {
              updated: true,
            },
          }),
          invoke: {
            src: createAsyncLogic({
              run: ({ input }) => {
                invokeInput = input
                return Promise.resolve()
              },
            }),
            input: ({ context }) => ({
              updated: context.updated,
            }),
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })

    yield* expect({ value: actorRef.getSnapshot().value, invokeInput }).toEqual({
      value: 'b',
      invokeInput: { updated: true },
    })
  })

  it('should deliver events sent from the entry actions to a service invoked in the same state', function*({ expect }) {
    let received: unknown

    const machine = createMachine({
      schemas: {
        context: z.object({
          updated: z.boolean(),
        }),
      },
      context: {
        updated: false,
      },
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          entry: ({ children }) => {
            children['myChild']?.send({ type: 'KNOCK_KNOCK' })
          },
          invoke: {
            id: 'myChild',
            src: createMachine({
              on: {
                // '*': {
                //   actions: ({ event }: any) => {
                //     received = event;
                //   }
                // }
                '*': ({ event }, enq) => {
                  enq(() => (received = event))
                },
              },
            }),
          },
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    yield* expect(received).toEqual({ type: 'KNOCK_KNOCK' })
  })

  it.live(
    'parent should be able to read the updated state of a child when receiving an event from it',
    function*({ expect }) {
      const child = createMachine({
        initial: 'a',
        states: {
          a: {
            // we need to clear the call stack before we send the event to the parent
            after: {
              1: { target: 'b' },
            },
          },
          b: {
            entry: ({ parent }, enq) => {
              // TODO: this should be deferred
              enq(() => {
                setTimeout(() => {
                  parent?.send({ type: 'CHILD_UPDATED' })
                }, 1)
              })
            },
          },
        },
      })

      const machine = createMachine({
        invoke: {
          id: 'myChild',
          src: child,
        },
        initial: 'initial',
        states: {
          initial: {
            on: {
              CHILD_UPDATED: ({ children }) => {
                if (children['myChild']?.getSnapshot().value === 'b') {
                  return { target: 'success' }
                }
                return { target: 'fail' }
              },
            },
          },
          success: {
            type: 'final',
          },
          fail: {
            type: 'final',
          },
        },
      })

      const service = createActor(machine)

      const finalValue = yield* Effect.promise(() =>
        new Promise<unknown>((resolve) => {
          service.subscribe({
            complete: () => {
              resolve(service.getSnapshot().value)
            },
          })
          service.start()
        })
      )

      yield* expect(finalValue).toEqual('success')
    },
  )

  it.live('should be possible to send immediate events to initially invoked actors', function*({ expect }) {
    const child = createMachine({
      on: {
        PING: ({ parent }) => {
          parent?.send({ type: 'PONG' })
        },
      },
    })

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          invoke: {
            id: 'ponger',
            src: child,
          },
          entry: ({ children }) => {
            // TODO: this should be deferred
            setTimeout(() => {
              children['ponger']?.send({ type: 'PING' })
            }, 1)
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

    const service = createActor(machine).start()

    const finalState = yield* Effect.promise(() => waitFor(service, (state) => state.matches('done')))

    yield* expect(finalState.value).toBe('done')
  })

  // https://github.com/statelyai/xstate/issues/3617
  it('should deliver events sent from the exit actions to a service invoked in the same state', function*({ expect }) {
    const received: Array<[unknown]> = []
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'my-service',
            src: createCallbackLogic(({ receive }) => {
              receive((event) => {
                received.push([event])
              })
            }),
          },
          exit: ({ children }, enq) => {
            enq.sendTo(children['my-service'], { type: 'MY_EVENT' })
          },
          on: {
            TOGGLE: { target: 'inactive' },
          },
        },
        inactive: {},
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'TOGGLE' })

    yield* expect(received).toEqual([[{ type: 'MY_EVENT' }]])
  })
})
