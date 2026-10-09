import { Match, Schema } from 'effect'

export const TRAVERSAL_LIMIT_MESSAGE = 'Traversal limit exceeded'
export const JOIN_MESSAGE = 'Paths cannot be joined'
export const INIT_EVENT_TYPE = '@xstate.init'

export const STATE_POOL: ReadonlyArray<StateName> = ['a', 'b', 'c', 'd']

const StateName = Schema.Literals(['a', 'b', 'c', 'd'])
export type StateName = Schema.Schema.Type<typeof StateName>
const EventName = Schema.Literals(['NEXT', 'BACK', 'JUMP'])
export type EventName = Schema.Schema.Type<typeof EventName>
const TargetChoice = Schema.Literals(['none', 'self', '0', '1', '2', '3'])
export type TargetChoice = Schema.Schema.Type<typeof TargetChoice>

const flatEdge = Schema.Struct({ state: StateName, event: EventName, target: TargetChoice })
export type FlatEdge = Schema.Schema.Type<typeof flatEdge>

export const FlatMachine = Schema.Struct({
  states: Schema.Array(StateName),
  edges: Schema.Array(flatEdge),
  counter: Schema.Boolean,
  inputSeeded: Schema.Boolean,
  cap: Schema.Literals([1, 2]),
})
export type FlatMachine = Schema.Schema.Type<typeof FlatMachine>

const TraverseQuery = Schema.Struct({
  operation: Schema.Literals(['adjacency', 'shortest', 'simple']),
  filter: Schema.Boolean,
  stop: Schema.Boolean,
  target: Schema.Boolean,
  limit: Schema.Literals(['unbounded', 'one']),
  fromSecond: Schema.Boolean,
  serialize: Schema.Literals(['default', 'value']),
  input: Schema.Literals(['zero', 'one']),
})
export type TraverseQuery = Schema.Schema.Type<typeof TraverseQuery>

const ReplayQuery = Schema.Struct({
  candidate: Schema.Literals(['none', 'last']),
  filter: Schema.Boolean,
  stop: Schema.Boolean,
  target: Schema.Boolean,
  limit: Schema.Literals(['unbounded', 'one']),
  fromSecond: Schema.Boolean,
  serialize: Schema.Literals(['default', 'value']),
  input: Schema.Literals(['zero', 'one']),
})
export type ReplayQuery = Schema.Schema.Type<typeof ReplayQuery>

const TreeEvent = Schema.Literals(['NEXT', 'BACK'])
export type TreeEvent = Schema.Schema.Type<typeof TreeEvent>
const TreeTarget = Schema.Literals(['none', 'self', 'sibling', 'child'])
export type TreeTarget = Schema.Schema.Type<typeof TreeTarget>
const treeTransition = Schema.Struct({ event: TreeEvent, target: TreeTarget })
export type TreeTransitionSpec = Schema.Schema.Type<typeof treeTransition>
const treeLeaf = Schema.TaggedStruct('Leaf', { key: StateName, transitions: Schema.Array(treeTransition) })
const treeBranch = Schema.TaggedStruct('Branch', {
  key: StateName,
  initial: Schema.Literals([0, 1]),
  children: Schema.Array(treeLeaf).check(Schema.isMinLength(1)),
  transitions: Schema.Array(treeTransition),
})
const treeChild = Schema.Union([treeLeaf, treeBranch])
export type TreeChild = Schema.Schema.Type<typeof treeChild>
export const TreeSpec = Schema.Struct({
  children: Schema.Array(treeChild),
  transitions: Schema.Array(treeTransition),
})
export type TreeSpec = Schema.Schema.Type<typeof TreeSpec>

export const GraphCommand = Schema.Union([
  Schema.TaggedStruct('Traverse', { machine: FlatMachine, query: TraverseQuery }),
  Schema.TaggedStruct('Replay', { machine: FlatMachine, sequence: Schema.Array(EventName), query: ReplayQuery }),
  Schema.TaggedStruct('Structure', { tree: TreeSpec }),
])
export type GraphCommand = Schema.Schema.Type<typeof GraphCommand>

