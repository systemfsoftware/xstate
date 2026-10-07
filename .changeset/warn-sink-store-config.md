---
"@systemfsoftware/xstate-store": minor
---

`createStore` accepts a `warn` option — a `(message: string) => void` sink for non-fatal runtime warnings from the store and its extensions, defaulting to `console.warn`. The `validateSchemas` extension now reports its "no schemas to validate" development warning through this sink, so callers can observe or silence it without patching the process-wide `console`.
