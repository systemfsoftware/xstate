import { Match, Schema } from 'effect'

const ChildName = Schema.Literals(['a', 'b', 'c'])
const MapperShape = Schema.Literals(['absent', 'states-only', 'map'])

const Atomic = Schema.TaggedStruct('Atomic', { mapper: MapperShape })
const Final = Schema.TaggedStruct('Final', { mapper: MapperShape })

const childrenOf = <S extends Schema.Top>(child: S) =>
  Schema.Array(Schema.Tuple([ChildName, child])).check(Schema.isMinLength(1), Schema.isMaxLength(3))

const branchesOver = <S extends Schema.Top>(child: S) => [
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
  tag: Schema.Literals(['x', 'y']),
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
  | { readonly _tag: 'Parallel'; readonly mapper: MapperShape; readonly children: ReadonlyArray<readonly [string, StateTree]> }

export const distinctChildrenOf = (
  children: ReadonlyArray<readonly [string, StateTree]>,
): ReadonlyArray<readonly [string, StateTree]> =>
  children.filter(([name], index) => children.findIndex(([other]) => other === name) === index)

export interface MappedState {
  readonly path: readonly string[]
  readonly result: string
}

export const mappedResultOf = (path: readonly string[], tag: string): string => `${path.join('/')}@${tag}`

export interface MappingResponse {
  readonly mapped: ReadonlyArray<MappedState>
  readonly leafFirst: boolean
}

const pathKeyOf = (path: readonly string[]): string => path.join('\u0000')

export const inCanonicalOrder = (mapped: ReadonlyArray<MappedState>): ReadonlyArray<MappedState> =>
  mapped.toSorted((left, right) => pathKeyOf(left.path).localeCompare(pathKeyOf(right.path)))

const isStrictAncestor = (ancestor: readonly string[], descendant: readonly string[]): boolean =>
  ancestor.length < descendant.length && ancestor.every((key, index) => descendant[index] === key)

export const listsEachStateBeforeItsAncestors = (mapped: ReadonlyArray<MappedState>): boolean =>
  mapped.every((earlier, index) => mapped.slice(index + 1).every((later) => !isStrictAncestor(earlier.path, later.path)))

interface ActiveNode {
  readonly path: readonly string[]
  readonly mapped: boolean
}

const activeChildrenOf = (tree: StateTree): ReadonlyArray<readonly [string, StateTree]> =>
  Match.value(tree).pipe(
    Match.tag('Compound', (compound) => {
      const children = distinctChildrenOf(compound.children)
      return children.slice(compound.initial % children.length).slice(0, 1)
    }),
    Match.tag('Parallel', (parallel) => distinctChildrenOf(parallel.children)),
    Match.orElse(() => []),
  )

const activeNodesOf = (
  tree: StateTree,
  path: readonly string[],
  parentReachable: boolean,
): ReadonlyArray<ActiveNode> => {
  const reachable = parentReachable && tree.mapper !== 'absent'
  return [
    { path, mapped: reachable && tree.mapper === 'map' },
    ...activeChildrenOf(tree).flatMap(([name, child]) => activeNodesOf(child, [...path, name], reachable)),
  ]
}

export const expectedMapping = (command: MapStateCommand): MappingResponse => ({
  mapped: inCanonicalOrder(
    activeNodesOf(command.machine, [], true)
      .filter((node) => node.mapped)
      .map(({ path }) => ({ path, result: mappedResultOf(path, command.tag) })),
  ),
  leafFirst: true,
})

export const MappingState = Schema.Struct({ mappedCalls: Schema.Finite })
export type MappingState = Schema.Schema.Type<typeof MappingState>

const stepMapping = (
  state: MappingState,
  command: MapStateCommand,
): readonly [MappingState, MappingResponse] => [{ mappedCalls: state.mappedCalls + 1 }, expectedMapping(command)]

export const stateMappingModel = {
  state: MappingState,
  initial: { mappedCalls: 0 },
  precondition: (): boolean => true,
  step: stepMapping,
}
