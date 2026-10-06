import { Cause, Effect, Ref } from 'effect'
import { dual } from 'effect/Function'

export const ensuringFinalizerWins: {
  <A, E, R>(
    finalizer: Effect.Effect<unknown, never, R>,
  ): (body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(
    body: Effect.Effect<A, E, R>,
    finalizer: Effect.Effect<unknown, never, R>,
  ): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  body: Effect.Effect<A, E, R>,
  finalizer: Effect.Effect<unknown, never, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function*() {
    const finalizerCause = yield* Ref.make<Cause.Cause<never> | undefined>(undefined)
    return yield* Effect.ensuring(
      body,
      finalizer.pipe(Effect.tapCause((cause) => Ref.set(finalizerCause, cause))),
    ).pipe(
      Effect.catchCause((bodyCause) =>
        Effect.flatMap(Ref.get(finalizerCause), (captured) => Effect.failCause(captured ?? bodyCause))
      ),
    )
  }))
