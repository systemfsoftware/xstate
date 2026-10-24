import type { AnyStateNode } from './types.js'

const IS_ATOMIC_TYPE: Record<AnyStateNode['type'], boolean> = {
  atomic: true,
  choice: true,
  compound: false,
  final: true,
  history: false,
  parallel: false,
}

export function isAtomicStateNode(stateNode: AnyStateNode): boolean {
  return IS_ATOMIC_TYPE[stateNode.type]
}

export interface DescendantArgs {
  readonly childStateNode: AnyStateNode
  readonly parentStateNode: AnyStateNode
}

const isOrHasAncestor = (stateNode: AnyStateNode, ancestor: AnyStateNode): boolean =>
  stateNode === ancestor || hasAncestor(stateNode.parent, ancestor)

const hasAncestor = (stateNode: AnyStateNode | undefined, ancestor: AnyStateNode): boolean =>
  stateNode === undefined ? false : isOrHasAncestor(stateNode, ancestor)

export function isDescendant(args: DescendantArgs): boolean {
  return hasAncestor(args.childStateNode.parent, args.parentStateNode)
}