export interface Sim {
  readonly value: StateName
  readonly count: number | undefined
}

export interface EventObjectView {
  readonly type: string
  readonly amount?: number
}

export interface PlanStepView {
  readonly event: string
  readonly state: string
}

export interface PathView {
  readonly weight: number
  readonly steps: ReadonlyArray<PlanStepView>
}

export interface AdjacencyEntryView {
  readonly state: string
  readonly event: string
  readonly nextState: string
}

export type GraphResponse =
  | { readonly _tag: 'adjacency'; readonly entries: ReadonlyArray<AdjacencyEntryView> }
  | { readonly _tag: 'paths'; readonly paths: ReadonlyArray<PathView> }
  | {
    readonly _tag: 'graph'
    readonly graph: object
    readonly edgeIds: ReadonlyArray<string>
    readonly descendantIds: ReadonlyArray<string>
  }
  | { readonly _tag: 'failed'; readonly message: string }

export const machineStates = (states: ReadonlyArray<StateName>): ReadonlyArray<StateName> => {
  const unique = states.filter((name, index) => states.indexOf(name) === index)
  const fillers = STATE_POOL.filter((name) => !unique.includes(name))
  const size = Math.min(Math.max(unique.length, 2), STATE_POOL.length)
  return [...unique, ...fillers].slice(0, size)
}

const resolveTargetOf = (edge: FlatEdge, states: ReadonlyArray<StateName>): StateName | undefined =>
  Match.value(edge.target).pipe(
    Match.when('none', () => undefined),
    Match.when('self', () => edge.state),
    Match.orElse(() => states[Number(edge.target)]),
  )

const edgesOf = (machine: FlatMachine, states: ReadonlyArray<StateName>): ReadonlyArray<FlatEdge> =>
  machine.edges
    .filter((edge, index) =>
      machine.edges.findIndex((other) => other.state === edge.state && other.event === edge.event) === index
    )
    .filter((edge) => edge.target !== 'none')
    .filter((edge) => states.includes(edge.state))
    .filter((edge) => resolveTargetOf(edge, states) !== undefined)

const declaredEventTypes = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  state: StateName,
): ReadonlyArray<string> => edgesOf(machine, states).filter((edge) => edge.state === state).map((edge) => edge.event)

const stateEventTypes = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  state: StateName,
): ReadonlyArray<string> => [...declaredEventTypes(machine, states, state), ...(machine.counter ? ['INC'] : [])]

export const lastState = (states: ReadonlyArray<StateName>): StateName => states[states.length - 1] ?? 'a'

const stopsAt = (states: ReadonlyArray<StateName>, sim: Sim): boolean => sim.value === lastState(states)

const withCount = (sim: Sim, count: number | undefined): Sim => ({ value: sim.value, count })

const incSim = (machine: FlatMachine, sim: Sim): Sim => {
  const count = sim.count ?? 0
  return count < machine.cap ? withCount(sim, count + 1) : sim
}

const findEdge = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  sim: Sim,
  event: string,
): FlatEdge | undefined =>
  edgesOf(machine, states).find((candidate) => candidate.state === sim.value && candidate.event === event)

const targetOfEdge = (edge: FlatEdge | undefined, states: ReadonlyArray<StateName>): StateName | undefined =>
  edge === undefined ? undefined : resolveTargetOf(edge, states)

const moveSim = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  sim: Sim,
  event: string,
): Sim => {
  const target = targetOfEdge(findEdge(machine, states, sim, event), states)
  return target === undefined ? sim : { value: target, count: sim.count }
}

