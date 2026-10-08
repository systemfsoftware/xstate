import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { assertEvent, createActor, createMachine } from '../src/index.js'

describe('assertion helpers', () => {
  it('assertEvent asserts the correct event type', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    type TestEvent =
      | { type: 'greet'; message: string }
      | { type: 'count'; value: number }

    const greet = (event: TestEvent) => {
      // @ts-expect-error
      event.message

      assertEvent(event, 'greet')
      event.message satisfies string

      // @ts-expect-error
      event.count
    }

    const machine = createMachine({
      schemas: {
        events: {
          greet: z.object({ message: z.string() }),
          count: z.object({ value: z.number() }),
        },
      },

      on: {
        greet: ({ event }, enq) => {
          enq(() => greet(event))
        },
        count: ({ event }) => {
          greet(event)
        },
      },
    })

    const actor = createActor(machine)

    let observed: { message: string; isError: boolean } | undefined

    actor.subscribe({
      error(err) {
        observed = {
          message: err instanceof Error ? err.message : String(err),
          isError: err instanceof Error,
        }
        resolve()
      },
    })

    actor.start()

    actor.send({ type: 'count', value: 42 })

    yield* Effect.promise(() => promise)

    yield* expect(observed).toEqual({
      message: 'Expected event {"type":"count","value":42} to have type matching "greet"',
      isError: true,
    })
  })

  it('assertEvent asserts multiple event types', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    type TestEvent =
      | { type: 'greet'; message: string }
      | { type: 'notify'; message: string; level: 'info' | 'error' }
      | { type: 'count'; value: number }

    const greet = (event: TestEvent) => {
      // @ts-expect-error
      event.message

      assertEvent(event, ['greet', 'notify'])
      event.message satisfies string

      // @ts-expect-error
      event.level

      assertEvent(event, ['notify'])
      event.level satisfies 'info' | 'error'

      // @ts-expect-error
      event.count
    }

    const machine = createMachine({
      schemas: {
        events: {
          greet: z.object({ message: z.string() }),
          notify: z.object({
            message: z.string(),
            level: z.enum(['info', 'error']),
          }),
          count: z.object({ value: z.number() }),
        },
      },

      on: {
        greet: ({ event }, enq) => {
          enq(() => greet(event))
        },
        count: ({ event }, enq) => {
          enq(() => greet(event))
        },
      },
    })

    const actor = createActor(machine)

    let observed: { message: string; isError: boolean } | undefined

    actor.subscribe({
      error(err) {
        observed = {
          message: err instanceof Error ? err.message : String(err),
          isError: err instanceof Error,
        }
        resolve()
      },
    })

    actor.start()

    actor.send({ type: 'count', value: 42 })

    yield* Effect.promise(() => promise)

    yield* expect(observed).toEqual({
      message: 'Expected event {"type":"count","value":42} to have one of types matching "greet", "notify"',
      isError: true,
    })
  })
})
