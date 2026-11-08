---
title: Exercise machine model paths against observable behavior
applies_when:
  - testing a state machine's transitions and guards
  - adding a test for a service driven by a machine actor
  - checking behavior across a machine lifecycle
tags: [xstate, model-testing, paths, behavior]
---

Exercise model paths against the system under test and assert externally observable outcomes for the paths. Drive the real implementation through its boundary; do not certify a mocked implementation against expectations derived from that same mock.

`packages/xstate-test/src/index.ts` exports `testPaths`. `packages/xstate-test/src/propertyTest.ts` defines it as an **experimental** API for executing model paths against a system under test; `packages/xstate-test/src/engine/testPaths.ts` defines its path options. Verify the API against the consumed fork version.
