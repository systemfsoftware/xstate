import { describe, expectTypeOf, it } from '@systemfsoftware/vitest'
import { type AnyActorRef, createMachine, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Stream } from 'effect'
import {
  ActorFailedError,
  ActorStoppedError,
  createEffectActor,
  EffectActor,
  emitted,
  fromEffect,
  inspect,
  join,
  send,
  snapshots,
  waitFor,
} from './index.js'

const until = (predicate: () => boolean, timeoutMs = 1000) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while (!predicate()) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(new Error('Timed out waiting for condition'))
      }
      yield* Effect.sleep(1)
    }
  })

const afterSubscribe = (actor: AnyActorRef, drive: () => void): void => {
  const actorSubscribe = actor.subscribe.bind(actor)
  let driven = false
  actor.subscribe = ((...args: Parameters<typeof actorSubscribe>) => {
    const subscription = actorSubscribe(...args)
    if (!driven) {
      driven = true
      queueMicrotask(drive)
    }
    return subscription
  }) as typeof actor.subscribe
}

/** The `actor.inspect` counterpart of {@link afterSubscribe}. */
const afterInspect = (actor: EffectActor<any>, drive: () => void): void => {
  const actorInspect = actor.inspect.bind(actor)
  actor.inspect = ((observer: Parameters<typeof actorInspect>[0]) => {
    const subscription = actorInspect(observer)
    queueMicrotask(drive)
    return subscription
  }) as typeof actor.inspect
}

const counterMachine = createMachine({
  schemas: {
    events: {
      INCREMENT: types<{}>(),
      FINISH: types<{}>(),
    },
  },
  context: { count: 0 },
  initial: 'counting',
  states: {
    counting: {
      on: {
        INCREMENT: ({ context }) => ({
          context: { count: context.count + 1 },
        }),
        FINISH: { target: 'finished' },
      },
    },
    finished: { type: 'final' },
  },
  output: ({ context }) => ({ count: context.count }),
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>
type DoneCounterSnapshot = CounterSnapshot & { status: 'done' }

const isDone = (snapshot: CounterSnapshot): snapshot is DoneCounterSnapshot => snapshot.status === 'done'

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

describe('send', (it) => {
  it('sends an event to the actor', function*({ expect }) {
    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)

        yield* send(actor, { type: 'INCREMENT' })
        yield* send(actor, { type: 'INCREMENT' })
        yield* waitFor(actor, (state) => state.context.count === 2)

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ count: 2 })
  })

  it('accepts the data-last form', function*({ expect }) {
    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)

        yield* send({ type: 'INCREMENT' } as const)(actor)
        yield* waitFor(actor, (state) => state.context.count === 1)

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ count: 1 })
  })

  it('rejects events the actor cannot receive', function*({ expect }) {
    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)

        const sendUnknownEvent = () =>
          // @ts-expect-error -- the event type is derived from the actor
          send(actor, { type: 'UNKNOWN' })

        void sendUnknownEvent
        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ count: 0 })
  })
})

describe('snapshots', (it) => {
  it('emits the current snapshot, then every change, and ends on completion', function*({ expect }) {
    const collected = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.send({ type: 'INCREMENT' })
          actor.send({ type: 'FINISH' })
        })

        return yield* Stream.runCollect(snapshots(actor))
      }),
    )

    yield* expect(
      [...collected].map((snapshot) => ({
        count: snapshot.context.count,
        status: snapshot.status,
      })),
    ).toEqual([
      { count: 0, status: 'active' },
      { count: 1, status: 'active' },
      { count: 1, status: 'done' },
    ])
  })

  it('emits the error snapshot and ends when the actor errors', function*({ expect }) {
    const failure = { code: 'BOOM' as const }
    const collected = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* Effect.fail(failure).pipe(
          Effect.delay(10),
          (effect) => fromEffect(effect),
          (logic) => createEffectActor(logic),
        )

        return yield* Stream.runCollect(snapshots(actor))
      }),
    )

    yield* expect(
      [...collected].map((snapshot) => ({
        status: snapshot.status,
        error: snapshot.error,
      })),
    ).toEqual([
      { status: 'active', error: undefined },
      { status: 'error', error: failure },
    ])
  })

  it('unsubscribes from the actor when the stream is interrupted', function*({ expect }) {
    const unsubscribeCalls: string[] = []
    const collected = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        const actorSubscribe = actor.subscribe.bind(actor)
        actor.subscribe = ((...args: Parameters<typeof actorSubscribe>) => {
          const subscription = actorSubscribe(...args)
          queueMicrotask(() => {
            actor.send({ type: 'INCREMENT' })
            actor.send({ type: 'INCREMENT' })
          })
          return {
            unsubscribe: () => {
              unsubscribeCalls.push('unsubscribe')
              subscription.unsubscribe()
            },
          }
        }) as typeof actor.subscribe

        return yield* Stream.runCollect(snapshots(actor).pipe(Stream.take(2)))
      }),
    )

    yield* expect({
      counts: [...collected].map((snapshot) => snapshot.context.count),
      unsubscribeCalls,
    }).toEqual({ counts: [0, 1], unsubscribeCalls: ['unsubscribe'] })
  })
})

