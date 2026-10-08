import { checkStateIn, createActor, createMachine, matchesState, pathToStateValue, type StateValue } from '@systemfsoftware/xstate'
import { Context, Effect, Layer, Match, pipe } from 'effect'
import { type MatchCommand, type ModelStateValue, stateValueOf, type StateTree, treesOf } from './stateValue.model.js'

const escapedKey = (key: string): string => key.replace(/[\\.]/g, '\\$&')

const idOf = (value: ModelStateValue): string | undefined => {
  if (typeof value === 'string') {
    return escapedKey(value)
  }
  const entries = Object.entries(value)
  const [only] = entries
  if (entries.length !== 1 || only === undefined) {
    return undefined
  }
  const rest = idOf(only[1])
  return rest === undefined ? undefined : `${escapedKey(only[0])}.${rest}`
}

interface Argument {
  readonly value: StateValue
  readonly asId: boolean
  readonly escapesADot: boolean
}

const argumentOf = (tree: StateTree, form: MatchCommand['parentForm']): Argument => {
  const value = stateValueOf(tree)
  const id = form === 'id' ? idOf(value) : undefined
  return id === undefined
    ? { value, asId: false, escapesADot: false }
    : { value: id, asId: true, escapesADot: id.includes('\\.') }
}

interface NodeConfig {
  readonly initial?: string
  readonly type?: 'parallel'
  readonly states?: Readonly<Record<string, NodeConfig>>
}

const nodeOf = (value: ModelStateValue): NodeConfig => {
  if (typeof value === 'string') {
    return { initial: value, states: { [value]: {} } }
  }
  const entries = Object.entries(value)
  const states = Object.fromEntries(entries.map(([key, region]) => [key, nodeOf(region)]))
  const [first] = entries
  return entries.length === 1 && first !== undefined ? { initial: first[0], states } : { type: 'parallel', states }
}

const snapshotWhoseValueIs = (tree: StateTree) => createActor(createMachine(nodeOf(stateValueOf(tree)))).getSnapshot()

export interface MatchingLedger {
  readonly answers: Record<MatchCommand['call'], { matched: number; unmatched: number }>
  idArguments: number
  escapedIdArguments: number
}

export interface MatchingHandle {
  readonly match: (command: MatchCommand) => boolean
}

export interface MatchingSubject {
  readonly layer: Layer.Layer<StateMatching>
  readonly observed: MatchingLedger
}

export class StateMatching extends Context.Service<StateMatching, MatchingHandle>()(
  '@systemfsoftware/xstate/tests/state-matching/StateMatching',
) {}

type Matcher = (call: MatchCommand['call'], childTree: StateTree, parent: StateValue, child: StateValue) => boolean

const publishedMatcher: Matcher = (call, childTree, parent, child) =>
  Match.value(call).pipe(
    Match.when('data-first', () => matchesState(parent, child)),
    Match.when('data-last', () => pipe(parent, matchesState(child))),
    Match.when('snapshot', () => checkStateIn(snapshotWhoseValueIs(childTree), parent)),
    Match.exhaustive,
  )

const splitOnEveryDot = (value: StateValue): StateValue =>
  typeof value === 'string' ? pathToStateValue(value.split('.')) : value

const escapeBlindMatcher: Matcher = (call, childTree, parent, child) =>
  publishedMatcher(call, childTree, splitOnEveryDot(parent), splitOnEveryDot(child))

const subjectOf = (matcher: Matcher): MatchingSubject => {
  const observed: MatchingLedger = {
    answers: {
      'data-first': { matched: 0, unmatched: 0 },
      'data-last': { matched: 0, unmatched: 0 },
      snapshot: { matched: 0, unmatched: 0 },
    },
    idArguments: 0,
    escapedIdArguments: 0,
  }
  const match = (command: MatchCommand): boolean => {
    const [parentTree, childTree] = treesOf(command)
    const parent = argumentOf(parentTree, command.parentForm)
    const child = argumentOf(childTree, command.childForm)
    const matched = matcher(command.call, childTree, parent.value, child.value)
    const tally = observed.answers[command.call]
    tally.matched += matched ? 1 : 0
    tally.unmatched += matched ? 0 : 1
    for (const argument of [parent, child]) {
      observed.idArguments += argument.asId ? 1 : 0
      observed.escapedIdArguments += argument.escapesADot ? 1 : 0
    }
    return matched
  }
  return { observed, layer: Layer.succeed(StateMatching, { match }) }
}

export const makeStateMatchingSubject = (): MatchingSubject => subjectOf(publishedMatcher)

export const makeEscapeBlindSubject = (): MatchingSubject => subjectOf(escapeBlindMatcher)

export const runMatchCommand = (command: MatchCommand): Effect.Effect<boolean, never, StateMatching> =>
  Effect.gen(function*() {
    const subject = yield* StateMatching
    return subject.match(command)
  })
