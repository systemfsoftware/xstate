import { createActor, mapState, setup, types } from '@systemfsoftware/xstate'
import { Context, Effect, Layer, Match } from 'effect'
import {
  distinctChildrenOf,
  inCanonicalOrder,
  listsEachStateBeforeItsAncestors,
  type MappedState,
  mappedResultOf,
  type MappingResponse,
  type MapStateCommand,
  type StateTree,
} from './stateMapping.model.js'

interface NodeConfig {
  readonly type?: 'final' | 'parallel'
  readonly initial?: string
  readonly states?: Readonly<Record<string, NodeConfig>>
}

const statesOf = (children: ReadonlyArray<readonly [string, StateTree]>): Record<string, NodeConfig> =>
  Object.fromEntries(children.map(([name, child]) => [name, nodeConfigOf(child)]))

const nodeConfigOf = (tree: StateTree): NodeConfig =>
  Match.value(tree).pipe(
    Match.tag('Atomic', (): NodeConfig => ({})),
    Match.tag('Final', (): NodeConfig => ({ type: 'final' })),
    Match.tag('Compound', (compound): NodeConfig => {
      const children = distinctChildrenOf(compound.children)
      const [initial = ''] = children[compound.initial % children.length] ?? []
      return { initial, states: statesOf(children) }
    }),
    Match.tag('Parallel', (parallel): NodeConfig => ({ type: 'parallel', states: statesOf(distinctChildrenOf(parallel.children)) })),
    Match.exhaustive,
  )

const machineFor = (tree: StateTree) =>
  setup({ schemas: { context: types<{ tag: string }>(), input: types<{ tag: string }>() } }).createMachine({
    context: ({ input }) => ({ tag: input.tag }),
    ...nodeConfigOf(tree),
  })

interface TaggedSnapshot {
  readonly context: { readonly tag: string }
}

interface Mapper {
  map?: (snapshot: TaggedSnapshot) => string
  states?: Record<string, Mapper>
}

const childMappersOf = (
  children: ReadonlyArray<readonly [string, StateTree]>,
  path: readonly string[],
): Record<string, Mapper> =>
  Object.fromEntries(
    children.flatMap(([name, child]) => {
      const mapper = mapperOf(child, [...path, name])
      return mapper === undefined ? [] : [[name, mapper]]
    }),
  )

const mapperOf = (tree: StateTree, path: readonly string[]): Mapper | undefined => {
  if (tree.mapper === 'absent') {
    return undefined
  }
  const map = (snapshot: TaggedSnapshot): string => mappedResultOf(path, snapshot.context.tag)
  const children = Match.value(tree).pipe(
    Match.tag('Compound', 'Parallel', (branch) => distinctChildrenOf(branch.children)),
    Match.orElse(() => []),
  )
  const states = childMappersOf(children, path)
  return tree.mapper === 'map' ? { map, states } : { states }
}

export interface MappingLedger {
  mappedResults: number
  emptyResults: number
  calls: number
}

export interface MappingSubject {
  readonly layer: Layer.Layer<StateMapping>
  readonly observed: MappingLedger
}

export class StateMapping extends Context.Service<StateMapping, (command: MapStateCommand) => MappingResponse>()(
  '@systemfsoftware/xstate/tests/map-state/StateMapping',
) {}

type Mapping = (command: MapStateCommand) => ReadonlyArray<MappedState>

const publishedMapping: Mapping = (command) => {
  const snapshot = createActor(machineFor(command.machine), { input: { tag: command.tag } }).getSnapshot()
  return mapState(snapshot, mapperOf(command.machine, []) ?? {}).map(({ stateNode, result }) => ({
    path: stateNode.path,
    result,
  }))
}

const rootFirstMapping: Mapping = (command) => publishedMapping(command).toReversed()

const subjectOf = (mapping: Mapping): MappingSubject => {
  const observed: MappingLedger = { mappedResults: 0, emptyResults: 0, calls: 0 }
  const run = (command: MapStateCommand): MappingResponse => {
    const results = mapping(command)
    observed.calls += 1
    observed.mappedResults += results.length
    observed.emptyResults += results.length === 0 ? 1 : 0
    return { mapped: inCanonicalOrder(results), leafFirst: listsEachStateBeforeItsAncestors(results) }
  }
  return { observed, layer: Layer.succeed(StateMapping, run) }
}

export const makeStateMappingSubject = (): MappingSubject => subjectOf(publishedMapping)

export const makeRootFirstSubject = (): MappingSubject => subjectOf(rootFirstMapping)

export const runMapStateCommand = (
  command: MapStateCommand,
): Effect.Effect<MappingResponse, never, StateMapping> =>
  Effect.gen(function*() {
    const mapping = yield* StateMapping
    return mapping(command)
  })
