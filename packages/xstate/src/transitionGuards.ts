import { STATE_IDENTIFIER } from './constants.js'
import type { AnyEventObject, AnyMachineSnapshot, EventObject, EventPayloadPattern, StateValue } from './types.js'

export const isStateId = (str: string): boolean => str.startsWith(STATE_IDENTIFIER)

const isStateIdValue = (stateValue: StateValue): stateValue is string =>
  typeof stateValue === 'string' && isStateId(stateValue)

const stateInSnapshot = (
  snapshot: AnyMachineSnapshot,
  stateValue: StateValue,
): boolean => {
  if (isStateIdValue(stateValue)) {
    const target = snapshot.machine.getStateNodeById(stateValue)
    return snapshot.nodes.some((node) => node === target)
  }

  return snapshot.matches(stateValue)
}

/** @public */
export function checkStateIn(
  stateValue: StateValue,
): (snapshot: AnyMachineSnapshot) => boolean
export function checkStateIn(
  snapshot: AnyMachineSnapshot,
  stateValue: StateValue,
): boolean
export function checkStateIn(
  ...args:
    | readonly [stateValue: StateValue]
    | readonly [snapshot: AnyMachineSnapshot, stateValue: StateValue]
): boolean | ((snapshot: AnyMachineSnapshot) => boolean) {
  if (args.length === 1) {
    const [stateValue] = args
    return (snapshot: AnyMachineSnapshot) => stateInSnapshot(snapshot, stateValue)
  }
  return stateInSnapshot(args[0], args[1])
}

const matchesEvent = (
  event: EventObject,
  pattern: EventPayloadPattern<AnyEventObject>,
): boolean => Object.entries(pattern).every(([key, value]) => Object.is(Reflect.get(event, key), value))

export type TransitionFunctionOutcome<Result> =
  | { readonly type: 'returned'; readonly value: Result | undefined }
  | { readonly type: 'effectEnqueued' }

export type TransitionSelection<Result> =
  | { readonly type: 'value'; readonly result: Result }
  | { readonly type: 'effect' }
  | { readonly type: 'absent' }

export const selectTransition = <Result>(
  outcome: TransitionFunctionOutcome<Result>,
): TransitionSelection<Result> =>
  outcome.type === 'returned'
    ? selectionOfReturned(outcome.value)
    : { type: 'effect' }

const selectionOfReturned = <Result>(
  value: Result | undefined,
): TransitionSelection<Result> => value === undefined ? { type: 'absent' } : { type: 'value', result: value }

export type SessionEventMatcher = (
  event: EventObject,
  snapshot: AnyMachineSnapshot,
) => boolean

export interface CandidateAdmissionInput<Result> {
  readonly event: EventObject
  readonly snapshot: AnyMachineSnapshot
  readonly matches: EventPayloadPattern<AnyEventObject> | undefined
  readonly eventMatcher: SessionEventMatcher | undefined
  readonly runGuard: (() => boolean) | undefined
  readonly runTransitionFunction:
    | (() => TransitionFunctionOutcome<Result>)
    | undefined
}

export type CandidateDecision<Result> =
  | { readonly type: 'rejected' }
  | { readonly type: 'admitted' }
  | { readonly type: 'enabled'; readonly selection: TransitionSelection<Result> }
  | { readonly type: 'disabled'; readonly selection: TransitionSelection<Result> }

const admitsByDecisionType: Readonly<
  Record<CandidateDecision<never>['type'], boolean>
> = {
  rejected: false,
  admitted: true,
  enabled: true,
  disabled: false,
}

export const isAdmitted = <Result>(
  decision: CandidateDecision<Result>,
): boolean => admitsByDecisionType[decision.type]

const rejectedDecision: CandidateDecision<never> = { type: 'rejected' }
const admittedDecision: CandidateDecision<never> = { type: 'admitted' }

const patternAccepts = <Result>(
  input: CandidateAdmissionInput<Result>,
): boolean => input.matches === undefined || matchesEvent(input.event, input.matches)

const sessionAccepts = <Result>(
  input: CandidateAdmissionInput<Result>,
): boolean =>
  input.eventMatcher === undefined ||
  input.eventMatcher(input.event, input.snapshot)

const guardAccepts = <Result>(
  input: CandidateAdmissionInput<Result>,
): boolean => input.runGuard === undefined || input.runGuard()

const sessionAndGuardAccept = <Result>(
  input: CandidateAdmissionInput<Result>,
): boolean => sessionAccepts(input) && guardAccepts(input)

const checksAccept = <Result>(
  input: CandidateAdmissionInput<Result>,
): boolean => patternAccepts(input) && sessionAndGuardAccept(input)

const selectionDecision = <Result>(
  selection: TransitionSelection<Result>,
): CandidateDecision<Result> =>
  selection.type === 'absent'
    ? { type: 'disabled', selection }
    : { type: 'enabled', selection }

const transitionDecision = <Result>(
  input: CandidateAdmissionInput<Result>,
): CandidateDecision<Result> =>
  input.runTransitionFunction === undefined
    ? admittedDecision
    : selectionDecision(selectTransition(input.runTransitionFunction()))

export const admitCandidate = <Result>(
  input: CandidateAdmissionInput<Result>,
): CandidateDecision<Result> => checksAccept(input) ? transitionDecision(input) : rejectedDecision

export interface AdmittedCandidate<TCandidate, Result> {
  readonly candidate: TCandidate
  readonly decision: CandidateDecision<Result>
}

const admittedOf = <TCandidate, Result>(
  admit: (candidate: TCandidate) => CandidateDecision<Result>,
  candidate: TCandidate,
): AdmittedCandidate<TCandidate, Result> | undefined => {
  const decision = admit(candidate)
  return isAdmitted(decision) ? { candidate, decision } : undefined
}

export const firstAdmittedCandidate = <TCandidate, Result>(input: {
  readonly candidates: readonly TCandidate[]
  readonly admit: (candidate: TCandidate) => CandidateDecision<Result>
}): AdmittedCandidate<TCandidate, Result> | undefined =>
  input.candidates.reduce<AdmittedCandidate<TCandidate, Result> | undefined>(
    (admitted, candidate) => admitted ?? admittedOf(input.admit, candidate),
    undefined,
  )