const stepSim = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  sim: Sim,
  event: string,
): Sim =>
  Match.value(event).pipe(
    Match.when('INC', () =>
      Match.value(machine.counter).pipe(
        Match.when(true, () => incSim(machine, sim)),
        Match.orElse(() => moveSim(machine, states, sim, event)),
      )),
    Match.orElse(() => moveSim(machine, states, sim, event)),
  )

const contextObject = (sim: Sim): object | undefined => sim.count === undefined ? undefined : { count: sim.count }

export const serializeDefault = (sim: Sim): string => JSON.stringify({ value: sim.value, context: contextObject(sim) })
export const serializeValue = (sim: Sim): string => JSON.stringify(sim.value)
export const serializerOf = (mode: 'default' | 'value'): (sim: Sim) => string =>
  mode === 'value' ? serializeValue : serializeDefault

export const eventJsonOf = (event: object): string => JSON.stringify(event)

const defaultEvents = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  sim: Sim,
): ReadonlyArray<EventObjectView> => stateEventTypes(machine, states, sim.value).map((type) => ({ type }))

const effectiveEvents = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  sim: Sim,
): ReadonlyArray<EventObjectView> => defaultEvents(machine, states, sim)

export interface Traversal {
  readonly machine: FlatMachine
  readonly states: ReadonlyArray<StateName>
  readonly start: Sim
  readonly filter: boolean
  readonly stop: boolean
  readonly target: boolean
  readonly limit: number
  readonly serialize: (sim: Sim) => string
}

const inputStart = (input: 'zero' | 'one'): number => input === 'one' ? 1 : 0
const zeroOrUndefined = (counter: boolean): number | undefined => counter ? 0 : undefined
const initialCount = (machine: FlatMachine, start: number): number | undefined =>
  machine.inputSeeded ? start : zeroOrUndefined(machine.counter)

const startSim = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  query: { readonly input: 'zero' | 'one'; readonly fromSecond: boolean },
): Sim => {
  const base: Sim = { value: states[0] ?? 'a', count: initialCount(machine, inputStart(query.input)) }
  return query.fromSecond ? { value: states[1] ?? base.value, count: base.count } : base
}

const stopPresent = (query: { readonly stop: boolean; readonly target: boolean }): boolean => query.stop || query.target
const limitOf = (query: { readonly limit: 'unbounded' | 'one' }): number => query.limit === 'unbounded' ? Infinity : 1

const traversalFrom = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  query: {
    readonly input: 'zero' | 'one'
    readonly fromSecond: boolean
    readonly filter: boolean
    readonly stop: boolean
    readonly target: boolean
    readonly limit: 'unbounded' | 'one'
    readonly serialize: 'default' | 'value'
  },
): Traversal => ({
  machine,
  states,
  start: startSim(machine, states, query),
  filter: query.filter,
  stop: stopPresent(query),
  target: query.target,
  limit: limitOf(query),
  serialize: serializerOf(query.serialize),
})

const traversalOf = (machine: FlatMachine, query: TraverseQuery): Traversal =>
  traversalFrom(machine, machineStates(machine.states), query)

interface AdjTransition {
  readonly event: EventObjectView
  readonly nextSim: Sim
  readonly nextKey: string
}

interface AdjNode {
  readonly key: string
  readonly sim: Sim
  readonly transitions: ReadonlyArray<AdjTransition>
}

interface MutableAdjNode {
  readonly key: string
  readonly sim: Sim
  readonly transitions: Map<string, AdjTransition>
}

interface AdjWork {
  readonly queue: Array<Sim>
  readonly nodes: Array<MutableAdjNode>
  readonly seen: Set<string>
  taken: number
}

const checkLimit = (taken: number, limit: number): void =>
  Match.value(taken > limit).pipe(
    Match.when(true, () => {
      throw new Error(TRAVERSAL_LIMIT_MESSAGE)
    }),
    Match.orElse(() => undefined),
  )

const keepsEvent = (traversal: Traversal, event: EventObjectView): boolean => !traversal.filter || event.type !== 'BACK'

