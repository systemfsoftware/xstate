---
"@systemfsoftware/xstate-effect": minor
---

`join` now fails with the new `ActorFailedError<E>` whenever the joined actor errors, for every kind of actor. Its `cause` is the exact value the actor failed with, typed as the actor's `ErrorFrom`: a `fromEffect` actor's own error, `unknown` for a machine or a `snapshot.children` entry. Breaking: `join` on a `fromEffect` actor no longer fails with the Effect's error directly; read it from `error.cause`, or match the `ActorFailedError` tag first. `ActorStoppedError` is unchanged.
