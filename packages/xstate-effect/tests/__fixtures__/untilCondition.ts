import { Clock, Effect } from 'effect'
import { dual } from 'effect/Function'

export interface UntilOptions {
  readonly timeoutMs?: number
}

type Until = {
  (options?: UntilOptions): (predicate: () => boolean) => Effect.Effect<void>
  (predicate: () => boolean, options?: UntilOptions): Effect.Effect<void>
}

const liveClock = Clock.Clock.defaultValue()

const pollEvery =
  (step: Effect.Effect<void>, now: Effect.Effect<number>) => (predicate: () => boolean, options?: UntilOptions) =>
    Effect.gen(function*() {
      const deadline = (yield* now) + (options?.timeoutMs ?? 1000)
      while (!predicate()) {
        if ((yield* now) > deadline) {
          return yield* Effect.die(new Error('Timed out waiting for condition'))
        }
        yield* step
      }
    })

const predicateFirst = (args: IArguments) => typeof args[0] === 'function'

const liveNow = Effect.sync(() => liveClock.currentTimeMillisUnsafe())

export const until: Until = dual(predicateFirst, pollEvery(Effect.sleep('1 millis'), liveNow))

const pollOnLiveClock = (predicate: () => boolean, options?: UntilOptions) =>
  pollEvery(Effect.yieldNow, Clock.currentTimeMillis)(predicate, options).pipe(
    Effect.provideService(Clock.Clock, liveClock),
  )

export const untilOnLiveClock: Until = dual(predicateFirst, pollOnLiveClock)
