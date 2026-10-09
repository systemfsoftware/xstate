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
import { resolveTraversalOptions, toSerializedEvent, toSerializedSnapshot } from './graph.js'
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

interface WeightEntry<TEvent extends EventObject> {
  weight: number
  state: SerializedSnapshot | undefined
  event: TEvent | undefined
}

interface PathPlan<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  state: TSnapshot
  paths: Array<StatePath<TSnapshot, TEvent>>
}

interface ShortestContext<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  adjacency: AdjacencyMap<TSnapshot, TEvent>
  serializeState: TraversalConfig<TSnapshot, TEvent>['serializeState']
  stateMap: Map<SerializedSnapshot, TSnapshot>
  weightMap: Map<SerializedSnapshot, WeightEntry<TEvent>>
  visited: Set<SerializedSnapshot>
  unvisited: Set<SerializedSnapshot>
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

const mustGet = <TKey, TValue>(map: Map<TKey, TValue>, key: TKey): TValue => {
  const value = map.get(key)
  if (value === undefined) {
    throw new Error('Missing traversal entry')
  }
  return value
}

const improveExisting = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  weight: number,
  nextSerialized: SerializedSnapshot,
  event: TEvent,
): void => {
  const { weight: nextWeight } = mustGet(context.weightMap, nextSerialized)
  if (nextWeight > weight + 1) {
    context.weightMap.set(nextSerialized, { weight: weight + 1, state: fromSerialized, event })
  }
}

const improveWeight = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  weight: number,
  nextSerialized: SerializedSnapshot,
  event: TEvent,
): void => {
  if (context.weightMap.has(nextSerialized)) {
    improveExisting(context, fromSerialized, weight, nextSerialized, event)
  } else {
    context.weightMap.set(nextSerialized, { weight: weight + 1, state: fromSerialized, event })
  }
}

const discover = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  nextSerialized: SerializedSnapshot,
): void => {
  if (!context.visited.has(nextSerialized)) {
    context.unvisited.add(nextSerialized)
  }
}

const relaxTransition = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  weight: number,
  transitions: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot]['transitions'],
  serializedEvent: SerializedEvent,
): void => {
  const transition = transitions[serializedEvent]
  if (transition === undefined) {
    return
  }
  const nextSerialized = toSerializedSnapshot(
    context.serializeState(transition.state, transition.event, context.stateMap.get(fromSerialized)),
  )
  context.stateMap.set(nextSerialized, transition.state)
  improveWeight(context, fromSerialized, weight, nextSerialized, transition.event)
  discover(context, nextSerialized)
}

const relaxTransitions = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  weight: number,
  adjacencyValue: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot],
): void => {
  for (const serializedEvent of Object.keys(adjacencyValue.transitions).map(toSerializedEvent)) {
    relaxTransition(context, fromSerialized, weight, adjacencyValue.transitions, serializedEvent)
  }
}

const relaxState = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
): void => {
  const weightEntry = mustGet(context.weightMap, fromSerialized)
  const adjacencyValue = context.adjacency[fromSerialized]
  if (adjacencyValue === undefined) {
    return
  }
  relaxTransitions(context, fromSerialized, weightEntry.weight, adjacencyValue)
  context.visited.add(fromSerialized)
  context.unvisited.delete(fromSerialized)
}

const runTraversal = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: ShortestContext<TSnapshot, TEvent>,
): void => {
  for (const fromSerialized of context.unvisited) {
    relaxState(context, fromSerialized)
  }
}

const firstPlanPath = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
): StatePath<TSnapshot, TEvent> | undefined => {
  const plan = statePlanMap[fromSerialized]
  return plan === undefined ? undefined : plan.paths[0]
}

const stepTo = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  fromSerialized: SerializedSnapshot,
  event: TEvent | undefined,
): Array<Step<TSnapshot, TEvent>> => event === undefined ? [] : [{ state: mustGet(stateMap, fromSerialized), event }]

const stepsToward = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  event: TEvent | undefined,
): Steps<TSnapshot, TEvent> => {
  const path = firstPlanPath(stateMap, statePlanMap, fromSerialized)
  return path === undefined
    ? []
    : path.steps.concat(stepTo(stateMap, fromSerialized, event))
}

const predecessorSteps = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  entry: WeightEntry<TEvent>,
): Steps<TSnapshot, TEvent> => {
  const { state: fromSerialized, event } = entry
  return fromSerialized === undefined
    ? []
    : stepsToward(stateMap, statePlanMap, fromSerialized, event)
}

const buildPath = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  statePlanMap: StatePlanMap<TSnapshot, TEvent>,
  entry: WeightEntry<TEvent>,
  stateSerial: SerializedSnapshot,
): StatePath<TSnapshot, TEvent> => {
  const state = mustGet(stateMap, stateSerial)
  const steps = predecessorSteps(stateMap, statePlanMap, entry)
  statePlanMap[stateSerial] = {
    state,
    paths: [{ state, steps, weight: entry.weight }],
  }
  return { state, steps, weight: entry.weight }
}

const collectPaths = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  weightMap: Map<SerializedSnapshot, WeightEntry<TEvent>>,
): Array<StatePath<TSnapshot, TEvent>> => {
  const statePlanMap: StatePlanMap<TSnapshot, TEvent> = createNullDict<PathPlan<TSnapshot, TEvent>>()
  const paths: Array<StatePath<TSnapshot, TEvent>> = []
  weightMap.forEach((entry, stateSerial) => {
    paths.push(buildPath(stateMap, statePlanMap, entry, stateSerial))
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
  context.stateMap.set(serialized, fromState)
  context.weightMap.set(serialized, { weight: 0, state: undefined, event: undefined })
  context.unvisited.add(serialized)
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
    stateMap: new Map(),
    weightMap: new Map(),
    visited: new Set(),
    unvisited: new Set(),
  }
  seed(context, fromState)
  runTraversal(context)
  return applyTarget(collectPaths(context.stateMap, context.weightMap), resolvedOptions.toState)
}

type ShortestOptions<TLogic extends AnyActorLogic> = TraversalOptions<
  SnapshotFrom<TLogic>,
  EventFromLogic<TLogic>,
  InputFrom<TLogic>
>

type ShortestPaths<TLogic extends AnyActorLogic> = Array<
  StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>
>

const isActorLogicLike = <TLogic extends AnyActorLogic>(
  value: TLogic | ShortestOptions<TLogic> | undefined,
): value is TLogic => value !== undefined && 'transition' in value

const resolveShortest = <TLogic extends AnyActorLogic>(
  first: TLogic | ShortestOptions<TLogic> | undefined,
  second: ShortestOptions<TLogic> | undefined,
): ShortestPaths<TLogic> | ((logic: TLogic) => ShortestPaths<TLogic>) =>
  isActorLogicLike(first)
    ? computeShortestPaths(first, second)
    : (logic: TLogic) => computeShortestPaths(logic, first)

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
    | readonly [logic: TLogic, options?: ShortestOptions<TLogic> | undefined]
    | readonly [options?: ShortestOptions<TLogic> | undefined]
): ShortestPaths<TLogic> | ((logic: TLogic) => ShortestPaths<TLogic>) {
  const [first, second] = args
  return resolveShortest(first, second)
}
