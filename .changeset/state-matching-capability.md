---
"@systemfsoftware/xstate": minor
---

`matchesState` can now be called with the child state value alone. It returns a function that takes a parent state value and returns whether it matches, so `pipe(parentStateValue, matchesState(snapshot.value))` gives the same answer as `matchesState(parentStateValue, snapshot.value)`. `pathToStateValue` now accepts a readonly path. Both are still exported from `@systemfsoftware/xstate` under the same names.

`matchesState` and `snapshot.matches` now read a state name inside a state value as a plain name, even when it contains a dot. Only a state value that is a whole string is read as a dotted path, where `\.` stands for a dot inside a name. For a state `d.e` nested under `b`, `snapshot.matches({ b: 'd.e' })` is now `true`; it used to be `false`, and `{ b: 'd\\.e' }` used to be needed. `snapshot.matches('b.d\\.e')` is `true`, as before.
