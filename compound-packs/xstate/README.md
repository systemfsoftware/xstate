# XState Compound Pack

Rules for choosing state representation, owning machine actors, typing machine boundaries, and testing model paths in the `@systemfsoftware/xstate` fork. Declare the pack explicitly in `.compound-engineering/config.yaml`; a dependency, a Nix `file:` catalog entry, or an installed tarball does not enroll it.

For a Git-sourced consumer, append this entry without replacing existing packs. `XSTATE_REV` is the commit to resolve under the rule below, not a literal ref:

```yaml
- source: https://github.com/systemfsoftware/xstate
  ref: XSTATE_REV
  path: compound-packs/xstate
```

A consumer's pack ref is the systemfsoftware/xstate commit its flake.lock pins for its github:systemfsoftware/xstate input. When that pin moves, the pack ref moves with it in the same change. A consumer with no such input uses the commit that added this pack: `e49280a6a73e085fd22e952299a8916d9d4b0f2d`. The selected commit must contain this pack.

In this repository, declare the local path `compound-packs/xstate` as a pack source instead. The resolver reads top-level rule files, not this README. An unreachable Git source can be skipped with a warning, so a declaration alone does not prove that a rule was selected.
