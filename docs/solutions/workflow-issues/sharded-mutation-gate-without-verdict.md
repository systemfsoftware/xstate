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
- Once the verdict job existed, run 37892133106 on `21fe21ef` failed it with `planned mutant(s) missing from the shard reports` naming all 114 planned mutants, while the one shard's stream held every one of them.

## Solution

A `verdict` job needs every `mutation` shard, downloads `stryker-plan` and every `mutation-shard-*` artifact, and runs stryker's own commands:

```bash
stryker merge --plan stryker-plan.json --out reports/mutation <one dir per shard, in plan order>
stryker gate --baseline .cache/no-survivors.json   # {"schemaVersion":1,"survivors":[]}
```

- **Plan at the repository root.** `stryker plan` writes each project path relative to the plan file's directory, and the shard run and merge join that path under their own directories. A plan in `.cache/` gives `../packages/<name>`, which climbs out of the shard's `reports/shards/<index>` directory, so every shard writes the same `.cache/reports/shards/packages/<name>`. At the root the path is `packages/<name>` and shard `k` writes `reports/shards/<k>/packages/<name>/`.
- **One layout for any shard count.** Each shard uploads the single directory `reports/shards/`, so its artifact holds `<k>/packages/<name>/`: upload-artifact v6's `findFilesToUpload` roots a single path at that path and several paths at their common ancestor. The verdict downloads every `mutation-shard-*` artifact with `merge-multiple: true` into `.cache/shard-reports`, so shard `k`'s reports are at `.cache/shard-reports/<k>` whether one shard ran or many. Without `merge-multiple`, download-artifact v6's `run` puts each artifact under its name only when more than one matches, and extracts a lone match straight into the path (its `artifacts.length === 1` case); that is what broke run 37892133106, which had one shard. The per-shard HTML report goes in its own `mutation-report-shard-*` artifact so it stays out of that pattern.
- **Fail-closed paths.** Merge raises `ShardReportGap` when a planned mutant has no report. `stryker gate` reads its `GATE_REPORT_FILE`, the file merge writes. It rejects any Survived or NoCoverage mutant missing from the baseline (`GateRejected`) and fails when the baseline is missing or undecodable (`GateInputUnusable`). An empty baseline is the same bar as `thresholds.break: 100`.
- **Errexit.** Keep `set -euo pipefail`, and write `jq`'s output to a file before `mapfile` reads it. A process substitution hides a `jq` failure from `set -e`.

## Prevention

`pnpm test:sandbox` runs the release-gate sandbox proof, which builds the verdict job's workspace from the workflow itself: the plan where the plan step writes it, each shard's stream under stryker-js's `SHARD_OUT_MARKER`, the upload root, and the download-artifact extraction rule. It then runs the verdict step with a recording `stryker` stub and resolves each shard directory merge receives the way merge does. It runs for one shard and for two shards listed in reverse matrix order, and fails if a planned mutant's stream is not where merge looks. It also fails if the job stops needing `mutation`, accepts a survivor in the baseline, or runs the gate after a failed merge. Local `stryker merge` and `stryker gate` runs are refused on this host, so the proof with real reports is the job's run on main.

## Related Issues

- Ruling cycle 165; survivor fix PR #73.