describe('emitted', (it) => {
  it('streams emitted events and ends when the actor stops', function*({ expect }) {
    const collected: unknown[] = []
    yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(emitterMachine)
        const listening = yield* Deferred.make<void>()
        const actorOn = actor.on.bind(actor)
        actor.on = ((...args: Parameters<typeof actorOn>) => {
          Deferred.doneUnsafe(listening, Effect.void)
          return actorOn(...args)
        }) as typeof actor.on

        const fiber = yield* Effect.forkScoped(
          Stream.runForEach(emitted(actor), (event) =>
            Effect.sync(() => {
              collected.push(event)
            })),
        )
        yield* Deferred.await(listening)

        actor.send({ type: 'PING' })
        actor.send({ type: 'PING' })
        yield* until(() => collected.length === 2)

        actor.stop()
        yield* Fiber.join(fiber)
      }),
    )

    yield* expect(collected).toEqual([{ type: 'pinged' }, { type: 'pinged' }])
  })
})

describe('waitFor', (it) => {
  it('resolves immediately when the current snapshot matches', function*({ expect }) {
    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)

        const snapshot = yield* waitFor(actor, (state) => state.context.count === 0)
        return snapshot.context
      }),
    )

    yield* expect(context).toEqual({ count: 0 })
  })

  it('resolves on the first later snapshot that matches', function*({ expect }) {
    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.send({ type: 'INCREMENT' })
          actor.send({ type: 'INCREMENT' })
        })

        const snapshot = yield* waitFor(actor, (state) => state.context.count === 2)
        return snapshot.context
      }),
    )

    yield* expect(context).toEqual({ count: 2 })
  })

  it('accepts the data-last form', function*({ expect }) {
    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.send({ type: 'INCREMENT' })
        })

        const snapshot = yield* waitFor(
          (state: CounterSnapshot) => state.context.count === 1,
        )(actor)
        return snapshot.context
      }),
    )

    yield* expect(context).toEqual({ count: 1 })
  })

  it('narrows the snapshot with a type-predicate predicate', function*({ expect }) {
    const snapshot = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.send({ type: 'FINISH' })
        })

        return yield* waitFor(actor, isDone)
      }),
    )

    snapshot satisfies { status: 'done' }
    yield* expect(snapshot.output).toEqual({ count: 0 })
  })

  it('fails with ActorStoppedError when the actor stops first', function*({ expect }) {
    const error = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.stop()
        })

        return yield* Effect.flip(
          waitFor(actor, (state) => state.context.count === 10),
        )
      }),
    )

    yield* expect({ tag: error._tag, message: error.message }).toEqual({
      tag: 'ActorStoppedError',
      message: expect.stringMatching(/^Actor ".+" stopped before completing$/),
    })
  })

  it('fails with TimeoutError when the timeout elapses', function*({ expect }) {
    const error = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)

        return yield* Effect.flip(
          waitFor(actor, (state) => state.context.count === 10, {
            timeout: Duration.millis(10),
          }),
        )
      }),
    )

    yield* expect(error).toMatchObject({ _tag: 'TimeoutError' })
  })
})

describe('join', (it) => {
  it('succeeds with the actor output when it is done', function*({ expect }) {
    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.send({ type: 'INCREMENT' })
          actor.send({ type: 'FINISH' })
        })

        return yield* join(actor)
      }),
    )

    yield* expect(output).toEqual({ count: 1 })
  })

  it('fails with ActorFailedError carrying the typed actor error', function*({ expect }) {
    const failure = { code: 'X' as const }
    const error = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* Effect.fail(failure).pipe(
          Effect.delay(10),
          (effect) => fromEffect(effect),
          (logic) => createEffectActor(logic),
        )

        return yield* Effect.flip(join(actor))
      }),
    )

    error satisfies ActorFailedError<{ code: 'X' }> | ActorStoppedError
    yield* expect(error).toMatchObject({
      _tag: '@systemfsoftware/xstate-effect/errors/ActorFailedError',
      cause: failure,
    })
  })

  it('fails with ActorFailedError carrying the thrown value', function*({ expect }) {
    const failure = { code: 'MACHINE_FAILURE' }
    const machine = createMachine({
      on: {
        FAIL: () => {
          throw failure
        },
      },
    })
    const error = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        const result = join(actor)
        expectTypeOf<Effect.Error<typeof result>>().toEqualTypeOf<
          ActorFailedError | ActorStoppedError
        >()
        afterSubscribe(actor, () => actor.send({ type: 'FAIL' }))
        return yield* Effect.flip(result)
      }),
    )

    yield* expect(error).toMatchObject({
      _tag: '@systemfsoftware/xstate-effect/errors/ActorFailedError',
      cause: failure,
    })
  })

  it('fails with ActorStoppedError when the actor is stopped', function*({ expect }) {
    const error = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterSubscribe(actor, () => {
          actor.stop()
        })

        return yield* Effect.flip(join(actor))
      }),
    )

    yield* expect({ tag: error._tag, message: error.message }).toEqual({
      tag: 'ActorStoppedError',
      message: expect.stringMatching(/^Actor ".+" stopped before completing$/),
    })
  })
})

describe('inspect', (it) => {
  it('streams inspection events from the actor system', function*({ expect }) {
    const events = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(counterMachine)
        afterInspect(actor, () => {
          actor.send({ type: 'INCREMENT' })
        })

        return yield* Stream.runCollect(inspect(actor).pipe(Stream.take(1)))
      }),
    )

    yield* expect(events[0]).toMatchObject({
      type: '@xstate.transition',
      event: { type: 'INCREMENT' },
    })
  })
})
