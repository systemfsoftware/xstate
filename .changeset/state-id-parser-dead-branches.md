---
"@systemfsoftware/xstate": none
---

The state-id parser behind `matchesState` and `snapshot.matches` drops a redundant end-of-input anchor and an unreachable default. It splits every id the same way as before.
