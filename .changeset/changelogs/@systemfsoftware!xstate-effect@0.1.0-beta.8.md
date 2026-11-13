# @systemfsoftware/xstate-effect@0.1.0-beta.8

`join` now fails with the new `ActorFailedError<E>` whenever the joined actor errors, for every kind of actor. Its `cause` is the exact value the actor failed with, typed as the actor's `ErrorFrom`: a `fromEffect` actor's own error, `unknown` for a machine or a `snapshot.children` entry. Breaking: `join` on a `fromEffect` actor no longer fails with the Effect's error directly; read it from `error.cause`, or match the `ActorFailedError` tag first. `ActorStoppedError` is unchanged.

Add `@systemfsoftware/xstate-effect`, the Effect 4 runtime for XState actors, forked from statelyai/xstate's `next` branch at 2146ae26 (MIT). It behaves like upstream's 0.1.0-alpha.7. Under `exactOptionalPropertyTypes`, optional members that can hold `undefined` declare it explicitly. The `effect` peer range is `^4.0.1` (the monorepo catalog had `^4`), so a consumer resolves at least Effect 4.0.1.
