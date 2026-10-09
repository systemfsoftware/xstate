import type {
  ActorLogic,
  ActorScope,
  AnyActorScope,
  AnyActorSystem,
  EventObject,
  NonReducibleUnknown,
} from '../index.js'
import { createMockActorScope } from './actorScope.js'
import { resolveTraversalOptions, toSerializedEvent, toSerializedSnapshot } from './graph.js'
import type {
  AdjacencyMap,
  AdjacencyValue,
  AnySnapshot,
  SerializedSnapshot,
  TraversalConfig,
  TraversalOptions,
} from './types.js'

interface QueueEntry<TSnapshot, TEvent> {
  nextState: TSnapshot
  event: TEvent | undefined
  prevState: TSnapshot | undefined
}

interface Transition<TSnapshot, TEvent> {
  event: TEvent
  state: TSnapshot
}

interface Traversal<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
> {
  config: TraversalConfig<TSnapshot, TEvent>
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>
  actorScope: AnyActorScope
  iterations: number
}

const createNullDict = <TValue>(): Record<string, TValue> => {
  const dict: Record<string, TValue> = {}
  Object.setPrototypeOf(dict, null)
  return dict
}

function resolveTransitionSnapshot<TSnapshot>(
  result: TSnapshot | [TSnapshot, NonReducibleUnknown[]],
): TSnapshot {
  return Array.isArray(result) ? result[0] : result
}

const initialSnapshotOf = <TSnapshot>(
  logic: { getInitialSnapshot(actorScope: AnyActorScope, input: NonReducibleUnknown): TSnapshot },
  input: NonReducibleUnknown,
  actorScope: AnyActorScope,
): TSnapshot => logic.getInitialSnapshot(actorScope, input)

function actorScopeOf<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TSystem extends AnyActorSystem,
>(scope: AnyActorScope): ActorScope<TSnapshot, TEvent, TSystem>
function actorScopeOf(scope: AnyActorScope): AnyActorScope {
  return scope
}

const isVisited = <TSnapshot, TEvent>(
  adj: AdjacencyMap<TSnapshot, TEvent>,
  serialized: SerializedSnapshot,
): boolean => adj[serialized] !== undefined

const stopsAt = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
  state: TSnapshot,
): boolean => {
  const { stopWhen } = traversal.config
  return stopWhen === undefined ? false : stopWhen(state)
}

const countIteration = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): void => {
  const exceeded = traversal.iterations > traversal.config.limit
  traversal.iterations += 1
  if (exceeded) {
    throw new Error('Traversal limit exceeded')
  }
}

const registerQueued = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  adj: AdjacencyMap<TSnapshot, TEvent>,
  queued: QueueEntry<TSnapshot, TEvent>,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): AdjacencyValue<TSnapshot, TEvent> | undefined => {
  countIteration(traversal)
  const { nextState, event, prevState } = queued
  const serialized = toSerializedSnapshot(traversal.config.serializeState(nextState, event, prevState))
  if (isVisited(adj, serialized)) {
    return undefined
  }
  return storeValue(adj, serialized, nextState, traversal)
}

const storeValue = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  adj: AdjacencyMap<TSnapshot, TEvent>,
  serialized: SerializedSnapshot,
  state: TSnapshot,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): AdjacencyValue<TSnapshot, TEvent> | undefined => {
  const value: AdjacencyValue<TSnapshot, TEvent> = {
    state,
    transitions: createNullDict<Transition<TSnapshot, TEvent>>(),
  }
  adj[serialized] = value
  return stopsAt(traversal, state) ? undefined : value
}

const eventsFor = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
  state: TSnapshot,
): readonly TEvent[] => {
  const { events } = traversal.config
  return typeof events === 'function' ? events(state) : events
}

const passesFilter = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
  state: TSnapshot,
  event: TEvent,
): boolean => {
  const { filterEvents } = traversal.config
  return filterEvents === undefined ? true : filterEvents(state, event)
}

const recordTransition = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  value: AdjacencyValue<TSnapshot, TEvent>,
  queue: Array<QueueEntry<TSnapshot, TEvent>>,
  queued: QueueEntry<TSnapshot, TEvent>,
  event: TEvent,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): void => {
  const nextState = resolveTransitionSnapshot(
    traversal.logic.transition(
      queued.nextState,
      event,
      actorScopeOf<TSnapshot, TEvent, TSystem>(traversal.actorScope),
    ),
  )
  value.transitions[toSerializedEvent(traversal.config.serializeEvent(event))] = { event, state: nextState }
  queue.push({ nextState, event, prevState: queued.nextState })
}

