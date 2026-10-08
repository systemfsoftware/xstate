import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine, createSystem, type EventRejection } from '../src/index.js'

const machine = createMachine({})

function stoppedActor(options?: Parameters<typeof createActor>[1]) {
  const actor = createActor(machine, options).start()
  actor.stop()
  return actor
}

describe('system.onRejectedEvent', () => {
  it('delivers a rejection to every listener in registration order', function*({ expect }) {
    const calls: string[] = []
    const rejections: EventRejection[] = []
    const actor = stoppedActor()

    actor.system.onRejectedEvent((rejection) => {
      calls.push('first')
      rejections.push(rejection)
    })
    actor.system.onRejectedEvent((rejection) => {
      calls.push('second')
      rejections.push(rejection)
    })

    actor.send({ type: 'PING' })

    yield* expect({
      calls,
      firstIsSecond: rejections[0] === rejections[1],
      firstRejection: {
        event: rejections[0]?.event,
        targetRef: rejections[0]?.targetRef,
        eventOrigin: rejections[0]?.eventOrigin,
        reason: rejections[0]?.reason,
      },
    }).toEqual({
      calls: ['first', 'second'],
      firstIsSecond: true,
      firstRejection: {
        event: { type: 'PING' },
        targetRef: actor,
        eventOrigin: 'external',
        reason: 'stopped',
      },
    })
  })

  it('stops delivering after unsubscribe', function*({ expect }) {
    const rejections: EventRejection[] = []
    const actor = stoppedActor()

    const subscription = actor.system.onRejectedEvent((rejection) => {
      rejections.push(rejection)
    })
    actor.send({ type: 'ONE' })
    subscription.unsubscribe()
    actor.send({ type: 'TWO' })

    yield* expect(rejections.map((r) => r.event.type)).toEqual(['ONE'])
  })

  it('keeps delivering to later listeners when one throws', function*({ expect }) {
    const reported: unknown[] = []
    const error = new Error('listener failed')
    const rejections: EventRejection[] = []
    const actor = stoppedActor({
      reportUnhandledError: (err) => {
        reported.push(err)
      },
    })

    actor.system.onRejectedEvent(() => {
      throw error
    })
    actor.system.onRejectedEvent((rejection) => {
      rejections.push(rejection)
    })

    actor.send({ type: 'PING' })

    yield* expect({
      rejections: rejections.map((r) => r.event.type),
      reported,
    }).toEqual({ rejections: ['PING'], reported: [error] })
  })

  it('registers the createActor onRejectedEvent option as a listener', function*({ expect }) {
    const calls: string[] = []
    const actor = stoppedActor({
      onRejectedEvent: () => {
        calls.push('option')
      },
    })
    actor.system.onRejectedEvent(() => {
      calls.push('late')
    })

    actor.send({ type: 'PING' })

    yield* expect(calls).toEqual(['option', 'late'])
  })

  it('is exposed on createSystem before the first actor exists', function*({ expect }) {
    const rejections: EventRejection[] = []
    const system = createSystem()
    system.onRejectedEvent((rejection) => {
      rejections.push(rejection)
    })

    const actor = system.createActor(machine).start()
    actor.stop()
    actor.send({ type: 'PING' })

    yield* expect(rejections.map((r) => r.event.type)).toEqual(['PING'])
  })
})
