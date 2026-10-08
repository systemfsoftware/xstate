import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine } from '../src/index.js'

describe('actor.trigger', () => {
  it('should send events via trigger', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            NEXT: { target: 'active' },
          },
        },
        active: {},
      },
    })

    const actor = createActor(machine).start()

    const nextTrigger = actor.trigger['NEXT']
    if (nextTrigger === undefined) {
      throw new Error('expected a NEXT trigger')
    }
    const before = actor.getSnapshot().value
    nextTrigger()
    const after = actor.getSnapshot().value

    yield* expect({ before, after }).toEqual({ before: 'idle', after: 'active' })
  })

  it('should send events with payload via trigger', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({ count: z.number() }),
        events: {
          INC: z.object({ by: z.number() }),
        },
      },
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            INC: ({ context, event }) => ({
              context: { count: context.count + event.by },
            }),
          },
        },
      },
    })

    const actor = createActor(machine).start()

    const before = actor.getSnapshot().context.count

    actor.trigger.INC({ by: 5 })

    const after = actor.getSnapshot().context.count

    yield* expect({ before, after }).toEqual({ before: 0, after: 5 })
  })

  it('should work with events with only type (no payload)', function*({ expect }) {
    const events: string[] = []

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            GO: (_, enq) => {
              enq(() => events.push('GO'))
              return { target: 'b' }
            },
          },
        },
        b: {},
      },
    })

    const actor = createActor(machine).start()

    const goTrigger = actor.trigger['GO']
    if (goTrigger === undefined) {
      throw new Error('expected a GO trigger')
    }
    goTrigger()

    yield* expect({ events, value: actor.getSnapshot().value }).toEqual({
      events: ['GO'],
      value: 'b',
    })
  })

  it('should work with multiple event types', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({ count: z.number() }),
        events: {
          INC: z.object({}),
          DEC: z.object({}),
          SET: z.object({ value: z.number() }),
        },
      },
      context: { count: 0 },
      initial: 'active',
      states: {
        active: {
          on: {
            INC: ({ context }) => ({
              context: { count: context.count + 1 },
            }),
            DEC: ({ context }) => ({
              context: { count: context.count - 1 },
            }),
            SET: ({ event }) => ({
              context: { count: event.value },
            }),
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.trigger.INC()
    const afterFirstInc = actor.getSnapshot().context.count

    actor.trigger.INC()
    const afterSecondInc = actor.getSnapshot().context.count

    actor.trigger.DEC()
    const afterDec = actor.getSnapshot().context.count

    actor.trigger.SET({ value: 100 })
    const afterSet = actor.getSnapshot().context.count

    yield* expect({ afterFirstInc, afterSecondInc, afterDec, afterSet })
      .toEqual({ afterFirstInc: 1, afterSecondInc: 2, afterDec: 1, afterSet: 100 })
  })
})
