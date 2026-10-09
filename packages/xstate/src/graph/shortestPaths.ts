import type {
  AnyActorLogic,
  AnyActorScope,
  EventFromLogic,
  EventObject,
  InputFrom,
  NonReducibleUnknown,
  SnapshotFrom,
} from '../index.js'
import { createMockActorScope } from './actorScope.js'
import { getAdjacencyMap } from './adjacency.js'
import { alterPath } from './alterPath.js'
import {
  logicFirstOrLast,
  type OptionsOf,
  type PathsOf,
  resolveTraversalOptions,
  toSerializedEvent,
  toSerializedSnapshot,
} from './graph.js'
import type {
  AdjacencyMap,
  AnySnapshot,
  SerializedEvent,
  SerializedSnapshot,
  StatePath,
  StatePlanMap,
  Step,
  Steps,
  TraversalConfig,
  TraversalOptions,
} from './types.js'

interface WeightEntry<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  weight: number
  snapshot: TSnapshot
  origin: SerializedSnapshot | undefined
  event: TEvent | undefined
}

interface PathPlan<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  state: TSnapshot
  paths: Array<StatePath<TSnapshot, TEvent>>
}

interface ShortestContext<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  adjacency: AdjacencyMap<TSnapshot, TEvent>
  serializeState: TraversalConfig<TSnapshot, TEvent>['serializeState']
  weightMap: Map<SerializedSnapshot, WeightEntry<TSnapshot, TEvent>>
  visited: Set<SerializedSnapshot>
  unvisited: Map<SerializedSnapshot, WeightEntry<TSnapshot, TEvent>>
}

const createNullDict = <TValue>(): Record<string, TValue> => {
  const dict: Record<string, TValue> = {}
  Object.setPrototypeOf(dict, null)
  return dict
}

const inputOf = <TInput>(options: { input?: TInput } | undefined): TInput | undefined =>
  options === undefined ? undefined : options.input

const initialSnapshotOf = <TSnapshot>(
  logic: { getInitialSnapshot(actorScope: AnyActorScope, input: NonReducibleUnknown): TSnapshot },
  input: NonReducibleUnknown,
  actorScope: AnyActorScope,
): TSnapshot => logic.getInitialSnapshot(actorScope, input)

const discover = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  nextSerialized: SerializedSnapshot,
  entry: WeightEntry<TSnapshot, TEvent>,
): void => {
  if (!context.visited.has(nextSerialized)) {
    context.unvisited.set(nextSerialized, entry)
  }
}

const recordReach = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  nextSerialized: SerializedSnapshot,
  weight: number,
  origin: SerializedSnapshot,
  snapshot: TSnapshot,
  event: TEvent,
): void => {
  const existing = context.weightMap.get(nextSerialized)
  const entry = existing === undefined ? { weight, snapshot, origin, event } : { ...existing, snapshot }
  context.weightMap.set(nextSerialized, entry)
  discover(context, nextSerialized, entry)
}

const relaxTransition = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  fromSnapshot: TSnapshot,
  weight: number,
  transitions: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot]['transitions'],
  serializedEvent: SerializedEvent,
): void => {
  const transition = transitions[serializedEvent]
  if (transition === undefined) {
    return
  }
  const nextSerialized = toSerializedSnapshot(
    context.serializeState(transition.state, transition.event, fromSnapshot),
  )
  recordReach(context, nextSerialized, weight + 1, fromSerialized, transition.state, transition.event)
}

const relaxTransitions = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  fromSnapshot: TSnapshot,
  weight: number,
  adjacencyValue: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot],
): void => {
  for (const serializedEvent of Object.keys(adjacencyValue.transitions).map(toSerializedEvent)) {
    relaxTransition(context, fromSerialized, fromSnapshot, weight, adjacencyValue.transitions, serializedEvent)
  }
}

const relaxState = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  entry: WeightEntry<TSnapshot, TEvent>,
): void => {
  const adjacencyValue = context.adjacency[fromSerialized]
  if (adjacencyValue === undefined) {
    return
  }
  relaxTransitions(context, fromSerialized, entry.snapshot, entry.weight, adjacencyValue)
  context.visited.add(fromSerialized)
  context.unvisited.delete(fromSerialized)
}

