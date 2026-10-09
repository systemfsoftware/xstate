import type {
  AnyActorLogic,
  AnyActorScope,
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
  EventFromLogic,
  EventObject,
  InputFrom,
  MachineContext,
  SnapshotFrom,
  StateNode,
  StateValue,
} from '../index.js'
import { getAllOwnEvents } from '../utils.js'
import { createMockActorScope } from './actorScope.js'
import type {
  AnySnapshot,
  AnyStateNode,
  DirectedGraphEdge,
  DirectedGraphNode,
  SerializationConfig,
  SerializedEvent,
  SerializedSnapshot,
  StatePath,
  Step,
  TraversalConfig,
  TraversalOptions,
} from './types.js'

export type OptionsOf<TLogic extends AnyActorLogic> = TraversalOptions<
  SnapshotFrom<TLogic>,
  EventFromLogic<TLogic>,
  InputFrom<TLogic>
>

export type PathsOf<TLogic extends AnyActorLogic> = Array<StatePath<SnapshotFrom<TLogic>, EventFromLogic<TLogic>>>

type FirstOrLast<TLogic extends AnyActorLogic, TResult> = (
  first: TLogic | OptionsOf<TLogic> | undefined,
  second: OptionsOf<TLogic> | undefined,
) => TResult | ((logic: TLogic) => TResult)

const isActorLogic = <TLogic extends AnyActorLogic>(
  value: TLogic | OptionsOf<TLogic> | undefined,
): value is TLogic => value !== undefined && 'transition' in value

export const logicFirstOrLast = <TLogic extends AnyActorLogic, TResult>(
  compute: (logic: TLogic, options: OptionsOf<TLogic> | undefined) => TResult,
): FirstOrLast<TLogic, TResult> =>
(first, second) => isActorLogic(first) ? compute(first, second) : (logic: TLogic) => compute(logic, first)

type SerializeState<TLogic extends AnyActorLogic> = SerializationConfig<
  SnapshotFrom<TLogic>,
  EventFromLogic<TLogic>
>['serializeState']

/**
 * Returns all state nodes of the given `node`.
 *
 * @public
 * @param stateNode State node to recursively get child state nodes from
 * @public
 */
export function getDescendantStateNodes(stateNode: {
  states: Record<string, AnyStateNode | StateNode<never, EventObject>>
}): AnyStateNode[] {
  const { states } = stateNode
  return Object.keys(states).reduce<AnyStateNode[]>((accNodes, stateKey) => {
    const childStateNode = states[stateKey]
    if (childStateNode === undefined) {
      return accNodes
    }

    accNodes.push(childStateNode, ...getDescendantStateNodes(childStateNode))
    return accNodes
  }, [])
}

function getChildren(stateNode: AnyStateNode): AnyStateNode[] {
  return Object.values(stateNode.states)
}

function isFilled(context: MachineContext | undefined): boolean {
  return context !== undefined && Object.keys(context).length > 0
}

function nonEmptyContext(
  context: MachineContext | undefined,
): MachineContext | undefined {
  return isFilled(context) ? context : undefined
}

function snapshotFields(snapshot: {
  value?: StateValue
  context?: MachineContext
}): {
  value: StateValue | undefined
  context: MachineContext | undefined
} {
  const { value, context } = snapshot
  return { value, context: nonEmptyContext(context) }
}

export function toSerializedSnapshot(value: string): SerializedSnapshot
export function toSerializedSnapshot(value: string): string {
  return value
}

export function toSerializedEvent(value: string): SerializedEvent
export function toSerializedEvent(value: string): string {
  return value
}

/** @public */
export function serializeSnapshot(
  snapshot: AnySnapshot & { value?: StateValue; context?: MachineContext },
): SerializedSnapshot {
  return toSerializedSnapshot(JSON.stringify(snapshotFields(snapshot)))
}

function serializeEvent<TEvent extends EventObject>(
  event: TEvent,
): SerializedEvent {
  return toSerializedEvent(JSON.stringify(event))
}

