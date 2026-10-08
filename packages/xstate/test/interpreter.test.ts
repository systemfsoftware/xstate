import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { from, interval, Subject } from 'rxjs'
import z from 'zod'
import { createCallbackLogic } from '../src/actors/callback.js'
import { createObservableLogic } from '../src/actors/observable.js'
import { type AsyncActorLogic, createAsyncLogic } from '../src/actors/promise.js'
import { assertEvent } from '../src/assert.js'
import { type ActorRefFrom, createActor, createMachine, type StateValue } from '../src/index.js'
import { SimulatedClock } from '../src/SimulatedClock.js'
import { toSubscribable } from './utils.js'

const lightMachine = createMachine({
  id: 'light',
  initial: 'green',
  states: {
    green: {
      entry: (_, enq) => {
        enq.raise({ type: 'TIMER' }, { id: 'TIMER1', delay: 10 })
      },
      on: {
        TIMER: { target: 'yellow' },
        KEEP_GOING: (_, enq) => {
          enq.cancel('TIMER1')
        },
      },
    },
    yellow: {
      entry: (_, enq) => {
        enq.raise({ type: 'TIMER' }, { delay: 10 })
      },
      on: {
        TIMER: { target: 'red' },
      },
    },
    red: {
      after: {
        10: { target: 'green' },
      },
    },
  },
})

