import { Clock, Effect } from 'effect'

const liveClock = Clock.Clock.defaultValue()

const pollEvery = (step: Effect.Effect<void>, now: Effect.Effect<number>) => (predicate: () => boolean) =>
  Effect.gen(function*() {
    const deadline = (yield* now) + 1000
    while (!predicate()) {
      if ((yield* now) > deadline) {
        return yield* Effect.die(new Error('Timed out waiting for condition'))
      }
      yield* step
    }
  })

const liveNow = Effect.sync(() => liveClock.currentTimeMillisUnsafe())

export const until = pollEvery(Effect.sleep('1 millis'), liveNow)

export const untilOnLiveClock = (predicate: () => boolean): Effect.Effect<void> =>
  pollEvery(Effect.yieldNow, Clock.currentTimeMillis)(predicate).pipe(
    Effect.provideService(Clock.Clock, liveClock),
  )
