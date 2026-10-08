---
"@systemfsoftware/xstate": minor
---

`matchesState` can now be called with the child state value alone. It returns a function that takes a parent state value and returns whether it matches, so `pipe(parentStateValue, matchesState(snapshot.value))` gives the same answer as `matchesState(parentStateValue, snapshot.value)`. `pathToStateValue` now accepts a readonly path. Both are still exported from `@systemfsoftware/xstate` under the same names.
