---
title: Type events and guards at the machine boundary
applies_when:
  - defining the events accepted by a state machine
  - adding a guard to an XState transition
  - changing event payloads or guard conditions in a machine
tags: [xstate, events, guards, types]
---

Define the event types and payloads at the machine boundary, and type guards against that boundary. Keep guard decisions in the machine rather than accepting untyped events or branching on unvalidated payload shapes outside it.

`packages/xstate/src/index.ts` exports `setup`. `packages/xstate/src/setup.ts` defines `SetupConfig`, which accepts schemas and guards, and the `SetupReturn.createMachine` configuration, which supports event schemas and guards. Use the APIs of the fork version actually consumed.
