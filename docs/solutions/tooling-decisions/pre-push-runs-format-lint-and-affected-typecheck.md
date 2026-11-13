---
title: Pre-push runs format, lint and affected typecheck, never tests
date: 2026-11-12
category: tooling-decisions
module: repo
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "editing .husky/pre-push"
symptoms:
  - "the pre-push hook only checked that main was not behind origin, so pushes skipped format, lint and typecheck"
root_cause: config_error
resolution_type: config_change
---

# Pre-push runs format, lint and affected typecheck, never tests

Agents run format, lint and typecheck before every push. Tests run only in CI.

`.husky/pre-push` runs `format:check`, `lint`, and `turbo run typecheck lint --affected` with base = the merge-base with `origin/main`. The main-behind check still runs for `main`. The hook runs no test task.
