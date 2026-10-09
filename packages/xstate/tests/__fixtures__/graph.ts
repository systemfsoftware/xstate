import { type AnyStateMachine, createMachine, type StateValue } from '@systemfsoftware/xstate'
import {
  adjacencyMapToArray,
  type DirectedGraphNode,
  getAdjacencyMap,
  getDescendantStateNodes,
  getPathsFromEvents,
  getShortestPaths,
  getSimplePaths,
  toDirectedGraph,
} from '@systemfsoftware/xstate/graph'
import { Context, Effect, Layer, Match } from 'effect'
import {
  type FlatMachine,
  flatMachine,
  type GraphCommand,
  graphEvents,
  type GraphResponse,
  type ParallelEdge,
  type ParallelRegion,
  type ParallelSpec,
  type ParallelState,
  pathProjection,
  type PathView,
  sortSeqs,
  type StateName,
  type TreeNodeModel,
  treeShape,
  type TreeTransitionSpec,
} from './graph.model.js'

interface StartSignals {
  readonly start: number
}

const startSignals = (query: { readonly input: 'zero' | 'one' }): StartSignals => ({
  start: query.input === 'one' ? 1 : 0,
})

const initialContext = (machine: FlatMachine, query: { readonly input: 'zero' | 'one' }): { readonly count?: number } =>
  machine.counter || machine.inputSeeded ? { count: machine.inputSeeded ? startSignals(query).start : 0 } : {}

const plainOnOf = (
  machine: FlatMachine,
  states: ReadonlyArray<StateName>,
  state: StateName,
): Record<string, { readonly target: string | undefined }> =>
  Object.fromEntries(
    flatMachine.edges(machine, states)
      .filter((edge) => edge.state === state)
      .map((edge) => [edge.event, { target: flatMachine.targetOf(edge, states) }]),
  )

const countedOnOf = (machine: FlatMachine, states: ReadonlyArray<StateName>, state: StateName) => ({
  ...plainOnOf(machine, states, state),
  INC: ({ context }: { readonly context: { readonly count?: number } }) =>
    (context.count ?? 0) < machine.cap ? { context: { count: (context.count ?? 0) + 1 } } : undefined,
})

const machineOf = (machine: FlatMachine) => {
  const states = flatMachine.states(machine.states)
  return createMachine({
    initial: states[0] ?? 'a',
    context: ({ input }: { readonly input: { readonly start: number } }) =>
      machine.inputSeeded ? { count: input.start } : (machine.counter ? { count: 0 } : {}),
    states: Object.fromEntries(
      states.map((state) => [
        state,
        { on: machine.counter ? countedOnOf(machine, states, state) : plainOnOf(machine, states, state) },
      ]),
    ),
  })
}

interface Snapshotish {
  readonly value: StateValue
  readonly context: object
}

const projectState = (mode: 'default' | 'value') => (snapshot: Snapshotish): string =>
  mode === 'value'
    ? JSON.stringify(snapshot.value)
    : JSON.stringify({
      value: snapshot.value,
      context: Object.keys(snapshot.context).length > 0 ? snapshot.context : undefined,
    })

const valueStateString = (snapshot: Snapshotish): string => JSON.stringify(snapshot.value)

const stopPredicate = (states: ReadonlyArray<StateName>) => (snapshot: Snapshotish): boolean =>
  snapshot.value === flatMachine.lastState(states)

const backFilter = (snapshot: Snapshotish, event: { readonly type: string }): boolean => event.type !== 'BACK'

const attempt = (compute: () => GraphResponse): GraphResponse => {
  try {
    return compute()
  } catch (error) {
    return { _tag: 'failed', message: error instanceof Error ? error.message : 'unrecognized failure' }
  }
}

interface TraverseBehaviour {
  readonly ignoreFilter: boolean
  readonly reverseShortest: boolean
  readonly duplicateSimple: boolean
}

