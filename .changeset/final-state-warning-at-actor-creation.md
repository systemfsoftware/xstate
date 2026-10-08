---
"@systemfsoftware/xstate": minor
---

The final-state behaviour warning — `State "..." is final and declares "invoke", "on", "after"; final states cannot run actors or take transitions.` — is now emitted once per actor when the actor is created, through the actor's `warn` option (default `console.warn`), instead of when the machine is defined. Creating a machine no longer writes this warning to the console; create an actor to receive it.