describe('interpreter', () => {
  describe('initial state', () => {
    it('.getSnapshot returns the initial state', function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          bar: {},
          foo: {},
        },
      })
      const service = createActor(machine)

      yield* expect(service.getSnapshot().value).toEqual('foo')
    })

    it('initially spawned actors should not be spawned when reading initial state', function*({ expect }) {
      let promiseSpawned = 0
      const { promise: spawnSignal, resolve: markSpawned } = Promise.withResolvers<void>()
      const neverResolves = Promise.withResolvers<void>().promise

      const machine = createMachine({
        initial: 'idle',
        schemas: {
          context: z.object({
            actor: z.any(),
          }),
        },
        context: {
          actor: undefined! as ActorRefFrom<AsyncActorLogic<unknown>>,
        },
        states: {
          idle: {
            entry: (_, enq) => ({
              context: {
                actor: enq.spawn(
                  createAsyncLogic({
                    run: () => {
                      promiseSpawned++
                      markSpawned()
                      return neverResolves
                    },
                  }),
                ),
              },
            }),
          },
        },
      })

      const service = createActor(machine)

      const spawnedBeforeReads = promiseSpawned

      service.getSnapshot()
      service.getSnapshot()
      service.getSnapshot()

      const spawnedAfterReads = promiseSpawned

      service.start()

      yield* Effect.promise(() => spawnSignal)

      yield* expect({
        spawnedBeforeReads,
        spawnedAfterReads,
        spawnedAfterStart: promiseSpawned,
      }).toEqual({
        spawnedBeforeReads: 0,
        spawnedAfterReads: 0,
        spawnedAfterStart: 1,
      })
    })

    it('does not execute actions from a restored state', function*({ expect }) {
      const executed: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            on: {
              // TIMER: {
              //   target: 'yellow',
              //   actions: () => (called = true)
              // }
              TIMER: (_, enq) => {
                enq(() => {
                  executed.push('TIMER')
                })
                return { target: 'yellow' }
              },
            },
          },
          yellow: {
            on: {
              TIMER: {
                target: 'red',
              },
            },
          },
          red: {
            on: {
              TIMER: { target: 'green' },
            },
          },
        },
      })

      let actorRef = createActor(machine).start()

      actorRef.send({ type: 'TIMER' })
      const executedOnLiveSend = [...executed]
      const persisted = actorRef.getPersistedSnapshot()
      actorRef = createActor(machine, { snapshot: persisted }).start()

      yield* expect({
        executedOnLiveSend,
        executedAfterRestore: [...executed],
      }).toEqual({
        executedOnLiveSend: ['TIMER'],
        executedAfterRestore: ['TIMER'],
      })
    })

    it('should not execute actions that are not part of the actual persisted state', function*({ expect }) {
      const executed: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => {
              enq(() => {
                executed.push('a-entry')
              })
            },
            always: { target: 'b' },
          },
          b: {},
        },
      })

      const actorRef = createActor(machine).start()
      const valueAfterStart = actorRef.getSnapshot().value
      const executedAfterStart = [...executed]
      const persisted = actorRef.getPersistedSnapshot()

      createActor(machine, { snapshot: persisted }).start()

      yield* expect({
        valueAfterStart,
        executedAfterStart,
        executedAfterRestore: [...executed],
      }).toEqual({
        valueAfterStart: 'b',
        executedAfterStart: ['a-entry'],
        executedAfterRestore: ['a-entry'],
      })
    })
  })

  describe('subscribing', () => {
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {},
      },
    })

    it('should not notify subscribers of the current state upon subscription (subscribe)', function*({ expect }) {
      const calls: unknown[][] = []
      const service = createActor(machine).start()

      service.subscribe((...args: unknown[]) => {
        calls.push(args)
      })

      yield* expect(calls).toEqual([])
    })
  })

  describe('send with delay', () => {
    it('can send an event after a delay', function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {
            // entry: [raise({ type: 'TIMER' }, { delay: 10 })],
            entry: (_, enq) => {
              enq.raise({ type: 'TIMER' }, { delay: 10 })
            },
            on: {
              TIMER: { target: 'bar' },
            },
          },
          bar: {},
        },
      })
      const idleClock = new SimulatedClock()
      const idleActorRef = createActor(machine, { clock: idleClock })
      const idleValueBeforeIncrement = idleActorRef.getSnapshot().value

      idleClock.increment(10)
      const idleValueAfterIncrement = idleActorRef.getSnapshot().value

      const clock = new SimulatedClock()
      const actorRef = createActor(machine, { clock })
      actorRef.start()
      const startedValue = actorRef.getSnapshot().value

      clock.increment(5)
      const valueAfterFive = actorRef.getSnapshot().value

      clock.increment(5)

      yield* expect({
        idleValueBeforeIncrement,
        idleValueAfterIncrement,
        startedValue,
        valueAfterFive,
        valueAfterTen: actorRef.getSnapshot().value,
      }).toEqual({
        idleValueBeforeIncrement: 'foo',
        idleValueAfterIncrement: 'foo',
        startedValue: 'foo',
        valueAfterFive: 'foo',
        valueAfterTen: 'bar',
      })
    })

    it('can send an event after a delay (expression)', function*({ expect }) {
      interface DelayExprMachineCtx {
        initialDelay: number
      }

      type DelayExpMachineEvents =
        | { type: 'ACTIVATE'; wait: number }
        | { type: 'FINISH' }

      const delayExprMachine = createMachine({
        // types: {} as {
        //   context: DelayExprMachineCtx;
        //   events: DelayExpMachineEvents;
        // },
        schemas: {
          context: z.object({
            initialDelay: z.number(),
          }),

          events: {
            ACTIVATE: z.object({ wait: z.number() }),
            FINISH: z.object({}),
          },
        },
        id: 'delayExpr',
        context: {
          initialDelay: 100,
        },
        initial: 'idle',
        states: {
          idle: {
            on: {
              ACTIVATE: { target: 'pending' },
            },
          },
          pending: {
            // entry: raise(
            //   { type: 'FINISH' },
            //   {
            //     delay: ({ context, event }) =>
            //       context.initialDelay + ('wait' in event ? event.wait : 0)
            //   }
            // ),
            entry: ({ context, event }, enq) => {
              enq.raise(
                { type: 'FINISH' },
                {
                  delay: context.initialDelay + ('wait' in event ? event.wait : 0),
                },
              )
            },
            on: {
              FINISH: { target: 'finished' },
            },
          },
          finished: { type: 'final' },
        },
      })

      const completed: string[] = []

      const clock = new SimulatedClock()

      const delayExprService = createActor(delayExprMachine, {
        clock,
      })
      delayExprService.subscribe({
        complete: () => {
          completed.push('complete')
        },
      })
      delayExprService.start()

      delayExprService.send({
        type: 'ACTIVATE',
        wait: 50,
      })

      clock.increment(101)
      const completedAfter101 = [...completed]

      clock.increment(50)

      yield* expect({ completedAfter101, completed }).toEqual({
        completedAfter101: [],
        completed: ['complete'],
      })
    })

    it('can send an event after a delay (expression using _event)', function*({ expect }) {
      interface DelayExprMachineCtx {
        initialDelay: number
      }

      type DelayExpMachineEvents =
        | {
          type: 'ACTIVATE'
          wait: number
        }
        | {
          type: 'FINISH'
        }

      const delayExprMachine = createMachine({
        // types: {} as {
        //   context: DelayExprMachineCtx;
        //   events: DelayExpMachineEvents;
        // },
        schemas: {
          context: z.object({
            initialDelay: z.number(),
          }),
          events: {
            ACTIVATE: z.object({ wait: z.number() }),
            FINISH: z.object({}),
          },
        },
        id: 'delayExpr',
        context: {
          initialDelay: 100,
        },
        initial: 'idle',
        states: {
          idle: {
            on: {
              ACTIVATE: { target: 'pending' },
            },
          },
          pending: {
            // entry: raise(
            //   { type: 'FINISH' },
            //   {
            //     delay: ({ context, event }) => {
            //       assertEvent(event, 'ACTIVATE');
            //       return context.initialDelay + event.wait;
            //     }
            //   }
            // ),
            entry: ({ context, event }, enq) => {
              assertEvent(event, 'ACTIVATE')
              enq.raise(
                { type: 'FINISH' },
                {
                  delay: context.initialDelay + event.wait,
                },
              )
            },
            on: {
              FINISH: { target: 'finished' },
            },
          },
          finished: {
            type: 'final',
          },
        },
      })

      const completed: string[] = []

      const clock = new SimulatedClock()

      const delayExprService = createActor(delayExprMachine, {
        clock,
      })
      delayExprService.subscribe({
        complete: () => {
          completed.push('complete')
        },
      })
      delayExprService.start()

      delayExprService.send({
        type: 'ACTIVATE',
        wait: 50,
      })

      clock.increment(101)
      const completedAfter101 = [...completed]

      clock.increment(50)

      yield* expect({ completedAfter101, completed }).toEqual({
        completedAfter101: [],
        completed: ['complete'],
      })
    })

    it('can send an event after a delay (delayed transitions)', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const clock = new SimulatedClock()
      const letterMachine = createMachine(
        {
          // types: {} as {
          //   events: { type: 'FIRE_DELAY'; value: number };
          // },
          schemas: {
            context: z.object({
              delay: z.number(),
            }),
            events: {
              FIRE_DELAY: z.object({ value: z.number() }),
            },
          },
          delays: {
            someDelay: ({ context }) => context.delay + 50,
            delayA: ({ context }) => context.delay,
            delayD: ({ context, event }) => context.delay + event.value,
          },
          id: 'letter',
          context: {
            delay: 100,
          },
          initial: 'a',
          states: {
            a: {
              after: {
                delayA: { target: 'b' },
              },
            },
            b: {
              after: {
                someDelay: { target: 'c' },
              },
            },
            c: {
              // entry: raise({ type: 'FIRE_DELAY', value: 200 }, { delay: 20 }),
              entry: (_, enq) => {
                enq.raise({ type: 'FIRE_DELAY', value: 200 }, { delay: 20 })
              },
              on: {
                FIRE_DELAY: { target: 'd' },
              },
            },
            d: {
              after: {
                delayD: { target: 'e' },
              },
            },
            e: {
              after: { someDelay: { target: 'f' } },
            },
            f: {
              type: 'final',
            },
          },
        },
        // {
        //   delays: {
        //     someDelay: ({ context }) => {
        //       return context.delay + 50;
        //     },
        //     delayA: ({ context }) => context.delay,
        //     delayD: ({ context, event }) => context.delay + event.value
        //   }
        // }
      )

      const actor = createActor(letterMachine, { clock })
      actor.subscribe({
        complete: () => {
          resolve()
        },
      })
      actor.start()

      const valueAfterStart = actor.getSnapshot().value
      clock.increment(100)
      const valueAfter100 = actor.getSnapshot().value
      clock.increment(100 + 50)
      const valueAfter250 = actor.getSnapshot().value
      clock.increment(20)
      const valueAfter270 = actor.getSnapshot().value
      clock.increment(100 + 200)
      const valueAfter570 = actor.getSnapshot().value
      clock.increment(100 + 50)

      yield* expect({
        valueAfterStart,
        valueAfter100,
        valueAfter250,
        valueAfter270,
        valueAfter570,
      }).toEqual({
        valueAfterStart: 'a',
        valueAfter100: 'b',
        valueAfter250: 'c',
        valueAfter270: 'd',
        valueAfter570: 'e',
      })

      yield* Effect.promise(() => promise)
    })
  })

  describe('activities (deprecated)', () => {
    it('should start activities', function*({ expect }) {
      const started: string[] = []
      const activity = () => {
        started.push('activity')
      }

      const activityMachine = createMachine({
        id: 'activity',
        initial: 'on',
        states: {
          on: {
            invoke: {
              src: createCallbackLogic(activity),
            },
            on: {
              TURN_OFF: { target: 'off' },
            },
          },
          off: {},
        },
      })
      const service = createActor(activityMachine)

      service.start()

      yield* expect(started).toEqual(['activity'])
    })

    it('should stop activities', function*({ expect }) {
      const cleanupCalls: string[] = []
      const cleanup = () => {
        cleanupCalls.push('stopped')
      }

      const activityMachine = createMachine({
        id: 'activity',
        initial: 'on',
        states: {
          on: {
            invoke: {
              src: createCallbackLogic(() => cleanup),
            },
            on: {
              TURN_OFF: { target: 'off' },
            },
          },
          off: {},
        },
      })
      const service = createActor(activityMachine)

      service.start()

      const beforeTurnOff = [...cleanupCalls]

      service.send({ type: 'TURN_OFF' })

      yield* expect({ beforeTurnOff, afterTurnOff: [...cleanupCalls] }).toEqual({
        beforeTurnOff: [],
        afterTurnOff: ['stopped'],
      })
    })

    it('should stop activities upon stopping the service', function*({ expect }) {
      const cleanupCalls: string[] = []
      const cleanup = () => {
        cleanupCalls.push('stopped')
      }

      const stopActivityMachine = createMachine({
        id: 'stopActivity',
        initial: 'on',
        states: {
          on: {
            invoke: {
              src: createCallbackLogic(() => cleanup),
            },
            on: {
              TURN_OFF: { target: 'off' },
            },
          },
          off: {},
        },
      })

      const stopActivityService = createActor(stopActivityMachine).start()

      const beforeStop = [...cleanupCalls]

      stopActivityService.stop()

      yield* expect({ beforeStop, afterStop: [...cleanupCalls] }).toEqual({
        beforeStop: [],
        afterStop: ['stopped'],
      })
    })

    it.skip('should restart activities from a compound state', function*({ expect }) {
      const activityEvents: string[] = []

      const machine = createMachine({
        initial: 'inactive',
        states: {
          inactive: {
            on: { TOGGLE: { target: 'active' } },
          },
          active: {
            invoke: {
              src: createCallbackLogic(() => {
                activityEvents.push('active')
                return () => {
                  activityEvents.push('inactive')
                }
              }),
            },
            on: { TOGGLE: { target: 'inactive' } },
            initial: 'A',
            states: {
              A: { on: { SWITCH: { target: 'B' } } },
              B: { on: { SWITCH: { target: 'A' } } },
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'TOGGLE' })
      actorRef.send({ type: 'SWITCH' })
      const bState = actorRef.getPersistedSnapshot()
      actorRef.stop()

      createActor(machine, { snapshot: bState }).start()

      yield* expect(activityEvents).toContain('active')
    })
  })

  it('can cancel a delayed event', function*({ expect }) {
    const service = createActor(lightMachine, {
      clock: new SimulatedClock(),
    })
    const clock = service.clock as SimulatedClock
    service.start()

    clock.increment(5)
    service.send({ type: 'KEEP_GOING' })

    const valueAfterFive = service.getSnapshot().value
    clock.increment(10)

    yield* expect({ valueAfterFive, valueAfterFifteen: service.getSnapshot().value }).toEqual({
      valueAfterFive: 'green',
      valueAfterFifteen: 'green',
    })
  })

  it('can cancel a delayed event using expression to resolve send id', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          // entry: [
          //   raise(
          //     { type: 'FOO' },
          //     {
          //       id: 'foo',
          //       delay: 100
          //     }
          //   ),
          //   raise(
          //     { type: 'BAR' },
          //     {
          //       delay: 200
          //     }
          //   ),
          //   cancel(() => 'foo')
          // ],
          entry: (_, enq) => {
            enq.raise({ type: 'FOO' }, { id: 'foo', delay: 100 })
            enq.raise({ type: 'BAR' }, { delay: 200 })
            enq.cancel('foo')
          },
          on: {
            FOO: { target: 'fail' },
            BAR: { target: 'pass' },
          },
        },
        fail: {
          type: 'final',
        },
        pass: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()

    const completedValues: StateValue[] = []
    service.subscribe({
      complete: () => {
        completedValues.push(service.getSnapshot().value)
        resolve()
      },
    })

    yield* Effect.promise(() => promise)

    yield* expect(completedValues).toEqual(['pass'])
  })

  it('should not throw an error if an event is sent to an uninitialized interpreter', function*({ expect }) {
    const actorRef = createActor(lightMachine)

    let thrown: unknown
    try {
      actorRef.send({ type: 'SOME_EVENT' })
    } catch (error) {
      thrown = error
    }

    yield* expect({ thrown, value: actorRef.getSnapshot().value }).toEqual({
      thrown: undefined,
      value: 'green',
    })
  })

  it('should defer events sent to an uninitialized service', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const deferMachine = createMachine({
      id: 'defer',
      initial: 'a',
      states: {
        a: {
          on: { NEXT_A: { target: 'b' } },
        },
        b: {
          on: { NEXT_B: { target: 'c' } },
        },
        c: {
          type: 'final',
        },
      },
    })

    let lastValue: StateValue | undefined
    const deferService = createActor(deferMachine)

    deferService.subscribe({
      next: (nextState) => {
        lastValue = nextState.value
      },
      complete: resolve,
    })

    deferService.send({ type: 'NEXT_A' })
    deferService.send({ type: 'NEXT_B' })

    const valueBeforeStart = lastValue

    deferService.start()

    yield* Effect.promise(() => promise)

    yield* expect({ valueBeforeStart, valueAfterStart: lastValue }).toEqual({
      valueBeforeStart: undefined,
      valueAfterStart: 'c',
    })
  })

  it('should throw an error if initial state sent to interpreter is invalid', function*({ expect }) {
    const invalidMachine = {
      id: 'fetchMachine',
      initial: 'create',
      states: {
        edit: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                FETCH: { target: 'pending' },
              },
            },
            pending: {},
          },
        },
      },
    }

    const snapshot = createActor(createMachine(invalidMachine)).getSnapshot()

    yield* expect({
      status: snapshot.status,
      error: snapshot.error instanceof Error
        ? { name: snapshot.error.name, message: snapshot.error.message }
        : snapshot.error,
    }).toEqual({
      status: 'error',
      error: {
        name: 'Error',
        message: 'Initial state node "create" not found on parent state node #fetchMachine',
      },
    })
  })

  it('should not update when stopped', function*({ expect }) {
    const written: string[] = []
    const service = createActor(lightMachine, {
      clock: new SimulatedClock(),
      warn: (message) => written.push(message),
    })

    service.start()
    service.send({ type: 'TIMER' })
    const valueAfterTimer = service.getSnapshot().value

    service.stop()
    let thrown: unknown
    try {
      service.send({ type: 'TIMER' })
    } catch (error) {
      thrown = error
    }
    const valueAfterStoppedSend = service.getSnapshot().value

    yield* expect({
      valueAfterTimer,
      thrown,
      valueAfterStoppedSend,
      written,
    }).toEqual({
      valueAfterTimer: 'yellow',
      thrown: undefined,
      valueAfterStoppedSend: 'yellow',
      written: ['Event "TIMER" to actor "light" was not delivered (stopped).'],
    })
  })

  it('should be able to log (log action)', function*({ expect }) {
    const logs: unknown[] = []

    const logMachine = createMachine({
      // types: {} as { context: { count: number } },
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      id: 'log',
      initial: 'x',
      context: { count: 0 },
      states: {
        x: {
          on: {
            LOG: ({ context }, enq) => {
              const nextContext = {
                count: context.count + 1,
              }
              enq.log(nextContext)
              return {
                context: nextContext,
              }
            },
          },
        },
      },
    })

    const service = createActor(logMachine, {
      logger: (msg) => logs.push(msg),
    }).start()

    service.send({ type: 'LOG' })
    service.send({ type: 'LOG' })

    yield* expect(logs).toEqual([{ count: 1 }, { count: 2 }])
  })

  it('should receive correct event (log action)', function*({ expect }) {
    const logs: unknown[] = []

    const parentMachine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          on: {
            // EXTERNAL_EVENT: {
            //   actions: [raise({ type: 'RAISED_EVENT' }), logAction]
            // }
            EXTERNAL_EVENT: ({ event }, enq) => {
              enq.raise({ type: 'RAISED_EVENT' })
              enq.log(event.type)
            },
          },
        },
      },
      on: {
        // '*': {
        //   actions: [logAction]
        // }
        '*': ({ event }, enq) => {
          enq.log(event.type)
        },
      },
    })

    const service = createActor(parentMachine, {
      logger: (msg) => logs.push(msg),
    }).start()

    service.send({ type: 'EXTERNAL_EVENT' })

    yield* expect(logs).toEqual(['EXTERNAL_EVENT', 'RAISED_EVENT'])
  })

  describe('send() event expressions', () => {
    const machine = createMachine({
      // types: {} as { context: Ctx; events: Events },
      schemas: {
        context: z.object({
          password: z.string(),
        }),
        events: {
          NEXT: z.object({ password: z.string() }),
        },
      },
      id: 'sendexpr',
      initial: 'start',
      context: {
        password: 'foo',
      },
      states: {
        start: {
          // entry: raise(({ context }) => ({
          //   type: 'NEXT' as const,
          //   password: context.password
          // })),
          entry: ({ context }, enq) => {
            enq.raise({
              type: 'NEXT' as const,
              password: context.password,
            })
          },
          on: {
            // NEXT: {
            //   target: 'finish',
            //   guard: ({ event }) => event.password === 'foo'
            // }
            NEXT: ({ event }) => {
              if (event.password === 'foo') {
                return { target: 'finish' }
              }
              return undefined
            },
          },
        },
        finish: {
          type: 'final',
        },
      },
    })

    it('should resolve send event expressions', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const actor = createActor(machine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()

      yield* Effect.promise(() => promise)

      yield* expect(actor.getSnapshot().value).toEqual('finish')
    })
  })

  describe('sendParent() event expressions', () => {
    it('should resolve sendParent event expressions', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const childMachine = createMachine({
        // types: {} as {
        //   context: { password: string };
        //   input: { password: string };
        // },
        schemas: {
          context: z.object({
            password: z.string(),
          }),
          input: z.object({
            password: z.string(),
          }),
        },
        id: 'child',
        initial: 'start',
        context: ({ input }) => ({
          password: input.password,
        }),
        states: {
          start: {
            // entry: sendParent(({ context }) => {
            //   return { type: 'NEXT', password: context.password };
            // })
            entry: ({ context, parent }, enq) => {
              enq.sendTo(parent, {
                type: 'NEXT',
                password: context.password,
              })
            },
          },
        },
      })

      const parentMachine = createMachine({
        // types: {} as {
        //   events: {
        //     type: 'NEXT';
        //     password: string;
        //   };
        // },
        schemas: {
          events: {
            NEXT: z.object({ password: z.string() }),
          },
        },
        id: 'parent',
        initial: 'start',
        states: {
          start: {
            invoke: {
              id: 'child',
              src: childMachine,
              input: { password: 'foo' },
            },
            on: {
              // NEXT: {
              //   target: 'finish',
              //   guard: ({ event }) => event.password === 'foo'
              // }
              NEXT: ({ event }) => {
                if (event.password === 'foo') {
                  return { target: 'finish' }
                }
                return undefined
              },
            },
          },
          finish: {
            type: 'final',
          },
        },
      })

      const childSendTypes: string[] = []
      const actor = createActor(parentMachine)
      actor.subscribe({
        next: (state) => {
          if (state.matches('start')) {
            const childActor = state.children['child']

            childSendTypes.push(typeof childActor!.send)
          }
        },
        complete: () => resolve(),
      })
      actor.start()

      yield* Effect.promise(() => promise)

      yield* expect({
        childSendTypes: [...new Set(childSendTypes)],
        value: actor.getSnapshot().value,
      }).toEqual({ childSendTypes: ['function'], value: 'finish' })
    })
  })

  describe('.send()', () => {
    const sendMachine = createMachine({
      schemas: {
        events: {
          EVENT: z.object({ id: z.number() }),
          ACTIVATE: z.object({}),
        },
      },
      id: 'send',
      initial: 'inactive',
      states: {
        inactive: {
          on: {
            // EVENT: {
            //   target: 'active',
            //   guard: ({ event }) => event.id === 42 // TODO: fix unknown event type
            // },
            EVENT: ({ event }) => {
              if (event.id === 42) {
                return { target: 'active' }
              }
              return undefined
            },
            ACTIVATE: { target: 'active' },
          },
        },
        active: {
          type: 'final',
        },
      },
    })

    it('can send events with a string', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const service = createActor(sendMachine)
      service.subscribe({ complete: () => resolve() })
      service.start()

      service.send({ type: 'ACTIVATE' })

      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().value).toEqual('active')
    })

    it('can send events with an object', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const service = createActor(sendMachine)
      service.subscribe({ complete: () => resolve() })
      service.start()

      service.send({ type: 'ACTIVATE' })

      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().value).toEqual('active')
    })

    it('can send events with an object with payload', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const service = createActor(sendMachine)
      service.subscribe({ complete: () => resolve() })
      service.start()

      service.send({ type: 'EVENT', id: 42 })

      yield* Effect.promise(() => promise)

      yield* expect(service.getSnapshot().value).toEqual('active')
    })

    it('should receive and process all events sent simultaneously', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const toggleMachine = createMachine({
        id: 'toggle',
        initial: 'inactive',
        states: {
          fail: {},
          inactive: {
            on: {
              INACTIVATE: { target: 'fail' },
              ACTIVATE: { target: 'active' },
            },
          },
          active: {
            on: {
              INACTIVATE: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const toggleService = createActor(toggleMachine)
      toggleService.subscribe({
        complete: () => {
          resolve()
        },
      })
      toggleService.start()

      toggleService.send({ type: 'ACTIVATE' })
      toggleService.send({ type: 'INACTIVATE' })

      yield* Effect.promise(() => promise)

      yield* expect(toggleService.getSnapshot().value).toEqual('success')
    })
  })

  describe('.start()', () => {
    it('should initialize the service', function*({ expect }) {
      const contextCalls: string[] = []
      const entryCalls: string[] = []

      const machine = createMachine({
        schemas: {
          context: z.object({}),
        },
        context: () => {
          contextCalls.push('context')
        },
        entry: () => {
          entryCalls.push('entry')
        },
        initial: 'foo',
        states: {
          foo: {},
        },
      })
      const actor = createActor(machine)
      actor.start()

      yield* expect({
        contextCalls,
        entryCalls,
        value: actor.getSnapshot().value,
        matchesFoo: actor.getSnapshot().matches('foo'),
      }).toEqual({
        contextCalls: ['context'],
        entryCalls: ['entry'],
        value: 'foo',
        matchesFoo: true,
      })
    })

    it('should not reinitialize a started service', function*({ expect }) {
      const contextCalls: string[] = []
      const entryCalls: string[] = []

      const machine = createMachine({
        schemas: {
          context: z.object({}),
        },
        context: () => {
          contextCalls.push('context')
        },
        entry: (_, enq) =>
          enq(() => {
            entryCalls.push('entry')
          }),
      })
      const actor = createActor(machine)
      actor.start()
      actor.start()

      yield* expect({ contextCalls, entryCalls }).toEqual({
        contextCalls: ['context'],
        entryCalls: ['entry'],
      })
    })

    it('should be able to be initialized at a custom state', function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {},
          bar: {},
        },
      })
      const actor = createActor(machine, {
        snapshot: machine.resolveState({ value: 'bar' }),
      })

      const valueBeforeStart = actor.getSnapshot().value
      actor.start()

      yield* expect({
        valueBeforeStart,
        valueAfterStart: actor.getSnapshot().value,
      }).toEqual({ valueBeforeStart: 'bar', valueAfterStart: 'bar' })
    })

    it('should be able to be initialized at a custom state value', function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {},
          bar: {},
        },
      })
      const actor = createActor(machine, {
        snapshot: machine.resolveState({ value: 'bar' }),
      })

      const valueBeforeStart = actor.getSnapshot().value
      actor.start()

      yield* expect({
        valueBeforeStart,
        valueAfterStart: actor.getSnapshot().value,
      }).toEqual({ valueBeforeStart: 'bar', valueAfterStart: 'bar' })
    })

    it('should be able to resolve a custom initialized state', function*({ expect }) {
      const machine = createMachine({
        id: 'start',
        initial: 'foo',
        states: {
          foo: {
            initial: 'one',
            states: {
              one: {},
            },
          },
          bar: {},
        },
      })
      const actor = createActor(machine, {
        snapshot: machine.resolveState({ value: 'foo' }),
      })

      const valueBeforeStart = actor.getSnapshot().value
      actor.start()

      yield* expect({
        valueBeforeStart,
        valueAfterStart: actor.getSnapshot().value,
      }).toEqual({
        valueBeforeStart: { foo: 'one' },
        valueAfterStart: { foo: 'one' },
      })
    })
  })

  describe('.stop()', () => {
    it('should cancel delayed events', function*({ expect }) {
      const executed: string[] = []
      const clock = new SimulatedClock()
      const delayedMachine = createMachine({
        id: 'delayed',
        initial: 'foo',
        states: {
          foo: {
            after: {
              50: (_, enq) => {
                enq(() => {
                  executed.push('bar-entry')
                })
                return { target: 'bar' }
              },
            },
          },
          bar: {},
        },
      })

      const delayedService = createActor(delayedMachine, { clock }).start()

      delayedService.stop()

      clock.increment(50)

      yield* expect({
        executed,
        value: delayedService.getSnapshot().value,
      }).toEqual({ executed: [], value: 'foo' })
    })

    it('should not execute transitions after being stopped', function*({ expect }) {
      const executed: string[] = []
      const written: string[] = []
      const clock = new SimulatedClock()

      const testMachine = createMachine({
        initial: 'waiting',
        states: {
          waiting: {
            on: {
              TRIGGER: { target: 'active' },
            },
          },
          active: {
            entry: (_, enq) => {
              enq(() => {
                executed.push('active-entry')
              })
            },
          },
        },
      })

      const service = createActor(testMachine, {
        clock,
        warn: (message) => written.push(message),
      }).start()

      service.stop()

      service.send({ type: 'TRIGGER' })

      clock.increment(10)

      yield* expect({ executed, written }).toEqual({
        executed: [],
        written: ['Event "TRIGGER" to actor "x:0" was not delivered (stopped).'],
      })
    })

    it('should not throw when sending an unserializable event to a stopped actor', function*({ expect }) {
      const written: string[] = []

      const testMachine = createMachine({
        initial: 'waiting',
        states: {
          waiting: {
            on: {
              TRIGGER: { target: 'active' },
            },
          },
          active: {},
        },
      })

      const service = createActor(testMachine, {
        warn: (message) => written.push(message),
      }).start()

      service.stop()

      const circular: { type: string; self?: unknown } = { type: 'TRIGGER' }
      circular.self = circular

      let thrown: unknown
      try {
        service.send(circular)
      } catch (error) {
        thrown = error
      }

      yield* expect({ thrown, written }).toEqual({
        thrown: undefined,
        written: ['Event "TRIGGER" to actor "x:0" was not delivered (stopped).'],
      })
    })

    it('stopping a not-started interpreter should not crash', function*({ expect }) {
      const service = createActor(
        createMachine({
          initial: 'a',
          states: { a: {} },
        }),
      )

      let thrown: unknown
      try {
        service.stop()
      } catch (error) {
        thrown = error
      }

      yield* expect({ thrown, value: service.getSnapshot().value }).toEqual({
        thrown: undefined,
        value: 'a',
      })
    })
  })

  describe('.unsubscribe()', () => {
    it('should remove transition listeners', function*({ expect }) {
      const toggleMachine = createMachine({
        id: 'toggle',
        initial: 'inactive',
        states: {
          inactive: {
            on: { TOGGLE: { target: 'active' } },
          },
          active: {
            on: { TOGGLE: { target: 'inactive' } },
          },
        },
      })

      const toggleService = createActor(toggleMachine).start()

      let stateCount = 0

      const listener = () => stateCount++

      const sub = toggleService.subscribe(listener)
      const afterSubscribe = stateCount

      toggleService.send({ type: 'TOGGLE' })
      const afterFirstToggle = stateCount

      toggleService.send({ type: 'TOGGLE' })
      const afterSecondToggle = stateCount

      sub.unsubscribe()
      toggleService.send({ type: 'TOGGLE' })

      yield* expect({
        afterSubscribe,
        afterFirstToggle,
        afterSecondToggle,
        afterUnsubscribe: stateCount,
      }).toEqual({
        afterSubscribe: 0,
        afterFirstToggle: 1,
        afterSecondToggle: 2,
        afterUnsubscribe: 2,
      })
    })
  })

  describe('transient states', () => {
    it('should transition in correct order', function*({ expect }) {
      const stateMachine = createMachine({
        id: 'transient',
        initial: 'idle',
        states: {
          idle: { on: { START: { target: 'transient' } } },
          transient: { always: { target: 'next' } },
          next: { on: { FINISH: { target: 'end' } } },
          end: { type: 'final' },
        },
      })

      const stateValues: StateValue[] = []
      const service = createActor(stateMachine)
      service.subscribe((current) => stateValues.push(current.value))
      service.start()
      service.send({ type: 'START' })

      yield* expect(stateValues).toEqual(['idle', 'next'])
    })

    it('should transition in correct order when there is a condition', function*({ expect }) {
      const alwaysFalse = () => false
      const stateMachine = createMachine(
        {
          id: 'transient',
          initial: 'idle',
          states: {
            idle: { on: { START: { target: 'transient' } } },
            transient: {
              // always: [
              //   { target: 'end', guard: 'alwaysFalse' },
              //   { target: 'next' }
              // ]
              always: () => {
                if (alwaysFalse()) {
                  return { target: 'end' }
                }
                return { target: 'next' }
              },
            },
            next: { on: { FINISH: { target: 'end' } } },
            end: { type: 'final' },
          },
        },
        // {
        //   guards: {
        //     alwaysFalse: () => false
        //   }
        // }
      )

      const stateValues: StateValue[] = []
      const service = createActor(stateMachine)
      service.subscribe((current) => stateValues.push(current.value))
      service.start()
      service.send({ type: 'START' })

      yield* expect(stateValues).toEqual(['idle', 'next'])
    })
  })

  describe('observable', () => {
    const context = { count: 0 }
    const intervalMachine = createMachine({
      id: 'interval',
      // types: {} as { context: typeof context },
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context,
      initial: 'active',
      states: {
        active: {
          after: {
            10: ({ context }) => {
              return {
                target: 'active',
                context: {
                  count: context.count + 1,
                },
                reenter: true,
              }
            },
          },
          // always: {
          //   target: 'finished',
          //   guard: ({ context }) => context.count >= 5
          // }
          always: ({ context }) => {
            if (context.count >= 5) {
              return { target: 'finished' }
            }
            return undefined
          },
        },
        finished: {
          type: 'final',
        },
      },
    })

    it('should be subscribable', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      let count: number | undefined
      const clock = new SimulatedClock()
      const intervalService = createActor(intervalMachine, { clock }).start()

      const subscribeType = typeof intervalService.subscribe

      intervalService.subscribe(
        (state) => {
          count = state.context.count
        },
        undefined,
        () => {
          resolve()
        },
      )

      for (let i = 0; i < 5; i++) {
        clock.increment(10)
      }

      yield* Effect.promise(() => promise)

      yield* expect({ subscribeType, count }).toEqual({
        subscribeType: 'function',
        count: 5,
      })
    })

    it('should be interoperable with RxJS, etc. via Symbol.observable', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      let count = 0
      const clock = new SimulatedClock()
      const intervalService = createActor(intervalMachine, { clock }).start()

      const state$ = from(intervalService)

      state$.subscribe({
        next: () => {
          count += 1
        },
        complete: () => {
          resolve()
        },
      })

      for (let i = 0; i < 5; i++) {
        clock.increment(10)
      }

      yield* Effect.promise(() => promise)

      yield* expect(count).toEqual(5)
    })

    it('should be unsubscribable', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const countContext = { count: 0 }
      const machine = createMachine({
        // types: {} as { context: typeof countContext },
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        context: countContext,
        initial: 'active',
        states: {
          active: {
            // always: {
            //   target: 'finished',
            //   guard: ({ context }) => context.count >= 5
            // },
            always: ({ context }) => {
              if (context.count >= 5) {
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

      let count: number | undefined
      const completedCounts: (number | undefined)[] = []
      const service = createActor(machine)
      service.subscribe({
        complete: () => {
          completedCounts.push(count)
          resolve()
        },
      })
      service.start()

      const subscription = service.subscribe(
        (state) => (count = state.context.count),
      )

      service.send({ type: 'INC' })
      service.send({ type: 'INC' })
      subscription.unsubscribe()
      service.send({ type: 'INC' })
      service.send({ type: 'INC' })
      service.send({ type: 'INC' })

      yield* Effect.promise(() => promise)

      yield* expect(completedCounts).toEqual([2])
    })

    it('should call complete() once a final state is reached', function*({ expect }) {
      const completions: string[] = []

      const service = createActor(
        createMachine({
          initial: 'idle',
          states: {
            idle: {
              on: {
                NEXT: { target: 'done' },
              },
            },
            done: { type: 'final' },
          },
        }),
      ).start()

      service.subscribe({
        complete: () => {
          completions.push('complete')
        },
      })

      service.send({ type: 'NEXT' })

      yield* expect({
        completions,
        value: service.getSnapshot().value,
      }).toEqual({ completions: ['complete'], value: 'done' })
    })

    it('should call complete() once the interpreter is stopped', function*({ expect }) {
      const completions: string[] = []

      const service = createActor(createMachine({})).start()

      service.subscribe({
        complete: () => {
          completions.push('complete')
        },
      })

      service.stop()

      yield* expect(completions).toEqual(['complete'])
    })
  })

  describe('actors', () => {
    it("doesn't crash cryptically on undefined return from the actor creator", function*({ expect }) {
      const child = createCallbackLogic(() => {})

      const machine = createMachine({
        initial: 'initial',
        states: {
          initial: {
            invoke: {
              src: child,
            },
          },
        },
      })

      const service = createActor(machine)
      let thrown: unknown
      try {
        service.start()
      } catch (error) {
        thrown = error
      }

      yield* expect({ thrown, value: service.getSnapshot().value }).toEqual({
        thrown: undefined,
        value: 'initial',
      })
    })
  })

  describe('children', () => {
    it('state.children should reference invoked child actors (machine)', function*({ expect }) {
      const childMachine = createMachine({
        initial: 'active',
        states: {
          active: {
            on: {
              // FIRE: {
              //   actions: sendParent({ type: 'FIRED' })
              // }
              FIRE: ({ parent }, enq) => {
                enq.sendTo(parent, { type: 'FIRED' })
              },
            },
          },
        },
      })
      const parentMachine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: {
              id: 'childActor',
              src: childMachine,
            },
            on: {
              FIRED: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const actor = createActor(parentMachine)
      actor.start()
      const childActor = actor.getSnapshot().children['childActor']
      const childPresent = childActor !== undefined
      childActor?.send({ type: 'FIRE' })

      yield* expect({
        childPresent,
        childAfterFire: actor.getSnapshot().children['childActor'],
        value: actor.getSnapshot().value,
      }).toEqual({
        childPresent: true,
        childAfterFire: undefined,
        value: 'success',
      })
    })

    it('state.children should reference invoked child actors (promise)', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const child = Promise.withResolvers<number>()
      const num = createAsyncLogic({
        run: () => child.promise,
      })
      const parentMachine = createMachine(
        {
          initial: 'active',

          states: {
            active: {
              invoke: {
                id: 'childActor',
                src: num,
                // onDone: [
                //   {
                //     target: 'success',
                //     guard: ({ event }) => {
                //       return event.output === 42;
                //     }
                //   },
                //   { target: 'failure' }
                // ]
                onDone: ({ event }) => {
                  if (event.output === 42) {
                    return { target: 'success' }
                  }
                  return { target: 'failure' }
                },
              },
            },
            success: {
              type: 'final',
            },
            failure: {
              type: 'final',
            },
          },
        },
        // {
        //   actors: {
        //     num: createAsyncLogic(
        //       () =>
        //         new Promise<number>((res) => {
        //           setTimeout(() => {
        //             res(42);
        //           }, 100);
        //         })
        //     )
        //   }
        // }
      )

      const service = createActor(parentMachine)

      const childSendTypes: string[] = []
      let finalValue: StateValue | undefined
      let childAfterComplete: unknown

      service.subscribe({
        next: (state) => {
          if (state.matches('active')) {
            const childActor = state.children['childActor']

            childSendTypes.push(typeof childActor!.send)
          }
        },
        complete: () => {
          finalValue = service.getSnapshot().value
          childAfterComplete = service.getSnapshot().children['childActor']
          resolve()
        },
      })

      service.start()
      child.resolve(42)

      yield* Effect.promise(() => promise)

      yield* expect({
        childSendTypes: [...new Set(childSendTypes)],
        finalValue,
        childAfterComplete,
      }).toEqual({
        childSendTypes: ['function'],
        finalValue: 'success',
        childAfterComplete: undefined,
      })
    })

    it('state.children should reference invoked child actors (observable)', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      const subject = new Subject<number>()
      const intervalLogic = createObservableLogic<number, undefined>(() => toSubscribable(subject))

      const parentMachine = createMachine(
        {
          // types: {} as {
          //   actors: {
          //     src: 'intervalLogic';
          //     logic: typeof intervalLogic;
          //   };
          // },
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'childActor',
                src: intervalLogic,
                // onSnapshot: {
                //   target: 'success',
                //   guard: ({ event }) => {
                //     return event.snapshot.context === 3;
                //   }
                // }
                onSnapshot: ({ event }) => {
                  if (event.snapshot.context === 3) {
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
        // {
        //   actors: {
        //     intervalLogic
        //   }
        // }
      )

      const service = createActor(parentMachine)

      let childAfterComplete: unknown
      const childPresence: string[] = []

      service.subscribe({
        complete: () => {
          childAfterComplete = service.getSnapshot().children['childActor']
          resolve()
        },
      })

      service.subscribe((state) => {
        if (state.matches('active')) {
          childPresence.push(
            state.children['childActor'] === undefined ? 'missing' : 'present',
          )
        }
      })

      service.start()
      subject.next(1)
      subject.next(2)
      subject.next(3)

      yield* Effect.promise(() => promise)

      yield* expect({
        childPresence: [...new Set(childPresence)],
        childAfterComplete,
      }).toEqual({ childPresence: ['present'], childAfterComplete: undefined })
    })

    it.skip('state.children should reference spawned actors', function*({ expect }) {
      const childMachine = createMachine({
        initial: 'idle',
        states: {
          idle: {},
        },
      })
      const formMachine = createMachine({
        id: 'form',
        initial: 'idle',
        schemas: {
          context: z.object({
            firstNameRef: z.object({}).optional(),
          }),
        },
        context: {},
        entry: (_, enq) => ({
          children: {
            child: enq.spawn(childMachine),
          },
        }),
        states: {
          idle: {},
        },
      })

      const actor = createActor(formMachine)
      actor.start()

      yield* expect(Object.keys(actor.getSnapshot().children)).toEqual([
        'child',
      ])
    })

    // TODO: need to detect children returned from transition functions
    it.skip('stopped spawned actors should be cleaned up in parent', function*({ expect }) {
      const neverResolves = Promise.withResolvers<void>().promise
      const childMachine = createMachine({
        initial: 'idle',
        states: {
          idle: {},
        },
      })

      const parentMachine = createMachine({
        id: 'form',
        initial: 'present',
        // context: {} as {
        //   machineRef: ActorRefFrom<typeof childMachine>;
        //   promiseRef: ActorRefFrom<typeof createAsyncLogic>;
        //   observableRef: AnyActorRef;
        // },
        schemas: {
          // context: z.object({
          //   machineRef: z.any(),
          //   promiseRef: z.any(),
          //   observableRef: z.any()
          // })
        },
        // context: {},
        entry: (_, enq) => ({
          children: {
            machineChild: enq.spawn(childMachine),
            promiseChild: enq.spawn(
              createAsyncLogic({
                run: () => neverResolves,
              }),
            ),
            observableChild: enq.spawn(
              createObservableLogic<number, undefined>(() => toSubscribable(interval(1000))),
            ),
          },
        }),
        states: {
          present: {
            on: {
              // NEXT: {
              //   target: 'gone',
              //   actions: [
              //     stopChild(({ context }) => context.machineRef),
              //     stopChild(({ context }) => context.promiseRef),
              //     stopChild(({ context }) => context.observableRef)
              //   ]
              // }
              NEXT: ({ children }, enq) => {
                enq.stop(children['machineChild'])
                enq.stop(children['promiseChild'])
                enq.stop(children['observableChild'])
                return { target: 'gone' }
              },
            },
          },
          gone: {
            type: 'final',
          },
        },
      })

      const service = createActor(parentMachine).start()

      const childrenBefore = Object.keys(service.getSnapshot().children).sort()

      service.send({ type: 'NEXT' })

      yield* expect({
        childrenBefore,
        machineChildAfter: service.getSnapshot().children['machineChild'],
        promiseChildAfter: service.getSnapshot().children['promiseChild'],
        observableChildAfter: service.getSnapshot().children['observableChild'],
      }).toEqual({
        childrenBefore: ['machineChild', 'observableChild', 'promiseChild'],
        machineChildAfter: undefined,
        promiseChildAfter: undefined,
        observableChildAfter: undefined,
      })
    })
  })

  it("shouldn't execute actions when reading a snapshot of not started actor", function*({ expect }) {
    const executed: string[] = []
    const actorRef = createActor(
      createMachine({
        entry: (_, enq) =>
          enq(() => {
            executed.push('entry')
          }),
      }),
    )

    actorRef.getSnapshot()

    yield* expect(executed).toEqual([])
  })

  it(`should execute entry actions when starting the actor after reading its snapshot first`, function*({ expect }) {
    const executed: string[] = []

    const actorRef = createActor(
      createMachine({
        entry: (_, enq) =>
          enq(() => {
            executed.push('entry')
          }),
      }),
    )

    actorRef.getSnapshot()
    const executedAfterRead = [...executed]

    actorRef.start()

    yield* expect({
      executedAfterRead,
      executedAfterStart: [...executed],
    }).toEqual({ executedAfterRead: [], executedAfterStart: ['entry'] })
  })

  it('the first state of an actor should be its initial state', function*({ expect }) {
    const machine = createMachine({})
    const actor = createActor(machine)
    const initialState = actor.getSnapshot()

    actor.start()

    yield* expect({ sameState: actor.getSnapshot() === initialState }).toEqual({
      sameState: true,
    })
  })

  it('should call an onDone callback immediately if the service is already done', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()

    const statusAfterStart = service.getSnapshot().status

    service.subscribe({
      complete: () => {
        resolve()
      },
    })

    yield* Effect.promise(() => promise)

    yield* expect({ statusAfterStart }).toEqual({ statusAfterStart: 'done' })
  })
})

it('should throw if an event is received', function*({ expect }) {
  const machine = createMachine({})

  const actor = createActor(machine).start()

  let thrown: unknown
  try {
    actor.send(
      // @ts-expect-error a string is not a sendable event
      'EVENT',
    )
  } catch (error) {
    thrown = error
  }

  yield* expect(
    thrown instanceof Error
      ? { name: thrown.name, message: thrown.message }
      : thrown,
  ).toEqual({
    name: 'Error',
    message: 'Only event objects may be sent to actors; use .send({ type: "EVENT" }) instead',
  })
})

it(
  'should not process events sent directly to own actor ref before initial entry actions are processed',
  function*({ expect }) {
    const actual: string[] = []
    const machine = createMachine({
      entry: (_, enq) => {
        enq(() => actual.push('initial root entry start'))
        // enq(() =>
        //   actorRef.send({
        //     type: 'EV'
        //   })
        // );
        enq.raise({ type: 'EV' })

        enq(() => actual.push('initial root entry end'))
      },
      on: {
        // EV: {
        //   actions: () => {
        //     actual.push('EV transition');
        //   }
        // }
        EV: (_, enq) => {
          enq(() => actual.push('EV transition'))
        },
      },
      initial: 'a',
      states: {
        a: {
          entry: (_, enq) => {
            enq(() => actual.push('initial nested entry'))
          },
        },
      },
    })

    const actorRef = createActor(machine)
    actorRef.start()

    yield* expect(actual).toEqual([
      'initial root entry start',
      'initial root entry end',
      'initial nested entry',
      'EV transition',
    ])
  },
)

it(
  'should not notify the completion observer for an active logic when it gets subscribed before starting',
  function*({ expect }) {
    const completions: string[] = []

    const machine = createMachine({})
    createActor(machine).subscribe({
      complete: () => {
        completions.push('complete')
      },
    })

    yield* expect(completions).toEqual([])
  },
)

it(
  'should notify the error observer for an errored logic when it gets subscribed after it errors',
  function*({ expect }) {
    const errors: unknown[] = []

    const machine = createMachine({
      entry: () => {
        throw new Error('error')
      },
    })
    const actorRef = createActor(machine)
    actorRef.subscribe({ error: () => {} })
    actorRef.start()

    actorRef.subscribe({
      error: (error) => {
        errors.push(error)
      },
    })

    yield* expect(
      errors.map((error) =>
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error
      ),
    ).toEqual([{ name: 'Error', message: 'error' }])
  },
)
