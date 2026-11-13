# @systemfsoftware/xstate-store@5.0.0

`createStore` accepts a `warn` option — a `(message: string) => void` sink for non-fatal runtime warnings from the store and its extensions, defaulting to `console.warn`. The `validateSchemas` extension now reports its "no schemas to validate" development warning through this sink, so callers can observe or silence it without patching the process-wide `console`.

Add `@systemfsoftware/xstate-store`, the event-driven store, forked from statelyai/xstate's `next` branch at 2146ae26 (MIT). It behaves like upstream's 5.0.0-alpha.5. Under `exactOptionalPropertyTypes`, optional members that can hold `undefined` declare it explicitly. It has no `effect` dependency or peer: the Effect 4.0.1 peer floor applies only to `@systemfsoftware/xstate-effect` and `@systemfsoftware/xstate-test`.
