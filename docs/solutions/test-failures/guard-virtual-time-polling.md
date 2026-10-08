---
title: Poll with the step your test lane's clock needs
category: test-failures
module: packages/xstate-effect
date: 2026-10-08
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "A poll waiting on an `after` transition or a delayed effect dies with `Timed out waiting for condition`"
  - "A poll that sleeps 1 ms per check pushes a case past vitest's 5000 ms default on a loaded runner"
root_cause: async_timing
resolution_type: test_fix
framework_version: "@systemfsoftware/vitest 2.0.0, effect 4.0.1"
tags:
  - virtual-time
  - polling
  - it-live
  - testclock
---

# Poll with the step your test lane's clock needs

## Problem

`@systemfsoftware/vitest` runs `it` bodies on virtual time that advances only when the test's fibers are idle, and `it.live` bodies on the real clock (the package README, section "Virtual time"). A poll loop (`while (!predicate()) yield* step`) behaves differently per lane. A test can wait forever on virtual time, or burn real time per check on the live clock, and both look like `Timed out waiting for condition`.

## Failure modes

1. **Yield step on a virtual clock.** `Effect.yieldNow` keeps the polling fiber runnable, so the fibers are never all idle, virtual time never advances, and the `after` timer the predicate waits for never fires.
2. **Sleep step on a live clock.** `Effect.sleep('1 millis')` is a real timer per check. Under CPU load each timer stretches, so wall time is `polls × stretched timer`; main CI run 37715459905 hit 5047 ms on a 561-poll case.
3. **Deadline on the clock the step advances.** On a virtual clock each 1 ms sleep spends 1 ms of a virtual deadline, so a poll with timeout `T` can never observe work scheduled at or after `T`.

## Architectural Invariants

- The step follows the lane: sleep the ambient clock where time is virtual; yield where time is real or moves only on `TestClock.adjust`.
- The deadline always reads the live clock, so `timeoutMs` bounds real waiting in every lane.

```ts
pollEvery(step, now)(predicate) =
  deadline = now() + timeoutMs
  while !predicate(): if now() > deadline: die; yield* step

until            = pollEvery(sleep('1 millis'), liveClock)   // it lanes
untilOnLiveClock = pollEvery(yieldNow, liveClock)            // it.live lanes, own TestClock
```

## Solution

The xstate-effect test fixture exports `until` and `untilOnLiveClock` (both `dual`, `UntilOptions.timeoutMs` default 1000). Every `it` body polls with `until`. Every `it.live` body, and the persistence suite that installs its own `TestClock`, polls with `untilOnLiveClock`.

## Verification

- Probe on an `it` lane with a machine whose `after` transition fires at 1000 or 2000 ms: `until` reached the target at both delays with its 1000 ms default; the yield poller timed out at 1000 ms.
- One core shared with two busy loops, five seeds: the package suite passed 5/5.

## Code smell

`Effect.yieldNow` inside a poll loop in an `it` body, or `Effect.sleep` inside a poll loop in an `it.live` body.
