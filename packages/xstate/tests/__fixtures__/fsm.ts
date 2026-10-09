import { createActor, initialTransition, transition } from '@systemfsoftware/xstate'
import {
  createFSM,
  type FSM,
  type FSMContextPatch,
  type FSMSnapshot,
  type FSMTransition,
  type FSMTransitionConfig,
  type FSMTransitionFunction,
} from '@systemfsoftware/xstate/fsm'
import { Context, Effect, Layer, Match } from 'effect'
import {
  type FsmCommand,
  type FsmContext,
  type FsmDriver,
  type FsmEvent,
  type FsmMachine,
  type FsmObservation,
  type FsmSlot,
  type FsmStateName,
  initialContext,
  patchValuesOf,
} from './fsm.model.js'

type St = FsmStateName
type Ctx = FsmContext
type Ev = FsmEvent
type Snapshot = FSMSnapshot<Ctx, St>
type Fsm = FSM<Ctx, Ev, St, Snapshot>

type Ownership = 'own-only' | 'materialised'

const inheritedNames: Record<'toString' | 'constructor', true> = { toString: true, constructor: true }

const isInherited = (type: string): boolean => Object.hasOwn(inheritedNames, type)

const count = (flag: boolean): number => flag ? 1 : 0

const stateOf = (choice: 'same' | St): St | undefined => choice === 'same' ? undefined : choice

const targetEntry = (value: St | undefined): { target?: St } => value === undefined ? {} : { target: value }

const contextEntryOf = (patch: FSMContextPatch<Ctx>): { context?: FSMContextPatch<Ctx> } =>
  Object.keys(patch).length === 0 ? {} : { context: patch }

const configTransition = (
  target: 'same' | St,
  patch: { readonly count: 'keep' | 0 | 1 | 2; readonly tag: 'keep' | 'base' | 'next' },
): FSMTransitionConfig<Ctx, St> => ({
  ...targetEntry(stateOf(target)),
  ...contextEntryOf(patchValuesOf(patch)),
})

const addTransition = (
  target: 'same' | St,
): FSMTransitionFunction<Ctx, Extract<Ev, { type: 'bump' }>, St> =>
({ context, event }) => ({
  ...targetEntry(stateOf(target)),
  context: { count: context.count + event.by },
})

const plainEntryOf = (slot: FsmSlot): St | FSMTransitionConfig<Ctx, St> | undefined =>
  Match.valueTags(slot, {
    Empty: () => undefined,
    Target: (target) => stateOf(target.target),
    Config: (config) => configTransition(config.target, config.patch),
    Add: () => undefined,
  })

const bumpEntryOf = (slot: FsmSlot): FSMTransition<Ctx, Extract<Ev, { type: 'bump' }>, St> | undefined =>
  Match.valueTags(slot, {
    Empty: () => undefined,
    Target: (target) => stateOf(target.target),
    Config: (config) => configTransition(config.target, config.patch),
    Add: (add) => addTransition(add.target),
  })

const toggleEntry = (slot: FsmSlot): { toggle?: St | FSMTransitionConfig<Ctx, St> } => {
  const entry = plainEntryOf(slot)
  return entry === undefined ? {} : { toggle: entry }
}

const noopEntry = (slot: FsmSlot): { noop?: St | FSMTransitionConfig<Ctx, St> } => {
  const entry = plainEntryOf(slot)
  return entry === undefined ? {} : { noop: entry }
}

const bumpEntry = (slot: FsmSlot): { bump?: FSMTransition<Ctx, Extract<Ev, { type: 'bump' }>, St> } => {
  const entry = bumpEntryOf(slot)
  return entry === undefined ? {} : { bump: entry }
}

const ownEntriesOf = (spec: FsmMachine) => ({
  ...toggleEntry(spec.toggle),
  ...noopEntry(spec.noop),
  ...bumpEntry(spec.bump),
})

const prototypeEntriesOf = (spec: FsmMachine): { toggle?: St } =>
  spec.inheritedToggle === 'keep' ? {} : { toggle: spec.inheritedToggle }

const onTableOf = (spec: FsmMachine, ownership: Ownership) =>
  ownership === 'materialised'
    ? { ...ownEntriesOf(spec), ...prototypeEntriesOf(spec) }
    : Object.setPrototypeOf(ownEntriesOf(spec), prototypeEntriesOf(spec))

const machineOf = (spec: FsmMachine, ownership: Ownership): Fsm =>
  createFSM<Ctx, Ev, St>({
    initial: spec.initial,
    context: initialContext,
    states: {
      idle: { on: onTableOf(spec, ownership) },
      active: { on: onTableOf(spec, ownership) },
      done: { on: onTableOf(spec, ownership) },
    },
  })

const slotIsAdd = (spec: FsmMachine, event: FsmEvent): boolean =>
  Match.value(event.type).pipe(
    Match.when('bump', () =>
      Match.value(spec.bump).pipe(
        Match.tag('Add', () => true),
        Match.orElse(() => false),
      )),
    Match.orElse(() => false),
  )

export interface FsmLedger {
  noopTransitions: number
  targetChanges: number
  contextPatches: number
  functionTransitions: number
  inheritedEventsIgnored: number
  drivers: Record<FsmDriver, number>
}

