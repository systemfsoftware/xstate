import { Match, Schema } from 'effect'

const ChildName = Schema.Literals(['a', 'b', 'c'])
const MapperShape = Schema.Literals(['absent', 'states-only', 'map'])

const Atomic = Schema.TaggedStruct('Atomic', { mapper: MapperShape })
const Final = Schema.TaggedStruct('Final', { mapper: MapperShape })

const childrenOf = <S extends Schema.Top>(child: S) =>
  Schema.Array(Schema.Tuple([ChildName, child])).check(Schema.isMinLength(1), Schema.isMaxLength(3))

const branchesOver = <S extends Schema.Top>(child: S) =>
  [
    Schema.TaggedStruct('Compound', {
      mapper: MapperShape,
      initial: Schema.Literals([0, 1, 2]),
      children: childrenOf(child),
    }),
    Schema.TaggedStruct('Parallel', { mapper: MapperShape, children: childrenOf(child) }),
  ] as const

const Depth1 = Schema.Union([Atomic, Final])
const Depth2 = Schema.Union([Atomic, Final, ...branchesOver(Depth1)])
const Depth3 = Schema.Union([Atomic, Final, ...branchesOver(Depth2)])
const Root = Schema.Union([Atomic, ...branchesOver(Depth3)])

export const MapStateCommand = Schema.TaggedStruct('MapState', {
  machine: Root,
  snapshot: Schema.Literals(['initial', 'after-next', 'context-threw']),
  tag: Schema.Literals(['x', 'y']),
  call: Schema.Literals(['data-first', 'data-last']),
})
export type MapStateCommand = Schema.Schema.Type<typeof MapStateCommand>

type MapperShape = Schema.Schema.Type<typeof MapperShape>

export type StateTree =
  | { readonly _tag: 'Atomic'; readonly mapper: MapperShape }
  | { readonly _tag: 'Final'; readonly mapper: MapperShape }
  | {
    readonly _tag: 'Compound'
    readonly mapper: MapperShape
    readonly initial: number
    readonly children: ReadonlyArray<readonly [string, StateTree]>
  }
  | {
    readonly _tag: 'Parallel'
    readonly mapper: MapperShape
    readonly children: ReadonlyArray<readonly [string, StateTree]>
  }

const distinctChildrenOf = (
  children: ReadonlyArray<readonly [string, StateTree]>,
): ReadonlyArray<readonly [string, StateTree]> =>
  children.filter(([name], index) => children.findIndex(([other]) => other === name) === index)

export interface MappedState {
  readonly path: readonly string[]
  readonly result: string
}

export const mappedResultOf = (path: readonly string[]) => (tag: string | undefined): string =>
  `${path.join('/')}@${String(tag)}`

interface ActiveNode {
  readonly path: readonly string[]
  readonly mapped: boolean
}

const activeChildrenOf = (tree: StateTree): ReadonlyArray<readonly [string, StateTree]> =>
  Match.value(tree).pipe(
    Match.tag('Compound', (compound) => {
      const children = distinctChildrenOf(compound.children)
      const initial = compound.initial % children.length
      return children.slice(initial, initial + 1)
    }),
    Match.tag('Parallel', (parallel) => distinctChildrenOf(parallel.children)),
    Match.orElse(() => []),
  )

const activeNodesDescendantsFirst = (
  tree: StateTree,
  path: readonly string[],
  parentReachable: boolean,
): ReadonlyArray<ActiveNode> => {
  const reachable = parentReachable && tree.mapper !== 'absent'
  return [
    ...activeChildrenOf(tree).flatMap(([name, child]) =>
      activeNodesDescendantsFirst(child, [...path, name], reachable)
    ),
    { path, mapped: reachable && tree.mapper === 'map' },
  ]
}

const advancedChildrenOf = (
  children: ReadonlyArray<readonly [string, StateTree]>,
): ReadonlyArray<readonly [string, StateTree]> =>
  distinctChildrenOf(children).map(([name, child]) => [name, afterNext(child)])

const nextChildOf = (compound: Extract<StateTree, { readonly _tag: 'Compound' }>): number => {
  const count = distinctChildrenOf(compound.children).length
  return (compound.initial % count + 1) % count
}

const isAtomic = Match.type<StateTree>().pipe(
  Match.tag('Atomic', () => true),
  Match.orElse(() => false),
)

const afterNext = (tree: StateTree): StateTree =>
  Match.value(tree).pipe(
    Match.tag('Compound', (compound): StateTree =>
      activeChildrenOf(compound).some(([, child]) => isAtomic(child))
        ? { ...compound, initial: nextChildOf(compound) }
        : { ...compound, children: advancedChildrenOf(compound.children) }),
    Match.tag('Parallel', (parallel): StateTree => ({ ...parallel, children: advancedChildrenOf(parallel.children) })),
    Match.orElse(() => tree),
  )

const activeNodesOf = (command: MapStateCommand): ReadonlyArray<ActiveNode> =>
  Match.value(command.snapshot).pipe(
    Match.when('initial', () => activeNodesDescendantsFirst(command.machine, [], true)),
    Match.when('after-next', () => activeNodesDescendantsFirst(afterNext(command.machine), [], true)),
    Match.when('context-threw', () =>
      Match.value(command.machine).pipe(
        Match.tag('Atomic', (root) => activeNodesDescendantsFirst(root, [], true)),
        Match.orElse((): ReadonlyArray<ActiveNode> => []),
      )),
    Match.exhaustive,
  )

const contextTagOf = (command: MapStateCommand): string | undefined =>
  Match.value(command.snapshot).pipe(
    Match.when('context-threw', () => undefined),
    Match.orElse(() => command.tag),
  )

export const expectedMapping = (command: MapStateCommand): ReadonlyArray<MappedState> =>
  activeNodesOf(command)
    .filter((node) => node.mapped)
    .map(({ path }) => ({ path, result: mappedResultOf(path)(contextTagOf(command)) }))

export const MappingState = Schema.Struct({})
export type MappingState = Schema.Schema.Type<typeof MappingState>

const stepMapping = (
  state: MappingState,
  command: MapStateCommand,
): readonly [MappingState, ReadonlyArray<MappedState>] => [state, expectedMapping(command)]

export const stateMappingModel = {
  state: MappingState,
  initial: {},
  precondition: (): boolean => true,
  step: stepMapping,
}
