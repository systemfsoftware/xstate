import { Clock, Effect } from 'effect'
import { dual } from 'effect/Function'

export interface UntilOptions {
  readonly timeoutMs?: number
}

type Until = {
  (options?: UntilOptions): (predicate: () => boolean) => Effect.Effect<void>
  (predicate: () => boolean, options?: UntilOptions): Effect.Effect<void>
}

const pollEvery = (step: Effect.Effect<void>) => (predicate: () => boolean, options?: UntilOptions) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + (options?.timeoutMs ?? 1000)
    while (!predicate()) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(new Error('Timed out waiting for condition'))
      }
      yield* step
    }
  })

const predicateFirst = (args: IArguments) => typeof args[0] === 'function'

export const until: Until = dual(predicateFirst, pollEvery(Effect.sleep('1 millis')))

const pollOnLiveClock = (predicate: () => boolean, options?: UntilOptions) =>
  pollEvery(Effect.yieldNow)(predicate, options).pipe(
    Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
  )

export const untilOnLiveClock: Until = dual(predicateFirst, pollOnLiveClock)
