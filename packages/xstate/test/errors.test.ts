import { describe, it } from '@systemfsoftware/vitest'
// @vitest-environment happy-dom

import { Effect } from 'effect'
import { setTimeout as sleep } from 'node:timers/promises'
import z from 'zod'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import {
  type ActorLogic,
  type AnyActor,
  type AnyActorRef,
  type AnyEventObject,
  type AnyStateMachine,
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createLogic,
  createMachine,
  type EventRejection,
  setup,
  SimulatedClock,
  type Snapshot,
  stopActor,
} from '../src/index.js'

const getErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
    ? String(error.message)
    : String(error)

function recorder<A extends unknown[]>() {
  const items: A[] = []
  return {
    items,
    record: (...args: A) => {
      items.push(args)
    },
  }
}

describe('error handling', () => {
  it.each(['calculation', 'effect'] as const)(
    'stops descendants after a parent %s fails',
    function*(failure, { expect }) {
      const cleanup = recorder<[]>()
      const exit = recorder<[]>()
      const timer = recorder<[]>()
      const clock = new SimulatedClock()
      const error = new Error('parent failed')
      const childLogic = createMachine({
        initial: 'running',
        states: {
          running: {
            exit: exit.record,
            invoke: {
              id: 'callback',
              src: createCallbackLogic(() => cleanup.record),
            },
            after: {
              10: (_, enq) => {
                enq(timer.record)
              },
            },
          },
        },
      })
      const actor = createActor(
        createMachine({
          invoke: { id: 'child', src: childLogic },
          on: {
            FAIL: (_, enq) => {
              if (failure === 'effect') {
                enq(() => {
                  throw error
                })
              } else {
                throw error
              }
            },
          },
        }),
        { clock },
      )
      const onError = recorder<[unknown]>()
      actor.subscribe({ error: onError.record })
      actor.start()
      const child = actor.getSnapshot().children['child']!
      actor.send({ type: 'FAIL' })
      clock.increment(20)

      yield* expect({
        actorStatus: actor.getSnapshot().status,
        childStatus: child.getSnapshot().status,
        cleanupCalls: cleanup.items,
        exitCalls: exit.items,
        timerCalls: timer.items,
        onErrorCalls: onError.items,
      }).toEqual({
        actorStatus: 'error',
        childStatus: 'stopped',
        cleanupCalls: [[]],
        exitCalls: [],
        timerCalls: [],
        onErrorCalls: [[error]],
      })
    },
  )

  it('stops custom-logic children absent from its snapshot after an error', function*({ expect }) {
    const cleanup = recorder<[]>()
    const actor = createActor(
      createLogic({
        context: undefined,
        run: ({ event, self }, enq) => {
          if (event.type === 'FAIL') {
            throw new Error('parent failed')
          }
          enq.effect('child', () => {
            createActor(
              createCallbackLogic(() => cleanup.record),
              { parent: self as AnyActor },
            ).start()
          })
        },
      }),
    )
    actor.subscribe({ error: () => {} })
    actor.start()
    actor.send({ type: 'FAIL' })

    yield* expect(cleanup.items).toEqual([[]])
  })

  it('ignores domain children and foreign actors when custom logic errors', function*({ expect }) {
    const foreign = createActor(createMachine({})).start()
    const error = new Error('custom failure')
    const snapshot = {
      status: 'active' as const,
      output: undefined,
      error: undefined,
      children: { number: 1, empty: null, domain: { name: 'child' }, foreign },
    }
    const actor = createActor({
      getInitialSnapshot: () => snapshot,
      initialTransition: () => [snapshot, []],
      transition: () => {
        throw error
      },
      getPersistedSnapshot: (value: typeof snapshot) => value,
    })
    const onError = recorder<[unknown]>()
    actor.subscribe({ error: onError.record })
    actor.start()
    actor.send({ type: 'FAIL' })

    yield* expect({
      onErrorCalls: onError.items,
      foreignStatus: foreign.getSnapshot().status,
    }).toEqual({
      onErrorCalls: [[error]],
      foreignStatus: 'active',
    })
    foreign.stop()
  })

  it.each([false, true])(
    'stops a removed child exactly once when its stop effect ran: %s',
    function*(stoppedFirst, { expect }) {
      const cleanup = recorder<[]>()
      const error = new Error('effect failed')
      const actor = createActor(
        createMachine({
          invoke: {
            id: 'child',
            src: createCallbackLogic(() => cleanup.record),
          },
          on: {
            FAIL: ({ children }, enq) => {
              if (stoppedFirst) {
                enq.stop(children['child'])
              }
              enq(() => {
                throw error
              })
              if (!stoppedFirst) {
                enq.stop(children['child'])
              }
            },
          },
        }),
      )
      actor.subscribe({ error: () => {} })
      actor.start()
      const runtimeStop = recorder<[AnyActor]>()
      actor.system.runtime = {
        stopActor: (actorRef) => {
          runtimeStop.record(actorRef)
          return stopActor(actorRef)
        },
      }
      actor.send({ type: 'FAIL' })

      yield* expect({
        child: actor.getSnapshot().children['child'],
        cleanupCalls: cleanup.items,
        stoppedChildIds: runtimeStop.items.map(([child]) => child.id),
      }).toEqual({
        child: undefined,
        cleanupCalls: [[]],
        stoppedChildIds: ['child'],
      })
    },
  )

  it('uses runtime child stops and continues after a child cleanup throws', function*({ expect }) {
    const originalError = new Error('parent failed')
    const cleanup = recorder<[]>()
    const actor = createActor(
      createMachine({
        invoke: [
          {
            id: 'bad',
            src: createCallbackLogic(() => () => {
              throw new Error('cleanup failed')
            }),
          },
          { id: 'good', src: createCallbackLogic(() => cleanup.record) },
        ],
        on: {
          FAIL: () => {
            throw originalError
          },
        },
      }),
    )
    const onError = recorder<[unknown]>()
    actor.subscribe({ error: onError.record })
    actor.start()
    const { bad, good } = actor.getSnapshot().children
    bad!.subscribe({ error: () => {} })
    const runtimeStop = recorder<[AnyActor]>()
    actor.system.runtime = {
      stopActor: (actorRef) => {
        runtimeStop.record(actorRef)
        return stopActor(actorRef)
      },
    }
    actor.send({ type: 'FAIL' })

    yield* expect({
      stoppedIds: runtimeStop.items.map(([child]) => child.id),
      goodStatus: good!.getSnapshot().status,
      cleanupCalls: cleanup.items,
      onErrorCalls: onError.items,
    }).toEqual({
      stoppedIds: ['bad', 'good'],
      goodStatus: 'stopped',
      cleanupCalls: [[]],
      onErrorCalls: [[originalError]],
    })
  })

  // https://github.com/statelyai/xstate/issues/4004
  it('does not cause an infinite loop when an error is thrown in subscribe', function*({ expect }) {
    const machine = createMachine({
      id: 'machine',
      initial: 'initial',
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      states: {
        initial: {
          on: { activate: { target: 'active' } },
        },
        active: {},
      },
    })

    const error = new Error(
      'no_infinite_loop_when_error_is_thrown_in_subscribe',
    )
    const subscriber = recorder<[]>()
    const reported = recorder<[unknown]>()

    const actor = createActor(machine, {
      reportUnhandledError: reported.record,
    }).start()

    actor.subscribe(() => {
      subscriber.record()
      throw error
    })
    actor.send({ type: 'activate' })

    yield* expect({
      spyCalls: subscriber.items.length,
      reportedMessages: reported.items.map(([err]) => getErrorMessage(err)),
    }).toEqual({
      spyCalls: 1,
      reportedMessages: ['no_infinite_loop_when_error_is_thrown_in_subscribe'],
    })
  })

  it(`doesn't crash the actor when an error is thrown in subscribe`, function*({ expect }) {
    const doSpy = recorder<[]>()

    const machine = createMachine({
      id: 'machine',
      initial: 'initial',
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      states: {
        initial: {
          on: { activate: { target: 'active' } },
        },
        active: {
          on: {
            do: (_, enq) => {
              enq(doSpy.record)
            },
          },
        },
      },
    })

    const subscriberError = new Error(
      'doesnt_crash_actor_when_error_is_thrown_in_subscribe',
    )
    let subscriberCalls = 0
    const subscriber = () => {
      subscriberCalls++
      if (subscriberCalls === 1) {
        throw subscriberError
      }
    }

    const reported = recorder<[unknown]>()
    const actor = createActor(machine, {
      reportUnhandledError: reported.record,
    }).start()

    actor.subscribe(subscriber)
    actor.send({ type: 'activate' })

    const subscriberCallsAfterActivate = subscriberCalls
    const statusAfterActivate = actor.getSnapshot().status
    const reportedAfterActivate = reported.items.length

    actor.send({ type: 'do' })

    yield* expect({
      subscriberCallsAfterActivate,
      statusAfterActivate,
      reportedAfterActivate,
      reportedMessages: reported.items.map(([err]) => getErrorMessage(err)),
      doSpyCalls: doSpy.items.length,
    }).toEqual({
      subscriberCallsAfterActivate: 1,
      statusAfterActivate: 'active',
      reportedAfterActivate: 1,
      reportedMessages: ['doesnt_crash_actor_when_error_is_thrown_in_subscribe'],
      doSpyCalls: 1,
    })
  })

  it(`doesn't notify error listener when an error is thrown in subscribe`, function*({ expect }) {
    const machine = createMachine({
      id: 'machine',
      initial: 'initial',
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      states: {
        initial: {
          on: { activate: { target: 'active' } },
        },
        active: {},
      },
    })

    const nextError = new Error(
      'doesnt_notify_error_listener_when_error_is_thrown_in_subscribe',
    )
    let nextCalls = 0
    const nextSpy = () => {
      nextCalls++
      throw nextError
    }
    const errorSpy = recorder<[unknown]>()
    const reported = recorder<[unknown]>()

    const actor = createActor(machine, {
      reportUnhandledError: reported.record,
    }).start()

    actor.subscribe({
      next: nextSpy,
      error: errorSpy.record,
    })
    actor.send({ type: 'activate' })

    yield* expect({
      nextCalls,
      errorSpyCalls: errorSpy.items.length,
      reportedMessages: reported.items.map(([err]) => getErrorMessage(err)),
    }).toEqual({
      nextCalls: 1,
      errorSpyCalls: 0,
      reportedMessages: ['doesnt_notify_error_listener_when_error_is_thrown_in_subscribe'],
    })
  })

  it('unhandled sync errors thrown when starting a child actor should be reported globally', function*({ expect }) {
    const error = new Error('unhandled_sync_error_in_actor_start')
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw error
            }),
            onDone: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const reported = recorder<[unknown]>()
    const { promise, resolve } = Promise.withResolvers<void>()
    createActor(machine, {
      reportUnhandledError: (err) => {
        reported.record(err)
        resolve()
      },
    }).start()

    yield* Effect.promise(() => promise)

    yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
      'unhandled_sync_error_in_actor_start',
    ])
  })

  it(
    'unhandled rejection of a promise actor should be reported globally in absence of error listener',
    function*({ expect }) {
      const reported = recorder<[unknown]>()
      const { promise, resolve } = Promise.withResolvers<void>()
      const error = new Error(
        'unhandled_rejection_in_promise_actor_without_error_listener',
      )
      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createAsyncLogic({
                run: () => Promise.reject(error),
              }),
              onDone: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      createActor(machine, {
        reportUnhandledError: (err) => {
          reported.record(err)
          resolve()
        },
      }).start()

      yield* Effect.promise(() => promise)

      yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
        'unhandled_rejection_in_promise_actor_without_error_listener',
      ])
    },
  )

  it(
    'unhandled rejection of a promise actor should be reported to the existing error listener of its parent',
    function*({ expect }) {
      const errorSpy = recorder<[unknown]>()
      const observed = Promise.withResolvers<void>()
      const error = new Error(
        'unhandled_rejection_in_promise_actor_with_parent_listener',
      )

      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createAsyncLogic({
                run: () => Promise.reject(error),
              }),
              onDone: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine)
      actorRef.subscribe({
        error: (err) => {
          errorSpy.record(err)
          observed.resolve()
        },
      })
      actorRef.start()

      yield* Effect.promise(() => observed.promise)

      yield* expect(errorSpy.items.map(([err]) => ({
        message: getErrorMessage(err),
        isError: err instanceof Error,
      }))).toEqual([
        {
          message: 'unhandled_rejection_in_promise_actor_with_parent_listener',
          isError: true,
        },
      ])
    },
  )

  it(
    'unhandled rejection of a promise actor should be reported to the existing error listener of its grandparent',
    function*({ expect }) {
      const errorSpy = recorder<[unknown]>()
      const observed = Promise.withResolvers<void>()
      const error = new Error(
        'unhandled_rejection_in_promise_actor_with_grandparent_listener',
      )

      const child = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createAsyncLogic({
                run: () => Promise.reject(error),
              }),
              onDone: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: child,
              onDone: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine)
      actorRef.subscribe({
        error: (err) => {
          errorSpy.record(err)
          observed.resolve()
        },
      })
      actorRef.start()

      yield* Effect.promise(() => observed.promise)

      yield* expect(errorSpy.items.map(([err]) => ({
        message: getErrorMessage(err),
        isError: err instanceof Error,
      }))).toEqual([
        {
          message: 'unhandled_rejection_in_promise_actor_with_grandparent_listener',
          isError: true,
        },
      ])
    },
  )

  it('handled sync errors thrown when starting a child actor should not be reported globally', function*({ expect }) {
    const error = new Error('handled_sync_error_in_actor_start')
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw error
            }),
            onError: { target: 'failed' },
          },
        },
        failed: {
          type: 'final',
        },
      },
    })

    const reported = recorder<[unknown]>()
    const settled = Promise.withResolvers<void>()
    const actor = createActor(machine, {
      reportUnhandledError: reported.record,
    })
    actor.subscribe((snapshot) => {
      if (snapshot.value === 'failed') {
        settled.resolve()
      }
    })
    actor.start()

    yield* Effect.promise(() => settled.promise)

    yield* expect({
      value: actor.getSnapshot().value,
      reportedCount: reported.items.length,
    }).toEqual({
      value: 'failed',
      reportedCount: 0,
    })
  })

  it(
    'handled sync errors thrown when starting a child actor should be reported globally when not all of its own observers come with an error listener',
    function*({ expect }) {
      const error = new Error('handled_sync_error_in_actor_start')
      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createCallbackLogic(() => {
                throw error
              }),
              onError: { target: 'failed' },
            },
          },
          failed: {
            type: 'final',
          },
        },
      })

      const reported = recorder<[unknown]>()
      const { promise, resolve } = Promise.withResolvers<void>()
      const actorRef = createActor(machine, {
        reportUnhandledError: (err) => {
          reported.record(err)
          resolve()
        },
      })
      const childActorRef = Object.values(actorRef.getSnapshot().children)[0]
      if (childActorRef === undefined) {
        throw new Error('expected a child actor')
      }
      childActorRef.subscribe({
        error: function preventUnhandledErrorListener() {},
      })
      childActorRef.subscribe(() => {})
      actorRef.start()

      yield* Effect.promise(() => promise)

      yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
        'handled_sync_error_in_actor_start',
      ])
    },
  )

  it(
    'handled sync errors thrown when starting a child actor should not be reported globally when all of its own observers come with an error listener',
    function*({ expect }) {
      const error = new Error('handled_sync_error_in_actor_start')
      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createCallbackLogic(() => {
                throw error
              }),
              onError: { target: 'failed' },
            },
          },
          failed: {
            type: 'final',
          },
        },
      })

      const reported = recorder<[unknown]>()
      const settled = Promise.withResolvers<void>()
      const actorRef = createActor(machine, {
        reportUnhandledError: reported.record,
      })
      actorRef.subscribe((snapshot) => {
        if (snapshot.value === 'failed') {
          settled.resolve()
        }
      })
      const childActorRef = Object.values(actorRef.getSnapshot().children)[0]
      if (childActorRef === undefined) {
        throw new Error('expected a child actor')
      }
      childActorRef.subscribe({
        error: function preventUnhandledErrorListener() {},
      })
      childActorRef.subscribe({
        error: function preventUnhandledErrorListener() {},
      })
      actorRef.start()

      yield* Effect.promise(() => settled.promise)

      yield* expect({
        value: actorRef.getSnapshot().value,
        reportedCount: reported.items.length,
      }).toEqual({
        value: 'failed',
        reportedCount: 0,
      })
    },
  )

  it(
    'unhandled sync errors thrown when starting a child actor should be reported twice globally when not all of its own observers come with an error listener and when the root has no error listener of its own',
    function*({ expect }) {
      const error = new Error('handled_sync_error_in_actor_start')
      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createCallbackLogic(() => {
                throw error
              }),
            },
          },
        },
      })

      const reported = recorder<[unknown]>()
      const { promise, resolve } = Promise.withResolvers<void>()
      const actorRef = createActor(machine, {
        reportUnhandledError: (err) => {
          reported.record(err)
          if (reported.items.length === 2) {
            resolve()
          }
        },
      })
      const childActorRef = Object.values(actorRef.getSnapshot().children)[0]
      if (childActorRef === undefined) {
        throw new Error('expected a child actor')
      }
      childActorRef.subscribe({
        error: function preventUnhandledErrorListener() {},
      })
      childActorRef.subscribe({})
      actorRef.start()

      yield* Effect.promise(() => promise)

      yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
        'handled_sync_error_in_actor_start',
        'handled_sync_error_in_actor_start',
      ])
    },
  )

  it(`handled sync errors shouldn't notify the error listener`, function*({ expect }) {
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw new Error('handled_sync_error_in_actor_start')
            }),
            onError: { target: 'failed' },
          },
        },
        failed: {
          type: 'final',
        },
      },
    })

    const errorSpy = recorder<[unknown]>()

    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy.record,
    })
    actorRef.start()

    yield* expect(errorSpy.items).toEqual([])
  })

  it(`unhandled sync errors should notify the root error listener`, function*({ expect }) {
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw new Error(
                'unhandled_sync_error_in_actor_start_with_root_error_listener',
              )
            }),
            onDone: { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const errorSpy = recorder<[unknown]>()

    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy.record,
    })
    actorRef.start()

    yield* expect(errorSpy.items.map(([err]) => ({
      message: getErrorMessage(err),
      isError: err instanceof Error,
    }))).toEqual([
      {
        message: 'unhandled_sync_error_in_actor_start_with_root_error_listener',
        isError: true,
      },
    ])
  })

  it(
    `unhandled sync errors should not notify the global listener when the root error listener is present`,
    function*({ expect }) {
      const error = new Error(
        'unhandled_sync_error_in_actor_start_with_root_error_listener',
      )
      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createCallbackLogic(() => {
                throw error
              }),
              onDone: { target: 'success' },
            },
          },
          success: {
            type: 'final',
          },
        },
      })

      const errorSpy = recorder<[unknown]>()
      const observed = Promise.withResolvers<void>()
      const reported = recorder<[unknown]>()

      const actorRef = createActor(machine, {
        reportUnhandledError: reported.record,
      })
      actorRef.subscribe({
        error: (err) => {
          errorSpy.record(err)
          observed.resolve()
        },
      })
      actorRef.start()

      yield* Effect.promise(() => observed.promise)

      yield* expect({
        errorMessages: errorSpy.items.map(([err]) => getErrorMessage(err)),
        reportedCount: reported.items.length,
      }).toEqual({
        errorMessages: [
          'unhandled_sync_error_in_actor_start_with_root_error_listener',
        ],
        reportedCount: 0,
      })
    },
  )

  it(`handled sync errors thrown when starting an actor shouldn't crash the parent`, function*({ expect }) {
    const doSpy = recorder<[]>()

    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw new Error('handled_sync_error_in_actor_start')
            }),
            onError: { target: 'failed' },
          },
        },
        failed: {
          on: {
            do: (_, enq) => {
              enq(doSpy.record)
            },
          },
        },
      },
    })

    const actorRef = createActor(machine)
    actorRef.start()

    const statusAfterStart = actorRef.getSnapshot().status

    actorRef.send({ type: 'do' })

    yield* expect({
      statusAfterStart,
      spyCalls: doSpy.items.length,
    }).toEqual({
      statusAfterStart: 'active',
      spyCalls: 1,
    })
  })

  it(`unhandled sync errors thrown when starting an actor should crash the parent`, function*({ expect }) {
    const error = new Error('unhandled_sync_error_in_actor_start')
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw error
            }),
          },
        },
      },
    })

    const reported = recorder<[unknown]>()
    const { promise, resolve } = Promise.withResolvers<void>()
    const actorRef = createActor(machine, {
      reportUnhandledError: (err) => {
        reported.record(err)
        resolve()
      },
    })
    actorRef.start()

    const statusAfterStart = actorRef.getSnapshot().status

    yield* Effect.promise(() => promise)

    yield* expect({
      statusAfterStart,
      messages: reported.items.map(([err]) => getErrorMessage(err)),
    }).toEqual({
      statusAfterStart: 'error',
      messages: ['unhandled_sync_error_in_actor_start'],
    })
  })

  it(`error thrown by the error listener should be reported globally`, function*({ expect }) {
    const machineError = new Error('handled_sync_error_in_actor_start')
    const listenerError = new Error('error_thrown_by_error_listener')
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw machineError
            }),
          },
        },
      },
    })

    const reported = recorder<[unknown]>()
    const { promise, resolve } = Promise.withResolvers<void>()
    const actorRef = createActor(machine, {
      reportUnhandledError: (err) => {
        reported.record(err)
        resolve()
      },
    })
    actorRef.subscribe({
      error: () => {
        throw listenerError
      },
    })
    actorRef.start()

    yield* Effect.promise(() => promise)

    yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
      'error_thrown_by_error_listener',
    ])
  })

  it(`error should be reported globally if not every observer comes with an error listener`, function*({ expect }) {
    const error = new Error(
      'error_thrown_when_not_every_observer_comes_with_an_error_listener',
    )
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: createCallbackLogic(() => {
              throw error
            }),
          },
        },
      },
    })

    const reported = recorder<[unknown]>()
    const { promise, resolve } = Promise.withResolvers<void>()
    const actorRef = createActor(machine, {
      reportUnhandledError: (err) => {
        reported.record(err)
        resolve()
      },
    })
    actorRef.subscribe({
      error: function preventUnhandledErrorListener() {},
    })
    actorRef.subscribe(() => {})
    actorRef.start()

    yield* Effect.promise(() => promise)

    yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
      'error_thrown_when_not_every_observer_comes_with_an_error_listener',
    ])
  })

  it(
    `uncaught error and an error thrown by the error listener should both be reported globally when not every observer comes with an error listener`,
    function*({ expect }) {
      const machineError = new Error(
        'error_thrown_when_not_every_observer_comes_with_an_error_listener',
      )
      const listenerError = new Error('error_thrown_by_error_listener')
      const machine = createMachine({
        initial: 'pending',
        states: {
          pending: {
            invoke: {
              src: createCallbackLogic(() => {
                throw machineError
              }),
            },
          },
        },
      })

      const reported = recorder<[unknown]>()
      const { promise, resolve } = Promise.withResolvers<void>()
      const actorRef = createActor(machine, {
        reportUnhandledError: (err) => {
          reported.record(err)
          if (reported.items.length === 2) {
            resolve()
          }
        },
      })
      actorRef.subscribe({
        error: () => {
          throw listenerError
        },
      })
      actorRef.subscribe(() => {})
      actorRef.start()

      yield* Effect.promise(() => promise)

      yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
        'error_thrown_by_error_listener',
        'error_thrown_when_not_every_observer_comes_with_an_error_listener',
      ])
    },
  )

  it('error thrown in initial custom entry action should error the actor', function*({ expect }) {
    const machine = createMachine({
      entry: () => {
        throw new Error('error_thrown_in_initial_entry_action')
      },
    })

    const errorSpy = recorder<[unknown]>()

    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy.record,
    })
    actorRef.start()

    const snapshot = actorRef.getSnapshot()

    yield* expect({
      status: snapshot.status,
      errorMessage: snapshot.error instanceof Error
        ? snapshot.error.message
        : undefined,
      errorCalls: errorSpy.items.map(([err]) => getErrorMessage(err)),
    }).toEqual({
      status: 'error',
      errorMessage: 'error_thrown_in_initial_entry_action',
      errorCalls: ['error_thrown_in_initial_entry_action'],
    })
  })

  it('error thrown by a custom entry action when transitioning should error the actor', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          entry: () => {
            throw new Error(
              'error_thrown_in_a_custom_entry_action_when_transitioning',
            )
          },
        },
      },
    })

    const errorSpy = recorder<[unknown]>()

    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy.record,
    })
    actorRef.start()
    actorRef.send({ type: 'NEXT' })

    const snapshot = actorRef.getSnapshot()

    yield* expect({
      status: snapshot.status,
      errorMessage: snapshot.error instanceof Error
        ? snapshot.error.message
        : undefined,
      errorCalls: errorSpy.items.map(([err]) => getErrorMessage(err)),
    }).toEqual({
      status: 'error',
      errorMessage: 'error_thrown_in_a_custom_entry_action_when_transitioning',
      errorCalls: ['error_thrown_in_a_custom_entry_action_when_transitioning'],
    })
  })

  it(`shouldn't execute deferred initial actions that come after an action that errors`, function*({ expect }) {
    const deferredSpy = recorder<[]>()

    const machine = createMachine({
      entry: (_, enq) => {
        enq(() => {
          throw new Error('error_thrown_in_initial_entry_action')
        })
        enq(deferredSpy.record)
      },
    })

    const actorRef = createActor(machine)
    actorRef.subscribe({ error: function preventUnhandledErrorListener() {} })
    actorRef.start()

    yield* expect(deferredSpy.items).toEqual([])
  })

  it('error thrown by an initial logic effect should error the actor', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const logic: ActorLogic<Snapshot<undefined>, AnyEventObject> = {
      transition: (snapshot: Snapshot<undefined>) => [snapshot, []],
      initialTransition: () => [
        {
          status: 'active',
          output: undefined,
          error: undefined,
        },
        [
          {
            kind: 'action',
            type: 'effect',
            action: undefined,
            params: undefined,
            args: [],
            exec: () => {
              throw new Error('error_thrown_in_initial_logic_effect')
            },
          },
        ],
      ],
      getInitialSnapshot: () => ({
        status: 'active',
        output: undefined,
        error: undefined,
      }),
      getPersistedSnapshot: (snapshot: Snapshot<undefined>) => snapshot,
    }

    const actorRef = createActor(logic)
    actorRef.subscribe({ error: errorSpy.record })
    actorRef.start()

    const snapshot = actorRef.getSnapshot()

    yield* expect({
      status: snapshot.status,
      errorMessage: snapshot.error instanceof Error
        ? snapshot.error.message
        : undefined,
      onErrorArgIsSnapshotError: errorSpy.items[0]?.[0] === snapshot.error,
    }).toEqual({
      status: 'error',
      errorMessage: 'error_thrown_in_initial_logic_effect',
      onErrorArgIsSnapshotError: true,
    })
  })

  it('should error the parent on errored initial state of a child', function*({ expect }) {
    const immediateFailure = createLogic({
      context: undefined,
      run: () => undefined,
    })
    immediateFailure.initialTransition = () => [
      {
        status: 'error',
        output: undefined,
        error: 'immediate error!',
        context: undefined,
        input: undefined,
      },
      [],
    ]

    const machine = createMachine({
      invoke: {
        src: immediateFailure,
      },
    })

    const actorRef = createActor(machine)
    actorRef.subscribe({ error: function preventUnhandledErrorListener() {} })
    actorRef.start()

    const snapshot = actorRef.getSnapshot()

    yield* expect({
      status: snapshot.status,
      error: snapshot.error,
    }).toEqual({
      status: 'error',
      error: 'immediate error!',
    })
  })

  it('actor continues to work normally after emit callback errors', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        emitted: {
          emitted: z.object({
            type: z.literal('emitted'),
            foo: z.string(),
          }),
        },
      },
      on: {
        someEvent: (_, enq) => {
          enq.emit({
            type: 'emitted',
            foo: 'bar',
          })
        },
      },
    })

    const reported = recorder<[unknown]>()
    const firstReport = Promise.withResolvers<void>()
    const actor = createActor(machine, {
      reportUnhandledError: (err) => {
        reported.record(err)
        firstReport.resolve()
      },
    }).start()
    let errorThrown = false

    actor.on('emitted', () => {
      errorThrown = true
      throw new Error('oops')
    })

    actor.send({ type: 'someEvent' })
    yield* Effect.promise(() => firstReport.promise)

    const errorThrownAfterFirst = errorThrown
    const statusAfterFirst = actor.getSnapshot().status
    const reportedAfterFirst = reported.items.length

    const emitted = Promise.withResolvers<AnyEventObject>()
    actor.on('emitted', emitted.resolve)
    actor.send({ type: 'someEvent' })
    const event = yield* Effect.promise(() => emitted.promise)

    yield* expect({
      errorThrown: errorThrownAfterFirst,
      statusAfterFirst,
      reportedAfterFirst,
      reportedMessages: reported.items.map(([err]) => getErrorMessage(err)),
      emittedFoo: event['foo'],
      statusAfterSecond: actor.getSnapshot().status,
    }).toEqual({
      errorThrown: true,
      statusAfterFirst: 'active',
      reportedAfterFirst: 1,
      reportedMessages: ['oops', 'oops'],
      emittedFoo: 'bar',
      statusAfterSecond: 'active',
    })
  })

  it('state onError catches errors thrown by initial entry actions', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const machine = createMachine({
      initial: 'active',
      onError: ({ event }) => {
        errorSpy.record(getErrorMessage(event.error))
        return {
          target: '.failed',
        }
      },
      states: {
        active: {
          entry: () => {
            throw new Error('initial entry failed')
          },
        },
        failed: {},
      },
    })

    const actor = createActor(machine).start()

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['initial entry failed']],
    })
  })

  it('state onError catches errors thrown by transition actions', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          on: {
            NEXT: (_, enq) => {
              enq(() => {
                throw new Error('transition action failed')
              })
            },
          },
          onError: ({ event }) => {
            errorSpy.record(getErrorMessage(event.error))
            return {
              target: 'failed',
            }
          },
        },
        failed: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['transition action failed']],
    })
  })

  it.live('does not report an error that a subscriber observes before the report runs', function*({ expect }) {
    const error = new Error('sync failure')
    const errorSpy = recorder<[unknown]>()
    const reported = recorder<[unknown]>()
    const actor = createActor(
      createCallbackLogic(() => {
        throw error
      }),
      { reportUnhandledError: reported.record },
    )

    actor.start()
    const statusAfterStart = actor.getSnapshot().status
    actor.subscribe({ error: errorSpy.record })

    yield* Effect.sleep('1 millis')

    yield* expect({
      statusAfterStart,
      errorCalls: errorSpy.items.length,
      reportedCount: reported.items.length,
    }).toEqual({
      statusAfterStart: 'error',
      errorCalls: 1,
      reportedCount: 0,
    })
  })

  it('reports an error that no subscriber observed', function*({ expect }) {
    const error = new Error('sync failure')
    const reported = recorder<[unknown]>()
    const { promise, resolve } = Promise.withResolvers<void>()
    const actor = createActor(
      createCallbackLogic(() => {
        throw error
      }),
      {
        reportUnhandledError: (err) => {
          reported.record(err)
          resolve()
        },
      },
    )

    actor.start()

    yield* Effect.promise(() => promise)

    yield* expect(reported.items.map(([err]) => getErrorMessage(err))).toEqual([
      'sync failure',
    ])
  })

  it('state onError catches rejected transition action promises', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          on: {
            NEXT: (_, enq) => {
              enq(() => Promise.reject(new Error('transition action rejected')))
            },
          },
          onError: ({ event }) => {
            errorSpy.record(getErrorMessage(event.error))
            return {
              target: 'failed',
            }
          },
        },
        failed: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    yield* Effect.promise(() => Promise.resolve())

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['transition action rejected']],
    })
  })

  it(
    'state onError accepts a cross-state context patch (typed against the target state schema)',
    function*({ expect }) {
      const machine = setup({
        schemas: {
          context: z.object({
            error: z.union([z.string(), z.null()]),
          }),
        },
        states: {
          active: { schemas: { context: z.object({ error: z.null() }) } },
          failed: { schemas: { context: z.object({ error: z.string() }) } },
        },
      }).createMachine({
        context: { error: null },
        initial: 'active',
        states: {
          active: {
            on: {
              NEXT: () => {
                throw new Error('boom')
              },
            },
            onError: ({ event }) => ({
              target: 'failed',
              context: { error: getErrorMessage(event.error) },
            }),
          },
          failed: {},
        },
      })

      const actor = createActor(machine).start()
      actor.send({ type: 'NEXT' })

      yield* expect({
        value: actor.getSnapshot().value,
        context: actor.getSnapshot().context,
      }).toEqual({
        value: 'failed',
        context: { error: 'boom' },
      })
    },
  )

  it(
    'state onError rejects a cross-state context patch that does not match the target state schema',
    function*({ expect }) {
      const machine = setup({
        schemas: {
          context: z.object({
            error: z.union([z.string(), z.null()]),
          }),
        },
        states: {
          active: { schemas: { context: z.object({ error: z.null() }) } },
          failed: { schemas: { context: z.object({ error: z.string() }) } },
        },
      }).createMachine({
        context: { error: null },
        initial: 'active',
        states: {
          active: {
            // @ts-expect-error - `error: null` is not assignable to the target state's context
            onError: () => ({
              target: 'failed',
              context: { error: null },
            }),
          },
          failed: {},
        },
      })

      yield* expect(machine.config.initial).toEqual('active')
    },
  )

  it('state onError catches errors thrown by transition functions', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          on: {
            NEXT: () => {
              throw new Error('transition function failed')
            },
          },
          onError: ({ event }) => {
            errorSpy.record(getErrorMessage(event.error))
            return {
              target: 'failed',
            }
          },
        },
        done: {},
        failed: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['transition function failed']],
    })
  })

  it('state onError catches errors thrown by target entry actions', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          on: {
            NEXT: {
              target: 'loading',
            },
          },
          onError: ({ event }) => {
            errorSpy.record(getErrorMessage(event.error))
            return {
              target: 'failed',
            }
          },
        },
        loading: {
          entry: () => {
            throw new Error('target entry failed')
          },
        },
        failed: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['target entry failed']],
    })
  })

  it('state onError catches invoked actor errors', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            src: createCallbackLogic(() => {
              throw new Error('invoked actor failed')
            }),
          },
          onError: ({ event }) => {
            errorSpy.record(getErrorMessage(event.error))
            return {
              target: 'failed',
            }
          },
        },
        failed: {},
      },
    })

    const actor = createActor(machine).start()

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['invoked actor failed']],
    })
  })

  it('state onError catches errors from invoked actor initialization', function*({ expect }) {
    const errorSpy = recorder<[unknown]>()
    const childMachine = createMachine({
      context: () => {
        throw new Error('invoked actor initialization failed')
      },
    })
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: { src: childMachine },
          onError: ({ event }) => {
            errorSpy.record(getErrorMessage(event.error))
            return { target: 'failed' }
          },
        },
        failed: {},
      },
    })

    const actor = createActor(machine).start()

    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      errorCalls: errorSpy.items,
    }).toEqual({
      value: 'failed',
      status: 'active',
      errorCalls: [['invoked actor initialization failed']],
    })
  })

  describe('missing send targets', () => {
    function observe(machine: AnyStateMachine) {
      const rejections: EventRejection[] = []
      const errorSpy = recorder<[unknown]>()
      const warnings: string[] = []
      const actor = createActor(machine, {
        onRejectedEvent: (rejection) => {
          rejections.push(rejection)
        },
        warn: (message) => {
          warnings.push(message)
        },
      })
      actor.subscribe({ error: errorSpy.record })
      actor.start()
      return { actor, rejections, errorSpy, warnings }
    }

    function machineSending(
      send: (
        args: { parent?: AnyActorRef | undefined },
        enq: {
          sendTo: (
            target: AnyActorRef | string | undefined,
            event: AnyEventObject,
          ) => void
        },
      ) => void,
      onErrorSpy: () => void,
    ) {
      return createMachine({
        id: 'sender',
        initial: 'active',
        states: {
          active: {
            on: { NEXT: send },
            onError: () => {
              onErrorSpy()
              return { target: 'failed' }
            },
          },
          failed: {},
        },
      })
    }

    it('dead-letters a send to an undefined ref without erroring the actor', function*({ expect }) {
      let onErrorCalls = 0
      const { actor, rejections, errorSpy, warnings } = observe(
        machineSending((_, enq) => {
          enq.sendTo(undefined, { type: 'PING' })
        }, () => {
          onErrorCalls++
        }),
      )

      actor.send({ type: 'NEXT' })

      yield* expect({
        status: actor.getSnapshot().status,
        value: actor.getSnapshot().value,
        onErrorCalls,
        errorCalls: errorSpy.items.length,
        warnings,
        rejections,
      }).toEqual({
        status: 'active',
        value: 'active',
        onErrorCalls: 0,
        errorCalls: 0,
        warnings: [
          'Actor "sender" sent event "PING" to missing target undefined; the event was not delivered (missingTarget).',
        ],
        rejections: [
          expect.objectContaining({
            event: { type: 'PING' },
            reason: 'missingTarget',
            sourceRef: actor,
            targetRef: undefined,
            targetId: undefined,
          }),
        ],
      })
    })

    it('dead-letters a send to an unknown child id without erroring the actor', function*({ expect }) {
      let onErrorCalls = 0
      const { actor, rejections, errorSpy, warnings } = observe(
        machineSending((_, enq) => {
          enq.sendTo('worker', { type: 'PING' })
        }, () => {
          onErrorCalls++
        }),
      )

      actor.send({ type: 'NEXT' })

      yield* expect({
        status: actor.getSnapshot().status,
        value: actor.getSnapshot().value,
        onErrorCalls,
        errorCalls: errorSpy.items.length,
        warnings,
        rejections,
      }).toEqual({
        status: 'active',
        value: 'active',
        onErrorCalls: 0,
        errorCalls: 0,
        warnings: [
          'Actor "sender" sent event "PING" to missing target "worker"; the event was not delivered (missingTarget).',
        ],
        rejections: [
          expect.objectContaining({
            reason: 'missingTarget',
            targetId: 'worker',
            sourceRef: actor,
          }),
        ],
      })
    })

    it('dead-letters a send to the parent of a root actor', function*({ expect }) {
      let onErrorCalls = 0
      const { actor, rejections, errorSpy } = observe(
        machineSending(({ parent }, enq) => {
          enq.sendTo(parent, { type: 'PING' })
        }, () => {
          onErrorCalls++
        }),
      )

      actor.send({ type: 'NEXT' })

      yield* expect({
        status: actor.getSnapshot().status,
        onErrorCalls,
        errorCalls: errorSpy.items.length,
        rejections,
      }).toEqual({
        status: 'active',
        onErrorCalls: 0,
        errorCalls: 0,
        rejections: [
          expect.objectContaining({
            reason: 'missingTarget',
            sourceRef: actor,
            targetRef: undefined,
          }),
        ],
      })
    })
  })
})
