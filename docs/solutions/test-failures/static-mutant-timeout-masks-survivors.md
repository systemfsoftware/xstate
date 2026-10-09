---
title: A static mutant's timeout can label a survivor as detected
date: 2026-10-09
category: test-failures
module: stryker.shared.ts
problem_type: test_failure
component: testing_framework
symptoms:
  - "A release gate run reports many `Timeout` mutants, and the same mutants were `Killed` or `Survived` in the run before"
  - "Every `Timeout` mutant is static and is covered by the whole suite, not by its own tests"
root_cause: config_error
resolution_type: config_change
severity: high
tags: [stryker, mutation-testing, timeout, static-mutants, release-gate]
---

# A static mutant's timeout can label a survivor as detected

## Problem

Stryker counts a `Timeout` mutant as detected. A slow run of a mutant that the suite never catches is therefore scored like a kill, and the release gate passes it.

## Symptoms

- Release gate run 37876073529 on `84e602e7` reported 22 `Timeout` mutants in the code behind `assertEvent`, `matchesState` and `mapState`. On unchanged state-matching code, the run before reported 17 `Killed` and 5 `Timeout`; this one reported 6 `Killed` and 16 `Timeout`.
- Every `Timeout` mutant was static (its code also runs while test files load), and the shard's incremental file gave each one the whole suite (2441 covering tests) as its cost.

## What Didn't Work

- Reading the label. Of the 20 `Timeout` mutants behind `matchesState` and `mapState`, applying each by hand and running the full suite showed:
  - 2 survive it: `\\$` -> `\\` and `[\s\S]` -> `[\S\S]` in the path-splitting regex. Both had been `Survived` in the run before.
  - 2 hang it: they make some test loop forever, and the capability spec kills them in about 2 s.
  - 16 are killed in 13-28 s.

## Solution

`timeoutMS` in `stryker.shared.ts` is set to 45 000 ms.

A static mutant (with `ignoreStatic: false`) runs the whole suite under the budget `timeoutFactor * netTime + timeoutMS + overhead`. Here `netTime` is the whole dry run's test time and `overhead` is its start-up, transform and import time. The factor scales only `netTime`, and both terms are measured in an uncontended dry run. Mutant runs share the runner, so their overhead grows too:

| Run                       | net       | overhead  | budget    | budget / dry run | slowest completed static run / dry run |
| ------------------------- | --------- | --------- | --------- | ---------------- | -------------------------------------- |
| 37869702486 on `9857b0b3` | 12 149 ms | 37 257 ms | 60 480 ms | 1.22             | 1.26                                   |
| 37876073529 on `84e602e7` | 9 382 ms  | 22 868 ms | 41 941 ms | 1.30             | 1.23                                   |

With the default `timeoutMS` of 5 000 ms, the budget sits inside the spread of normal run times, so whether a static mutant comes out `Killed`, `Survived` or `Timeout` depends on runner load. With 45 000 ms the budget is 100 480 ms (2.03x) and 81 941 ms (2.54x) on the same two runs.

## Why This Works

The slack is now added where the unscaled time is. A static mutant that finishes under contention completes and reports `Killed` or `Survived`. Only a run that is still going at twice the dry run's length is called a hang.

## Prevention

- When a gate run's `Timeout` count jumps, check whether the `Timeout` mutants are static. If they are, read the shard incremental file's `costs[<id>].actualMs` against the dry run's `net + overhead`, and apply a few of the mutants by hand to see whether the whole suite actually fails or hangs.
- Do not read `Timeout` as detected for a static mutant until its run time is clearly beyond a contended full-suite run.

## Related Issues

- Ruling cycle 172.
- `docs/solutions/workflow-issues/sharded-mutation-gate-without-verdict.md`.
