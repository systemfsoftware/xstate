---
"@systemfsoftware/xstate": minor
---

Add a `wallClock` actor option (`{ now(): number }`) as the injectable wall-time source for timer persistence and restore. When a running actor's scheduling `clock` has no `now` of its own, the absolute start (`startedAt`) stamped into a persisted timer and the remaining-delay computation on restore are read through `wallClock` instead of the global `Date.now()`, so a host can own wall time the same way it owns `setTimeout`/`clearTimeout`. It defaults to `{ now: () => Date.now() }`, and the custom-clock contract is unchanged: a scheduling clock that exposes `now` still restarts every timer with its declared delay and stamps no `startedAt`.
