---
"@systemfsoftware/xstate": patch
---

A transition with `reenter: true` that targets its source's own history state no longer runs entry actions for states it does not enter.

- Before, when the history state had no record yet, the ancestors of its default target ran their `entry` actions even though the restored states were the recorded ones. For a default of `b.b2` that was `b`; for a default inside a parallel state it was the parallel state, its regions and their initial states.
- The machine now exits the source, re-enters it, and enters exactly the restored states, so it emits only those states' entry actions.
- The resulting state value and persisted history value are the same as before.