const pushTransition = (
  work: AdjWork,
  node: MutableAdjNode,
  sim: Sim,
  event: EventObjectView,
  traversal: Traversal,
): void => {
  const nextSim = stepSim(traversal.machine, traversal.states, sim, event.type)
  node.transitions.set(eventJsonOf(event), { event, nextSim, nextKey: traversal.serialize(nextSim) })
  work.queue.push(nextSim)
}

const expandTransitions = (work: AdjWork, node: MutableAdjNode, sim: Sim, traversal: Traversal): void => {
  effectiveEvents(traversal.machine, traversal.states, sim)
    .filter((event) => keepsEvent(traversal, event))
    .forEach((event) => pushTransition(work, node, sim, event, traversal))
}

const recordNode = (work: AdjWork, sim: Sim, key: string, traversal: Traversal): void => {
  const node: MutableAdjNode = { key, sim, transitions: new Map() }
  work.seen.add(key)
  work.nodes.push(node)
  Match.value(traversal.stop && stopsAt(traversal.states, sim)).pipe(
    Match.when(true, () => undefined),
    Match.orElse(() => expandTransitions(work, node, sim, traversal)),
  )
}

const expandEntry = (work: AdjWork, sim: Sim, traversal: Traversal): void => {
  const taken = work.taken
  work.taken = taken + 1
  checkLimit(taken, traversal.limit)
  const key = traversal.serialize(sim)
  Match.value(work.seen.has(key)).pipe(
    Match.when(true, () => undefined),
    Match.orElse(() => recordNode(work, sim, key, traversal)),
  )
}

export const adjacencyOf = (traversal: Traversal): ReadonlyArray<AdjNode> => {
  const work: AdjWork = { queue: [traversal.start], nodes: [], seen: new Set(), taken: 0 }
  for (const sim of work.queue) {
    expandEntry(work, sim, traversal)
  }
  return work.nodes.map((node) => ({ key: node.key, sim: node.sim, transitions: [...node.transitions.values()] }))
}

const adjacencyEntries = (traversal: Traversal): ReadonlyArray<AdjacencyEntryView> => {
  const nodes = adjacencyOf(traversal)
  return nodes.flatMap((node) =>
    node.transitions.map((transition) => ({
      state: node.key,
      event: eventJsonOf(transition.event),
      nextState: transition.nextKey,
    }))
  )
}

export interface PlanStep {
  readonly state: Sim
  readonly event: EventObjectView
}

export interface Plan {
  readonly state: Sim
  readonly steps: ReadonlyArray<PlanStep>
  readonly weight: number
}

interface ParentLink {
  readonly from: string
  readonly event: EventObjectView
}

interface ShortestWork {
  readonly byKey: Map<string, AdjNode>
  readonly order: Array<string>
  readonly seen: Set<string>
  readonly parent: Map<string, ParentLink>
}

interface AdjLookup {
  readonly byKey: Map<string, AdjNode>
}

const simOf = (work: AdjLookup, key: string, traversal: Traversal): Sim => work.byKey.get(key)?.sim ?? traversal.start

const recordDiscovery = (work: ShortestWork, from: string, transition: AdjTransition): void =>
  Match.value(work.seen.has(transition.nextKey)).pipe(
    Match.when(true, () => undefined),
    Match.orElse(() => {
      work.seen.add(transition.nextKey)
      work.order.push(transition.nextKey)
      work.parent.set(transition.nextKey, { from, event: transition.event })
    }),
  )

const discoverFrom = (work: ShortestWork, key: string, node: AdjNode | undefined): void => {
  const transitions = node === undefined ? [] : node.transitions
  transitions.forEach((transition) => recordDiscovery(work, key, transition))
}

