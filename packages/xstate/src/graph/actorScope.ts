import type { AnyActorScope, AnyActorSystem } from '../index.js'
import { createEmptyActor } from '../index.js'
import { defaultWarn } from '../warnSink.js'

function actorSystem(actor: Pick<AnyActorScope, 'system'>): AnyActorSystem {
  return actor.system
}

export function createMockActorScope(): AnyActorScope {
  const emptyActor = createEmptyActor()
  return {
    self: emptyActor,
    logger: console.log,
    warn: defaultWarn,
    id: '',
    sessionId: 'mock-actor-scope',
    defer: () => {},
    system: actorSystem(emptyActor),
    stopChild: () => {},
    emit: () => {},
    actionExecutor: () => {},
  }
}
