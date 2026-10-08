import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import z from 'zod'
import { createActor, createAsyncLogic, createMachine as createMachine, toPromise } from '../src/index.js'

describe('toPromise', (it) => {
  it('should be awaitable', function*({ expect }) {
    const promiseActor = createActor(
      createAsyncLogic({ run: () => Promise.resolve(42) }),
    ).start()

    const result = yield* Effect.promise(() => toPromise(promiseActor))

    result satisfies number

    yield* expect(result).toEqual(42)
  })

  it('should await actors', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        output: z.object({
          count: z.number(),
        }),
      },
      initial: 'pending',
      states: {
        pending: {
          on: {
            RESOLVE: { target: 'done' },
          },
        },
        done: {
          type: 'final',
        },
      },
      output: { count: 42 },
    })

    const actor = createActor(machine).start()

    const completion = toPromise(actor)
    actor.send({ type: 'RESOLVE' })

    const data = yield* Effect.promise(() => completion)

    data satisfies { count: number }

    yield* expect(data).toEqual({ count: 42 })
  })

  it('should await already done actors', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        output: z.object({
          count: z.number(),
        }),
      },
      initial: 'done',
      states: {
        done: {
          type: 'final',
        },
      },
      output: { count: 42 },
    })

    const actor = createActor(machine).start()

    const data = yield* Effect.promise(() => toPromise(actor))

    data satisfies { count: number }

    yield* expect(data).toEqual({ count: 42 })
  })

  it('should handle errors', function*({ expect }) {
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          on: {
            REJECT: () => {
              throw new Error('oh noes')
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    const settlement = toPromise(actor)
    actor.send({ type: 'REJECT' })

    const rejection = yield* Effect.flip(
      Effect.tryPromise({
        try: () => settlement,
        catch: (cause) => cause as Error,
      }),
    )

    yield* expect({ name: rejection.name, message: rejection.message })
      .toEqual({
        name: 'Error',
        message: 'oh noes',
      })
  })

  it('should immediately resolve for a done actor', function*({ expect }) {
    const machine = createMachine({
      initial: 'done',
      states: {
        done: {
          type: 'final',
        },
      },
      output: {
        count: 100,
      },
    })

    const actor = createActor(machine).start()
    const snapshot = actor.getSnapshot()

    yield* expect({ status: snapshot.status, output: snapshot.output })
      .toEqual({
        status: 'done',
        output: { count: 100 },
      })

    const output = yield* Effect.promise(() => toPromise(actor))

    yield* expect(output).toEqual({ count: 100 })
  })

  it('should immediately reject for an actor that had an error', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        enq(() => {
          throw new Error('oh noes')
        })
      },
    })

    const actor = createActor(machine).start()
    const snapshot = actor.getSnapshot()

    const rejection = yield* Effect.flip(
      Effect.tryPromise({
        try: () => toPromise(actor),
        catch: (cause) => cause as Error,
      }),
    )

    yield* expect({
      status: snapshot.status,
      error: {
        name: (snapshot.error as Error).name,
        message: (snapshot.error as Error).message,
      },
      rejection: { name: rejection.name, message: rejection.message },
    }).toEqual({
      status: 'error',
      error: { name: 'Error', message: 'oh noes' },
      rejection: { name: 'Error', message: 'oh noes' },
    })
  })
})