const ancestorsOf = (
  work: ShortestWork,
  traversal: Traversal,
  key: string,
): ReadonlyArray<{ readonly state: Sim; readonly event: EventObjectView }> => {
  const link = work.parent.get(key)
  return link === undefined
    ? []
    : [...ancestorsOf(work, traversal, link.from), { state: simOf(work, link.from, traversal), event: link.event }]
}

const planOf = (work: ShortestWork, traversal: Traversal, key: string): Plan => {
  const steps = ancestorsOf(work, traversal, key)
  return { state: simOf(work, key, traversal), steps, weight: steps.length }
}

export const shortestPlans = (traversal: Traversal): ReadonlyArray<Plan> => {
  const nodes = adjacencyOf(traversal)
  const startKey = traversal.serialize(traversal.start)
  const work: ShortestWork = {
    byKey: new Map(nodes.map((node) => [node.key, node])),
    order: [startKey],
    seen: new Set([startKey]),
    parent: new Map(),
  }
  for (const key of work.order) {
    discoverFrom(work, key, work.byKey.get(key))
  }
  return work.order.map((key) => planOf(work, traversal, key))
}

interface SimpleWork {
  readonly byKey: Map<string, AdjNode>
  readonly vertices: Set<string>
  readonly stack: Array<{ readonly state: Sim; readonly event: EventObjectView }>
  readonly pathsByTarget: Map<string, Array<Plan>>
}

const visitSimpleTransition = (
  work: SimpleWork,
  traversal: Traversal,
  fromKey: string,
  toKey: string,
  transition: AdjTransition,
): void =>
  Match.value(work.vertices.has(transition.nextKey)).pipe(
    Match.when(true, () => undefined),
    Match.orElse(() => {
      work.stack.push({ state: simOf(work, fromKey, traversal), event: transition.event })
      simpleUtil(work, traversal, transition.nextKey, toKey)
    }),
  )

const recordSimple = (work: SimpleWork, traversal: Traversal, fromKey: string, toKey: string): void => {
  const found = work.pathsByTarget.get(toKey) ?? []
  work.pathsByTarget.set(toKey, [
    ...found,
    {
      state: simOf(work, fromKey, traversal),
      steps: [...work.stack],
      weight: work.stack.length,
    },
  ])
}

const descendSimple = (work: SimpleWork, traversal: Traversal, fromKey: string, toKey: string): void => {
  const node = work.byKey.get(fromKey)
  const transitions = node === undefined ? [] : node.transitions
  transitions.forEach((transition) => visitSimpleTransition(work, traversal, fromKey, toKey, transition))
}

const simpleUtil = (work: SimpleWork, traversal: Traversal, fromKey: string, toKey: string): void => {
  work.vertices.add(fromKey)
  Match.value(fromKey === toKey).pipe(
    Match.when(true, () => recordSimple(work, traversal, fromKey, toKey)),
    Match.orElse(() => descendSimple(work, traversal, fromKey, toKey)),
  )
  work.stack.pop()
  work.vertices.delete(fromKey)
}

export const simplePlans = (traversal: Traversal): ReadonlyArray<Plan> => {
  const nodes = adjacencyOf(traversal)
  const startKey = traversal.serialize(traversal.start)
  const work: SimpleWork = {
    byKey: new Map(nodes.map((node) => [node.key, node])),
    vertices: new Set(),
    stack: [],
    pathsByTarget: new Map(),
  }
  for (const target of work.byKey.keys()) {
    simpleUtil(work, traversal, startKey, target)
  }
  return [...work.pathsByTarget.values()].flatMap((plans) => plans)
}

const INIT_EVENT: EventObjectView = { type: INIT_EVENT_TYPE }

const eventAt = (
  steps: ReadonlyArray<{ readonly state: Sim; readonly event: EventObjectView }>,
  index: number,
): EventObjectView =>
  Match.value(index).pipe(
    Match.when(0, () => INIT_EVENT),
    Match.orElse(() => steps[index - 1]?.event ?? INIT_EVENT),
  )

