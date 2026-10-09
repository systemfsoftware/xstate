---
"@systemfsoftware/xstate": major
---

`createFSM` from `@systemfsoftware/xstate/fsm`, and the `createFSM` that `setup` returns, now take the machine's state names as their state type parameter, such as `'idle' | 'done'`, instead of a record keyed by state name, such as `{ idle: unknown; done: unknown }`.

`FSM.initialTransition()` and `FSM.getInitialSnapshot()` no longer accept arguments.

If you pass the state type explicitly, write the state names as a union: `createFSM<Context, Event, 'idle' | 'done'>(...)`. If you call `initialTransition` or `getInitialSnapshot` on an FSM directly, drop the arguments.
