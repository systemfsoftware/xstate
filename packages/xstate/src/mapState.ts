import { dual } from 'effect/Function'
import type { MachineSnapshot } from './State.js'
import type { AnyMachineSnapshot, AnyStateNode, StateSchema } from './types.js'

type StateSchemaFromSnapshot<TSnapshot extends AnyMachineSnapshot> = TSnapshot extends MachineSnapshot<
  infer _TContext,
  infer _TEvent,
  infer _TChildren,
  infer _TStateValue,
  infer _TTag,
  infer _TOutput,
  infer _TMeta,
  infer TStateSchema extends StateSchema
> ? TStateSchema
  : StateSchema

/**
 * A mapper object that defines how to transform a snapshot based on its state.
 * Can be nested to match the state hierarchy of the machine.
 */
type StateSchemaMapper<
  TSnapshot extends AnyMachineSnapshot,
  T extends StateSchema,
  TResult,
> = {
  /** Maps the snapshot to a value when this state is active. */
  map?: (snapshot: TSnapshot) => TResult
  /** Nested mappers for child states. */
  states?: {
    [K in keyof T['states']]?: T['states'][K] extends StateSchema
      ? StateSchemaMapper<TSnapshot, T['states'][K], TResult>
      : never
  }
}

interface NodeMapper<TSnapshot, TResult> {
  readonly map?: ((snapshot: TSnapshot) => TResult) | undefined
  readonly states?: Readonly<Record<string, NodeMapper<TSnapshot, TResult> | undefined>> | undefined
}

interface MappedStateNode<TResult> {
  stateNode: AnyStateNode
  result: TResult
}

const ownResultOf = <TSnapshot extends AnyMachineSnapshot, TResult>(
  snapshot: TSnapshot,
  stateNode: AnyStateNode,
  mapper: NodeMapper<TSnapshot, TResult>,
): MappedStateNode<TResult>[] => mapper.map === undefined ? [] : [{ stateNode, result: mapper.map(snapshot) }]

const mappedStatesOf = <TSnapshot extends AnyMachineSnapshot, TResult>(
  snapshot: TSnapshot,
  active: ReadonlySet<AnyStateNode>,
  stateNode: AnyStateNode,
  mapper: NodeMapper<TSnapshot, TResult> | undefined,
): MappedStateNode<TResult>[] =>
  mapper === undefined
    ? []
    : [
      ...Object.values<AnyStateNode>(stateNode.states)
        .filter((child) => active.has(child))
        .flatMap((child) => mappedStatesOf(snapshot, active, child, mapper.states?.[child.key])),
      ...ownResultOf(snapshot, stateNode, mapper),
    ]

const mapActiveStates = <TSnapshot extends AnyMachineSnapshot, TResult>(
  snapshot: TSnapshot,
  mapper: NodeMapper<TSnapshot, TResult>,
): MappedStateNode<TResult>[] => mappedStatesOf(snapshot, new Set(snapshot.nodes), snapshot.machine.root, mapper)

/**
 * Maps a machine snapshot to an array of result objects based on active states.
 *
 * Collects results from the `map` functions in the mapper object for every
 * active state node. Each state comes before its ancestors (most specific
 * state first); otherwise results follow the order the states are declared in
 * the machine. Called with the mapper alone, it returns a function that takes
 * the snapshot.
 *
 * @public
 */
export const mapState: {
  <T extends AnyMachineSnapshot, TResult>(
    mapper: StateSchemaMapper<T, StateSchemaFromSnapshot<T>, TResult>,
  ): (snapshot: T) => { stateNode: AnyStateNode; result: TResult }[]
  <T extends AnyMachineSnapshot, TResult>(
    snapshot: T,
    mapper: StateSchemaMapper<T, StateSchemaFromSnapshot<T>, TResult>,
  ): { stateNode: AnyStateNode; result: TResult }[]
} = dual(2, mapActiveStates)
