import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import z from 'zod'
import {
  type ActorRefFrom,
  createActor,
  createMachine,
  type EventRejection,
  type SendableEventFromLogic,
  setup,
  types,
} from '../src/index.js'

describe('internalEvents', () => {
  it('keeps setup-level internal events out of the public protocol', function*({ expect }) {
    const machine = setup({
      schemas: {
        events: { GO: types<{}>() },
        internalEvents: { TICK: types<{}>() },
      },
    }).createMachine({
      initial: 'idle',
      states: { idle: { on: { GO: {}, TICK: {} } } },
    })
    const actor = createActor(machine)
    type Sendable = SendableEventFromLogic<typeof machine>
    const publicEvent: Sendable = { type: 'GO' }
    yield* expect(publicEvent.type).toBe('GO')
    if (false) {
      // @ts-expect-error Internal events are not public.
      const internalEvent: Sendable = { type: 'TICK' }
      // @ts-expect-error External callers cannot send an internal event.
      actor.send({ type: 'TICK' })
      // @ts-expect-error Internal events have no public trigger method.
      actor.trigger.TICK()
    }
  })

  it('keeps registered child internal events private for both spawn forms', function*({ expect }) {
    const child = setup({
      schemas: {
        events: { GO: types<{}>() },
        internalEvents: { TICK: types<{}>() },
      },
    }).createMachine({
      initial: 'idle',
      states: { idle: { on: { GO: {}, TICK: {} } } },
    })
    const parent = setup({ actors: { child } }).createMachine({
      on: {
        GO: ({ actors }, enq) => {
          const byKey = enq.spawn('child')
          const byLogic = enq.spawn(actors.child)
          byKey.send({ type: 'GO' })
          byLogic.send({ type: 'GO' })
          if (false) {
            // @ts-expect-error Internal events stay private via the key overload.
            byKey.send({ type: 'TICK' })
            // @ts-expect-error Internal events have no public trigger method.
            byKey.trigger.TICK()
            // @ts-expect-error Internal events stay private via the logic overload.
            byLogic.send({ type: 'TICK' })
            // @ts-expect-error Internal events have no public trigger method.
            byLogic.trigger.TICK()
          }
        },
      },
    })
    yield* expect(parent).toMatchObject({ id: '(machine)' })
  })

  it('supports separately declared internal event schemas', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          start: z.object({}),
        },
        internalEvents: {
          tick: z.object({ count: z.number() }),
          'change.*': z.object({ value: z.string() }),
        },
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            start: (_, enq) => {
              enq.raise({ type: 'tick', count: 1 })
              enq.raise({ type: 'change.value', value: 'ready' })
            },
            tick: {},
            'change.value': { target: 'done' },
          },
        },
        done: {},
      },
    })

    const deadLetters: EventRejection[] = []
    const actor = createActor(machine, {
      onRejectedEvent: (rejection) => deadLetters.push(rejection),
    }).start()
    actor.send({ type: 'start' })

    const valueAfterStart = actor.getSnapshot().value
    const validated = yield* Effect.promise(() =>
      Promise.resolve(
        machine.eventSchema['~standard'].validate({
          type: 'change.value',
          value: 'ready',
        }),
      )
    )
    actor.system.runtime = { sendEvent: () => {} }
    actor.send(
      { type: 'tick', count: 2 } as unknown as SendableEventFromLogic<
        typeof machine
      >,
    )
    const deadLetter = deadLetters[0]
    yield* expect({
      valueAfterStart,
      validated,
      deadLetterCount: deadLetters.length,
      reason: deadLetter?.reason,
      message: deadLetter?.error?.message,
    }).toEqual({
      valueAfterStart: 'done',
      validated: {
        value: { type: 'change.value', value: 'ready' },
      },
      deadLetterCount: 1,
      reason: 'internalEvent',
      message: 'Internal event "tick" cannot be sent to actor "x:0" from outside.',
    })
  })

  it('allows raising internal events', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          foo: z.object({}),
        },
        internalEvents: {
          tick: z.object({}),
        },
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            foo: (_, enq) => {
              enq.raise({ type: 'tick' })
            },
            tick: { target: 'done' },
          },
        },
        done: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'foo' })

    yield* expect(actor.getSnapshot().value).toBe('done')
  })

  it('rejects sending internal events from outside', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          foo: z.object({}),
        },
        internalEvents: {
          tick: z.object({}),
        },
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            foo: { target: 'done' },
            tick: { target: 'done' },
          },
        },
        done: {},
      },
    })

    const rejections: EventRejection[] = []
    const actor = createActor(machine, {
      onRejectedEvent: (rejection) => rejections.push(rejection),
    }).start()

    actor.send({ type: 'tick' } as unknown as SendableEventFromLogic<typeof machine>)

    const rejection = rejections[0]
    yield* expect({
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
      rejectionCount: rejections.length,
      event: rejection?.event,
      targetId: rejection?.targetId,
      eventOrigin: rejection?.eventOrigin,
      reason: rejection?.reason,
      message: rejection?.error?.message,
    }).toEqual({
      value: 'idle',
      status: 'active',
      rejectionCount: 1,
      event: { type: 'tick' },
      targetId: actor.id,
      eventOrigin: 'external',
      reason: 'internalEvent',
      message: 'Internal event "tick" cannot be sent to actor "x:0" from outside.',
    })
  })

  it('throws in development for the removed top-level internalEvents key', function*({ expect }) {
    let thrown: unknown
    try {
      createMachine({
        // @ts-expect-error removed; use `schemas.internalEvents`
        internalEvents: ['tick'],
      })
    } catch (error) {
      thrown = error
    }
    yield* expect(
      thrown instanceof Error
        ? { name: thrown.name, message: thrown.message }
        : thrown,
    ).toEqual({
      name: 'Error',
      message:
        'The top-level "internalEvents" list was removed. Declare private events under `schemas.internalEvents` instead, e.g. `schemas: { internalEvents: { tick: types<{}>() } }`.',
    })
  })

  it('rejects sending wildcard-matched internal events from outside', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        internalEvents: {
          'change.*': z.object({ value: z.string() }),
        },
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            'change.value': { target: 'done' },
          },
        },
        done: {},
      },
    })

    const rejections: EventRejection[] = []
    const actor = createActor(machine, {
      onRejectedEvent: (rejection) => rejections.push(rejection),
    }).start()

    actor.send(
      // @ts-expect-error
      { type: 'change.value', value: 'x' },
    )

    const rejection = rejections[0]
    yield* expect({
      value: actor.getSnapshot().value,
      rejectionCount: rejections.length,
      reason: rejection?.reason,
      message: rejection?.error?.message,
    }).toEqual({
      value: 'idle',
      rejectionCount: 1,
      reason: 'internalEvent',
      message: 'Internal event "change.value" cannot be sent to actor "x:0" from outside.',
    })
  })
})

it('an untyped machine keeps its sendable events (type-level)', function*({ expect }) {
  const machine = createMachine({
    initial: 'a',
    states: { a: { on: { NEXT: { target: 'a' } } } },
  })
  const actor = createActor(machine).start()
  actor.send({ type: 'NEXT' })
  const ref: ActorRefFrom<typeof machine> = actor
  ref.send({ type: 'NEXT' })
  const value = actor.getSnapshot().value
  actor.stop()
  yield* expect(value).toEqual('a')
})