export const alterSteps = (
  plan: Plan,
): ReadonlyArray<PlanStep> =>
  Match.value(plan.steps.length).pipe(
    Match.when(0, () => [{ state: plan.state, event: INIT_EVENT }]),
    Match.orElse(() => [
      ...plan.steps.map((step, index) => ({ state: step.state, event: eventAt(plan.steps, index) })),
      { state: plan.state, event: plan.steps[plan.steps.length - 1]?.event ?? INIT_EVENT },
    ]),
  )

const alteredPlan = (plan: Plan): { readonly weight: number; readonly steps: ReadonlyArray<PlanStep> } => ({
  weight: plan.weight,
  steps: alterSteps(plan),
})

const pathViewOf2 = <S>(
  path: { readonly weight: number; readonly steps: ReadonlyArray<{ readonly state: S; readonly event: object }> },
  serialize: (state: S) => string,
): PathView => ({
  weight: path.weight,
  steps: path.steps.map((step) => ({ event: eventJsonOf(step.event), state: serialize(step.state) })),
})

const filteredPlans = (plans: ReadonlyArray<Plan>, traversal: Traversal): ReadonlyArray<Plan> =>
  traversal.target ? plans.filter((plan) => stopsAt(traversal.states, plan.state)) : plans

export const CANDIDATES: ReadonlyArray<EventObjectView> = [{ type: 'NEXT' }, { type: 'BACK' }]

const replayTraversal = (machine: FlatMachine, query: ReplayQuery): Traversal => ({
  machine,
  states: machineStates(machine.states),
  start: startSim(machine, machineStates(machine.states), query),
  filter: query.filter,
  stop: stopPresent(query),
  target: query.target,
  limit: limitOf(query),
  serialize: serializerOf(query.serialize),
})

const rejectsEvent = (traversal: Traversal, event: EventObjectView): boolean =>
  traversal.filter && event.type === 'BACK'

const candidateFor = (traversal: Traversal): EventObjectView | undefined => {
  const passing = CANDIDATES.filter((candidate) => keepsEvent(traversal, candidate))
  return passing[passing.length - 1]
}

const resolveReplayEvent = (
  traversal: Traversal,
  event: EventObjectView,
  candidate: boolean,
): EventObjectView | undefined =>
  candidate ? candidateFor(traversal) : (rejectsEvent(traversal, event) ? undefined : event)

const replayEventSerial = (event: EventObjectView, candidate: boolean): string => candidate ? 'E' : eventJsonOf(event)

const replayStep = (traversal: Traversal, sim: Sim, type: string, candidate: boolean): Sim => {
  const event: EventObjectView = { type }
  const nextEvent = resolveReplayEvent(traversal, event, candidate)
  Match.value(nextEvent === undefined || (traversal.stop && stopsAt(traversal.states, sim))).pipe(
    Match.when(true, () => {
      throw new Error(
        `Invalid transition from ${traversal.serialize(sim)} with ${replayEventSerial(event, candidate)}`,
      )
    }),
    Match.orElse(() => undefined),
  )
  return stepSim(traversal.machine, traversal.states, sim, (nextEvent ?? event).type)
}

const replayLimit = (taken: number, limit: number): void =>
  Match.value(taken >= limit).pipe(
    Match.when(true, () => {
      throw new Error(TRAVERSAL_LIMIT_MESSAGE)
    }),
    Match.orElse(() => undefined),
  )

const finalAccepted = (traversal: Traversal, sim: Sim): boolean =>
  Match.value(traversal.target).pipe(
    Match.when(false, () => true),
    Match.orElse(() => stopsAt(traversal.states, sim)),
  )

