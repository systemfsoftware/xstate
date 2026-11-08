---
title: Choose state representation from transitions and observation
applies_when:
  - choosing how a service represents a connection or job lifecycle
  - adding state transitions to a service with status fields
  - deciding between a machine, an observable store, and a keyed counter
tags: [xstate, state, lifecycle, store]
---

Choose a **named-state machine** when a lifecycle has distinct named phases and the current phase determines which events or transitions are allowed. Express those phases and transitions in a machine; do not hand-roll that lifecycle as a status field with conditionals. The fork exports `createMachine` and `setup` ([exports](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate/src/index.ts#L57-L63), [setup export](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate/src/index.ts#L109)).

When there is no such lifecycle but consumers subscribe to changing state, use an **observable store**. `@systemfsoftware/xstate-store` exports `createStore` ([export](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-store/src/index.ts#L6)); its store receives events and is observable ([store interface](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-store/src/types.ts#L197-L216)).

When neither lifecycle transitions nor subscriptions are needed, keep a plain value, Ref, or keyed table in its owning service. An unsubscribed per-key counter is a table, not a machine or observable store. A status value that merely records data is not by itself a lifecycle.