const traverseOptions = <M extends AnyStateMachine>(
  machine: M,
  flat: FlatMachine,
  states: ReadonlyArray<StateName>,
  query: Extract<GraphCommand, { readonly _tag: 'Traverse' }>['query'],
  ignoreFilter: boolean,
) => ({
  ...(query.events === 'array' ? { events: graphEvents.custom } : {}),
  ...(query.events === 'function' ? { events: () => graphEvents.custom } : {}),
  ...(query.filter && !ignoreFilter ? { filterEvents: backFilter } : {}),
  ...(query.stop || query.target ? { stopWhen: stopPredicate(states) } : {}),
  ...(query.target ? { toState: stopPredicate(states) } : {}),
  ...(query.limit === 'one' ? { limit: 1 } : {}),
  ...(query.fromSecond
    ? {
      fromState: machine.resolveState({
        value: states[1] ?? states[0] ?? 'a',
        context: initialContext(flat, query),
      }),
    }
    : {}),
  ...(query.serialize === 'value' ? { serializeState: valueStateString } : {}),
  ...(flat.counter || flat.inputSeeded ? { input: startSignals(query) } : {}),
})

const duplicateFirst = (paths: ReadonlyArray<PathView>): ReadonlyArray<PathView> => {
  const first = paths[0]
  return first === undefined ? paths : [...paths, first]
}

const runTraverse = (
  command: Extract<GraphCommand, { readonly _tag: 'Traverse' }>,
  behaviour: TraverseBehaviour,
): GraphResponse => {
  const machine = machineOf(command.machine)
  const states = flatMachine.states(command.machine.states)
  const query = command.query
  const serialize = projectState(query.serialize)
  const ignoreFilter = behaviour.ignoreFilter && query.operation === 'adjacency'
  const options = traverseOptions(machine, command.machine, states, query, ignoreFilter)
  return Match.value(query.operation).pipe(
    Match.when('adjacency', (): GraphResponse =>
      attempt((): GraphResponse => ({
        _tag: 'adjacency',
        entries: adjacencyMapToArray(getAdjacencyMap(machine, options)).map((entry) => ({
          state: serialize(entry.state),
          event: graphEvents.json(entry.event),
          nextState: serialize(entry.nextState),
        })),
      }))),
    Match.when('shortest', (): GraphResponse => {
      const paths = getShortestPaths(machine, options).map((path) => pathProjection.view(path, serialize))
      return { _tag: 'paths', paths: behaviour.reverseShortest ? paths.toReversed() : paths }
    }),
    Match.when('simple', (): GraphResponse => {
      const paths = getSimplePaths(machine, options).map((path) => pathProjection.view(path, serialize))
      return { _tag: 'paths', paths: behaviour.duplicateSimple ? duplicateFirst(paths) : paths }
    }),
    Match.exhaustive,
  )
}

interface ReplayBehaviour {
  readonly firstCandidate: boolean
}

const runReplay = (
  command: Extract<GraphCommand, { readonly _tag: 'Replay' }>,
  behaviour: ReplayBehaviour,
): GraphResponse => {
  const machine = machineOf(command.machine)
  const states = flatMachine.states(command.machine.states)
  const query = command.query
  const candidates = behaviour.firstCandidate ? graphEvents.candidates.toReversed() : graphEvents.candidates
  const options = {
    ...(query.candidate === 'last' ? { events: candidates, serializeEvent: () => 'E' } : {}),
    ...(query.filter ? { filterEvents: backFilter } : {}),
    ...(query.stop || query.target ? { stopWhen: stopPredicate(states) } : {}),
    ...(query.target ? { toState: stopPredicate(states) } : {}),
    ...(query.limit === 'one' ? { limit: 1 } : {}),
    ...(query.fromSecond
      ? {
        fromState: machine.resolveState({
          value: states[1] ?? states[0] ?? 'a',
          context: initialContext(command.machine, query),
        }),
      }
      : {}),
    ...(query.serialize === 'value' ? { serializeState: valueStateString } : {}),
    ...(command.machine.counter || command.machine.inputSeeded ? { input: startSignals(query) } : {}),
  }
  const events = command.sequence.map((type) => ({ type }))
  const serialize = projectState(query.serialize)
  return attempt((): GraphResponse => ({
    _tag: 'paths',
    paths: getPathsFromEvents(machine, events, options).map((path) => pathProjection.view(path, serialize)),
  }))
}

