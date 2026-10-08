---
"@systemfsoftware/xstate": minor
---

`matchesState(childStateValue)` returns a function of the parent state value, for use in `pipe`. `pathToStateValue` accepts a readonly path.

`matchesState` and `snapshot.matches` read a state name inside a state value as a plain name, even with a dot: for a state `d.e` under `b`, `snapshot.matches({ b: 'd.e' })` is now `true` (it needed `'d\\.e'`). Only a whole-string state value is a dotted path; `'b.d\\.e'` still matches.

Edge inputs that changed:

- A snapshot passed in place of a state value is no longer read as its `value`; pass `snapshot.value`.
- A region whose value is `undefined` no longer matches, instead of throwing a `TypeError`.
- An id ending in a lone `\` keeps the backslash; it used to become the text `undefined`.
