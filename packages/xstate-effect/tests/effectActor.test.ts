import { it } from '@systemfsoftware/vitest'
import { createMachine } from '@systemfsoftware/xstate'
import { createEffectActor } from '@systemfsoftware/xstate-effect'
import { Effect, Exit, Scope } from 'effect'

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

const reportedOrder = async (): Promise<ReadonlyArray<string>> => {
  const order: string[] = []
  const errorA = new Error('listener A threw')
  const errorB = new Error('listener B threw')
  let complete: () => void = () => {}
  const recorded = new Promise<void>((resolve) => {
    complete = resolve
  })
  const record = (entry: string) => {
    order.push(entry)
    if (order.length === NOTIFICATION_ENTRIES) {
      complete()
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
  const scope = await Effect.runPromise(Scope.make())
  try {
    const actor = await Effect.runPromise(
      Scope.provide(createEffectActor(emitterMachine), scope),
    )
    actor.on('pinged', () => {
      setTimeout(() => {
        record('timer-marker')
      }, 0)
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
    await recorded
    return order
  } finally {
    process.setUncaughtExceptionCaptureCallback(null)
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

it.live(
  'Should_ReportListenerErrorsAsMacrotasksInNotificationOrder_When_TwoListenersThrow',
  function*({ expect }) {
    const order = yield* Effect.promise(reportedOrder)
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
    const json = yield* Effect.promise(async () => {
      const scope = await Effect.runPromise(Scope.make())
      try {
        const actor = await Effect.runPromise(
          Scope.provide(createEffectActor(identifiedMachine), scope),
        )
        return JSON.stringify(actor)
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
    })
    yield* expect(json).toEqual('{"xstate$$type":1,"id":"identified"}')
  },
)
