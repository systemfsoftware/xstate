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

interface SnapshotBox<TSnapshot> {
  snapshot: TSnapshot
}

interface SimpleContext<TSnapshot extends AnySnapshot, TEvent extends EventObject> {
  adjacency: AdjacencyMap<TSnapshot, TEvent>
  serializeState: TraversalConfig<TSnapshot, TEvent>['serializeState']
  stateMap: Map<SerializedSnapshot, SnapshotBox<TSnapshot>>
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

const boxFor = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  serialized: SerializedSnapshot,
  snapshot: TSnapshot,
): SnapshotBox<TSnapshot> => {
  const existing = context.stateMap.get(serialized)
  const box = existing === undefined ? { snapshot } : existing
  box.snapshot = snapshot
  context.stateMap.set(serialized, box)
  return box
}

const createPlan = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  pathMap: StatePlanMap<TSnapshot, TEvent>,
  serialized: SerializedSnapshot,
  state: TSnapshot,
): PathPlan<TSnapshot, TEvent> => {
  const plan: PathPlan<TSnapshot, TEvent> = { state, paths: [] }
  pathMap[serialized] = plan
  return plan
}

const planAt = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  pathMap: StatePlanMap<TSnapshot, TEvent>,
  serialized: SerializedSnapshot,
  state: TSnapshot,
): PathPlan<TSnapshot, TEvent> => {
  const existing = pathMap[serialized]
  return existing === undefined ? createPlan(pathMap, serialized, state) : existing
}

const recordPath = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  toSerialized: SerializedSnapshot,
  fromState: TSnapshot,
): void => {
  const plan = planAt(context.pathMap, toSerialized, fromState)
  plan.paths.push({
    state: fromState,
    weight: context.steps.length,
    steps: [...context.steps],
  })
}

function expandInto<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  box: SnapshotBox<TSnapshot>,
  toSerialized: SerializedSnapshot,
  serializedEvent: SerializedEvent,
  event: TEvent,
  nextSerialized: SerializedSnapshot,
  nextBox: SnapshotBox<TSnapshot>,
): void {
  context.visitCtx.edges.add(serializedEvent)
  context.steps.push({ state: box.snapshot, event })
  visit(context, nextSerialized, nextBox, toSerialized)
}

const descendInto = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  box: SnapshotBox<TSnapshot>,
  toSerialized: SerializedSnapshot,
  serializedEvent: SerializedEvent,
  transition: Transition<TSnapshot, TEvent>,
): void => {
  const nextSerialized = toSerializedSnapshot(
    context.serializeState(transition.state, transition.event, box.snapshot),
  )
  const nextBox = boxFor(context, nextSerialized, transition.state)
  if (!context.visitCtx.vertices.has(nextSerialized)) {
    expandInto(context, box, toSerialized, serializedEvent, transition.event, nextSerialized, nextBox)
  }
}

const descendTransition = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  box: SnapshotBox<TSnapshot>,
  toSerialized: SerializedSnapshot,
  transitions: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot]['transitions'],
  serializedEvent: SerializedEvent,
): void => {
  const transition = transitions[serializedEvent]
  if (transition === undefined) {
    return
  }
  descendInto(context, box, toSerialized, serializedEvent, transition)
}

const descendTransitions = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  box: SnapshotBox<TSnapshot>,
  toSerialized: SerializedSnapshot,
  adjacencyValue: AdjacencyMap<TSnapshot, TEvent>[SerializedSnapshot],
): void => {
  for (const serializedEvent of Object.keys(adjacencyValue.transitions).map(toSerializedEvent)) {
    descendTransition(context, box, toSerialized, adjacencyValue.transitions, serializedEvent)
  }
}

const descend = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  box: SnapshotBox<TSnapshot>,
  toSerialized: SerializedSnapshot,
): void => {
  const adjacencyValue = context.adjacency[fromSerialized]
  if (adjacencyValue === undefined) {
    return
  }
  descendTransitions(context, box, toSerialized, adjacencyValue)
}

function visit<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  box: SnapshotBox<TSnapshot>,
  toSerialized: SerializedSnapshot,
): void {
  context.visitCtx.vertices.add(fromSerialized)
  if (fromSerialized === toSerialized) {
    recordPath(context, toSerialized, box.snapshot)
  } else {
    descend(context, fromSerialized, box, toSerialized)
  }
  context.steps.pop()
  context.visitCtx.vertices.delete(fromSerialized)
}

const seed = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromState: TSnapshot,
): { serialized: SerializedSnapshot; box: SnapshotBox<TSnapshot> } => {
  const serialized = toSerializedSnapshot(context.serializeState(fromState, undefined))
  return { serialized, box: boxFor(context, serialized, fromState) }
}

const visitEachStart = <TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  context: SimpleContext<TSnapshot, TEvent>,
  fromSerialized: SerializedSnapshot,
  box: SnapshotBox<TSnapshot>,
): void => {
  for (const nextSerialized of Object.keys(context.adjacency).map(toSerializedSnapshot)) {
    visit(context, fromSerialized, box, nextSerialized)
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
  const { serialized: fromSerialized, box } = seed(context, fromState)
  visitEachStart(context, fromSerialized, box)
  const simplePaths = Object.values(context.pathMap).flatMap((plan) => plan.paths)
  return applyTarget(simplePaths, resolvedOptions.toState)
}

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
    | readonly [logic: TLogic, options?: OptionsOf<TLogic> | undefined]
    | readonly [options?: OptionsOf<TLogic> | undefined]
): PathsOf<TLogic> | ((logic: TLogic) => PathsOf<TLogic>) {
  const [first, second] = args
  return logicFirstOrLast(computeSimplePaths<TLogic>)(first, second)
}
