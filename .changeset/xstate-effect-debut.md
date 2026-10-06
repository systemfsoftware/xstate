---
"@systemfsoftware/xstate-effect": minor
---

Add `@systemfsoftware/xstate-effect`, the Effect 4 runtime for XState actors, forked from statelyai/xstate's `next` branch at 2146ae26 (MIT). It behaves like upstream's 0.1.0-alpha.7. Under `exactOptionalPropertyTypes`, optional members that can hold `undefined` declare it explicitly. The `effect` peer range is `^4.0.1` (the monorepo catalog had `^4`), so a consumer resolves at least Effect 4.0.1.