const enqueueTransitions = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  value: AdjacencyValue<TSnapshot, TEvent>,
  queue: Array<QueueEntry<TSnapshot, TEvent>>,
  queued: QueueEntry<TSnapshot, TEvent>,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): void => {
  for (const event of eventsFor(traversal, queued.nextState)) {
    enqueueFiltered(value, queue, queued, event, traversal)
  }
}

const enqueueFiltered = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  value: AdjacencyValue<TSnapshot, TEvent>,
  queue: Array<QueueEntry<TSnapshot, TEvent>>,
  queued: QueueEntry<TSnapshot, TEvent>,
  event: TEvent,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): void => {
  if (passesFilter(traversal, queued.nextState, event)) {
    recordTransition(value, queue, queued, event, traversal)
  }
}

const expand = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  adj: AdjacencyMap<TSnapshot, TEvent>,
  queue: Array<QueueEntry<TSnapshot, TEvent>>,
  queued: QueueEntry<TSnapshot, TEvent>,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): void => {
  const value = registerQueued(adj, queued, traversal)
  if (value === undefined) {
    return
  }
  enqueueTransitions(value, queue, queued, traversal)
}

const expandLevel = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  adj: AdjacencyMap<TSnapshot, TEvent>,
  level: ReadonlyArray<QueueEntry<TSnapshot, TEvent>>,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): Array<QueueEntry<TSnapshot, TEvent>> => {
  const nextLevel: Array<QueueEntry<TSnapshot, TEvent>> = []
  for (const queued of level) {
    expand(adj, nextLevel, queued, traversal)
  }
  return nextLevel
}

const drain = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  adj: AdjacencyMap<TSnapshot, TEvent>,
  start: QueueEntry<TSnapshot, TEvent>,
  traversal: Traversal<TSnapshot, TEvent, TInput, TSystem>,
): void => {
  let level = [start]
  while (level.length > 0) {
    level = expandLevel(adj, level, traversal)
  }
}

function computeAdjacencyMap<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
  options: TraversalOptions<TSnapshot, TEvent, TInput>,
): AdjacencyMap<TSnapshot, TEvent> {
  'use strict'
  const config = resolveTraversalOptions({ logic, options })
  const actorScope = createMockActorScope()
  const traversal: Traversal<TSnapshot, TEvent, TInput, TSystem> = {
    config,
    logic,
    actorScope,
    iterations: 0,
  }
  const fromState = config.fromState ?? initialSnapshotOf(logic, options.input, actorScope)
  const adj: AdjacencyMap<TSnapshot, TEvent> = createNullDict<AdjacencyValue<TSnapshot, TEvent>>()
  drain(adj, { nextState: fromState, event: undefined, prevState: undefined }, traversal)
  return adj
}

export function getAdjacencyMap<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  options: TraversalOptions<TSnapshot, TEvent, TInput>,
): (logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>) => AdjacencyMap<TSnapshot, TEvent>
export function getAdjacencyMap<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
  options: TraversalOptions<TSnapshot, TEvent, TInput>,
): AdjacencyMap<TSnapshot, TEvent>
export function getAdjacencyMap<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  ...args:
    | readonly [
      logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
      options: TraversalOptions<TSnapshot, TEvent, TInput>,
    ]
    | readonly [options: TraversalOptions<TSnapshot, TEvent, TInput>]
):
  | AdjacencyMap<TSnapshot, TEvent>
  | ((logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>) => AdjacencyMap<TSnapshot, TEvent>)
{
  if (args.length === 1) {
    const [options] = args
    return (logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>) => computeAdjacencyMap(logic, options)
  }
  return computeAdjacencyMap(args[0], args[1])
}

/** @public */
export function adjacencyMapToArray<TSnapshot, TEvent>(
  adjMap: AdjacencyMap<TSnapshot, TEvent>,
): Array<{
  state: TSnapshot
  event: TEvent
  nextState: TSnapshot
}> {
  return Object.values({ ...adjMap }).flatMap((adjValue) => adjacencyRow(adjValue))
}

const adjacencyRow = <TSnapshot, TEvent>(
  adjValue: AdjacencyValue<TSnapshot, TEvent>,
): Array<{
  state: TSnapshot
  event: TEvent
  nextState: TSnapshot
}> =>
  Object.values({ ...adjValue.transitions }).map((transition) => ({
    state: adjValue.state,
    event: transition.event,
    nextState: transition.state,
  }))
