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
import { isActorLogicLike, resolveTraversalOptions, toSerializedEvent, toSerializedSnapshot } from './graph.js'
import type {
  AdjacencyMap,
  AnySnapshot,
  SerializedEvent,
  SerializedSnapshot,
  StatePath,
  StatePlanMap,
  Steps,
  TraversalConfig,
  TraversalOptions,
  VisitedContext,
} from './types.js'

interface PathPlan<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  state: TSnapshot
  paths: Array<StatePath<TSnapshot, TEvent>>
}

interface Transition<TSnapshot, TEvent> {
  event: TEvent
  state: TSnapshot
}

interface SimpleContext<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  adjacency: AdjacencyMap<TSnapshot, TEvent>
  serializeState: TraversalConfig<TSnapshot, TEvent>['serializeState']
  stateMap: Map<SerializedSnapshot, TSnapshot>
  visitCtx: VisitedContext<TSnapshot, TEvent>
  steps: Steps<TSnapshot, TEvent>
  pathMap: StatePlanMap<TSnapshot, TEvent>
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

const createPlan = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  pathMap: StatePlanMap<TSnapshot, TEvent>,
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  serialized: SerializedSnapshot,
): PathPlan<TSnapshot, TEvent> => {
  const plan: PathPlan<TSnapshot, TEvent> = { state: mustGet(stateMap, serialized), paths: [] }
  pathMap[serialized] = plan
  return plan
}

const planAt = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  pathMap: StatePlanMap<TSnapshot, TEvent>,
  stateMap: Map<SerializedSnapshot, TSnapshot>,
  serialized: SerializedSnapshot,
): PathPlan<TSnapshot, TEvent> => {
  const existing = pathMap[serialized]
  return existing === undefined ? createPlan(pathMap, stateMap, serialized) : existing
}

const recordPath = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  toSerialized: SerializedSnapshot,
  fromState: TSnapshot,
): void => {
  const plan = planAt(context.pathMap, context.stateMap, toSerialized)
  plan.paths.push({
    state: fromState,
    weight: context.steps.length,
    steps: [...context.steps],
  })
}

function expandInto<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  toSerialized: SerializedSnapshot,
  serializedEvent: SerializedEvent,
  event: TEvent,
  nextSerialized: SerializedSnapshot,
): void {
  context.visitCtx.edges.add(serializedEvent)
  context.steps.push({ state: mustGet(context.stateMap, fromSerialized), event })
  visit(context, nextSerialized, toSerialized)
}

const descendInto = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  toSerialized: SerializedSnapshot,
  serializedEvent: SerializedEvent,
  transition: Transition<TSnapshot, TEvent>,
): void => {
  const nextSerialized = toSerializedSnapshot(
    context.serializeState(transition.state, transition.event, context.stateMap.get(fromSerialized)),
  )
  context.stateMap.set(nextSerialized, transition.state)
  if (!context.visitCtx.vertices.has(nextSerialized)) {
    expandInto(context, fromSerialized, toSerialized, serializedEvent, transition.event, nextSerialized)
  }
}

const descendTransition = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  toSerialized: SerializedSnapshot,
  transitions: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot]['transitions'],
  serializedEvent: SerializedEvent,
): void => {
  const transition = transitions[serializedEvent]
  if (transition === undefined) {
    return
  }
  descendInto(context, fromSerialized, toSerialized, serializedEvent, transition)
}

const descendTransitions = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  toSerialized: SerializedSnapshot,
  adjacencyValue: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot],
): void => {
  for (const serializedEvent of Object.keys(adjacencyValue.transitions).map(toSerializedEvent)) {
    descendTransition(context, fromSerialized, toSerialized, adjacencyValue.transitions, serializedEvent)
  }
}

const descend = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  toSerialized: SerializedSnapshot,
): void => {
  const adjacencyValue = context.adjacency[fromSerialized]
  if (adjacencyValue === undefined) {
    return
  }
  descendTransitions(context, fromSerialized, toSerialized, adjacencyValue)
}

function visit<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  toSerialized: SerializedSnapshot,
): void {
  const fromState = mustGet(context.stateMap, fromSerialized)
  context.visitCtx.vertices.add(fromSerialized)
  if (fromSerialized === toSerialized) {
    recordPath(context, toSerialized, fromState)
  } else {
    descend(context, fromSerialized, toSerialized)
  }
  context.steps.pop()
  context.visitCtx.vertices.delete(fromSerialized)
}

const seed = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromState: TSnapshot,
): SerializedSnapshot => {
  const serialized = toSerializedSnapshot(context.serializeState(fromState, undefined))
  context.stateMap.set(serialized, fromState)
  return serialized
}

const visitEachStart = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
): void => {
  for (const nextSerialized of Object.keys(context.adjacency).map(toSerializedSnapshot)) {
    visit(context, fromSerialized, nextSerialized)
  }
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

function computeSimplePaths<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: TraversalOptions<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
): Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>> {
  type TState = SnapshotFrom<TLogic>
  type TEvent = EventFromLogic<TLogic>

  const resolvedOptions = resolveTraversalOptions({ logic, options })
  const actorScope = createMockActorScope()
  const fromState = resolvedOptions.fromState ??
    initialSnapshotOf<TState>(logic, inputOf(options), actorScope)
  const adjacency = getAdjacencyMap(logic, { ...resolvedOptions, fromState })
  const context: SimpleContext<TState, TEvent> = {
    adjacency,
    serializeState: resolvedOptions.serializeState,
    stateMap: new Map(),
    visitCtx: { vertices: new Set(), edges: new Set() },
    steps: [],
    pathMap: createNullDict<PathPlan<TState, TEvent>>(),
  }
  const fromSerialized = seed(context, fromState)
  visitEachStart(context, fromSerialized)
  const simplePaths = Object.values(context.pathMap).flatMap((plan) => plan.paths)
  return applyTarget(simplePaths, resolvedOptions.toState)
}

type SimpleOptions<TLogic extends AnyActorLogic> = TraversalOptions<
  SnapshotFrom<TLogic>,
  EventFromLogic<TLogic>,
  InputFrom<TLogic>
>

type SimplePaths<TLogic extends AnyActorLogic> = Array<
  StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>
>

const resolveSimple = <TLogic extends AnyActorLogic>(
  first: TLogic | SimpleOptions<TLogic> | undefined,
  second: SimpleOptions<TLogic> | undefined,
): SimplePaths<TLogic> | ((logic: TLogic) => SimplePaths<TLogic>) =>
  isActorLogicLike(first)
    ? computeSimplePaths(first, second)
    : (logic: TLogic) => computeSimplePaths(logic, first)

export function getSimplePaths<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options?: TraversalOptions<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
): Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>>
export function getSimplePaths<TLogic extends AnyActorLogic>(
  options?: TraversalOptions<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>,
    InputFrom<TLogic>
  >,
): (logic: TLogic) => Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>>
export function getSimplePaths<TLogic extends AnyActorLogic>(
  ...args:
    | readonly [logic: TLogic, options?: SimpleOptions<TLogic> | undefined]
    | readonly [options?: SimpleOptions<TLogic> | undefined]
): SimplePaths<TLogic> | ((logic: TLogic) => SimplePaths<TLogic>) {
  if (args.length === 2) {
    return computeSimplePaths(args[0], args[1])
  }
  const [first, second] = args
  return resolveSimple(first, second)
}
