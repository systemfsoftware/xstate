import { it } from '@systemfsoftware/vitest'
import { createMachine } from '@systemfsoftware/xstate'
import { createEffectActor } from '@systemfsoftware/xstate-effect'
import { Deferred, Duration, Effect, Exit, Schema, Scope } from 'effect'

const emitterMachine = createMachine({
  initial: 'active',
  states: {
    active: {
      on: {
        PING: (_args, enq) => {
          enq.emit({ type: 'pinged' })
        },
      },
    },
  },
})

const identifiedMachine = createMachine({
  id: 'identified',
  initial: 'active',
  states: { active: {} },
})

const NOTIFICATION_ENTRIES = 4

const ActorJson = Schema.fromJsonString(
  Schema.Struct({
    xstate$$type: Schema.Finite,
    id: Schema.String,
  }),
)

const reportedOrder = Effect.gen(function*() {
  const order: string[] = []
  const errorA = new Error('listener A threw')
  const errorB = new Error('listener B threw')
  const recorded = yield* Deferred.make<void>()
  const record = (entry: string) => {
    order.push(entry)
    if (order.length === NOTIFICATION_ENTRIES) {
      Deferred.doneUnsafe(recorded, Effect.void)
    }
  }
  process.setUncaughtExceptionCaptureCallback((error: unknown) => {
    record(
      error === errorA
        ? 'error-A'
        : error === errorB
        ? 'error-B'
        : 'error-unexpected',
    )
  })
  const services = yield* Effect.context<never>()
  const scope = yield* Scope.make()
  return yield* Effect.gen(function*() {
    const actor = yield* Scope.provide(createEffectActor(emitterMachine), scope)
    actor.on('pinged', () => {
      Effect.runCallbackWith(services)(Effect.sleep(Duration.millis(1)), {
        onExit: () => record('timer-marker'),
      })
    })
    actor.on('pinged', () => {
      throw errorA
    })
    actor.on('pinged', () => {
      throw errorB
    })
    actor.on('pinged', () => {
      queueMicrotask(() => {
        record('microtask-marker')
      })
    })
    actor.send({ type: 'PING' })
    yield* Deferred.await(recorded)
    return order
  }).pipe(
    Effect.ensuring(Scope.close(scope, Exit.void)),
    Effect.ensuring(
      Effect.sync(() => process.setUncaughtExceptionCaptureCallback(null)),
    ),
  )
})

it.live(
  'Should_ReportListenerErrorsAsMacrotasksInNotificationOrder_When_TwoListenersThrow',
  function*({ expect }) {
    const order = yield* reportedOrder
    yield* expect(order).toEqual([
      'microtask-marker',
      'timer-marker',
      'error-A',
      'error-B',
    ])
  },
)

it.live(
  'Should_SerializeAnEffectActorWithUpstreamTypeTag_When_Stringified',
  function*({ expect }) {
    const json = yield* Effect.gen(function*() {
      const scope = yield* Scope.make()
      return yield* Effect.gen(function*() {
        const actor = yield* Scope.provide(
          createEffectActor(identifiedMachine),
          scope,
        )
        return yield* Schema.encodeEffect(ActorJson)(actor.toJSON()).pipe(
          Effect.orDie,
        )
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
    })
    yield* expect(json).toEqual('{"xstate$$type":1,"id":"identified"}')
  },
)
