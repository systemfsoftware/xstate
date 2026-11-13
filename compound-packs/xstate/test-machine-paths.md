---
title: Exercise machine model paths against observable behavior
applies_when:
  - testing a state machine's transitions and guards
  - adding a test for a service driven by a machine actor
  - checking behavior across a machine lifecycle
tags: [xstate, model-testing, paths, behavior]
---

When a machine exists, derive test paths from that machine using the fork's path generation so that every reachable state is covered. Execute each path against the system under test and assert externally observable outcomes. Drive the real implementation through its boundary; do not certify a mocked implementation against expectations derived from that same mock. Hand-picked event sequences are allowed only in addition, for a specific regression, and never as the coverage of reachable states.

`packages/xstate-test/src/index.ts` exports `testPaths`. `packages/xstate-test/src/propertyTest.ts` defines it as an **experimental** API for executing model paths against a system under test; `packages/xstate-test/src/engine/testPaths.ts` defines `testPaths` path generation by traversing the machine's state graph. Verify the API against the consumed fork version.