const targetSpec = (
  transition: TreeTransitionSpec,
  node: TreeNodeModel,
  siblings: ReadonlyArray<TreeNodeModel>,
  parentId: string,
  nodeId: string,
): { readonly target?: string } =>
  transition.target === 'none' ? {} : { target: `#${treeShape.targetId(transition, node, siblings, parentId, nodeId)}` }

interface TreeConfig {
  readonly initial?: string
  readonly states?: Record<string, TreeConfig>
  readonly on?: Record<string, { readonly target?: string }>
}

const pickInitial = (node: TreeNodeModel): string => {
  const index = node.initial % Math.max(node.children.length, 1)
  return node.children[index]?.key ?? ''
}

const treeConfig = (
  node: TreeNodeModel,
  nodeId: string,
  parentId: string,
  siblings: ReadonlyArray<TreeNodeModel>,
): TreeConfig => ({
  ...(node.kind === 'branch' ? { initial: pickInitial(node) } : {}),
  ...(node.kind === 'branch'
    ? {
      states: Object.fromEntries(
        node.children.map((child) => [
          child.key,
          treeConfig(child, treeShape.childId(nodeId, child.key), nodeId, node.children),
        ]),
      ),
    }
    : {}),
  ...(node.transitions.length === 0 ? {} : {
    on: Object.fromEntries(
      node.transitions.map((transition) => [
        transition.event,
        targetSpec(transition, node, siblings, parentId, nodeId),
      ]),
    ),
  }),
})

const collectEdgeIds = (
  node: DirectedGraphNode,
): ReadonlyArray<string> => [
  ...node.edges.map((edge) => edge.id),
  ...node.children.flatMap((child) => collectEdgeIds(child)),
]

const runStructure = (command: Extract<GraphCommand, { readonly _tag: 'Structure' }>): GraphResponse => {
  const model = treeShape.model(command.tree)
  const root: TreeNodeModel = {
    key: model.key,
    kind: 'branch',
    initial: 0,
    children: model.children,
    transitions: model.transitions,
  }
  const machine = createMachine({ id: 'm', ...treeConfig(root, model.key, '', [root]) })
  const digraph = toDirectedGraph(machine)
  const graph: object = JSON.parse(JSON.stringify(digraph))
  return {
    _tag: 'graph',
    graph,
    edgeIds: collectEdgeIds(digraph),
    descendantIds: getDescendantStateNodes(machine).map((node) => node.id),
  }
}

const uniqueRegionEdges = (region: ParallelRegion): ReadonlyArray<ParallelEdge> =>
  region.edges.filter((edge, index) =>
    region.edges.findIndex((other) => other.from === edge.from && other.event === edge.event) === index
  )

const regionOnOf = (
  region: ParallelRegion,
  regionName: string,
  state: ParallelState,
): Record<string, { readonly target: string }> =>
  Object.fromEntries(
    uniqueRegionEdges(region)
      .filter((edge) => edge.from === state)
      .map((edge) => [edge.event, { target: `#m.${regionName}.${edge.to}` }]),
  )

const parallelRegionConfig = (region: ParallelRegion, regionName: string) => ({
  initial: region.initial,
  states: Object.fromEntries(
    (['a', 'b'] as const).map((state) => [state, { on: regionOnOf(region, regionName, state) }]),
  ),
})

const parallelMachineOf = (spec: ParallelSpec) =>
  createMachine({
    id: 'm',
    type: 'parallel',
    states: {
      left: parallelRegionConfig(spec.left, 'left'),
      right: parallelRegionConfig(spec.right, 'right'),
    },
  })

