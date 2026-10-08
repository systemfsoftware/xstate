import { Match, Schema } from 'effect'

const StateName = Schema.Literals(['a', 'b', 'c', 'd.e'])

const regionsOf = <S extends Schema.Top>(region: S) =>
  Schema.Array(Schema.Tuple([StateName, region])).check(Schema.isMinLength(1), Schema.isMaxLength(3))

const LeafTree = StateName
const Depth1Tree = Schema.Union([LeafTree, regionsOf(LeafTree)])
const Depth2Tree = Schema.Union([LeafTree, regionsOf(Depth1Tree)])
const ParentTree = Schema.Union([LeafTree, regionsOf(Depth2Tree)])
const ChildTree = Schema.Union([ParentTree, Schema.Tuple([])])

export type StateTree = string | ReadonlyArray<readonly [string, StateTree]>

const Form = Schema.Literals(['value', 'id'])
const Call = Schema.Literals(['data-first', 'data-last', 'snapshot'])

export const MatchCommand = Schema.Union([
  Schema.TaggedStruct('Match', { parent: ParentTree, child: ChildTree, parentForm: Form, childForm: Form, call: Call }),
  Schema.TaggedStruct('MatchItself', { tree: ParentTree, parentForm: Form, childForm: Form, call: Call }),
])
export type MatchCommand = Schema.Schema.Type<typeof MatchCommand>

export const treesOf = (command: MatchCommand): readonly [parent: StateTree, child: StateTree] =>
  Match.valueTags(command, {
    Match: (pair): readonly [StateTree, StateTree] => [pair.parent, pair.child],
    MatchItself: (itself): readonly [StateTree, StateTree] => [itself.tree, itself.tree],
  })

export type ModelStateValue = string | { readonly [key: string]: ModelStateValue }

export const stateValueOf = (tree: StateTree): ModelStateValue =>
  typeof tree === 'string'
    ? tree
    : Object.fromEntries(tree.map(([key, region]) => [key, stateValueOf(region)]))

type StatePath = readonly string[]

const leafPathsOf = (value: ModelStateValue, prefix: StatePath): ReadonlyArray<StatePath> =>
  typeof value === 'string'
    ? [[...prefix, value]]
    : Object.entries(value).flatMap(([key, region]) => leafPathsOf(region, [...prefix, key]))

const isPrefixOf = (path: StatePath, longer: StatePath): boolean =>
  path.length <= longer.length && path.every((key, index) => longer[index] === key)

type Form = MatchCommand['parentForm']

const readsAsDottedPath = (tree: StateTree, form: Form): tree is string => typeof tree === 'string' && form === 'value'

const argumentPathsOf = (tree: StateTree, form: Form): ReadonlyArray<StatePath> =>
  readsAsDottedPath(tree, form) ? [tree.split('.')] : leafPathsOf(stateValueOf(tree), [])

const childFormOf = (command: MatchCommand): Form => command.call === 'snapshot' ? 'value' : command.childForm

const activeStatesInclude = (parent: ReadonlyArray<StatePath>, child: ReadonlyArray<StatePath>): boolean =>
  parent.every((wanted) => child.some((active) => isPrefixOf(wanted, active)))

export const MatchingState = Schema.Struct({ matched: Schema.Finite, unmatched: Schema.Finite })
export type MatchingState = Schema.Schema.Type<typeof MatchingState>

const initialMatchingState: MatchingState = { matched: 0, unmatched: 0 }

const stepMatching = (state: MatchingState, command: MatchCommand): readonly [MatchingState, boolean] => {
  const [parent, child] = treesOf(command)
  const included = activeStatesInclude(
    argumentPathsOf(parent, command.parentForm),
    argumentPathsOf(child, childFormOf(command)),
  )
  return [
    included
      ? { matched: state.matched + 1, unmatched: state.unmatched }
      : { matched: state.matched, unmatched: state.unmatched + 1 },
    included,
  ]
}

export const stateMatchingModel = {
  state: MatchingState,
  initial: initialMatchingState,
  precondition: (): boolean => true,
  step: stepMatching,
}
