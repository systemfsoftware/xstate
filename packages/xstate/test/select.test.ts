import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { type SnapshotFrom } from '../src/index.js'
import { createMachine } from '../src/index.js'
import { createActor } from '../src/index.js'

describe('select', () => {
  it('should get current value', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.number(),
        }),
      },
      context: { data: 42 },
      initial: 'G',
      states: {
        G: {
          on: {
            INC: ({ context }) => ({
              context: {
                data: context.data + 1,
              },
            }),
          },
        },
      },
    })

    const service = createActor(machine).start()
    const selection = service.select(({ context }) => context.data)

    const before = selection.get()

    service.send({ type: 'INC' })

    const after = selection.get()

    yield* expect({ before, after }).toEqual({ before: 42, after: 43 })
  })

  it('should subscribe to changes', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.number(),
        }),
      },
      context: { data: 42 },
      initial: 'G',
      states: {
        G: {
          on: {
            INC: ({ context }) => ({
              context: {
                data: context.data + 1,
              },
            }),
          },
        },
      },
    })

    const calls: number[] = []
    const callback = (value: number) => {
      calls.push(value)
    }
    const service = createActor(machine).start()
    const selection = service.select(({ context }) => context.data)
    selection.subscribe(callback)

    service.send({ type: 'INC' })

    yield* expect(calls).toEqual([43])
  })

  it('should not notify if selected value has not changed', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.number(),
          other: z.string(),
        }),
      },
      context: { data: 42, other: 'foo' },
      initial: 'G',
      states: {
        G: {
          on: {
            INC: ({ context }) => ({
              context: {
                data: context.data + 1,
              },
            }),
          },
        },
      },
    })

    const calls: string[] = []
    const callback = (value: string) => {
      calls.push(value)
    }
    const service = createActor(machine).start()
    const selection = service.select(({ context }) => context.other)
    selection.subscribe(callback)

    service.send({ type: 'INC' })

    yield* expect(calls).toEqual([])
  })

  it('should support custom equality function', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          age: z.number(),
          name: z.string(),
        }),
        events: {
          UPDATE_NAME: z.object({ name: z.string() }),
          UPDATE_AGE: z.object({ age: z.number() }),
        },
      },
      context: { age: 42, name: 'John' },
      initial: 'G',
      states: {
        G: {
          on: {
            UPDATE_NAME: ({ context, event }) => ({
              context: {
                name: event.name,
              },
            }),
            UPDATE_AGE: ({ context, event }) => ({
              context: {
                age: event.age,
              },
            }),
          },
        },
      },
    })

    const service = createActor(machine).start()

    const calls: Array<{ name: string; age: number }> = []
    const callback = (value: { name: string; age: number }) => {
      calls.push(value)
    }
    const selector = ({ context }: SnapshotFrom<typeof machine>) => ({
      name: context.name,
      age: context.age,
    })
    const equalityFn = (a: { name: string }, b: { name: string }) => a.name === b.name

    service.select(selector, equalityFn).subscribe(callback)

    service.send({ type: 'UPDATE_AGE', age: 66 })

    service.send({ type: 'UPDATE_NAME', name: 'Jane' })

    yield* expect(calls).toEqual([{ name: 'Jane', age: 66 }])
  })

  it('should unsubscribe correctly', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.number(),
        }),
      },
      context: { data: 42 },
      initial: 'G',
      states: {
        G: {
          on: {
            INC: ({ context }) => ({
              context: {
                data: context.data + 1,
              },
            }),
          },
        },
      },
    })

    const service = createActor(machine).start()

    const calls: number[] = []
    const callback = (value: number) => {
      calls.push(value)
    }
    const selection = service.select(({ context }) => context.data)
    const subscription = selection.subscribe(callback)

    subscription.unsubscribe()
    service.send({ type: 'INC' })

    yield* expect(calls).toEqual([])
  })

  it('should handle updates with multiple subscribers', function*({ expect }) {
    interface PositionContext {
      position: {
        x: number
        y: number
      }
    }

    const machine = createMachine({
      schemas: {
        context: z.object({
          position: z.object({ x: z.number(), y: z.number() }),
          user: z.object({ name: z.string(), age: z.number() }),
        }),
        events: {
          UPDATE_USER: z.object({
            user: z.object({ name: z.string(), age: z.number() }),
          }),
          UPDATE_POSITION: z.object({
            position: z.object({ x: z.number(), y: z.number() }),
          }),
        },
      },
      context: { position: { x: 0, y: 0 }, user: { name: 'John', age: 30 } },
      initial: 'G',
      states: {
        G: {
          on: {
            UPDATE_USER: ({ context, event }) => ({
              context: {
                user: event.user,
              },
            }),
            UPDATE_POSITION: ({ context, event }) => ({
              context: {
                position: event.position,
              },
            }),
          },
        },
      },
    })

    const store = createActor(machine).start()

    const renderCalls: Array<{ x: number; y: number }> = []
    store
      .select(({ context }) => context.position)
      .subscribe((position) => {
        renderCalls.push(position)
      })

    const loggerCalls: number[] = []
    store
      .select(({ context }) => context.position.x)
      .subscribe((x) => {
        loggerCalls.push(x)
      })

    store.send({
      type: 'UPDATE_POSITION',
      position: { x: 100, y: 200 },
    })

    store.send({
      type: 'UPDATE_POSITION',
      position: { x: 150, y: 300 },
    })

    store.send({
      type: 'UPDATE_POSITION',
      position: { x: 150, y: 400 },
    })

    store.send({
      type: 'UPDATE_USER',
      user: { name: 'Jane', age: 25 },
    })

    yield* expect({
      render: renderCalls,
      logger: loggerCalls,
    }).toEqual({
      render: [
        { x: 100, y: 200 },
        { x: 150, y: 300 },
        { x: 150, y: 400 },
      ],
      logger: [100, 150],
    })
  })
})