function ownLogicEvents<TLogic extends AnyActorLogic>(
  state: SnapshotFrom<TLogic>,
): readonly EventFromLogic<TLogic>[]
function ownLogicEvents(state: AnyMachineSnapshot): readonly AnyEventObject[] {
  return getAllOwnEvents(state)
}

function defaultSerializeState<TLogic extends AnyActorLogic>(
  state: SnapshotFrom<TLogic>,
): string {
  return JSON.stringify(state)
}

function firstDefined<T>(
  candidates: readonly (T | undefined)[],
  fallback: T,
): T {
  return candidates.find((candidate) => candidate !== undefined) ?? fallback
}

function optionSerializeState<TLogic extends AnyActorLogic>(
  options: OptionsOf<TLogic> | undefined,
): SerializeState<TLogic> | undefined {
  return options?.serializeState
}

function optionFromState<TLogic extends AnyActorLogic>(
  options: OptionsOf<TLogic> | undefined,
): SnapshotFrom<TLogic> | undefined {
  return options?.fromState
}

function optionStopWhen<TLogic extends AnyActorLogic>(
  options: OptionsOf<TLogic> | undefined,
): ((state: SnapshotFrom<TLogic>) => boolean) | undefined {
  return options?.toState
}

function startState<TLogic extends AnyActorLogic>(
  logic: {
    getInitialSnapshot(
      actorScope: AnyActorScope,
      input: InputFrom<TLogic> | undefined,
    ): SnapshotFrom<TLogic>
  },
  options: OptionsOf<TLogic>,
): SnapshotFrom<TLogic> {
  return options.fromState ??
    logic.getInitialSnapshot(createMockActorScope(), options.input)
}

function createDefaultMachineOptions<TLogic extends AnyActorLogic>(
  machine: TLogic & AnyStateMachine,
  options: OptionsOf<TLogic> = {},
): OptionsOf<TLogic> {
  return {
    serializeState: serializeSnapshot,
    serializeEvent,
    events: ownLogicEvents<TLogic>,
    fromState: startState(machine, options),
  }
}

const memberOf = (value: object, key: string): object => new Object(Reflect.get(value, key))

const memberIs = (value: object, key: string, kind: string): boolean => typeof Reflect.get(value, key) === kind

const machineMethods = ['getStateNodeById', 'resolveState', 'getTransitionData']

function isMachineLogic(logic: object): logic is AnyStateMachine {
  const root = memberOf(logic, 'root')
  return [
    typeof logic === 'object',
    memberIs(logic, 'root', 'object'),
    memberIs(root, 'id', 'string'),
    memberIs(root, 'states', 'object'),
    memberIs(memberOf(root, 'transitions'), 'values', 'function'),
    ...machineMethods.map((method) => memberIs(logic, method, 'function')),
  ].every(Boolean)
}

function transitionEventType(transition: { eventType: string }): string {
  return transition.eventType
}

/** @public */
export function toDirectedGraph(
  stateMachine: AnyStateNode | AnyStateMachine,
): DirectedGraphNode {
  const stateNode = isMachineLogic(stateMachine)
    ? stateMachine.root
    : stateMachine

  const edges: DirectedGraphEdge[] = [...stateNode.transitions.values()]
    .flat()
    .flatMap((t, transitionIndex) => {
      const targets = t.target !== undefined ? t.target : [stateNode]
      const eventType = transitionEventType(t)

      return targets.map((target, targetIndex) => {
        const edge: DirectedGraphEdge = {
          id: `${stateNode.id}:${transitionIndex}:${targetIndex}`,
          source: stateNode,
          target,
          transition: t,
          label: {
            text: eventType,
            toJSON: () => ({ text: eventType }),
          },
          toJSON: () => {
            const { label } = edge

            return { source: stateNode.id, target: target.id, label }
          },
        }

        return edge
      })
    })

  const graph = {
    id: stateNode.id,
    stateNode: stateNode,
    children: getChildren(stateNode).map(toDirectedGraph),
    edges,
    toJSON: () => {
      const { id, children, edges: graphEdges } = graph
      return { id, children, edges: graphEdges }
    },
  }

  return graph
}

