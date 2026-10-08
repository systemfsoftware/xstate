import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { setTimeout as sleep } from 'node:timers/promises'
import { createActor, createMachine, initialTransition, transition } from '../src/index.js'

const errorMessageOf = (value: unknown): string => value instanceof Error ? value.message : String(value)

const messageWhenCalled = (call: () => unknown): string => {
  try {
    call()
  } catch (error) {
    return errorMessageOf(error)
  }
  throw new Error('expected the call to throw')
}

describe('async transition functions', () => {
  it('throws a synchronous execution error when a transition function returns a promise', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            LOAD: (async () => ({ target: 'idle' })) as any,
          },
        },
      },
    })
    const [snapshot] = initialTransition(machine)
    const transitionMessage = messageWhenCalled(() => transition(machine, snapshot, { type: 'LOAD' }))

    const reportedErrors: unknown[] = []
    const actor = createActor(machine)
    actor.subscribe({
      error: (thrown) => {
        reportedErrors.push(thrown)
      },
    })
    actor.start()
    actor.send({ type: 'LOAD' })

    yield* expect({
      transitionMessage,
      status: actor.getSnapshot().status,
      errorMessages: reportedErrors.map((thrown) => errorMessageOf(thrown)),
    }).toEqual({
      transitionMessage:
        'Transition functions must be synchronous. Transition for event "LOAD" in state "(machine).idle" returned a promise. Move async work into an invoked or spawned actor, or enq.effect.',
      status: 'error',
      errorMessages: [
        'Transition functions must be synchronous. Transition for event "LOAD" in state "(machine).idle" returned a promise. Move async work into an invoked or spawned actor, or enq.effect.',
      ],
    })
  })

  it('lets state onError recover from an async transition function', function*({ expect }) {
    const actor = createActor(
      createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: { LOAD: (async () => {}) as any },
            onError: { target: 'failed' },
          },
          failed: {},
        },
      }),
    ).start()
    actor.send({ type: 'LOAD' })

    yield* expect({
      status: actor.getSnapshot().status,
      value: actor.getSnapshot().value,
    }).toEqual({ status: 'active', value: 'failed' })
  })

  it('throws when enq.* is called after the transition function returned', function*({ expect }) {
    const handles: any[] = []
    const actor = createActor(
      createMachine({
        on: {
          KEEP: (_, enq) => {
            handles.push(enq)
            return {}
          },
          KEEP_AND_RAISE: (_, enq) => {
            handles.push(enq)
            enq.raise({ type: 'noop' })
          },
        },
      }),
    ).start()
    actor.send({ type: 'KEEP' })
    actor.send({ type: 'KEEP_AND_RAISE' })

    yield* expect({
      handlesAtLeastTwo: handles.length >= 2,
      lateRaiseMessages: handles.map((enq) => messageWhenCalled(() => enq.raise({ type: 'late' }))),
      status: actor.getSnapshot().status,
    }).toEqual({
      handlesAtLeastTwo: true,
      lateRaiseMessages: handles.map(() => 'enq.* called after the transition function returned'),
      status: 'active',
    })
  })

  it('does not leak an unhandled rejection from an async transition function', function*({ expect }) {
    const rejections: unknown[] = []
    const recordRejection = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', recordRejection)
    try {
      const actor = createActor(
        createMachine({
          on: {
            LOAD: (async (_: unknown, enq: any) => {
              await Promise.resolve()
              enq.raise({ type: 'late' })
            }) as any,
          },
        }),
      )
      actor.subscribe({ error: () => {} })
      actor.start()
      actor.send({ type: 'LOAD' })
      yield* Effect.promise(() => sleep(10))
    } finally {
      process.off('unhandledRejection', recordRejection)
    }

    yield* expect(rejections).toEqual([])
  })

  it('treats an async two-argument entry function as an execution error recoverable by onError', function*({ expect }) {
    const actor = createActor(
      createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: { GO: { target: 'loading' } },
            onError: { target: 'failed' },
          },
          loading: {
            entry: (async (_: unknown, enq: any) => {
              enq.raise({ type: 'noop' })
            }) as any,
          },
          failed: {},
        },
      }),
    ).start()
    actor.send({ type: 'GO' })

    yield* expect({
      status: actor.getSnapshot().status,
      value: actor.getSnapshot().value,
    }).toEqual({ status: 'active', value: 'failed' })
  })

  it('throws a sync-only error when an entry or exit function returns a promise', function*({ expect }) {
    const entryMachine = createMachine({
      initial: 'idle',
      states: {
        idle: { on: { GO: { target: 'loading' } } },
        loading: { entry: (async (_: unknown, _enq: any) => {}) as any },
      },
    })
    const [entrySnapshot] = initialTransition(entryMachine)
    const entryMessage = messageWhenCalled(() => transition(entryMachine, entrySnapshot, { type: 'GO' }))

    const exitMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          exit: (async (_: unknown, _enq: any) => {}) as any,
          on: { GO: { target: 'next' } },
        },
        next: {},
      },
    })
    const [exitSnapshot] = initialTransition(exitMachine)
    const exitMessage = messageWhenCalled(() => transition(exitMachine, exitSnapshot, { type: 'GO' }))

    yield* expect({ entryMessage, exitMessage }).toEqual({
      entryMessage:
        'Entry functions must be synchronous. The entry function of state "(machine).loading" returned a promise (event "GO"). Move async work into an invoked or spawned actor, or enq.effect.',
      exitMessage:
        'Exit functions must be synchronous. The exit function of state "(machine).idle" returned a promise (event "GO"). Move async work into an invoked or spawned actor, or enq.effect.',
    })
  })

  it('throws when enq.* is called after an entry function returned', function*({ expect }) {
    let handle: any
    const actor = createActor(
      createMachine({
        entry: (_, enq) => {
          handle = enq
        },
      }),
    ).start()

    yield* expect({
      handleDefined: handle !== undefined,
      lateRaiseMessage: handle === undefined
        ? undefined
        : messageWhenCalled(() => handle.raise({ type: 'late' })),
      status: actor.getSnapshot().status,
    }).toEqual({
      handleDefined: true,
      lateRaiseMessage: 'enq.* called after the transition function returned',
      status: 'active',
    })
  })

  it('does not leak an unhandled rejection from an async entry function', function*({ expect }) {
    const rejections: unknown[] = []
    const recordRejection = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', recordRejection)
    try {
      const actor = createActor(
        createMachine({
          entry: (async (_: unknown, enq: any) => {
            await Promise.resolve()
            enq.raise({ type: 'late' })
          }) as any,
        }),
      )
      actor.subscribe({ error: () => {} })
      actor.start()
      yield* expect(actor.getSnapshot().status).toBe('error')
      yield* Effect.promise(() => sleep(10))
    } finally {
      process.off('unhandledRejection', recordRejection)
    }

    yield* expect(rejections).toEqual([])
  })
})
