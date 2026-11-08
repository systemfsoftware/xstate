---
title: A machine actor belongs to the scope of its Layer-built service
applies_when:
  - starting a machine actor for a service
  - moving a live actor between a module and an Effect Layer
  - stopping a service that owns a machine actor
tags: [xstate, actor, layer, scope]
---

A machine actor is a running instance of machine logic. Create it inside the Effect that builds its owning service, and keep it within that Layer's scope. Never create a live actor at module scope or share a global live actor between service instances. The actor must start and stop with the owning scope.

For Effect-hosted machines, `packages/xstate-effect/src/index.ts` exports `createEffectActor`; `packages/xstate-effect/src/createEffectActor.ts` defines its scoped lifecycle: it creates and starts the actor and stops it when the enclosing scope closes. Immutable machine logic may be defined at module scope; the live actor may not.
