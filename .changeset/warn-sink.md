---
"@systemfsoftware/xstate": minor
---

Add a `warn` option when creating an actor or an actor system: an injectable sink for the development warnings the interpreter emits. It covers dead-lettered events, events received with no matching transition, malformed wildcard event descriptors, unresolved history ids, restoring into eventless transitions, non-JSON persisted payloads, and deprecated dynamic output mappings. The option defaults to the native `console.warn`; supply your own function to capture warnings in a test or forward them to a logger.
