---
title: Choose state representation from transitions and observation
applies_when:
  - choosing how a service represents a connection or job lifecycle
  - adding state transitions to a service with status fields
  - deciding between a machine, an observable store, and a keyed counter
tags: [xstate, state, lifecycle, store]
---

Choose a **named-state machine** when a lifecycle has distinct named phases and the current phase determines which events or transitions are allowed. Express those phases and transitions in a machine; do not hand-roll that lifecycle as a status field with conditionals. `packages/xstate/src/index.ts` exports `createMachine` and `setup`.

When there is no such lifecycle but consumers subscribe to changing state, use an **observable store**. `packages/xstate-store/src/index.ts` exports `createStore`; `packages/xstate-store/src/types.ts` defines the observable, event-receiving `Store` interface.

When neither lifecycle transitions nor subscriptions are needed, keep a plain value, Ref, or keyed table in its owning service. An unsubscribed per-key counter is a table, not a machine or observable store. A status value that merely records data is not by itself a lifecycle.
