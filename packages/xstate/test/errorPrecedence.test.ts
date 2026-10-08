import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { setTimeout as sleep } from 'node:timers/promises'
import { createActor, createAsyncLogic, createCallbackLogic, createMachine } from '../src/index.js'

const boom = new Error('boom')

/**
 * Error-handling precedence contract. An error raised while an actor runs is
 * resolved by the first applicable step:
 *
 * 1. The nearest enclosing state's `onError` (the actor stays active).
 * 2. Subscribers with an `error` observer.
 * 3. `reportUnhandledError` (once) when any non-passive subscriber lacks an
 *    `error` observer, even if other subscribers received the error.
 */
describe('error precedence', () => {
  it('(a) an execution error recovered by state-level onError does not reach subscribers', function*({ expect }) {
    const failure = new Error('boom')
    const reported: unknown[] = []
    const actor = createActor(
      createMachine({
        initial: 'active',
        states: {
          active: {
            on: {
              FAIL: () => {
                throw failure
              },
            },
            onError: { target: 'recovered' },
          },
          recovered: {},
        },
      }),
      {
        reportUnhandledError: (error) => {
          reported.push(error)
        },
      },
    )
    const errorCalls: unknown[][] = []
    const error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    actor.subscribe({ error })
    actor.start()
    actor.send({ type: 'FAIL' })
    yield* Effect.promise(() => sleep(0))

    yield* expect({
      status: actor.getSnapshot().status,
      value: actor.getSnapshot().value,
      errorCalls,
      reported,
    }).toEqual({
      status: 'active',
      value: 'recovered',
      errorCalls: [],
      reported: [],
    })
  })

  it('(b) the nearest enclosing ancestor onError wins', function*({ expect }) {
    const handledByCalls: unknown[][] = []
    const handledBy = (...args: unknown[]) => {
      handledByCalls.push(args)
    }
    const actor = createActor(
      createMachine({
        initial: 'outer',
        onError: () => {
          handledBy('root')
          return {}
        },
        states: {
          outer: {
            initial: 'middle',
            onError: () => {
              handledBy('outer')
              return {}
            },
            states: {
              middle: {
                initial: 'leaf',
                onError: () => {
                  handledBy('middle')
                  return {}
                },
                states: {
                  leaf: {
                    on: {
                      FAIL: () => {
                        throw boom
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).start()
    actor.send({ type: 'FAIL' })

    yield* expect({
      status: actor.getSnapshot().status,
      handledByCalls,
    }).toEqual({
      status: 'active',
      handledByCalls: [['middle']],
    })
  })

  it('(c) an unrecovered error goes to an error observer and is not reported globally', function*({ expect }) {
    const failure = new Error('boom')
    const reported: unknown[] = []
    const actor = createActor(
      createMachine({
        on: {
          FAIL: () => {
            throw failure
          },
        },
      }),
      {
        reportUnhandledError: (error) => {
          reported.push(error)
        },
      },
    )
    const errorCalls: unknown[][] = []
    const error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    actor.subscribe({ error })
    actor.start()
    actor.send({ type: 'FAIL' })
    yield* Effect.promise(() => sleep(10))

    yield* expect({
      status: actor.getSnapshot().status,
      errorCalls,
      reported,
    }).toEqual({
      status: 'error',
      errorCalls: [[failure]],
      reported: [],
    })
  })

  it('(d) an unrecovered error without an error observer is reported once', function*({ expect }) {
    const failure = new Error('boom')
    const reported: unknown[] = []
    const actor = createActor(
      createMachine({
        on: {
          FAIL: () => {
            throw failure
          },
        },
      }),
      {
        reportUnhandledError: (error) => {
          reported.push(error)
        },
      },
    )
    actor.subscribe({ next: () => {} })
    actor.start()
    actor.send({ type: 'FAIL' })
    yield* Effect.promise(() => sleep(10))

    yield* expect({
      status: actor.getSnapshot().status,
      reported,
    }).toEqual({
      status: 'error',
      reported: [failure],
    })
  })

  it('(e) subscribing after the actor errored delivers the same error immediately', function*({ expect }) {
    const failure = new Error('boom')
    const actor = createActor(
      createMachine({
        on: {
          FAIL: () => {
            throw failure
          },
        },
      }),
    ).start()
    actor.send({ type: 'FAIL' })

    const errorCalls: unknown[][] = []
    const error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    actor.subscribe({ error })

    yield* expect(errorCalls).toEqual([[failure]])
  })

  it('(f) a throwing subscribe observer or on() listener does not kill the actor', function*({ expect }) {
    const reported: unknown[] = []
    const actor = createActor(
      createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: (_, enq) => {
                enq.emit({ type: 'moved' })
                return { target: 'b' }
              },
            },
          },
          b: {
            on: { NEXT: { target: 'a' } },
          },
        },
      }),
      {
        reportUnhandledError: (error) => {
          reported.push(error)
        },
      },
    )
    const observerError = new Error('observer')
    const listenerError = new Error('listener')
    actor.subscribe(() => {
      throw observerError
    })
    actor.on('moved', () => {
      throw listenerError
    })
    actor.start()
    actor.send({ type: 'NEXT' })
    actor.send({ type: 'NEXT' })

    yield* expect({
      status: actor.getSnapshot().status,
      value: actor.getSnapshot().value,
      reported,
    }).toEqual({
      status: 'active',
      value: 'a',
      reported: [observerError, listenerError, observerError, observerError],
    })
  })

  it('(g) a parent error stops all of its invoked and spawned children', function*({ expect }) {
    const child = createMachine({})
    const actor = createActor(
      createMachine({
        invoke: { id: 'invoked', src: child },
        entry: (_, enq) => {
          enq.spawn(child, { id: 'spawned' })
        },
        on: {
          FAIL: () => {
            throw boom
          },
        },
      }),
    )
    actor.subscribe({ error: () => {} })
    actor.start()
    const { invoked, spawned } = actor.getSnapshot().children as Record<
      string,
      any
    >
    const before = {
      invoked: invoked.getSnapshot().status,
      spawned: spawned.getSnapshot().status,
    }

    actor.send({ type: 'FAIL' })

    yield* expect({
      before,
      status: actor.getSnapshot().status,
      invokedAfter: invoked.getSnapshot().status,
      spawnedAfter: spawned.getSnapshot().status,
    }).toEqual({
      before: { invoked: 'active', spawned: 'active' },
      status: 'error',
      invokedAfter: 'stopped',
      spawnedAfter: 'stopped',
    })
  })

  it(
    "(h) an invoke failure in one parallel region is recovered by that region's onError without exiting siblings",
    function*({ expect }) {
      const siblingExitCalls: unknown[][] = []
      const siblingExit = (...args: unknown[]) => {
        siblingExitCalls.push(args)
      }
      const actor = createActor(
        createMachine({
          type: 'parallel',
          states: {
            left: {
              initial: 'working',
              states: {
                working: {
                  invoke: {
                    src: createCallbackLogic(() => {
                      throw boom
                    }),
                  },
                },
                failed: {},
              },
              onError: { target: '.failed' },
            },
            right: {
              initial: 'idle',
              states: {
                idle: { exit: siblingExit },
              },
            },
          },
        }),
      ).start()

      yield* expect({
        status: actor.getSnapshot().status,
        value: actor.getSnapshot().value,
        siblingExitCalls,
      }).toEqual({
        status: 'active',
        value: { left: 'failed', right: 'idle' },
        siblingExitCalls: [],
      })
    },
  )

  it('(i) an invoked child failure is delivered as xstate.error.actor for that child id', function*({ expect }) {
    const receivedEvents: unknown[] = []
    const actor = createActor(
      createMachine({
        invoke: {
          id: 'fetcher',
          src: createAsyncLogic({
            run: () => Promise.reject(boom),
          }),
        },
        on: {
          'xstate.error.actor.fetcher': ({ event }) => {
            receivedEvents.push(event)
            return {}
          },
        },
      }),
    ).start()
    yield* Effect.promise(() => sleep(0))

    yield* expect({
      status: actor.getSnapshot().status,
      receivedCalls: receivedEvents,
    }).toEqual({
      status: 'active',
      receivedCalls: [
        expect.objectContaining({
          type: 'xstate.error.actor',
          actorId: 'fetcher',
          error: boom,
        }),
      ],
    })
  })

  it('(j) mixed subscribers: error observer receives it and reportUnhandledError fires once', function*({ expect }) {
    const failure = new Error('boom')
    const reported: unknown[] = []
    const actor = createActor(
      createMachine({
        on: {
          FAIL: () => {
            throw failure
          },
        },
      }),
      {
        reportUnhandledError: (error) => {
          reported.push(error)
        },
      },
    )
    const errorCalls: unknown[][] = []
    const error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    actor.subscribe({ error })
    actor.subscribe({ next: () => {} })
    actor.start()
    actor.send({ type: 'FAIL' })
    yield* Effect.promise(() => sleep(10))

    yield* expect({
      status: actor.getSnapshot().status,
      errorCalls,
      reported,
    }).toEqual({
      status: 'error',
      errorCalls: [[failure]],
      reported: [failure],
    })
  })
})
