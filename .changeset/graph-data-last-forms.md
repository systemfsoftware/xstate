---
"@systemfsoftware/xstate": minor
---

The graph functions `getShortestPaths`, `getSimplePaths`, `getAdjacencyMap`, `getPathsFromEvents` and `joinPaths` can now be called with their data last, so they compose in `pipe`:

- `getShortestPaths(options)` and `getSimplePaths(options)` return a function of the actor logic.
- `getAdjacencyMap(options)` returns a function of the actor logic.
- `getPathsFromEvents(events, options?)` returns a function of the actor logic.
- `joinPaths(tailPath)` returns a function of the head path, so `pipe(headPath, joinPaths(tailPath))` equals `joinPaths(headPath, tailPath)`.

Data-first calls are unchanged. The implementation tells the forms apart by an exact runtime shape check: `getShortestPaths` and `getSimplePaths` read a lone argument as actor logic when it has a `transition` function and as options otherwise; `getPathsFromEvents` reads an array first argument as data-last events.
