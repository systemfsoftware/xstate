---
title: A sharded mutation gate passes with survivors until a job merges the shard reports and gates them
date: 2026-10-09
category: workflow-issues
module: .github/workflows/release-gate.yml
problem_type: workflow_issue
component: tooling
symptoms:
  - "The Release gate is green while its report lists Survived and NoCoverage mutants"
  - "A shard logs 'scored below thresholds.break over this shard's mutants: the merged report carries the project verdict' and exits 0"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: high
tags: [stryker, mutation-testing, release-gate, sharding, ci]
---

# A sharded mutation gate passes with survivors until a job merges the shard reports and gates them

## Problem

`stryker.shared.ts` sets `thresholds.break: 100`, but a `stryker run --shard` child does not enforce it. A shard holds only part of a project's mutants, so stryker-js 17 logs that the merged report carries the verdict and exits 0. A workflow with only the `plan` and `mutation` jobs therefore never fails on a survivor.

## Symptoms

- Release gate run 37869702486 on `9857b0b3` was green, and its report held 3 Survived mutants and 1 NoCoverage mutant in the state-id parser behind `toStatePath`.

## Solution

A `verdict` job needs every `mutation` shard, downloads `stryker-plan` and every `mutation-shard-*` artifact, and runs stryker's own commands:

```bash
stryker merge --plan .cache/stryker-plan.json --out reports/mutation <one dir per shard, in plan order>
stryker gate --baseline .cache/no-survivors.json   # {"schemaVersion":1,"survivors":[]}
```

- **Shard directory.** A shard run writes under stryker-js's `SHARD_OUT_MARKER` (`reports/shards`) plus the shard index, joined with each plan project path. Merge resolves projects the same way, so pass the shard's `reports/shards/<index>` directory even though `<index>` never exists on disk: the plan's `../packages/<name>` steps back out of it.
- **Artifact for each shard.** `strategy.job-index` follows matrix order, which can differ from plan order, so find a shard's artifact by its matrix label `index/count`.
- **Fail-closed paths.** Merge raises `ShardReportGap` when a planned mutant has no report. `stryker gate` reads its `GATE_REPORT_FILE`, the file merge writes. It rejects any Survived or NoCoverage mutant missing from the baseline (`GateRejected`) and fails when the baseline is missing or undecodable (`GateInputUnusable`). An empty baseline is the same bar as `thresholds.break: 100`.
- **Errexit.** Keep `set -euo pipefail`, and write `jq`'s output to a file before `mapfile` reads it. A process substitution hides a `jq` failure from `set -e`.

## Prevention

The release-gate sandbox proof runs the verdict step in the sandbox with a recording `stryker` stub. It fails if the job stops needing `mutation`, maps shards by position, accepts a survivor in the baseline, or runs the gate after a failed merge. Local `stryker merge` and `stryker gate` runs are refused on this host, so the first proof with real reports is the job's first run on main.

## Related Issues

- Ruling cycle 165; survivor fix PR #73.
