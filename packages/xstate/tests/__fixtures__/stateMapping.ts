import { createActor, mapState, setup, types } from '@systemfsoftware/xstate'
import { Context, Effect, Layer, Match, pipe } from 'effect'
import {
  activeChildrenOf,
  distinctChildrenOf,
  mappedResultOf,
  type MappedState,
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
      const [initial = ''] = activeChildrenOf(compound).map(([name]) => name)
      return { initial, states: statesOf(distinctChildrenOf(compound.children)) }
    }),
    Match.tag(
      'Parallel',
      (parallel): NodeConfig => ({ type: 'parallel', states: statesOf(distinctChildrenOf(parallel.children)) }),
    ),
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
  const map = (snapshot: TaggedSnapshot): string => mappedResultOf(path)(snapshot.context.tag)
  const children = Match.value(tree).pipe(
    Match.tag('Compound', 'Parallel', (branch) => distinctChildrenOf(branch.children)),
    Match.orElse(() => []),
  )
  const states = childMappersOf(children, path)
  return tree.mapper === 'map' ? { map, states } : { states }
}

export interface MappingLedger {
  emptyResults: number
  severalResults: number
  unrelatedResults: number
}

const isAncestorPath = (ancestor: readonly string[], descendant: readonly string[]): boolean =>
  ancestor.length < descendant.length && ancestor.every((key, index) => descendant[index] === key)

const mapsUnrelatedStates = (results: ReadonlyArray<MappedState>): boolean =>
  results.some((left, index) =>
    results.slice(index + 1).some((right) =>
      !isAncestorPath(left.path, right.path) && !isAncestorPath(right.path, left.path)
    )
  )

export interface MappingSubject {
  readonly layer: Layer.Layer<StateMapping>
  readonly observed: MappingLedger
}

type MappingResponse = ReadonlyArray<MappedState>

export class StateMapping extends Context.Service<StateMapping, (command: MapStateCommand) => MappingResponse>()(
  '@systemfsoftware/xstate/tests/map-state/StateMapping',
) {}

type Mapping = (command: MapStateCommand) => ReadonlyArray<MappedState>

const publishedMapping: Mapping = (command) => {
  const snapshot = createActor(machineFor(command.machine), { input: { tag: command.tag } }).getSnapshot()
  const mapper = mapperOf(command.machine, []) ?? {}
  const results = Match.value(command.call).pipe(
    Match.when('data-first', () => mapState(snapshot, mapper)),
    Match.when('data-last', () => pipe(snapshot, mapState(mapper))),
    Match.exhaustive,
  )
  return results.map(({ stateNode, result }) => ({ path: stateNode.path, result }))
}

const rootFirstMapping: Mapping = (command) => publishedMapping(command).toReversed()

const deepestFirstMapping: Mapping = (command) =>
  publishedMapping(command).toSorted((left, right) => right.path.length - left.path.length)

const subjectOf = (mapping: Mapping): MappingSubject => {
  const observed: MappingLedger = { emptyResults: 0, severalResults: 0, unrelatedResults: 0 }
  const run = (command: MapStateCommand): MappingResponse => {
    const results = mapping(command)
    observed.emptyResults += results.length === 0 ? 1 : 0
    observed.severalResults += results.length > 1 ? 1 : 0
    observed.unrelatedResults += mapsUnrelatedStates(results) ? 1 : 0
    return results
  }
  return { observed, layer: Layer.succeed(StateMapping, run) }
}

export const makeStateMappingSubject = (): MappingSubject => subjectOf(publishedMapping)

export const makeRootFirstSubject = (): MappingSubject => subjectOf(rootFirstMapping)

export const makeDeepestFirstSubject = (): MappingSubject => subjectOf(deepestFirstMapping)

export const runMapStateCommand = (
  command: MapStateCommand,
): Effect.Effect<MappingResponse, never, StateMapping> =>
  Effect.gen(function*() {
    const mapping = yield* StateMapping
    return mapping(command)
  })
