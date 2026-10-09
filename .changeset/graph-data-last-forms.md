---
"@systemfsoftware/xstate": minor
---

The graph functions `getShortestPaths`, `getSimplePaths`, `getAdjacencyMap`, `getPathsFromEvents` and `joinPaths` can now be called with their data last, so they compose in `pipe`:

- `getShortestPaths(options)` and `getSimplePaths(options)` return a function of the actor logic.
- `getAdjacencyMap(options)` returns a function of the actor logic.
- `getPathsFromEvents(events, options?)` returns a function of the actor logic.
- `joinPaths(tailPath)` returns a function of the head path, so `pipe(headPath, joinPaths(tailPath))` equals `joinPaths(headPath, tailPath)`.

Data-first calls are unchanged. A lone argument that has a `transition` member is read as actor logic (actor logic always has one, `TraversalOptions` has none) and any other lone argument as options; `getPathsFromEvents` reads an array first argument as data-last events.
