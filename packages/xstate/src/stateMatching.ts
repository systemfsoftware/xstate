import { dual } from 'effect/Function'
import type { StateValue, StateValueMap } from './types.js'

const segmentAfterDot = /\.((?:\\[\s\S]|\\$|[^.\\])*)/g
const escapedCharacter = /\\([\s\S])/g

export const toStatePath = (stateId: string | readonly string[]): string[] =>
  typeof stateId === 'string'
    ? Array.from(`.${stateId}`.matchAll(segmentAfterDot), ([, segment = '']) => segment.replace(escapedCharacter, '$1'))
    : [...stateId]

/** @public */
export const pathToStateValue = (statePath: readonly string[]): StateValue => {
  const leaf = statePath.at(-1)
  return leaf === undefined
    ? {}
    : statePath.slice(0, -1).reduceRight<StateValue>((value, key) => ({ [key]: value }), leaf)
}

const toStateValue = (stateValue: StateValue): StateValue =>
  typeof stateValue === 'string' ? pathToStateValue(toStatePath(stateValue)) : stateValue

const presentRegionMatches = (parentRegion: StateValue | undefined, childRegion: StateValue): boolean =>
  parentRegion !== undefined && regionsMatch(parentRegion, childRegion)

const regionMatches = (parentRegion: StateValue | undefined, childRegion: StateValue | undefined): boolean =>
  childRegion !== undefined && presentRegionMatches(parentRegion, childRegion)

const matchesRegions = (parent: StateValue, child: StateValueMap): boolean =>
  typeof parent === 'string'
    ? parent in child
    : Object.keys(parent).every((key) => regionMatches(parent[key], child[key]))

function regionsMatch(parent: StateValue, child: StateValue): boolean {
  return typeof child === 'string' ? parent === child : matchesRegions(parent, child)
}

const valueMatches = (parentStateValue: StateValue, childStateValue: StateValue): boolean =>
  regionsMatch(toStateValue(parentStateValue), toStateValue(childStateValue))

/** @public */
export const matchesState: {
  (childStateValue: StateValue): (parentStateValue: StateValue) => boolean
  (parentStateValue: StateValue, childStateValue: StateValue): boolean
} = dual(2, valueMatches)
