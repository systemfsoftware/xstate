# @systemfsoftware/xstate@6.0.0

`ContextFrom`, `ActorRefFrom` and `PersistedSnapshotFrom` now resolve a `createMachine` result's declared context exactly (for example `{ counter: number }`) instead of widening it to `MachineContext` when `exactOptionalPropertyTypes` is enabled.

`createActor` accepts a `crypto` option (`{ getRandomValues?, randomUUID? }`), the Web Crypto source of the session-id prefix for the system a root actor creates. Without it, every system still shares one prefix read once per process from `globalThis.crypto`. With it, that system builds its own prefix from the given methods and falls back to a time-and-`Math.random` prefix when neither works, so the fallback can be exercised without replacing `globalThis.crypto`. Actors that join a parent's system ignore the option.

`assertEvent` can now be called with the event types alone. It returns the assertion as a function: bind that function to a constant with an explicit assertion type, such as `const assertGreet: (event: AppEvent) => asserts event is Greet = assertEvent('greet')`. Calling `assertGreet(event)` then narrows `event` and throws the same error as `assertEvent(event, 'greet')` when the type does not match. TypeScript narrows only through an explicitly typed assertion function, so calling `assertEvent('greet')(event)` inline is a type error (TS2776). Calls of the form `assertEvent(event, types)` are unchanged.

The final-state behaviour warning — `State "..." is final and declares "invoke", "on", "after"; final states cannot run actors or take transitions.` — is now emitted when an actor is created, through that actor's `warn` option (default `console.warn`), instead of once when the machine is defined.

- The warning is per actor. Two actors of one machine warn twice, and a machine used as an invoked or spawned child warns once for every child actor created from it, so a child machine under two parent actors warns twice.
- Defining a machine no longer warns, and neither do the pure entry points: `machine.getInitialSnapshot()`, `machine.transition()`, `machine.microstep()`, `initialTransition()` and `transition()` write nothing. Create an actor, with a `warn` sink if you need the message somewhere other than the console, to receive it.

`createFSM` from `@systemfsoftware/xstate/fsm`, and the `createFSM` that `setup` returns, now take the machine's state names as their state type parameter, such as `'idle' | 'done'`. `FSM.initialTransition()` and `FSM.getInitialSnapshot()` take no arguments.

Breaking: the state type parameter used to be a record keyed by state name, such as `{ idle: unknown; done: unknown }`, and both methods accepted arguments they never read. If you pass the state type explicitly, write the state names as a union instead: `createFSM<Context, Event, 'idle' | 'done'>(...)`. If you call `initialTransition` or `getInitialSnapshot` on an FSM directly, drop the arguments. Code that lets TypeScript infer the states, or that runs an FSM through `createActor`, `initialTransition` or `transition`, needs no change.

`getShortestPaths`, `getSimplePaths`, `getAdjacencyMap`, `getPathsFromEvents` and `joinPaths` can also be called data-last, so they compose in `pipe`: `getShortestPaths(options)(logic)`, `getPathsFromEvents(events, options?)(logic)`, and `pipe(headPath, joinPaths(tailPath))`, which equals `joinPaths(headPath, tailPath)`. A lone argument with a `transition` member is read as actor logic. Data-first calls are unchanged.

- The graph entrypoint exports a new `AnySnapshot<TOutput = unknown>` type, equal to `Snapshot<TOutput>`.
- `serializeSnapshot` now only accepts a snapshot whose `value` is a `StateValue` and whose `context` is an object. A snapshot typed with another `value` or `context`, such as `context: number`, no longer compiles. Pass your own `serializeState` for such snapshots.

The graph traversals in `@systemfsoftware/xstate/graph` drop code that changed no result: a queue compaction shortcut, a shortest-path weight improvement that breadth-first order never reaches, unreachable missing-entry errors, and a serializer fallback that the options spread always replaced. Every path, step and adjacency entry comes out the same as before.

`checkStateIn(stateValue)` returns a function of the snapshot, for use in `pipe`; `checkStateIn(snapshot, stateValue)` is unchanged.

A transition with `reenter: true` that targets its source's own history state no longer runs entry actions for states it does not enter.

- Before, when the history state had no record yet, the ancestors of its default target ran their `entry` actions even though the restored states were the recorded ones. For a default of `b.b2` that was `b`; for a default inside a parallel state it was the parallel state, its regions and their initial states.
- The machine now exits the source, re-enters it, and enters exactly the restored states, so it emits only those states' entry actions.
- The resulting state value and persisted history value are the same as before.

Add a `wallClock` actor option (`{ now(): number }`) as the injectable wall-time source for timer persistence and restore. When a running actor's scheduling `clock` has no `now` of its own, the absolute start (`startedAt`) stamped into a persisted timer and the remaining-delay computation on restore are read through `wallClock` instead of the global `Date.now()`, so a host can own wall time the same way it owns `setTimeout`/`clearTimeout`. It defaults to `{ now: () => Date.now() }`, and the custom-clock contract is unchanged: a scheduling clock that exposes `now` still restarts every timer with its declared delay and stamps no `startedAt`.

`mapState` now returns results in the order its documentation gives: every active state comes before its ancestors, and states that are not nested in each other come in the order they are declared in the machine. Before, results from parallel regions could come out of declaration order, and a parent could come before a child of a later region. Results for a finished machine now follow the same order as for a running one.

`mapState` can now be called with the mapper alone. It returns a function that takes the snapshot, so `pipe(snapshot, mapState(mapper))` gives the same results as `mapState(snapshot, mapper)`.

`createActor` accepts a `reportUnhandledError` option: a sink that receives errors no consumer observed. Every actor in one system reports to the same sink, so a child actor's unhandled error reaches the sink passed to the root. Omitting the option keeps the rethrow-in-a-macrotask default.

The state-id parser behind `matchesState` and `snapshot.matches` drops a redundant end-of-input anchor and an unreachable default. It splits every id the same way as before.

`matchesState(childStateValue)` returns a function of the parent state value, for use in `pipe`. `pathToStateValue` accepts a readonly path.

`matchesState` and `snapshot.matches` read a state name inside a state value as a plain name, even with a dot: for a state `d.e` under `b`, `snapshot.matches({ b: 'd.e' })` is now `true` (it needed `'d\\.e'`). Only a whole-string state value is a dotted path; `'b.d\\.e'` still matches.

Edge inputs that changed:

- A snapshot passed in place of a state value is no longer read as its `value`; pass `snapshot.value`.
- A region whose value is `undefined` no longer matches, instead of throwing a `TypeError`.
- An id ending in a lone `\` keeps the backslash; it used to become the text `undefined`.

Add a `warn` option when creating an actor or an actor system: an injectable sink for the development warnings the interpreter emits. It covers dead-lettered events, events received with no matching transition, malformed wildcard event descriptors, unresolved history ids, restoring into eventless transitions, non-JSON persisted payloads, and deprecated dynamic output mappings. The option defaults to the native `console.warn`; supply your own function to capture warnings in a test or forward them to a logger.

Add `@systemfsoftware/xstate` (statecharts and actors, with the `/actors`, `/durable`, `/fsm`, `/graph` and `/validation` entry points), forked from statelyai/xstate's `next` branch at 2146ae26 (MIT). It behaves like upstream's 6.0.0-alpha.64. Under `exactOptionalPropertyTypes`, optional members that can hold `undefined` declare it explicitly. It has no `effect` dependency or peer: the Effect 4.0.1 peer floor applies only to `@systemfsoftware/xstate-effect` and `@systemfsoftware/xstate-test`.
