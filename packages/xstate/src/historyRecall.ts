import { isAtomicStateNode, isDescendant } from './stateNodePredicates.js'
import type { AnyStateNode, AnyTransitionDefinition, HistoryValue } from './types.js'

export type HistoryStateNode = AnyStateNode & { type: 'history' }

export interface HistoryRecallRecorded {
  readonly type: 'recorded'
  readonly nodes: readonly AnyStateNode[]
}

export interface HistoryRecallDefault {
  readonly type: 'default'
  readonly transition: AnyTransitionDefinition
}

export type HistoryRecall = HistoryRecallRecorded | HistoryRecallDefault

export function isHistoryNode(
  stateNode: AnyStateNode,
): stateNode is HistoryStateNode {
  return stateNode.type === 'history'
}

const defaultHistoryTransition = (
  source: HistoryStateNode,
  target: readonly AnyStateNode[],
): AnyTransitionDefinition => ({
  target,
  source,
  reenter: false,
  eventType: '',
})

export interface RecallHistoryArgs {
  readonly historyNode: HistoryStateNode
  readonly historyValue: HistoryValue
  readonly defaultTargets: () => readonly AnyStateNode[]
}

export function recallHistory(args: RecallHistoryArgs): HistoryRecall {
  const recorded = args.historyValue[args.historyNode.id]

  return recorded === undefined
    ? {
      type: 'default',
      transition: defaultHistoryTransition(
        args.historyNode,
        args.defaultTargets(),
      ),
    }
    : { type: 'recorded', nodes: recorded }
}

export interface RecordHistoryArgs {
  readonly historyNode: HistoryStateNode
  readonly exitingNode: AnyStateNode
  readonly currentStateNodes: readonly AnyStateNode[]
}

export function recordHistoryNodes(
  args: RecordHistoryArgs,
): Array<AnyStateNode> {
  const { historyNode, exitingNode, currentStateNodes } = args

  if (historyNode.history === 'deep') {
    return currentStateNodes.filter(
      (stateNode) =>
        isAtomicStateNode(stateNode) &&
        isDescendant({ childStateNode: stateNode, parentStateNode: exitingNode }),
    )
  }

  return currentStateNodes.filter(
    (stateNode) => stateNode.parent === exitingNode,
  )
}

export interface RestoresSourceViaHistoryArgs {
  readonly targets: readonly AnyStateNode[]
  readonly effectiveTargetStates: readonly AnyStateNode[]
  readonly source: AnyStateNode
}

export function restoresSourceViaHistory(
  args: RestoresSourceViaHistoryArgs,
): boolean {
  return args.targets.some(isHistoryNode)
    ? args.effectiveTargetStates.some((stateNode) => stateNode === args.source)
    : false
}
