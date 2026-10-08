---
"@systemfsoftware/xstate": minor
---

The final-state behaviour warning — `State "..." is final and declares "invoke", "on", "after"; final states cannot run actors or take transitions.` — is now emitted when an actor is created, through that actor's `warn` option (default `console.warn`), instead of once when the machine is defined.

- The warning is per actor. Two actors of one machine warn twice, and a machine used as an invoked or spawned child warns once for every child actor created from it, so a child machine under two parent actors warns twice.
- Defining a machine no longer warns, and neither do the pure entry points: `machine.getInitialSnapshot()`, `machine.transition()`, `machine.microstep()`, `initialTransition()` and `transition()` write nothing. Create an actor, with a `warn` sink if you need the message somewhere other than the console, to receive it.
