import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createActor, createMachine } from '../src/index.js'

interface CounterContext {
  count: number
  foo: string
  maybe?: string
}

const createCounterMachine = (context: Partial<CounterContext> = {}) =>
  createMachine({
    schemas: {
      context: z.object({
        count: z.number(),
        foo: z.string(),
        maybe: z.string().optional(),
      }),
    },
    initial: 'counting',
    context: { count: 0, foo: 'bar', ...context },
    states: {
      counting: {
        on: {
          INC: ({ context }) => ({
            target: 'counting',
            context: { count: context.count + 1 },
          }),
          DEC: ({ context }) => ({
            target: 'counting',
            context: {
              count: context.count - 1,
            },
          }),
          WIN_PROP: {
            target: 'counting',
            context: {
              count: 100,
              foo: 'win',
            },
          },
          WIN_STATIC: {
            target: 'counting',
            context: {
              count: 100,
              foo: 'win',
            },
          },
          WIN_MIX: {
            target: 'counting',
            context: {
              count: 100,
              foo: 'win',
            },
          },
          WIN: {
            target: 'counting',
            context: {
              count: 100,
              foo: 'win',
            },
          },
          SET_MAYBE: () => ({
            context: {
              maybe: 'defined',
            },
          }),
        },
      },
    },
  })

describe('assigning to context', () => {
  it('applies the assignment to context (property assignment)', function*({ expect }) {
    const counterMachine = createCounterMachine()

    const actorRef = createActor(counterMachine).start()
    actorRef.send({
      type: 'DEC',
    })
    const oneState = actorRef.getSnapshot()

    actorRef.send({ type: 'DEC' })
    const twoState = actorRef.getSnapshot()

    yield* expect({
      oneValue: oneState.value,
      oneContext: oneState.context,
      twoValue: twoState.value,
      twoContext: twoState.context,
    }).toEqual({
      oneValue: 'counting',
      oneContext: { count: -1, foo: 'bar' },
      twoValue: 'counting',
      twoContext: { count: -2, foo: 'bar' },
    })
  })

  it('applies the assignment to context', function*({ expect }) {
    const counterMachine = createCounterMachine()

    const actorRef = createActor(counterMachine).start()
    actorRef.send({
      type: 'INC',
    })
    const oneState = actorRef.getSnapshot()

    actorRef.send({ type: 'INC' })
    const twoState = actorRef.getSnapshot()

    yield* expect({
      oneValue: oneState.value,
      oneContext: oneState.context,
      twoValue: twoState.value,
      twoContext: twoState.context,
    }).toEqual({
      oneValue: 'counting',
      oneContext: { count: 1, foo: 'bar' },
      twoValue: 'counting',
      twoContext: { count: 2, foo: 'bar' },
    })
  })

  it('applies the assignment to multiple properties (property assignment)', function*({ expect }) {
    const counterMachine = createCounterMachine()
    const actorRef = createActor(counterMachine).start()
    actorRef.send({
      type: 'WIN_PROP',
    })

    yield* expect(actorRef.getSnapshot().context).toEqual({ count: 100, foo: 'win' })
  })

  it('applies the assignment to multiple properties (static)', function*({ expect }) {
    const counterMachine = createCounterMachine()
    const actorRef = createActor(counterMachine).start()
    actorRef.send({
      type: 'WIN_STATIC',
    })

    yield* expect(actorRef.getSnapshot().context).toEqual({ count: 100, foo: 'win' })
  })

  it('applies the assignment to multiple properties (static + prop assignment)', function*({ expect }) {
    const counterMachine = createCounterMachine()
    const actorRef = createActor(counterMachine).start()
    actorRef.send({
      type: 'WIN_MIX',
    })

    yield* expect(actorRef.getSnapshot().context).toEqual({ count: 100, foo: 'win' })
  })

  it('applies the assignment to multiple properties', function*({ expect }) {
    const counterMachine = createCounterMachine()
    const actorRef = createActor(counterMachine).start()
    actorRef.send({
      type: 'WIN',
    })

    yield* expect(actorRef.getSnapshot().context).toEqual({ count: 100, foo: 'win' })
  })

  it('applies the assignment to the explicit external state (property assignment)', function*({ expect }) {
    const machine = createCounterMachine({ count: 50, foo: 'bar' })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'DEC' })
    const oneState = actorRef.getSnapshot()

    actorRef.send({ type: 'DEC' })
    const twoState = actorRef.getSnapshot()

    const machine2 = createCounterMachine({ count: 100, foo: 'bar' })

    const actorRef2 = createActor(machine2).start()
    actorRef2.send({ type: 'DEC' })
    const threeState = actorRef2.getSnapshot()

    yield* expect({
      oneValue: oneState.value,
      oneContext: oneState.context,
      twoValue: twoState.value,
      twoContext: twoState.context,
      threeValue: threeState.value,
      threeContext: threeState.context,
    }).toEqual({
      oneValue: 'counting',
      oneContext: { count: 49, foo: 'bar' },
      twoValue: 'counting',
      twoContext: { count: 48, foo: 'bar' },
      threeValue: 'counting',
      threeContext: { count: 99, foo: 'bar' },
    })
  })

  it('applies the assignment to the explicit external state', function*({ expect }) {
    const machine = createCounterMachine({ count: 50, foo: 'bar' })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'INC' })
    const oneState = actorRef.getSnapshot()

    actorRef.send({ type: 'INC' })
    const twoState = actorRef.getSnapshot()

    const machine2 = createCounterMachine({ count: 102, foo: 'bar' })

    const actorRef2 = createActor(machine2).start()
    actorRef2.send({ type: 'INC' })
    const threeState = actorRef2.getSnapshot()

    yield* expect({
      oneValue: oneState.value,
      oneContext: oneState.context,
      twoValue: twoState.value,
      twoContext: twoState.context,
      threeValue: threeState.value,
      threeContext: threeState.context,
    }).toEqual({
      oneValue: 'counting',
      oneContext: { count: 51, foo: 'bar' },
      twoValue: 'counting',
      twoContext: { count: 52, foo: 'bar' },
      threeValue: 'counting',
      threeContext: { count: 103, foo: 'bar' },
    })
  })

  it('should maintain state after unhandled event', function*({ expect }) {
    const counterMachine = createCounterMachine()
    const actorRef = createActor(counterMachine).start()

    actorRef.send({
      type: 'FAKE_EVENT',
    })
    const nextState = actorRef.getSnapshot()

    yield* expect({ defined: nextState.context !== undefined, context: nextState.context }).toEqual({
      defined: true,
      context: { count: 0, foo: 'bar' },
    })
  })

  it('sets undefined properties', function*({ expect }) {
    const counterMachine = createCounterMachine()
    const actorRef = createActor(counterMachine).start()

    actorRef.send({
      type: 'SET_MAYBE',
    })

    const nextState = actorRef.getSnapshot()

    yield* expect({ maybe: nextState.context.maybe, context: nextState.context }).toEqual({
      maybe: 'defined',
      context: {
        count: 0,
        foo: 'bar',
        maybe: 'defined',
      },
    })
  })

  it('can assign from event', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        events: {
          INC: z.object({ value: z.number() }),
        },
      },
      initial: 'active',
      context: {
        count: 0,
      },
      states: {
        active: {
          on: {
            INC: ({ event }) => ({
              context: {
                count: event.value,
              },
            }),
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'INC', value: 30 })

    yield* expect(actorRef.getSnapshot().context).toEqual({ count: 30 })
  })
})
