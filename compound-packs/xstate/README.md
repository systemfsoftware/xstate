# XState Compound Pack

Rules for choosing state representation, owning machine actors, typing machine boundaries, and testing model paths in the `@systemfsoftware/xstate` fork. Declare the pack explicitly in `.compound-engineering/config.yaml`; a dependency, a Nix `file:` catalog entry, or an installed tarball does not enroll it.

For a Git-sourced consumer, append this entry without replacing existing packs. `CORE_TAG` is a value to resolve, not a literal tag:

```yaml
- source: https://github.com/systemfsoftware/xstate
  ref: CORE_TAG
  path: compound-packs/xstate
```

A consumer's pack ref is the `@systemfsoftware/xstate` release tag for the core version its lockfile resolves, whether directly or transitively through `@systemfsoftware/xstate-effect`. Tags of other packages, such as xstate-effect or xstate-store, are never used as the pack ref and need not equal it. A consumer whose lockfile resolves no core `@systemfsoftware/xstate` uses the first pack-bearing core tag. That release must exist and contain this pack before Git-sourced enrollment; no such tag is specified here.

In this repository, declare the local path `compound-packs/xstate` as a pack source instead. The resolver reads top-level rule files, not this README. An unreachable Git source can be skipped with a warning, so a declaration alone does not prove that a rule was selected.
