---
title: Bridge a generic public signature with an overload, not a no-op assertion function
date: 2026-10-09
category: conventions
module: packages/xstate
problem_type: convention
component: tooling
applies_when:
  - "A published generic function builds a value TypeScript cannot prove has the generic type, such as an empty context typed as the caller's context type"
  - "A file joins the recommended lint, whose consistent-type-assertions rule rejects every `as` assertion"
symptoms:
  - "`typescript(consistent-type-assertions)`: Do not use any type assertions"
root_cause: wrong_api
tags: [type-assertions, overloads, lint, casts, fsm]
---

# Bridge a generic public signature with an overload, not a no-op assertion function

## Context

The recommended oxlint config rejects every `as` assertion through `typescript(consistent-type-assertions)`, including `as unknown as T`. When the `@systemfsoftware/xstate/fsm` entry (`createFSM`, `setup`) joined that lint for the fsm capability, two places still needed a value TypeScript could not prove had the published generic type:

- `createFSM` defaults a missing context to `{}`, and `{}` is not provably the caller's `TContext`.
- `setup()` returns an object whose `createFSM` is the runtime function, while its published type is a generic method over setup's schemas.

The first fix replaced each `as` with an assertion function whose body does nothing:

```ts
const assertContext: <TContext extends MachineContext>(
  value: MachineContext,
) => asserts value is TContext = () => undefined
```

The lint accepts it. Yet it is the same unchecked cast, now in the shape of a check: a reader sees `assertContext(empty)` and trusts a verification that never runs. That is the harm CONST-B5 names, and it reads as dodging the lint rule rather than satisfying it.

## Guidance

Write the published generic signature as an overload, and give the implementation signature the erased types (`MachineContext`, `EventObject`, `string`):

```ts
/** @public */
export function createFSM<
  TContext extends MachineContext = {},
  TEvent extends EventObject = EventObject,
  TState extends string = string,
>(
  config: FSMConfigForStates<TContext, TEvent, TState>,
): FSM<TContext, TEvent, TState, FSMSnapshot<TContext, TState>, FSMConfigForStates<TContext, TEvent, TState>>
export function createFSM(config: AnyFSMConfig): AnyFSM {
  return fsmOf(config)
}
```

Inside the erased implementation, `config.context ?? {}` is a plain `MachineContext`, and `setup` can return `{ createFSM: fsmOf }` directly. Neither needs a bridge. The generic helpers that existed only to index a generic `on` table become ordinary functions. The declaration file and the api-extractor report contain only the overload, so the published API is byte-identical.

The overload is still an unchecked bridge: TypeScript checks overload compatibility with type parameters erased, and it rejected `setup`'s implementation return type until that was widened to `object`. State the bridge openly in the PR body. Do not dress it as a runtime check.

Keep each implementation helper at the lint's complexity cap of 2. Merging `?.`, `??`, `&&` and a ternary into one function is what pushes it over.

Gate: review. The lint passes both forms, so the reviewer rejects any `asserts value is T` function whose body never inspects `value`. The two code blocks above are the wrong/right pair.

## When this applies

Use this for any published generic factory whose runtime body only works on the erased shape: machine, actor-logic or store factories. Where the value comes from outside the program (bytes, JSON, a foreign type), the answer is a decode returning a typed result, not an overload.
