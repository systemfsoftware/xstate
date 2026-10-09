---
"@systemfsoftware/xstate": minor
---

`getShortestPaths`, `getSimplePaths`, `getAdjacencyMap`, `getPathsFromEvents` and `joinPaths` can also be called data-last, so they compose in `pipe`: `getShortestPaths(options)(logic)`, `getPathsFromEvents(events, options?)(logic)`, and `pipe(headPath, joinPaths(tailPath))`, which equals `joinPaths(headPath, tailPath)`. A lone argument with a `transition` member is read as actor logic. Data-first calls are unchanged.

- The graph entrypoint exports a new `AnySnapshot<TOutput = unknown>` type, equal to `Snapshot<TOutput>`.
- `serializeSnapshot` now only accepts a snapshot whose `value` is a `StateValue` and whose `context` is an object. A snapshot typed with another `value` or `context`, such as `context: number`, no longer compiles. Pass your own `serializeState` for such snapshots.
