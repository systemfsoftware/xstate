---
"@systemfsoftware/xstate": minor
---

`createActor` accepts a `reportUnhandledError` option: a sink that receives errors no consumer observed. Every actor in one system reports to the same sink, so a child actor's unhandled error reaches the sink passed to the root. Omitting the option keeps the rethrow-in-a-macrotask default.
