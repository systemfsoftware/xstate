import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable } from '../src/durable/index.js'
import { createAsyncLogic, setup } from '../src/index.js'
import type { InspectionEvent } from '../src/inspection.js'

const fraudCheck = createAsyncLogic({
  id: 'fraudCheck',
  run: () => Promise.resolve(0.2),
})

const machine = setup({ actors: { fraudCheck } }).createMachine({
  id: 'order',
  initial: 'verifying',
  states: {
    verifying: {
      invoke: { id: 'fraud', src: 'fraudCheck', onDone: { target: 'approved' } },
    },
    approved: {},
  },
})

describe('durable execution inspection', () => {
  it('the inspect option observes the whole run without any adapter wiring', function*({ expect }) {
    const inspected: InspectionEvent[] = []
    const durable = createDurable(
      machine,
      {
        executeAction: () => {},
        startActor: (actor) => {
          actor.start()
        },
        waitForEvent: () => {
          throw new Error('host-driven loop')
        },
      },
      { inspect: (ev) => inspected.push(ev) },
    )

    const [snapshot, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    const done = yield* Effect.promise(() => durable.waitForEvent())
    const [next] = durable.transition(snapshot, done)

    const actorAddresses = inspected
      .filter((ev) => ev.type === '@xstate.actor')
      .map((ev) => 'address' in ev.actorRef ? ev.actorRef.address : undefined)
    const causingEventTypes = inspected
      .filter((ev) => ev.type === '@xstate.transition')
      .map((ev) => ev.event.type)

    yield* expect({
      status: next.status,
      value: 'value' in next ? next.value : undefined,
      observedTypes: Array.from(new Set(inspected.map((ev) => ev.type))),
      actorAddresses,
      causingEventTypes,
    }).toEqual({
      status: 'active',
      value: 'approved',
      observedTypes: expect.arrayContaining([
        '@xstate.actor',
        '@xstate.transition',
      ]),
      actorAddresses: expect.arrayContaining(['order', 'order/fraud']),
      causingEventTypes: expect.arrayContaining([
        expect.stringMatching(/^xstate\.done\.actor/),
      ]),
    })
  })

  it('inspection is host observability only: none without the option', function*({ expect }) {
    const durable = createDurable(machine, {
      executeAction: () => {},
      startActor: (actor) => {
        actor.start()
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })
    const [snapshot, effects] = durable.initialTransition()
    yield* Effect.promise(() => durable.executeEffects(effects))
    const done = yield* Effect.promise(() => durable.waitForEvent())
    const [next] = durable.transition(snapshot, done)

    yield* expect('value' in next ? next.value : undefined).toBe('approved')
  })
})