function resolveDefaultOptions<TLogic extends AnyActorLogic>(
  logic: TLogic,
  traversalOptions: OptionsOf<TLogic> | undefined,
): OptionsOf<TLogic> | undefined {
  return isMachineLogic(logic)
    ? createDefaultMachineOptions(logic, traversalOptions)
    : undefined
}

export function resolveTraversalOptions<TLogic extends AnyActorLogic>(
  {
    logic,
    options: traversalOptions,
  }: {
    logic: TLogic
    options?: OptionsOf<TLogic> | undefined
  },
): TraversalConfig<SnapshotFrom<TLogic>, EventFromLogic<TLogic>> {
  const resolvedDefaultOptions = resolveDefaultOptions(logic, traversalOptions)
  const serializeState: SerializeState<TLogic> = firstDefined(
    [
      optionSerializeState<TLogic>(traversalOptions),
      optionSerializeState<TLogic>(resolvedDefaultOptions),
    ],
    defaultSerializeState<TLogic>,
  )
  const fromState = optionFromState<TLogic>(traversalOptions) ??
    optionFromState<TLogic>(resolvedDefaultOptions)
  const traversalConfig: TraversalConfig<
    SnapshotFrom<TLogic>,
    EventFromLogic<TLogic>
  > = {
    serializeState,
    serializeEvent,
    events: [],
    filterEvents: undefined,
    limit: Infinity,
    toState: undefined,
    // Traversal should not continue past the `toState` predicate
    // since the target state has already been reached at that point
    stopWhen: optionStopWhen<TLogic>(traversalOptions),
    ...resolvedDefaultOptions,
    ...traversalOptions,
    fromState,
  }

  return traversalConfig
}

function requireFirstStep<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  path: StatePath<TSnapshot, TEvent>,
): Step<TSnapshot, TEvent> {
  const firstStep = path.steps[0]
  if (firstStep === undefined) {
    throw new Error(`Paths cannot be joined`)
  }
  return firstStep
}

const joinPathsDataFirst = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
>(
  headPath: StatePath<TSnapshot, TEvent>,
  tailPath: StatePath<TSnapshot, TEvent>,
): StatePath<TSnapshot, TEvent> => {
  const firstTailStep = requireFirstStep(tailPath)

  if (firstTailStep.state !== headPath.state) {
    throw new Error(`Paths cannot be joined`)
  }

  return {
    state: tailPath.state,
    // e.g. [A, B, C] + [C, D, E] = [A, B, C, D, E]
    steps: headPath.steps.concat(tailPath.steps.slice(1)),
    weight: headPath.weight + tailPath.weight,
  }
}

export function joinPaths<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  tailPath: StatePath<TSnapshot, TEvent>,
): (headPath: StatePath<TSnapshot, TEvent>) => StatePath<TSnapshot, TEvent>
export function joinPaths<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  headPath: StatePath<TSnapshot, TEvent>,
  tailPath: StatePath<TSnapshot, TEvent>,
): StatePath<TSnapshot, TEvent>
export function joinPaths<TSnapshot extends AnySnapshot, TEvent extends EventObject>(
  ...args:
    | readonly [headPath: StatePath<TSnapshot, TEvent>, tailPath: StatePath<TSnapshot, TEvent>]
    | readonly [tailPath: StatePath<TSnapshot, TEvent>]
): StatePath<TSnapshot, TEvent> | ((headPath: StatePath<TSnapshot, TEvent>) => StatePath<TSnapshot, TEvent>) {
  if (args.length === 2) {
    return joinPathsDataFirst(args[0], args[1])
  }
  const [tailPath] = args
  return (headPath: StatePath<TSnapshot, TEvent>) => joinPathsDataFirst(headPath, tailPath)
}
