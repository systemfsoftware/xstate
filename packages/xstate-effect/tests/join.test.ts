import { expectTypeOf, it } from '@systemfsoftware/vitest'
import { type ActorRefFrom, type AnyActor, setup } from '@systemfsoftware/xstate'
import {
  ActorFailedError,
  type ActorStoppedError,
  createEffectActor,
  fromEffect,
  join,
} from '@systemfsoftware/xstate-effect'
import { Data, Effect, Exit, Scope } from 'effect'

class WorkerFailed extends Data.TaggedError('@systemfsoftware/xstate-effect/tests/join.test/WorkerFailed')<{}> {}

const failure = new WorkerFailed()
const worker = fromEffect(Effect.sleep('20 millis').pipe(Effect.andThen(Effect.fail(failure))))
const machine = setup({ actors: { worker } }).createMachine({
  invoke: { src: 'worker', id: 'worker' },
})

const withWorkerChild = <A, E>(use: (child: AnyActor) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    return yield* Effect.gen(function*() {
      const parent = yield* Scope.provide(createEffectActor(machine), scope)
      const child = parent.getSnapshot().children['worker']
      if (child === undefined) return yield* Effect.die(new Error('expected the invoked worker child'))
      return yield* use(child)
    }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
  })

const failureOf = <A, E>(joined: Effect.Effect<A, E>): Effect.Effect<E> =>
  Effect.matchEffect(joined, {
    onSuccess: () => Effect.die(new Error('expected join to fail')),
    onFailure: Effect.succeed,
  })

const wrapsFailure = (error: ActorFailedError<unknown> | ActorStoppedError): boolean =>
  error instanceof ActorFailedError && error.cause === failure

it.live(
  'Should_FailWithActorFailedErrorCarryingTheRawError_When_JoiningAFromEffectChildReadFromChildren',
  function*({ expect }) {
    const error = yield* withWorkerChild((child) => {
      const joined = join(child)
      expectTypeOf<Effect.Error<typeof joined>>().toEqualTypeOf<ActorFailedError<unknown> | ActorStoppedError>()
      return failureOf(joined)
    })
    yield* expect(error).toSatisfy(
      wrapsFailure,
      'an ActorFailedError whose cause is the exact error the Effect failed with',
    )
  },
)

it.live(
  'Should_FailWithActorFailedErrorCarryingTheRawError_When_JoiningAFromEffectChildTypedByItsLogic',
  function*({ expect }) {
    const error = yield* withWorkerChild((child) => {
      const typed: ActorRefFrom<typeof worker> = child
      const joined = join(typed)
      expectTypeOf<Effect.Error<typeof joined>>().toEqualTypeOf<ActorFailedError<WorkerFailed> | ActorStoppedError>()
      return failureOf(joined)
    })
    yield* expect(error).toSatisfy(
      wrapsFailure,
      'an ActorFailedError whose cause is the exact error the Effect failed with',
    )
  },
)
