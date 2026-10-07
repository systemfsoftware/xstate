---
"@systemfsoftware/xstate": patch
---

`ContextFrom`, `ActorRefFrom` and `PersistedSnapshotFrom` now resolve a `createMachine` result's declared context exactly (for example `{ counter: number }`) instead of widening it to `MachineContext` when `exactOptionalPropertyTypes` is enabled.
