---
title: A shuffled suite that exits 1 with 0 failed tests has a case whose error report outlived it
category: test-failures
module: packages/xstate, packages/xstate-test
date: 2026-10-08
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "`vitest run --sequence.shuffle --sequence.seed=N` exits 1 with every test passed and `Errors 1 error` under `Unhandled Errors`"
  - "The uncaught exception is an assertion inside another case's global `error` handler, quoting an error message that case never throws"
  - "A case passes in CI's order and fails on another seed because it reads files a sibling case writes"
root_cause: test_isolation
resolution_type: test_fix
framework_version: "vitest 5.0.3, happy-dom 20.14.5"
tags:
  - shuffle
  - unhandled-error
  - report-unhandled-error
  - test-order
---

# A shuffled suite that exits 1 with 0 failed tests has a case whose error report outlived it

## Problem

CI runs one test order, and that order passed. Under `--sequence.shuffle`, the xstate suite exited 1 on seeds 2 and 3 with every test passed, and xstate-test failed one case on seed 3.

## Failure mechanism

1. xstate's error-handling suite mocks `reportUnhandledError` so that it dispatches a window `ErrorEvent` from a `setTimeout`. Several of its cases install a global `error` handler that asserts on the message.
2. The case `actor continues to work normally after emit callback errors` left subscribed a listener that throws `'oops'`, so its second `send` reported `'oops'` again. That report runs on a timer after the case has resolved.
3. The report lands in whichever case runs next. That case's handler assertion throws, and vitest records the throw as an unhandled error, not a failed test. Its `Unhandled Errors` section names that next case as "the last test to run". That case is the victim. Find the source by the quoted message: it is the case that throws it.
4. In xstate-test's vitest-adapter suite, the case `saved the expected failure under the test file and name` asserted on a failure file written by a sibling `it.model.fails` case, and the `keyed` case wrote into the same directory. The result depended on the order the cases ran in.

## Invariant

Everything a case causes is observed before that case ends: error reports, files and timers. A case never reads state that another case produces.

```ts
// wrong: the report runs on a timer after the case returns
createActor(machine).start()

// right: the published sink is called synchronously inside the case
const reported: string[] = []
const actor = createActor(machine, {
  reportUnhandledError: (error) => reported.push(getErrorMessage(error)),
}).start()
```

Give each case its own failure directory, and have a case that checks a side effect produce that side effect itself.

## Prevention

No gate enforces this: CI runs one order. Before trusting a green suite, run each package with `--sequence.shuffle` on seeds 1-6. A nonzero exit with 0 failed tests means a report outlived its case.