const replaySteps = (
  traversal: Traversal,
  sequence: ReadonlyArray<string>,
  candidate: boolean,
): ReadonlyArray<Plan> => {
  const steps: Array<{ state: Sim; event: EventObjectView }> = []
  let sim = traversal.start
  for (const type of sequence) {
    replayLimit(steps.length, traversal.limit)
    steps.push({ state: sim, event: { type } })
    sim = replayStep(traversal, sim, type, candidate)
  }
  return finalAccepted(traversal, sim) ? [{ state: sim, steps, weight: steps.length }] : []
}

export interface TreeNodeModel {
  readonly key: string
  readonly kind: 'leaf' | 'branch'
  readonly initial: number
  readonly children: ReadonlyArray<TreeNodeModel>
  readonly transitions: ReadonlyArray<TreeTransitionSpec>
}

export interface TreeModel {
  readonly key: string
  readonly children: ReadonlyArray<TreeNodeModel>
  readonly transitions: ReadonlyArray<TreeTransitionSpec>
}

const uniqueBy = <T>(items: ReadonlyArray<T>, keyOf: (item: T) => string): ReadonlyArray<T> =>
  items.filter((item, index) => items.findIndex((other) => keyOf(other) === keyOf(item)) === index)

const uniqueTransitions = (transitions: ReadonlyArray<TreeTransitionSpec>): ReadonlyArray<TreeTransitionSpec> =>
  uniqueBy(transitions, (transition) => transition.event)

const normalizeNode = (node: TreeChild): TreeNodeModel =>
  Match.value(node).pipe(
    Match.tag('Leaf', (leaf): TreeNodeModel => ({
      key: leaf.key,
      kind: 'leaf',
      initial: 0,
      children: [],
      transitions: uniqueTransitions(leaf.transitions),
    })),
    Match.tag('Branch', (branch): TreeNodeModel => ({
      key: branch.key,
      kind: 'branch',
      initial: branch.initial,
      children: uniqueBy(branch.children.map(normalizeNode), (child) => child.key),
      transitions: uniqueTransitions(branch.transitions),
    })),
    Match.exhaustive,
  )

export const treeModelOf = (spec: TreeSpec): TreeModel => ({
  key: 'm',
  children: uniqueBy(spec.children.map(normalizeNode), (child) => child.key),
  transitions: uniqueTransitions(spec.transitions),
})

const childId = (parentId: string, key: string): string => parentId === '' ? key : `${parentId}.${key}`

const siblingIdOf = (
  node: TreeNodeModel,
  siblings: ReadonlyArray<TreeNodeModel>,
  parentId: string,
  nodeId: string,
): string => {
  const index = siblings.indexOf(node)
  const next = siblings[(index + 1) % siblings.length]
  return next === undefined ? nodeId : childId(parentId, next.key)
}

const targetOf = (
  transition: TreeTransitionSpec,
  node: TreeNodeModel,
  siblings: ReadonlyArray<TreeNodeModel>,
  parentId: string,
  nodeId: string,
): string =>
  Match.value(transition.target).pipe(
    Match.when('sibling', () => siblingIdOf(node, siblings, parentId, nodeId)),
    Match.when('child', () => node.children[0] === undefined ? nodeId : childId(nodeId, node.children[0].key)),
    Match.orElse(() => nodeId),
  )

export interface TreeGraphEdge {
  readonly source: string
  readonly target: string
  readonly label: { readonly text: string }
}

interface NodeProjection {
  readonly json: object
  readonly edgeIds: ReadonlyArray<string>
}

const projectNode = (
  node: TreeNodeModel,
  nodeId: string,
  parentId: string,
  siblings: ReadonlyArray<TreeNodeModel>,
): NodeProjection => {
  const edges = node.transitions.map((transition, index) => ({
    id: `${nodeId}:${index}:0`,
    source: nodeId,
    target: targetOf(transition, node, siblings, parentId, nodeId),
    label: { text: transition.event },
  }))
  const children = node.children.map((child) => projectNode(child, childId(nodeId, child.key), nodeId, node.children))
  return {
    json: {
      id: nodeId,
      children: children.map((projection) => projection.json),
      edges: edges.map((edge): TreeGraphEdge => ({ source: edge.source, target: edge.target, label: edge.label })),
    },
    edgeIds: [...edges.map((edge) => edge.id), ...children.flatMap((projection) => projection.edgeIds)],
  }
}

