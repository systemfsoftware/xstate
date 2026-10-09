---
"@systemfsoftware/xstate": minor
---

`createFSM` from `@systemfsoftware/xstate/fsm`, and the `createFSM` that `setup` returns, now take the machine's state names as their state type parameter, such as `'idle' | 'done'`. `FSM.initialTransition()` and `FSM.getInitialSnapshot()` take no arguments.

Breaking: the state type parameter used to be a record keyed by state name, such as `{ idle: unknown; done: unknown }`, and both methods accepted arguments they never read. If you pass the state type explicitly, write the state names as a union instead: `createFSM<Context, Event, 'idle' | 'done'>(...)`. If you call `initialTransition` or `getInitialSnapshot` on an FSM directly, drop the arguments. Code that lets TypeScript infer the states, or that runs an FSM through `createActor`, `initialTransition` or `transition`, needs no change.
