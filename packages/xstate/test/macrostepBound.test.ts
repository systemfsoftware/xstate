import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine, InfiniteTransitionError } from '../src/index.js'

function countingMachine(target: number, maxIterations?: number) {
  return createMachine({
    id: 'counter',
    ...(maxIterations !== undefined && { options: { maxIterations } }),
    schemas: {
      context: z.object({ n: z.number() }),
    },
    context: { n: 0 },
    initial: 'idle',
    states: {
      idle: {
        on: { START: { target: 'counting' } },
      },
      counting: {
        always: ({ context }) => context.n < target ? { context: { n: context.n + 1 } } : undefined,
      },
    },
  })
}

describe('macrostep bound', (it) => {
  it('throws InfiniteTransitionError at the default bound for an always loop', function*({
    expect,
  }) {
    const actor = createActor(
      createMachine({
        id: 'loop',
        initial: 'idle',
        states: {
          idle: { on: { GO: { target: 'a' } } },
          a: { always: { target: 'b' } },
          b: { always: { target: 'a' } },
        },
      }),
    )
    const errors: unknown[] = []
    actor.subscribe({ error: (error) => errors.push(error) })
    actor.start()
    actor.send({ type: 'GO' })

    const error = errors[0]
    if (!(error instanceof InfiniteTransitionError)) {
      throw new Error(
        'expected the actor to error with an InfiniteTransitionError',
      )
    }

    yield* expect({
      status: actor.getSnapshot().status,
      name: error.name,
      maxIterations: error.maxIterations,
      actorId: error.actorId,
      event: error.event,
    }).toEqual({
      status: 'error',
      name: 'InfiniteTransitionError',
      maxIterations: 1000,
      actorId: actor.id,
      event: { type: 'GO' },
    })
  })

  it('names the actor, the event and the last 5 states in the message', function*({
    expect,
  }) {
    const actor = createActor(
      createMachine({
        initial: 'idle',
        options: { maxIterations: 10 },
        states: {
          idle: { on: { GO: { target: 'a' } } },
          a: { always: { target: 'b' } },
          b: { always: { target: 'c' } },
          c: { always: { target: 'a' } },
        },
      }),
      { id: 'looper' },
    )
    const errors: unknown[] = []
    actor.subscribe({ error: (error) => errors.push(error) })
    actor.start()
    actor.send({ type: 'GO' })

    const error = errors[0]
    if (!(error instanceof InfiniteTransitionError)) {
      throw new Error(
        'expected the actor to error with an InfiniteTransitionError',
      )
    }

    yield* expect({
      states: error.states,
      message: error.message,
    }).toEqual({
      states: ['c', 'a', 'b', 'c', 'a'],
      message:
        'Infinite loop detected in actor "looper" processing event "GO": more than 10 microsteps without reaching a stable state. Last states: "c" -> "a" -> "b" -> "c" -> "a". Check for a cycle of eventless transitions or raised events, or raise the bound with createMachine({ options: { maxIterations } }).',
    })
  })

  it('counts 1000 microsteps within the default bound', function*({ expect }) {
    const actor = createActor(countingMachine(999)).start()
    actor.send({ type: 'START' })

    yield* expect({
      status: actor.getSnapshot().status,
      n: actor.getSnapshot().context.n,
    }).toEqual({ status: 'active', n: 999 })
  })

  it('allows 3000 microsteps with maxIterations: 5000', function*({ expect }) {
    const errors: unknown[] = []
    const failing = createActor(countingMachine(3000))
    failing.subscribe({ error: (error) => errors.push(error) })
    failing.start()
    failing.send({ type: 'START' })

    const actor = createActor(countingMachine(3000, 5000)).start()
    actor.send({ type: 'START' })

    yield* expect({
      boundedByDefault: errors[0] instanceof InfiniteTransitionError,
      status: actor.getSnapshot().status,
      n: actor.getSnapshot().context.n,
    }).toEqual({ boundedByDefault: true, status: 'active', n: 3000 })
  })
})