const descendantIdsOf = (
  children: ReadonlyArray<TreeNodeModel>,
  parentId: string,
): ReadonlyArray<string> =>
  children.flatMap((child) => {
    const id = childId(parentId, child.key)
    return [id, ...descendantIdsOf(child.children, id)]
  })

const attempt = (compute: () => GraphResponse): GraphResponse => {
  try {
    return compute()
  } catch (error) {
    return { _tag: 'failed', message: error instanceof Error ? error.message : 'unrecognized failure' }
  }
}

const traversalResponse = (traversal: Traversal, query: TraverseQuery): GraphResponse =>
  Match.value(query.operation).pipe(
    Match.when('adjacency', (): GraphResponse => ({
      _tag: 'adjacency',
      entries: adjacencyEntries(traversal),
    })),
    Match.when('shortest', (): GraphResponse => ({
      _tag: 'paths',
      paths: filteredPlans(shortestPlans(traversal), traversal)
        .map((plan) => pathViewOf2(alteredPlan(plan), traversal.serialize)),
    })),
    Match.when('simple', (): GraphResponse => ({
      _tag: 'paths',
      paths: filteredPlans(simplePlans(traversal), traversal)
        .map((plan) => pathViewOf2(alteredPlan(plan), traversal.serialize)),
    })),
    Match.exhaustive,
  )

const replayResponse = (
  machine: FlatMachine,
  sequence: ReadonlyArray<string>,
  query: ReplayQuery,
): GraphResponse => {
  const traversal = replayTraversal(machine, query)
  return attempt((): GraphResponse => ({
    _tag: 'paths',
    paths: replaySteps(traversal, sequence, query.candidate === 'last')
      .map((plan) => pathViewOf2(alteredPlan(plan), traversal.serialize)),
  }))
}

const structureResponse = (spec: TreeSpec): GraphResponse => {
  const model = treeModelOf(spec)
  const root: TreeNodeModel = {
    key: model.key,
    kind: 'branch',
    initial: 0,
    children: model.children,
    transitions: model.transitions,
  }
  const projection = projectNode(root, model.key, '', [root])
  return {
    _tag: 'graph',
    graph: projection.json,
    edgeIds: projection.edgeIds,
    descendantIds: descendantIdsOf(model.children, model.key),
  }
}

const responseOf = (command: GraphCommand): GraphResponse =>
  Match.value(command).pipe(
    Match.tag('Traverse', (traverse): GraphResponse =>
      attempt(() =>
        traversalResponse(traversalOf(traverse.machine, traverse.query), traverse.query)
      )),
    Match.tag('Replay', (replay): GraphResponse => replayResponse(replay.machine, replay.sequence, replay.query)),
    Match.tag('Structure', (structure): GraphResponse => structureResponse(structure.tree)),
    Match.exhaustive,
  )

export const flatMachine = {
  states: machineStates,
  edges: edgesOf,
  targetOf: resolveTargetOf,
  lastState,
}

export const graphEvents = {
  candidates: CANDIDATES,
  serialize: serializerOf,
  json: eventJsonOf,
}

export const treeShape = {
  model: treeModelOf,
  childId,
  targetId: targetOf,
}

export const pathProjection = {
  view: pathViewOf2,
}

const GraphState = Schema.Struct({})
export type GraphState = Schema.Schema.Type<typeof GraphState>

export const graphModel = {
  state: GraphState,
  initial: {},
  precondition: (): boolean => true,
  step: (state: GraphState, command: GraphCommand): readonly [GraphState, GraphResponse] =>
    [state, responseOf(command)] as const,
}
