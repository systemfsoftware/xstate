---
"@systemfsoftware/xstate": minor
---

`mapState` now returns results in the order its documentation gives: every active state comes before its ancestors, and states that are not nested in each other come in the order they are declared in the machine. Before, results from parallel regions could come out of declaration order, and a parent could come before a child of a later region. Results for a finished machine now follow the same order as for a running one.

`mapState` can now be called with the mapper alone. It returns a function that takes the snapshot, so `pipe(snapshot, mapState(mapper))` gives the same results as `mapState(snapshot, mapper)`.
