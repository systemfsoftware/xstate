---
"@systemfsoftware/xstate": patch
---

The package's `lint` script runs oxlint through `effect-tsgo`, so the `effecttsgo` rules load without a patched `node_modules`. No runtime or type change.