const noteStep = (ledger: FsmLedger, spec: FsmMachine, event: FsmEvent, previous: Snapshot, next: Snapshot): void => {
  ledger.noopTransitions += count(previous === next)
  ledger.targetChanges += count(previous.value !== next.value)
  ledger.contextPatches += count(previous.context !== next.context)
  ledger.functionTransitions += count(slotIsAdd(spec, event))
  ledger.inheritedEventsIgnored += count(isInherited(event.type) && previous === next)
}

const observationOf = (
  snapshot: Snapshot,
  sentinelKeptIdentity: boolean,
  initialIdentity: boolean,
): FsmObservation => ({
  value: snapshot.value,
  context: snapshot.context,
  sentinelKeptIdentity,
  initialIdentity,
})

const pureObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation => {
  let snapshot = fsm.initialState
  for (const event of command.events) {
    const [next] = fsm.transition(snapshot, event)
    noteStep(ledger, command.machine, event, snapshot, next)
    snapshot = next
  }
  const [sentinel] = fsm.transition(snapshot, { type: 'toString' })
  return observationOf(snapshot, sentinel === snapshot, false)
}

const identityHeld = (fsm: Fsm): boolean =>
  initialTransition(fsm)[0] === fsm.initialState && fsm.getInitialSnapshot() === fsm.initialState

const entryObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation => {
  const initialIdentity = identityHeld(fsm)
  let snapshot = fsm.initialState
  for (const event of command.events) {
    const [next] = transition(fsm, snapshot, event)
    noteStep(ledger, command.machine, event, snapshot, next)
    snapshot = next
  }
  const [sentinel] = fsm.transition(snapshot, { type: 'toString' })
  return observationOf(snapshot, sentinel === snapshot, initialIdentity)
}

const actorObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation => {
  const actor = createActor(fsm).start()
  let previous = actor.getSnapshot()
  for (const event of command.events) {
    actor.send(event)
    const next = actor.getSnapshot()
    noteStep(ledger, command.machine, event, previous, next)
    previous = next
  }
  const snapshot = actor.getSnapshot()
  actor.stop()
  const [sentinel] = fsm.transition(snapshot, { type: 'toString' })
  return observationOf(snapshot, sentinel === snapshot, false)
}

const persistedObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation => {
  const actor = createActor(fsm).start()
  const [first, ...rest] = command.events
  if (first !== undefined) {
    actor.send(first)
  }
  const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()))
  actor.stop()
  const restored = createActor(fsm, { snapshot: persisted }).start()
  let previous = restored.getSnapshot()
  for (const event of rest) {
    restored.send(event)
    const next = restored.getSnapshot()
    noteStep(ledger, command.machine, event, previous, next)
    previous = next
  }
  const snapshot = restored.getSnapshot()
  restored.stop()
  const [sentinel] = fsm.transition(snapshot, { type: 'toString' })
  return observationOf(snapshot, sentinel === snapshot, false)
}

interface Behaviour {
  readonly ownership: Ownership
  readonly copyOnNoop: boolean
}

const driverObservation = (behaviour: Behaviour, fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation =>
  Match.value(command.driver).pipe(
    Match.when('pure', () => pureObservation(fsm, command, ledger)),
    Match.when('entry', () => entryObservation(fsm, command, ledger)),
    Match.when('actor', () => actorObservation(fsm, command, ledger)),
    Match.when('persisted', () => persistedObservation(fsm, command, ledger)),
    Match.exhaustive,
  )

const emptyLedger = (): FsmLedger => ({
  noopTransitions: 0,
  targetChanges: 0,
  contextPatches: 0,
  functionTransitions: 0,
  inheritedEventsIgnored: 0,
  drivers: { pure: 0, entry: 0, actor: 0, persisted: 0 },
})

export class FsmSubject extends Context.Service<FsmSubject, (command: FsmCommand) => FsmObservation>()(
  '@systemfsoftware/xstate/tests/fsm/FsmSubject',
) {}

export interface FsmHandle {
  readonly layer: Layer.Layer<FsmSubject>
  readonly observed: FsmLedger
}

const subjectOf = (behaviour: Behaviour): FsmHandle => {
  const observed = emptyLedger()
  const run = (command: FsmCommand): FsmObservation => {
    observed.drivers[command.driver] += 1
    const fsm = machineOf(command.machine, behaviour.ownership)
    const observation = driverObservation(behaviour, fsm, command, observed)
    return behaviour.copyOnNoop ? { ...observation, sentinelKeptIdentity: false } : observation
  }
  return { observed, layer: Layer.succeed(FsmSubject, run) }
}

export const makeFsmSubject = (): FsmHandle => subjectOf({ ownership: 'own-only', copyOnNoop: false })

export const makeCopyOnNoopSubject = (): FsmHandle => subjectOf({ ownership: 'own-only', copyOnNoop: true })

export const makeInheritedEventSubject = (): FsmHandle => subjectOf({ ownership: 'materialised', copyOnNoop: false })

export const runFsmCommand = (command: FsmCommand): Effect.Effect<FsmObservation, never, FsmSubject> =>
  Effect.gen(function*() {
    const run = yield* FsmSubject
    return run(command)
  })
