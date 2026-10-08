---
"@systemfsoftware/xstate-test": minor
---

The `statistics` option on `propertyTest()` and `testPaths()` now also accepts a callback: `statistics?: boolean | ((report: string) => void)`. `true` still prints `formatTestStatistics(coverage)` after a passing campaign; a function receives that same string once instead of the print, so a caller can route the report to its own sink. Leaving the option out reports nothing, as before. `statistics: false` used to print the report as well; it now reports nothing.
