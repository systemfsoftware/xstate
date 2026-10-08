import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { createDurable } from '../src/durable/index.js'
import {
  type AnyEventObject,
  createActor,
  createMachine,
  type EventRejection,
  initialTransition,
  setup,
  transition,
} from '../src/index.js'
import { standardSchemaValidator } from '../src/validation/index.js'

type GoEvent = { type: 'GO'; count: number }
type TickEvent = { type: 'tick'; count: number }

const createValidatedMachine = () =>
  setup({
    validator: standardSchemaValidator(),
    schemas: {
      events: {
        GO: z.object({ count: z.number() }),
        FINISH: z.object({}),
      },
    },
  }).createMachine({
    initial: 'idle',
    states: {
      idle: {
        on: {
          GO: { target: 'going' },
          FINISH: { target: 'done' },
        },
      },
      going: {
        on: { FINISH: { target: 'done' } },
      },
      done: { type: 'final' },
    },
  })

describe('event boundary: reject and report', () => {
  it('rejects an invalid external event on send without erroring the actor', function*({ expect }) {
    const rejections: EventRejection[] = []
    const actor = createActor(createValidatedMachine(), {
      onRejectedEvent: (rejection) => rejections.push(rejection),
    }).start()

    actor.send({ type: 'GO', count: 'oops' } as unknown as GoEvent)

    const idleValue = actor.getSnapshot().value
    const idleStatus = actor.getSnapshot().status

    if (rejections[0] === undefined) {
      throw new Error('expected an event rejection')
    }
    const rejection = rejections[0]
    const issueCountPositive = (rejection.issues?.length ?? 0) > 0
    const isError = rejection.error instanceof Error

    actor.send({ type: 'GO', count: 1 })
    const finalValue = actor.getSnapshot().value

    yield* expect({
      idleValue,
      idleStatus,
      rejectionCount: rejections.length,
      event: rejection.event,
      targetRefIsActor: rejection.targetRef === actor,
      targetId: rejection.targetId,
      sourceRef: rejection.sourceRef,
      eventOrigin: rejection.eventOrigin,
      reason: rejection.reason,
      issueCountPositive,
      isError,
      finalValue,
    }).toEqual({
      idleValue: 'idle',
      idleStatus: 'active',
      rejectionCount: 1,
      event: { type: 'GO', count: 'oops' },
      targetRefIsActor: true,
      targetId: actor.id,
      sourceRef: undefined,
      eventOrigin: 'external',
      reason: 'invalidEvent',
      issueCountPositive: true,
      isError: true,
      finalValue: 'going',
    })
  })

  it('rejects an invalid event sent from another actor with eventOrigin "actor"', function*({ expect }) {
    const child = createValidatedMachine()
    const rejections: EventRejection[] = []
    const parent = createMachine({
      invoke: { id: 'child', src: child },
      on: {
        forward: ({ children }, enq) => {
          enq.sendTo(children['child']!, {
            type: 'GO',
            count: 'bad',
          } as unknown as GoEvent)
        },
      },
    })
    const actor = createActor(parent, {
      onRejectedEvent: (rejection) => rejections.push(rejection),
    }).start()

    actor.send({ type: 'forward' })

    if (rejections[0] === undefined) {
      throw new Error('expected an event rejection')
    }
    const rejection = rejections[0]

    yield* expect({
      rejectionCount: rejections.length,
      event: rejection.event,
      targetId: rejection.targetId,
      eventOrigin: rejection.eventOrigin,
      reason: rejection.reason,
      sourceRefIsActor: rejection.sourceRef === actor,
      actorStatus: actor.getSnapshot().status,
      childStatus: actor.getSnapshot().children['child']!.getSnapshot().status,
    }).toEqual({
      rejectionCount: 1,
      event: { type: 'GO', count: 'bad' },
      targetId: 'child',
      eventOrigin: 'actor',
      reason: 'invalidEvent',
      sourceRefIsActor: true,
      actorStatus: 'active',
      childStatus: 'active',
    })
  })

  it('warns on rejection in development mode', function*({ expect }) {
    const rejections: EventRejection[] = []
    const warnings: string[] = []
    const actor = createActor(createValidatedMachine(), {
      onRejectedEvent: (rejection) => rejections.push(rejection),
      warn: (message) => warnings.push(message),
    }).start()
    actor.send({ type: 'GO', count: 'oops' } as unknown as GoEvent)

    yield* expect({
      warnings,
      rejectionCount: rejections.length,
      event: rejections[0]?.event,
      reason: rejections[0]?.reason,
      targetIsActor: rejections[0]?.targetId === actor.id,
      actorStatus: actor.getSnapshot().status,
    }).toEqual({
      warnings: ['Event "GO" to actor "x:0" was not delivered (invalidEvent).'],
      rejectionCount: 1,
      event: { type: 'GO', count: 'oops' },
      reason: 'invalidEvent',
      targetIsActor: true,
      actorStatus: 'active',
    })
  })

  it('rejects queued deliveries of internal event types from outside', function*({ expect }) {
    const machine = createMachine({
      schemas: { internalEvents: { tick: z.object({}) } },
      initial: 'idle',
      states: {
        idle: { on: { tick: { target: 'done' } } },
        done: {},
      },
    })
    const rejections: EventRejection[] = []
    const actor = createActor(machine, {
      onRejectedEvent: (rejection) => rejections.push(rejection),
    }).start()
    ;(actor.send as (event: AnyEventObject) => void)({ type: 'tick' })

    yield* expect({
      value: actor.getSnapshot().value,
      eventOrigin: rejections[0]?.eventOrigin,
      reason: rejections[0]?.reason,
    }).toEqual({
      value: 'idle',
      eventOrigin: 'external',
      reason: 'internalEvent',
    })
  })

  it('pure transition() returns the snapshot unchanged with a rejection effect', function*({ expect }) {
    const machine = createValidatedMachine()
    const [snapshot] = initialTransition(machine)

    const [nextSnapshot, effects] = transition(machine, snapshot, {
      type: 'GO',
      count: 'oops',
    } as unknown as GoEvent)

    yield* expect({
      unchanged: nextSnapshot === snapshot,
      effectCount: effects.length,
      effect: effects[0],
    }).toMatchObject({
      unchanged: true,
      effectCount: 1,
      effect: {
        kind: 'builtin',
        type: '@xstate.deadLetter',
        event: { type: 'GO', count: 'oops' },
        reason: 'invalidEvent',
      },
    })
  })

  it('internal faults still error: an invalid delayed raise errors the actor', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: {
          START: z.object({}),
        },
        internalEvents: {
          tick: z.object({ count: z.number() }),
        },
      },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            START: (_, enq) => {
              enq.raise({ type: 'tick', count: 'bad' } as unknown as TickEvent, {
                delay: 10,
              })
            },
            tick: {},
          },
        },
      },
    })

    // pure transition throws — a machine bug must be loud
    const [snapshot] = initialTransition(machine)
    let thrown: unknown
    try {
      transition(machine, snapshot, { type: 'START' })
    } catch (error) {
      thrown = error
    }
    const thrownMessage = thrown instanceof Error
      ? thrown.message
      : String(thrown)

    const rejections: EventRejection[] = []
    const actor = createActor(machine, {
      onRejectedEvent: (rejection) => rejections.push(rejection),
    })
    actor.subscribe({ error: () => {} })
    actor.start()
    actor.send({ type: 'START' })

    yield* expect({
      thrownMessage,
      status: actor.getSnapshot().status,
      rejectionCount: rejections.length,
    }).toEqual({
      thrownMessage: expect.stringMatching(/tick/),
      status: 'error',
      rejectionCount: 0,
    })
  })

  describe('durable execution', () => {
    it('journals rejections through the deadLetter runtime operation and keeps replay total', function*({ expect }) {
      const machine = createValidatedMachine()
      const queue: AnyEventObject[] = [
        { type: 'GO', count: 'poisoned' },
        { type: 'GO', count: 1 },
        { type: 'FINISH' },
      ]
      const rejected: Array<{ event: AnyEventObject; reason: string }> = []

      const execution = createDurable(machine, {
        executeAction: () => {},
        deadLetter: (_source, _target, event, reason) => {
          rejected.push({ event, reason })
        },
        waitForEvent: () => queue.shift()!,
      })

      yield* Effect.promise(() => execution.run())

      yield* expect({
        remaining: queue.length,
        rejectionCount: rejected.length,
        rejection: rejected[0],
      }).toMatchObject({
        remaining: 0,
        rejectionCount: 1,
        rejection: {
          event: { type: 'GO', count: 'poisoned' },
          reason: 'invalidEvent',
        },
      })
    })

    it('replaying a poisoned event yields the same unchanged snapshot (totality)', function*({ expect }) {
      const machine = createValidatedMachine()
      const execution = createDurable(machine, {
        executeAction: () => {},
        waitForEvent: () => {
          throw new Error('unused')
        },
      })

      const [snapshot] = execution.initialTransition()
      const poisoned = { type: 'GO', count: 'poisoned' } as unknown as GoEvent

      const [first, firstEffects] = execution.transition(snapshot, poisoned)
      const [second, secondEffects] = execution.transition(snapshot, poisoned)

      if (firstEffects[0] === undefined) {
        throw new Error('expected a first effect')
      }
      if (secondEffects[0] === undefined) {
        throw new Error('expected a second effect')
      }

      yield* expect({
        firstUnchanged: first === snapshot,
        secondUnchanged: second === snapshot,
        firstEffect: firstEffects[0].effect,
        secondEffect: secondEffects[0].effect,
      }).toMatchObject({
        firstUnchanged: true,
        secondUnchanged: true,
        firstEffect: { type: '@xstate.deadLetter' },
        secondEffect: { type: '@xstate.deadLetter' },
      })
    })
  })
})