const runParallel = (command: Extract<GraphCommand, { readonly _tag: 'Parallel' }>): GraphResponse => {
  const machine = parallelMachineOf(command.spec)
  const serialize = projectState('default')
  return attempt((): GraphResponse => ({
    _tag: 'parallel',
    adjacency: adjacencyMapToArray(getAdjacencyMap(machine, {})).map((entry) => ({
      state: serialize(entry.state),
      event: graphEvents.json(entry.event),
      nextState: serialize(entry.nextState),
    })).sort((a, b) => {
      const ka = `${a.state}|${a.event}|${a.nextState}`
      const kb = `${b.state}|${b.event}|${b.nextState}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    }),
    shortest: sortSeqs(
      getShortestPaths(machine).map((path) => pathProjection.view(path, serialize).steps.map((step) => step.state)),
    ),
    simple: sortSeqs(
      getSimplePaths(machine).map((path) => pathProjection.view(path, serialize).steps.map((step) => step.state)),
    ),
    descendantIds: getDescendantStateNodes(machine).map((node) => node.id),
  }))
}

export interface GraphLedger {
  readonly operations: Record<'adjacency' | 'shortest' | 'simple' | 'replay' | 'structure' | 'parallel', number>
  counters: number
  plain: number
  inputSeeded: number
  customEvents: number
  adjacencyArray: number
  parallel: number
  filtered: number
  stopped: number
  targeted: number
  limited: number
  fromSecond: number
  valueSerialize: number
  treeBranches: number
  readonly treeTargets: Record<'none' | 'self' | 'sibling' | 'child', number>
}

const noteTree = (ledger: GraphLedger, node: TreeNodeModel): void => {
  ledger.treeBranches += node.kind === 'branch' ? 1 : 0
  node.transitions.forEach((transition) => {
    ledger.treeTargets[transition.target] += 1
  })
  node.children.forEach((child) => noteTree(ledger, child))
}

const noteTraverse = (ledger: GraphLedger, command: Extract<GraphCommand, { readonly _tag: 'Traverse' }>): void => {
  ledger.operations[command.query.operation] += 1
  ledger.counters += command.machine.counter ? 1 : 0
  ledger.plain += command.machine.counter ? 0 : 1
  ledger.inputSeeded += command.machine.inputSeeded ? 1 : 0
  ledger.customEvents += command.query.events === 'default' ? 0 : 1
  ledger.adjacencyArray += command.query.operation === 'adjacency' ? 1 : 0
  ledger.filtered += command.query.filter ? 1 : 0
  ledger.stopped += command.query.stop || command.query.target ? 1 : 0
  ledger.targeted += command.query.target ? 1 : 0
  ledger.limited += command.query.limit === 'one' ? 1 : 0
  ledger.fromSecond += command.query.fromSecond ? 1 : 0
  ledger.valueSerialize += command.query.serialize === 'value' ? 1 : 0
}

const noteReplay = (ledger: GraphLedger, command: Extract<GraphCommand, { readonly _tag: 'Replay' }>): void => {
  ledger.operations.replay += 1
  ledger.counters += command.machine.counter ? 1 : 0
  ledger.plain += command.machine.counter ? 0 : 1
  ledger.inputSeeded += command.machine.inputSeeded ? 1 : 0
  ledger.filtered += command.query.filter ? 1 : 0
  ledger.stopped += command.query.stop || command.query.target ? 1 : 0
  ledger.limited += command.query.limit === 'one' ? 1 : 0
  ledger.fromSecond += command.query.fromSecond ? 1 : 0
  ledger.valueSerialize += command.query.serialize === 'value' ? 1 : 0
}

const noteStructure = (ledger: GraphLedger, command: Extract<GraphCommand, { readonly _tag: 'Structure' }>): void => {
  ledger.operations.structure += 1
  const model = treeShape.model(command.tree)
  model.transitions.forEach((transition) => {
    ledger.treeTargets[transition.target] += 1
  })
  model.children.forEach((child) => noteTree(ledger, child))
}

const noteParallel = (ledger: GraphLedger, _command: Extract<GraphCommand, { readonly _tag: 'Parallel' }>): void => {
  ledger.operations.parallel += 1
  ledger.parallel += 1
}

const emptyLedger = (): GraphLedger => ({
  operations: { adjacency: 0, shortest: 0, simple: 0, replay: 0, structure: 0, parallel: 0 },
  counters: 0,
  plain: 0,
  inputSeeded: 0,
  customEvents: 0,
  adjacencyArray: 0,
  parallel: 0,
  filtered: 0,
  stopped: 0,
  targeted: 0,
  limited: 0,
  fromSecond: 0,
  valueSerialize: 0,
  treeBranches: 0,
  treeTargets: { none: 0, self: 0, sibling: 0, child: 0 },
})

export class GraphSubject extends Context.Service<GraphSubject, (command: GraphCommand) => GraphResponse>()(
  '@systemfsoftware/xstate/tests/graph/GraphSubject',
) {}

export interface GraphHandle {
  readonly layer: Layer.Layer<GraphSubject>
  readonly observed: GraphLedger
}

interface Behaviour {
  readonly traverse: TraverseBehaviour
  readonly replay: ReplayBehaviour
}

const publishedBehaviour: Behaviour = {
  traverse: { ignoreFilter: false, reverseShortest: false, duplicateSimple: false },
  replay: { firstCandidate: false },
}

const respond = (command: GraphCommand, behaviour: Behaviour): GraphResponse =>
  Match.value(command).pipe(
    Match.tag('Traverse', (traverse): GraphResponse => runTraverse(traverse, behaviour.traverse)),
    Match.tag('Replay', (replay): GraphResponse => runReplay(replay, behaviour.replay)),
    Match.tag('Structure', (structure): GraphResponse => runStructure(structure)),
    Match.tag('Parallel', (parallel): GraphResponse => runParallel(parallel)),
    Match.exhaustive,
  )

const subjectOf = (behaviour: Behaviour): GraphHandle => {
  const observed = emptyLedger()
  const run = (command: GraphCommand): GraphResponse => {
    Match.value(command).pipe(
      Match.tag('Traverse', (traverse) => noteTraverse(observed, traverse)),
      Match.tag('Replay', (replay) => noteReplay(observed, replay)),
      Match.tag('Structure', (structure) => noteStructure(observed, structure)),
      Match.tag('Parallel', (parallel) => noteParallel(observed, parallel)),
      Match.exhaustive,
    )
    return attempt(() => respond(command, behaviour))
  }
  return { observed, layer: Layer.succeed(GraphSubject, run) }
}

export const makeGraphSubject = (): GraphHandle => subjectOf(publishedBehaviour)

export const makeAdjacencyIgnoreFilterSubject = (): GraphHandle =>
  subjectOf({ ...publishedBehaviour, traverse: { ...publishedBehaviour.traverse, ignoreFilter: true } })

export const makeShortestLastSubject = (): GraphHandle =>
  subjectOf({ ...publishedBehaviour, traverse: { ...publishedBehaviour.traverse, reverseShortest: true } })

export const makeSimpleRevisitSubject = (): GraphHandle =>
  subjectOf({ ...publishedBehaviour, traverse: { ...publishedBehaviour.traverse, duplicateSimple: true } })

export const makeReplayFirstCandidateSubject = (): GraphHandle =>
  subjectOf({ ...publishedBehaviour, replay: { firstCandidate: true } })

export const runGraphCommand = (command: GraphCommand): Effect.Effect<GraphResponse, never, GraphSubject> =>
  Effect.gen(function*() {
    const run = yield* GraphSubject
    return run(command)
  })
