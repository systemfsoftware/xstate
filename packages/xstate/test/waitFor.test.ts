import { describe } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createActor, createMachine, waitFor } from '../src/index.js'

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => new Error('expected the promise to reject'),
    (error: unknown) => error,
  )

const errorShape = (error: unknown): { name: string; message: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'NotAnError', message: String(error) }

describe('waitFor', (it) => {
  it.live('should wait for a condition to be true and return the emitted value', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {},
      },
    })

    const service = createActor(machine).start()

    setTimeout(() => service.send({ type: 'NEXT' }), 10)

    const state = yield* Effect.promise(() => waitFor(service, (s) => s.matches('b')))

    yield* expect(state.value).toEqual('b')
  })

  it.live('should throw an error after a timeout', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          on: { NEXT: { target: 'c' } },
        },
        c: {},
      },
    })

    const service = createActor(machine).start()

    const error = yield* Effect.promise(() =>
      rejectionOf(waitFor(service, (state) => state.matches('c'), { timeout: 10 }))
    )

    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: 'Timeout of 10 ms exceeded',
    })
  })

  it.live('should not reject immediately when passing Infinity as timeout', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          on: { NEXT: { target: 'c' } },
        },
        c: {},
      },
    })
    const service = createActor(machine).start()
    const result = yield* Effect.promise(() =>
      Promise.race([
        waitFor(service, (state) => state.matches('c'), {
          timeout: Infinity,
        }),
        new Promise((res) => setTimeout(res, 10)).then(() => 'timeout'),
      ])
    )

    yield* expect(result).toBe('timeout')
    service.stop()
  })

  it.live('should throw an error when reaching a final state that does not match the predicate', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()

    setTimeout(() => {
      service.send({ type: 'NEXT' })
    }, 10)

    const error = yield* Effect.promise(() => rejectionOf(waitFor(service, (state) => state.matches('never'))))

    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: 'Actor terminated without satisfying predicate',
    })
  })

  it.live('should resolve correctly when the predicate immediately matches the current state', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {},
      },
    })

    const service = createActor(machine).start()

    const state = yield* Effect.promise(() => waitFor(service, (state) => state.matches('a')))

    yield* expect(state.value).toEqual('a')
  })

  it.live('should not subscribe when the predicate immediately matches', function*({ expect }) {
    const machine = createMachine({})

    const actorRef = createActor(machine).start()
    const subscribeCalls: Array<ReadonlyArray<unknown>> = []
    actorRef.subscribe = (...args: Array<unknown>) => {
      subscribeCalls.push(args)
      return { unsubscribe: () => {} }
    }

    void waitFor(actorRef, () => true)

    yield* expect(subscribeCalls).toEqual([])
  })

  it.live(
    'should internally unsubscribe when the predicate immediately matches the current state',
    function*({ expect }) {
      let count = 0
      const machine = createMachine({
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

      const service = createActor(machine).start()

      yield* Effect.promise(() =>
        waitFor(service, (state) => {
          count++
          return state.matches('a')
        })
      )

      service.send({ type: 'NEXT' })

      yield* expect(count).toBe(1)
    },
  )

  it.live(
    'should immediately resolve for an actor in its final state that matches the predicate',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {
            type: 'final',
          },
        },
      })

      const service = createActor(machine).start()
      service.send({ type: 'NEXT' })

      const state = yield* Effect.promise(() => waitFor(service, (state) => state.matches('b')))

      yield* expect(state.value).toEqual('b')
    },
  )

  it.live(
    'should immediately reject for an actor in its final state that does not match the predicate',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {
            type: 'final',
          },
        },
      })

      const service = createActor(machine).start()
      service.send({ type: 'NEXT' })

      const error = yield* Effect.promise(() => rejectionOf(waitFor(service, (state) => state.matches('a'))))

      yield* expect(errorShape(error)).toEqual({
        name: 'Error',
        message: 'Actor terminated without satisfying predicate',
      })
    },
  )

  it.live('should not subscribe to the actor when it receives an aborted signal', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    const controller = new AbortController()
    const { signal } = controller
    controller.abort(new Error('Aborted!'))
    const subscribeCalls: Array<ReadonlyArray<unknown>> = []
    service.subscribe = (...args: Array<unknown>) => {
      subscribeCalls.push(args)
      return { unsubscribe: () => {} }
    }

    const error = yield* Effect.promise(() => rejectionOf(waitFor(service, (state) => state.matches('b'), { signal })))

    yield* expect({ ...errorShape(error), subscribeCalls }).toEqual({
      name: 'Error',
      message: 'Aborted!',
      subscribeCalls: [],
    })
  })

  it.live('should not listen for the "abort" event when it receives an aborted signal', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    const controller = new AbortController()
    const { signal } = controller
    controller.abort(new Error('Aborted!'))

    const addEventListenerCalls: Array<ReadonlyArray<unknown>> = []
    signal.addEventListener = (...args: Array<unknown>) => {
      addEventListenerCalls.push(args)
    }

    const error = yield* Effect.promise(() => rejectionOf(waitFor(service, (state) => state.matches('b'), { signal })))

    yield* expect({ ...errorShape(error), addEventListenerCalls }).toEqual({
      name: 'Error',
      message: 'Aborted!',
      addEventListenerCalls: [],
    })
  })

  it.live(
    'should not listen for the "abort" event for actor in its final state that matches the predicate',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {
            type: 'final',
          },
        },
      })

      const service = createActor(machine).start()
      service.send({ type: 'NEXT' })

      const controller = new AbortController()
      const { signal } = controller

      const addEventListenerCalls: Array<ReadonlyArray<unknown>> = []
      signal.addEventListener = (...args: Array<unknown>) => {
        addEventListenerCalls.push(args)
      }

      const state = yield* Effect.promise(() => waitFor(service, (state) => state.matches('b'), { signal }))

      yield* expect({ value: state.value, addEventListenerCalls }).toEqual({
        value: 'b',
        addEventListenerCalls: [],
      })
    },
  )

  it.live('should immediately reject when it receives an aborted signal', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })

    const controller = new AbortController()
    const { signal } = controller
    controller.abort(new Error('Aborted!'))

    const error = yield* Effect.promise(() => rejectionOf(waitFor(service, (state) => state.matches('b'), { signal })))

    yield* expect(errorShape(error)).toEqual({ name: 'Error', message: 'Aborted!' })
  })

  it.live('should reject when the signal is aborted while waiting', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {},
      },
    })

    const service = createActor(machine).start()
    const controller = new AbortController()
    const { signal } = controller
    setTimeout(() => controller.abort(new Error('Aborted!')), 10)

    const error = yield* Effect.promise(() => rejectionOf(waitFor(service, (state) => state.matches('b'), { signal })))

    yield* expect(errorShape(error)).toEqual({ name: 'Error', message: 'Aborted!' })
  })

  it.live('should stop listening for the "abort" event upon successful completion', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()
    setTimeout(() => {
      service.send({ type: 'NEXT' })
    }, 10)

    const controller = new AbortController()
    const { signal } = controller
    const removeEventListenerCalls: Array<[string, string]> = []
    signal.removeEventListener = (...args: Array<unknown>) => {
      removeEventListenerCalls.push([String(args[0]), typeof args[1]])
    }

    yield* Effect.promise(() => waitFor(service, (state) => state.matches('b'), { signal }))

    yield* expect(removeEventListenerCalls).toEqual([['abort', 'function']])
  })

  it.live('should stop listening for the "abort" event upon failure', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine).start()

    setTimeout(() => {
      service.send({ type: 'NEXT' })
    }, 10)

    const controller = new AbortController()
    const { signal } = controller
    const removeEventListenerCalls: Array<[string, string]> = []
    signal.removeEventListener = (...args: Array<unknown>) => {
      removeEventListenerCalls.push([String(args[0]), typeof args[1]])
    }

    const error = yield* Effect.promise(() =>
      rejectionOf(waitFor(service, (state) => state.matches('never'), { signal }))
    )

    yield* expect({ ...errorShape(error), removeEventListenerCalls }).toEqual({
      name: 'Error',
      message: 'Actor terminated without satisfying predicate',
      removeEventListenerCalls: [['abort', 'function']],
    })
  })
})
