---
title: An xstate error snapshot's nodes hold only the root, so a root-down walk must find an active leaf first
date: 2026-10-09
category: logic-errors
module: packages/xstate
problem_type: logic_error
component: data_model
symptoms:
  - "`mapState` on the snapshot of an actor whose context factory threw calls the root mapper and returns `[{ stateNode: root, result }]`, where main returned `[]`"
  - "A root mapper that reads `snapshot.context` throws, because the error snapshot's context is `{}`"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [snapshot-nodes, error-snapshot, map-state, traversal, state-configuration]
---

# An xstate error snapshot's nodes hold only the root, so a root-down walk must find an active leaf first

## Problem

Capability 3 (map-state) rewrote `mapState` to walk the machine from the root down through the active set `new Set(snapshot.nodes)`, so results come out in the documented order. On the snapshot left by a context factory that throws, that walk called the root mapper; main's walk returned nothing.

## Symptoms

- `createActor(machine).getSnapshot()` for a machine whose `context` factory throws has `status: 'error'` and `nodes` equal to `[root]`, with `context` `{}`.
- The root-down `mapState` returned the root's result for it, and a mapper reading context threw.

## What Didn't Work

- Treating `snapshot.nodes` as a resolved state configuration. For most snapshots it is closed under ancestors and every compound or parallel node in it has an active child, down to an atomic node. The snapshots `StateMachine` builds with `_nodes: [this.root]` break that: the catch around `_getPreInitialState` in `getInitialSnapshot` (context factory threw), `_getPreInitialState` itself, and `_createRestoreErrorSnapshot` (restore failed). There the root is "active" with no active child.

## Solution

`mapState`'s `mapActiveStates` maps only when the snapshot has an active atomic node, which is the condition main's leaf-up walk applied implicitly:

```ts
const mapActiveStates = (snapshot, mapper) =>
  snapshot.nodes.some(isAtomicStateNode)
    ? mappedStatesOf(snapshot, new Set(snapshot.nodes), snapshot.machine.root, mapper)
    : []
```

A machine with no child states has an atomic root, so its error snapshot still maps the root, as on main.

## Why This Works

Main's `mapState` started from `snapshot.nodes.filter(isAtomicStateNode)` and walked `parent` links up. Only ancestors of an active leaf were ever visited, so a root-only snapshot of a compound or parallel machine produced nothing. A root-down walk visits every node reachable through the active set, including a root with no active child. Gating on an active atomic node restores main's result set while keeping the new order.

Invariant: a traversal over `snapshot.nodes` may assume a resolved configuration only after it has found an active atomic node; otherwise the set is `[root]` and no state is resolved.

## Prevention

- Any rewrite of a snapshot query from leaf-up to root-down (tags, meta, `can`, the snapshot-queries capability) needs the same gate, or must be shown to be safe on `[root]`-only nodes.
- The map-state model fixture (`stateMapping.model.ts`) draws a `context-threw` snapshot kind, so the conformance check fails if the gate is removed. A model for another snapshot query should draw the same kind.

## Related Issues

- Capability 3 branch `xs/xstate-map-state` (PR pending).
