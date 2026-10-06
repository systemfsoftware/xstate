---
"@systemfsoftware/xstate": minor
---

Add `@systemfsoftware/xstate` (statecharts and actors, with the `/actors`, `/durable`, `/fsm`, `/graph` and `/validation` entry points), forked from statelyai/xstate's `next` branch at 2146ae26 (MIT). It behaves like upstream's 6.0.0-alpha.64. Under `exactOptionalPropertyTypes`, optional members that can hold `undefined` declare it explicitly. It has no `effect` dependency or peer: the Effect 4.0.1 peer floor applies only to `@systemfsoftware/xstate-effect` and `@systemfsoftware/xstate-test`.
