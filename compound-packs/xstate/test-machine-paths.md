---
title: Exercise machine model paths against observable behavior
applies_when:
  - testing a state machine's transitions and guards
  - adding a test for a service driven by a machine actor
  - checking behavior across a machine lifecycle
tags: [xstate, model-testing, paths, behavior]
---

Exercise model paths against the system under test and assert externally observable outcomes for the paths. Drive the real implementation through its boundary; do not certify a mocked implementation against expectations derived from that same mock.

`@systemfsoftware/xstate-test` exports `testPaths` ([export](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-test/src/index.ts#L93-L100)). It executes model paths against a system under test and is **experimental** ([implementation](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-test/src/propertyTest.ts#L404-L415), [path options](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-test/src/engine/testPaths.ts#L621-L630)). Verify the API against the consumed fork version.
