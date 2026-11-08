---
title: A machine actor belongs to the scope of its Layer-built service
applies_when:
  - starting a machine actor for a service
  - moving a live actor between a module and an Effect Layer
  - stopping a service that owns a machine actor
tags: [xstate, actor, layer, scope]
---

A machine actor is a running instance of machine logic. Create it inside the Effect that builds its owning service, and keep it within that Layer's scope. Never create a live actor at module scope or share a global live actor between service instances. The actor must start and stop with the owning scope.

For Effect-hosted machines, `createEffectActor` creates and starts the actor and stops it when the enclosing scope closes ([export](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-effect/src/index.ts#L14-L15), [lifecycle](https://github.com/systemfsoftware/xstate/blob/1c1fda7eb3328bacd3132e6995ae0de777fcd12d/packages/xstate-effect/src/createEffectActor.ts#L48-L70)). Immutable machine logic may be defined at module scope; the live actor may not.
