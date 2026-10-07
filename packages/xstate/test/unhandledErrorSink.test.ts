import { describe } from '@systemfsoftware/vitest'
import { Deferred, Effect } from 'effect'
import { createActor, createCallbackLogic, createMachine } from '../src/index.js'

describe('the actor system unhandled-error sink', (it) => {
  it('reports a root actor error once to the sink', function*({ expect }) {
    const boom = new Error('unhandled root error')
    const reported: unknown[] = []
    const reportMade = yield* Deferred.make<void>()
    const reportUnhandledError = (error: unknown) => {
      reported.push(error)
      Deferred.doneUnsafe(reportMade, Effect.void)
    }

    const actor = createActor(
      createCallbackLogic(() => {
        throw boom
      }),
      { reportUnhandledError },
    )
    actor.start()

    yield* Deferred.await(reportMade)
    yield* expect(reported).toEqual([boom])
  })

  it('reports nothing when an error listener observes the error', function*({ expect }) {
    const boom = new Error('observed root error')
    const reported: unknown[] = []
    const observed: unknown[] = []

    const actor = createActor(
      createCallbackLogic(() => {
        throw boom
      }),
      { reportUnhandledError: (error: unknown) => reported.push(error) },
    )
    actor.subscribe({ error: (error) => observed.push(error) })
    actor.start()

    yield* expect({ observed, reported }).toEqual({ observed: [boom], reported: [] })
  })

  it('reports a child actor error to the root system sink', function*({ expect }) {
    const childBoom = new Error('unhandled child error')
    const reported: unknown[] = []
    const reportMade = yield* Deferred.make<void>()
    const reportUnhandledError = (error: unknown) => {
      reported.push(error)
      Deferred.doneUnsafe(reportMade, Effect.void)
    }

    const parent = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            src: createCallbackLogic(() => {
              throw childBoom
            }),
          },
        },
      },
    })
    const actor = createActor(parent, { reportUnhandledError })
    actor.start()

    yield* Deferred.await(reportMade)
    yield* expect(reported).toEqual([childBoom])
  })
})