const runTraversal = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
): void => {
  for (const [fromSerialized, entry] of context.unvisited) {
    relaxState(context, fromSerialized, entry)
  }
}

const firstPlanPath = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
): StatePath<TSnapshot, TEvent> | undefined => {
  const plan = statePlanMap[fromSerialized]
  return plan === undefined ? undefined : plan.paths[0]
}

const stepTo = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  fromState: TSnapshot,
  event: TEvent | undefined,
): Array<Step<TSnapshot, TEvent>> => event === undefined ? [] : [{ state: fromState, event }]

const stepsToward = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  event: TEvent | undefined,
): Steps<TSnapshot, TEvent> => {
  const path = firstPlanPath(statePlanMap, fromSerialized)
  return path === undefined
    ? []
    : path.steps.concat(stepTo(path.state, event))
}

const predecessorSteps = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  entry: WeightEntry<TSnapshot, TEvent>,
): Steps<TSnapshot, TEvent> => {
  const origin = entry.origin
  return origin === undefined
    ? []
    : stepsToward(statePlanMap, origin, entry.event)
}

const buildPath = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  entry: WeightEntry<TSnapshot, TEvent>,
  stateSerial: SerializedSnapshot,
): StatePath<TSnapshot, TEvent> => {
  const state = entry.snapshot
  const steps = predecessorSteps(statePlanMap, entry)
  statePlanMap[stateSerial] = {
    state,
    paths: [{ state, steps, weight: entry.weight }],
  }
  return { state, steps, weight: entry.weight }
}

const collectPaths = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  weightMap: Map<SerializedSnapshot, WeightEntry<TSnapshot, TEvent>>,
): Array<StatePath<TSnapshot, TEvent>> => {
  const statePlanMap: StatePlanMap<TSnapshot, TEvent> = createNullDict<PathPlan<TSnapshot, TEvent>>()
  const paths: Array<StatePath<TSnapshot, TEvent>> = []
  weightMap.forEach((entry, stateSerial) => {
    paths.push(buildPath(statePlanMap, entry, stateSerial))
  })
  return paths
}

const applyTarget = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  paths: Array<StatePath<TSnapshot, TEvent>>,
  toState: ((state: TSnapshot) => boolean) | undefined,
): Array<StatePath<TSnapshot, TEvent>> => {
  const target = toState
  if (target === undefined) {
    return paths.map(alterPath)
  }
  return paths.filter((path) => target(path.state)).map(alterPath)
}

const seed = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromState: TSnapshot,
): void => {
  const serialized = toSerializedSnapshot(context.serializeState(fromState, undefined, undefined))
  const entry: WeightEntry<TSnapshot, TEvent> = {
    weight: 0,
    snapshot: fromState,
    origin: undefined,
    event: undefined,
  }
  context.weightMap.set(serialized, entry)
  context.unvisited.set(serialized, entry)
}

function computeShortestPaths<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: TraversalOptions<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
): Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>> {
  type TInternalState = SnapshotFrom<TLogic>
  type TEvent = EventFromLogic<TLogic>

  const resolvedOptions = resolveTraversalOptions({ logic, options })
  const fromState = resolvedOptions.fromState ??
    initialSnapshotOf<TInternalState>(logic, inputOf(options), createMockActorScope())
  const adjacency = getAdjacencyMap(logic, { ...resolvedOptions, fromState })
  const context: ShortestContext<TInternalState, TEvent> = {
    adjacency,
    serializeState: resolvedOptions.serializeState,
    weightMap: new Map(),
    visited: new Set(),
    unvisited: new Map(),
  }
  seed(context, fromState)
  runTraversal(context)
  return applyTarget(collectPaths(context.weightMap), resolvedOptions.toState)
}

export function getShortestPaths<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: TraversalOptions<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
): Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>>
export function getShortestPaths<TLogic extends AnyActorLogic>(
  options?: TraversalOptions<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
): (logic: TLogic) => Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>>
export function getShortestPaths<TLogic extends AnyActorLogic>(
  ...args:
    | readonly [logic: TLogic, options?: OptionsOf<TLogic> | undefined]
    | readonly [options?: OptionsOf<TLogic> | undefined]
): PathsOf<TLogic> | ((logic: TLogic) => PathsOf<TLogic>) {
  const [first, second] = args
  return logicFirstOrLast(computeShortestPaths<TLogic>)(first, second)
}
