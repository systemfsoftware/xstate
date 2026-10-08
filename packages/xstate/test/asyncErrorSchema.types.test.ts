import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createAsyncLogic, type ErrorFrom, setup, TimeoutError } from '../src/index.js'

function expectType<T>(_v: T) {}

const withError = createAsyncLogic({
  schemas: {
    output: z.object({ name: z.string() }),
    error: z.object({ code: z.string() }),
  },
  run: () => Promise.resolve({ name: 'David' }),
})

const withoutError = createAsyncLogic({
  schemas: { output: z.object({ name: z.string() }) },
  run: () => Promise.resolve({ name: 'David' }),
})

describe('async logic `schemas.error`', () => {
  it('types `event.error` in the invoking `onError`', function*({ expect }) {
    const machine = setup({ actors: { withError } }).createMachine({
      invoke: {
        src: 'withError',
        onError: ({ event }) => {
          expectType<string>(event.error.code)
        },
      },
    })

    setup({ actors: { withoutError } }).createMachine({
      invoke: {
        src: 'withoutError',
        onError: ({ event }) => {
          // @ts-expect-error - error is `unknown` without an error schema
          event.error.code
        },
      },
    })

    yield* expect(machine.id).toEqual('(machine)')
  })

  it('types the error snapshot field', function*({ expect }) {
    expectType<{ code: string }>({} as ErrorFrom<typeof withError>)

    const snapshot = createActor(withError).getSnapshot()
    if (snapshot.status === 'error') {
      expectType<string>(snapshot.error.code)
    }

    const other = createActor(withoutError).getSnapshot()
    if (other.status === 'error') {
      // @ts-expect-error - error is `unknown` without an error schema
      other.error.code
    }

    yield* expect(snapshot.status).toBe('active')
  })

  it('accepts error-only and input + error schemas', function*({ expect }) {
    const errorOnly = createAsyncLogic({
      schemas: { error: z.object({ code: z.string() }) },
      run: () => Promise.resolve(42),
    })
    expectType<{ code: string }>({} as ErrorFrom<typeof errorOnly>)

    const inputAndError = createAsyncLogic({
      schemas: {
        input: z.object({ id: z.string() }),
        error: z.object({ code: z.string() }),
      },
      run: ({ input }) => Promise.resolve(input.id),
    })
    expectType<{ code: string }>({} as ErrorFrom<typeof inputAndError>)

    yield* expect(createActor(errorOnly).getSnapshot().status).toBe('active')
  })

  it('includes `TimeoutError` when a `timeout` is configured', function*({ expect }) {
    const withTimeout = createAsyncLogic({
      schemas: { error: z.object({ code: z.string() }) },
      timeout: '30s',
      run: () => Promise.resolve(42),
    })
    expectType<{ code: string } | TimeoutError>(
      {} as ErrorFrom<typeof withTimeout>,
    )

    const withTimeoutAndOutput = createAsyncLogic({
      schemas: {
        output: z.object({ name: z.string() }),
        error: z.object({ code: z.string() }),
      },
      timeout: 1000,
      run: () => Promise.resolve({ name: 'David' }),
    })

    const machine = setup({ actors: { withTimeout, withTimeoutAndOutput } }).createMachine({
      invoke: [
        {
          src: 'withTimeout',
          onError: ({ event }) => {
            // @ts-expect-error - may be a `TimeoutError`
            event.error.code
            if (!(event.error instanceof TimeoutError)) {
              expectType<string>(event.error.code)
            }
            if ('code' in event.error) {
              expectType<string>(event.error.code)
            }
          },
        },
        {
          src: 'withTimeoutAndOutput',
          onError: ({ event }) => {
            // @ts-expect-error - may be a `TimeoutError`
            event.error.code
          },
        },
      ],
    })

    yield* expect(machine.id).toEqual('(machine)')
  })
})
