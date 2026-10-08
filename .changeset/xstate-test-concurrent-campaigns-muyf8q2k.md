---
"@systemfsoftware/xstate-test": patch
---

Two property-test campaigns that run concurrently in one process no longer affect each other: each campaign's stubbed actor outcomes and fast-check scheduler now resolve only inside the campaign that created them. Previously, a campaign could resolve outcomes another campaign had queued, and a campaign run with `scheduler: true` leaked its scheduler into campaigns that had scheduling off, so overlapping campaigns could cover states they never reached or run as if they were scheduled.
