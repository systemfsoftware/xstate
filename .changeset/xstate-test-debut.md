---
"@systemfsoftware/xstate-test": minor
---

Add `@systemfsoftware/xstate-test`, model-based and property testing for XState machines, forked from statelyai/xstate's `next` branch at 2146ae26 (MIT). It behaves like upstream's 2.0.0-alpha.1. Under `exactOptionalPropertyTypes`, optional members that can hold `undefined` declare it explicitly. The `effect` peer range is `^4.0.1` (the monorepo catalog had `^4`), so a consumer resolves at least Effect 4.0.1.
