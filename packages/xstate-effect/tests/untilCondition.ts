import { Clock, Effect } from 'effect'
import { dual } from 'effect/Function'

export interface UntilOptions {
  readonly timeoutMs?: number
}

const poll = (predicate: () => boolean, options?: UntilOptions): Effect.Effect<void> =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + (options?.timeoutMs ?? 1000)
    while (!predicate()) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(new Error('Timed out waiting for condition'))
      }
      yield* Effect.yieldNow
    }
  }).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()))

/**
 * Polls until `predicate` holds. Effects run on detached fibers, so tests wait
 * for the condition they assert on instead of for a fixed number of ticks.
 *
 * Each poll yields to the fiber scheduler instead of sleeping, so a check costs
 * scheduler turns rather than timer latency, which grows with CPU load. The
 * deadline reads the live clock even when the surrounding program provides a
 * `TestClock`, because it bounds real waiting rather than simulated time.
 */
export const until: {
  (options?: UntilOptions): (predicate: () => boolean) => Effect.Effect<void>
  (predicate: () => boolean, options?: UntilOptions): Effect.Effect<void>
} = dual((args) => typeof args[0] === 'function', poll)
