---
title: Choose state representation from transitions and observation
applies_when:
  - choosing how a service represents a connection or job lifecycle
  - adding state transitions to a service with status fields
  - deciding between a machine, an observable store, and a keyed counter
tags: [xstate, state, lifecycle, store]
---

Choose a **named-state machine** when a lifecycle is present. A lifecycle is present when a field takes a finite set of named values and events move it between them; the event handler bodies do not need to be visible. For example, a `status` starts as `queued`, a `start` event moves it to `started`, and a `finish` event moves it to `finished`. Express those phases and transitions in a machine; do not hand-roll that lifecycle as a status field with conditionals. `packages/xstate/src/index.ts` exports `createMachine` and `setup`.

When state has both a lifecycle and subscribers, use the named-state machine, never a store for the lifecycle. A running actor is observable, so subscribers subscribe to the actor; `packages/xstate-effect/src/effectActor.ts` defines `EffectActor.subscribe`. For example, a store with subscribers and a `status` of `queued` advanced by `start` and `finish` events must become a machine whose actor the subscribers observe.

When there is no such lifecycle but consumers subscribe to changing state, use an **observable store**. `packages/xstate-store/src/index.ts` exports `createStore`; `packages/xstate-store/src/types.ts` defines the observable, event-receiving `Store` interface.

When neither lifecycle transitions nor subscriptions are needed, keep a plain value, Ref, or keyed table in its owning service. An unsubscribed per-key counter is a table, not a machine or observable store. A status value that merely records data is not by itself a lifecycle.
