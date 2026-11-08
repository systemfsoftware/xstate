---
title: Type events and guards at the machine boundary
applies_when:
  - defining the events accepted by a state machine
  - adding a guard to an XState transition
  - changing event payloads or guard conditions in a machine
tags: [xstate, events, guards, types]
---

Define the event types and payloads at the machine boundary, and type guards against that boundary. Keep guard decisions in the machine rather than accepting untyped events or branching on unvalidated payload shapes outside it.

The fork exports `setup` ([export](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate/src/index.ts#L109)), whose configuration accepts schemas and guards ([setup configuration](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate/src/setup.ts#L91-L109)); machine configuration supports event schemas and guards ([machine configuration](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate/src/setup.ts#L4645-L4683)). Use the APIs of the fork version actually consumed.
