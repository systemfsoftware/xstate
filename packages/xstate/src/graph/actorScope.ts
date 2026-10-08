import type { AnyActorScope } from '../index.js'
import { createEmptyActor } from '../index.js'
import { defaultWarn } from '../warnSink.js'

export function createMockActorScope(): AnyActorScope {
  const emptyActor = createEmptyActor()
  return {
    self: emptyActor,
    logger: console.log,
    warn: defaultWarn,
    id: '',
    sessionId: Math.random().toString(32).slice(2),
    defer: () => {},
    system: emptyActor.system, // TODO: mock system?
    stopChild: () => {},
    emit: () => {},
    actionExecutor: () => {},
  }
}
