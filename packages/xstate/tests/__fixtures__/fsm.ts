import { type Actor, createActor, initialTransition, transition } from '@systemfsoftware/xstate'
import {
  createFSM,
  type FSM,
  type FSMContextPatch,
  type FSMSnapshot,
  type FSMTransition,
  type FSMTransitionConfig,
  type FSMTransitionFunction,
  setup,
  types,
} from '@systemfsoftware/xstate/fsm'
import { Context, Effect, Layer, Match } from 'effect'
import {
  emissionOf,
  type FsmCommand,
  type FsmContext,
  type FsmDriver,
  type FsmEvent,
  type FsmMachine,
  type FsmObservation,
  type FsmSlot,
  type FsmStateName,
  initialContextOf,
  patchValuesOf,
} from './fsm.model.js'

type St = FsmStateName
type Ctx = FsmContext
type Ev = FsmEvent
type Snapshot = FSMSnapshot<Ctx, St>
type Fsm = FSM<Ctx, Ev, St, Snapshot, object>

type Ownership = 'own-only' | 'materialised'

type InheritedPatch = 'none' | 'count' | 'tag'

const inheritedNames: Record<'toString' | 'constructor', true> = { toString: true, constructor: true }

const isInherited = (type: string): boolean => Object.hasOwn(inheritedNames, type)

const count = (flag: boolean): number => flag ? 1 : 0

const stateOf = (choice: 'same' | St): St | undefined => choice === 'same' ? undefined : choice

const targetEntry = (value: St | undefined): { target?: St } => value === undefined ? {} : { target: value }

const inheritedPatchOf = (inherited: InheritedPatch): FSMContextPatch<Ctx> =>
  Match.value(inherited).pipe(
    Match.when('count', () => ({ count: 7 })),
    Match.when('tag', () => ({ tag: 'inherited' })),
    Match.orElse(() => ({})),
  )

const patchWithPrototype = (
  own: FSMContextPatch<Ctx>,
  inherited: InheritedPatch,
  ownership: Ownership,
): FSMContextPatch<Ctx> => {
  const prototype = inheritedPatchOf(inherited)
  if (ownership === 'materialised') {
    return { ...prototype, ...own }
  }
  const patch = { ...own }
  Reflect.setPrototypeOf(patch, prototype)
  return patch
}

const contextEntryOf = (
  own: FSMContextPatch<Ctx>,
  inherited: InheritedPatch,
  ownership: Ownership,
): { context?: FSMContextPatch<Ctx> } =>
  Object.keys(own).length === 0 && inherited === 'none'
    ? {}
    : { context: patchWithPrototype(own, inherited, ownership) }

type Fault = 'none' | 'copy-on-noop' | 'copy-unchanged-context'

interface Behaviour {
  readonly eventOwnership: Ownership
  readonly patchOwnership: Ownership
  readonly fault: Fault
}

const configTransition = (
  config: Extract<FsmSlot, { _tag: 'Config' }>,
  behaviour: Behaviour,
): FSMTransitionConfig<Ctx, St> => ({
  ...targetEntry(stateOf(config.target)),
  ...contextEntryOf(patchValuesOf(config.patch), config.inherited, behaviour.patchOwnership),
})

const addTransition = (
  target: 'same' | St,
): FSMTransitionFunction<Ctx, Extract<Ev, { type: 'bump' }>, St> =>
({ context, event }) => ({
  ...targetEntry(stateOf(target)),
  context: { count: (context.count ?? 0) + event.by },
})

const plainEntryOf = (slot: FsmSlot, behaviour: Behaviour): St | FSMTransitionConfig<Ctx, St> | undefined =>
  Match.valueTags(slot, {
    Empty: () => undefined,
    Target: (target) => stateOf(target.target),
    Config: (config) => configTransition(config, behaviour),
    Add: () => undefined,
  })

const bumpEntryOf = (
  slot: FsmSlot,
  behaviour: Behaviour,
): FSMTransition<Ctx, Extract<Ev, { type: 'bump' }>, St> | undefined =>
  Match.valueTags(slot, {
    Empty: () => undefined,
    Target: (target) => stateOf(target.target),
    Config: (config) => configTransition(config, behaviour),
    Add: (add) => addTransition(add.target),
  })

const toggleEntry = (slot: FsmSlot, behaviour: Behaviour): { toggle?: St | FSMTransitionConfig<Ctx, St> } => {
  const entry = plainEntryOf(slot, behaviour)
  return entry === undefined ? {} : { toggle: entry }
}

const noopEntry = (slot: FsmSlot, behaviour: Behaviour): { noop?: St | FSMTransitionConfig<Ctx, St> } => {
  const entry = plainEntryOf(slot, behaviour)
  return entry === undefined ? {} : { noop: entry }
}

const bumpEntry = (
  slot: FsmSlot,
  behaviour: Behaviour,
): { bump?: FSMTransition<Ctx, Extract<Ev, { type: 'bump' }>, St> } => {
  const entry = bumpEntryOf(slot, behaviour)
  return entry === undefined ? {} : { bump: entry }
}

const ownEntriesOf = (spec: FsmMachine, behaviour: Behaviour) => ({
  ...toggleEntry(spec.toggle, behaviour),
  ...noopEntry(spec.noop, behaviour),
  ...bumpEntry(spec.bump, behaviour),
})

const prototypeEntriesOf = (spec: FsmMachine): { toggle?: St } =>
  spec.inheritedToggle === 'keep' ? {} : { toggle: spec.inheritedToggle }

const onTableOf = (spec: FsmMachine, behaviour: Behaviour) =>
  behaviour.eventOwnership === 'materialised'
    ? { ...ownEntriesOf(spec, behaviour), ...prototypeEntriesOf(spec) }
    : Object.setPrototypeOf(ownEntriesOf(spec, behaviour), prototypeEntriesOf(spec))

const statesOf = (spec: FsmMachine, behaviour: Behaviour) => ({
  idle: { on: onTableOf(spec, behaviour) },
  active: { on: onTableOf(spec, behaviour) },
  done: { on: onTableOf(spec, behaviour) },
})

const eventSchemas = {
  toggle: types<{}>(),
  noop: types<{}>(),
  bump: types<{ by: 0 | 1 | 2 }>(),
  toString: types<{}>(),
  constructor: types<{}>(),
}

const contextSetup = setup({ schemas: { context: types<Ctx>(), events: eventSchemas } })

const bareSetup = setup({ schemas: { events: eventSchemas } })

const createdFsmOf = (spec: FsmMachine, behaviour: Behaviour): Fsm =>
  spec.withContext
    ? createFSM<Ctx, Ev, St>({
      initial: spec.initial,
      context: initialContextOf(spec),
      states: statesOf(spec, behaviour),
    })
    : createFSM<{}, Ev, St>({ initial: spec.initial, states: statesOf(spec, behaviour) })

const setUpFsmOf = (spec: FsmMachine, behaviour: Behaviour): Fsm =>
  spec.withContext
    ? contextSetup.createFSM<St>({
      initial: spec.initial,
      context: initialContextOf(spec),
      states: statesOf(spec, behaviour),
    })
    : bareSetup.createFSM<St>({ initial: spec.initial, states: statesOf(spec, behaviour) })

const machineOf = (command: FsmCommand, behaviour: Behaviour): Fsm =>
  Match.value(command.factory).pipe(
    Match.when('createFSM', () => createdFsmOf(command.machine, behaviour)),
    Match.when('setup', () => setUpFsmOf(command.machine, behaviour)),
    Match.exhaustive,
  )

const slotOf = (spec: FsmMachine, event: FsmEvent): FsmSlot | undefined =>
  Match.value(event.type).pipe(
    Match.when('toggle', () => spec.toggle),
    Match.when('noop', () => spec.noop),
    Match.when('bump', () => spec.bump),
    Match.orElse(() => undefined),
  )

const slotIsAdd = (spec: FsmMachine, event: FsmEvent): boolean => slotOf(spec, event)?._tag === 'Add'

const slotCarriesPatch = (spec: FsmMachine, event: FsmEvent): boolean =>
  ['Config', 'Add'].includes(slotOf(spec, event)?._tag ?? 'Empty')

const keepsPatchedContext = (spec: FsmMachine, event: FsmEvent, previous: Snapshot, next: Snapshot): boolean =>
  slotCarriesPatch(spec, event) && next.context === previous.context

type Transition = Fsm['transition']

const copyOnNoop = (fsm: Fsm): Transition => (snapshot, event) => {
  const [next, actions] = fsm.transition(snapshot, event)
  return [next === snapshot ? { ...next } : next, actions]
}

const copyUnchangedContext = (fsm: Fsm, spec: FsmMachine): Transition => (snapshot, event) => {
  const [next, actions] = fsm.transition(snapshot, event)
  return [keepsPatchedContext(spec, event, snapshot, next) ? { ...next, context: { ...next.context } } : next, actions]
}

const transitionWith: Record<Fault, (fsm: Fsm, spec: FsmMachine) => Transition> = {
  none: (fsm) => (snapshot, event) => fsm.transition(snapshot, event),
  'copy-on-noop': copyOnNoop,
  'copy-unchanged-context': copyUnchangedContext,
}

const subjectMachineOf = (command: FsmCommand, behaviour: Behaviour): Fsm => {
  const fsm = machineOf(command, behaviour)
  return { ...fsm, transition: transitionWith[behaviour.fault](fsm, command.machine) }
}

const slotCarriesInheritedPatch = (spec: FsmMachine, event: FsmEvent): boolean => {
  const slot = slotOf(spec, event)
  return slot?._tag === 'Config' && slot.inherited !== 'none'
}

export interface FsmLedger {
  noopTransitions: number
  targetChanges: number
  contextPatches: number
  functionTransitions: number
  inheritedEventsIgnored: number
  inheritedPatchKeys: number
  unchangedPatches: number
  bareContexts: number
  emissions: number
  drivers: Record<FsmDriver, number>
  factories: Record<FsmCommand['factory'], number>
}

const noteStep = (ledger: FsmLedger, spec: FsmMachine, event: FsmEvent, previous: Snapshot, next: Snapshot): void => {
  ledger.noopTransitions += count(previous === next)
  ledger.targetChanges += count(previous.value !== next.value)
  ledger.contextPatches += count(previous.context !== next.context)
  ledger.functionTransitions += count(slotIsAdd(spec, event))
  ledger.inheritedEventsIgnored += count(isInherited(event.type) && previous === next)
  ledger.inheritedPatchKeys += count(slotCarriesInheritedPatch(spec, event))
  ledger.unchangedPatches += count(keepsPatchedContext(spec, event, previous, next))
}

type JsonValue = object | string | number | boolean | null | undefined

const keysOf = (snapshot: Snapshot): ReadonlyArray<string> => [
  Object.keys(snapshot).join(','),
  Object.keys(JSON.parse(JSON.stringify(snapshot, (_key: string, value: JsonValue) => value ?? null))).join(','),
]

const distinct = (lists: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(lists)]

const initialKeysOf = (fsm: Fsm): ReadonlyArray<string> => [
  ...keysOf(fsm.initialState),
  ...keysOf(fsm.getInitialSnapshot()),
]

interface Run {
  readonly snapshot: Snapshot
  readonly snapshotKeys: ReadonlyArray<string>
  readonly effects: number
  readonly emissions: ReadonlyArray<string>
  readonly contextKept: ReadonlyArray<boolean>
  readonly initialIdentity: boolean
}

const observationOf = (fsm: Fsm, run: Run): FsmObservation => {
  const [sentinel] = fsm.transition(run.snapshot, { type: 'toString' })
  return {
    value: run.snapshot.value,
    context: run.snapshot.context,
    status: run.snapshot.status,
    snapshotKeys: distinct([...initialKeysOf(fsm), ...run.snapshotKeys]),
    effects: run.effects,
    emissions: run.emissions,
    sentinelKeptIdentity: sentinel === run.snapshot,
    contextKept: run.contextKept,
    initialIdentity: run.initialIdentity,
  }
}

const stepThrough = (
  command: FsmCommand,
  ledger: FsmLedger,
  start: Snapshot,
  step: (snapshot: Snapshot, event: FsmEvent) => readonly [Snapshot, ReadonlyArray<object>],
): Omit<Run, 'initialIdentity'> => {
  let snapshot = start
  let effects = 0
  const snapshotKeys: Array<string> = []
  const contextKept: Array<boolean> = []
  for (const event of command.events) {
    const [next, emitted] = step(snapshot, event)
    noteStep(ledger, command.machine, event, snapshot, next)
    effects += emitted.length
    snapshotKeys.push(...keysOf(next))
    contextKept.push(next.context === snapshot.context)
    snapshot = next
  }
  return { snapshot, snapshotKeys, effects, emissions: [], contextKept }
}

const pureObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation =>
  observationOf(fsm, {
    ...stepThrough(command, ledger, fsm.initialState, (snapshot, event) => fsm.transition(snapshot, event)),
    initialIdentity: false,
  })

const entryObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation => {
  const [initial, initialEffects] = initialTransition(fsm)
  const initialIdentity = initial === fsm.initialState && fsm.getInitialSnapshot() === fsm.initialState
  const run = stepThrough(command, ledger, initial, (snapshot, event) => transition(fsm, snapshot, event))
  return observationOf(fsm, { ...run, effects: run.effects + initialEffects.length, initialIdentity })
}

const sendThrough = (
  actor: Actor<Fsm>,
  command: FsmCommand,
  events: ReadonlyArray<FsmEvent>,
  ledger: FsmLedger,
): Run => {
  const emissions: Array<string> = []
  const contextKept: Array<boolean> = []
  const subscription = actor.subscribe((snapshot) => {
    ledger.emissions += 1
    emissions.push(emissionOf(snapshot))
  })
  let previous = actor.getSnapshot()
  for (const event of events) {
    actor.send(event)
    const next = actor.getSnapshot()
    noteStep(ledger, command.machine, event, previous, next)
    contextKept.push(next.context === previous.context)
    previous = next
  }
  subscription.unsubscribe()
  actor.stop()
  return { snapshot: previous, snapshotKeys: [], effects: 0, emissions, contextKept, initialIdentity: false }
}

const actorObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation =>
  observationOf(fsm, sendThrough(createActor(fsm).start(), command, command.events, ledger))

const persistedObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation => {
  const actor = createActor(fsm).start()
  const [first, ...rest] = command.events
  if (first !== undefined) {
    actor.send(first)
  }
  const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()))
  actor.stop()
  return observationOf(fsm, sendThrough(createActor(fsm, { snapshot: persisted }).start(), command, rest, ledger))
}

const driverObservation = (fsm: Fsm, command: FsmCommand, ledger: FsmLedger): FsmObservation =>
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
  inheritedPatchKeys: 0,
  unchangedPatches: 0,
  bareContexts: 0,
  emissions: 0,
  drivers: { pure: 0, entry: 0, actor: 0, persisted: 0 },
  factories: { createFSM: 0, setup: 0 },
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
    observed.factories[command.factory] += 1
    observed.bareContexts += count(!command.machine.withContext)
    return driverObservation(subjectMachineOf(command, behaviour), command, observed)
  }
  return { observed, layer: Layer.succeed(FsmSubject, run) }
}

export const makeFsmSubject = (): FsmHandle =>
  subjectOf({ eventOwnership: 'own-only', patchOwnership: 'own-only', fault: 'none' })

export const makeCopyOnNoopSubject = (): FsmHandle =>
  subjectOf({ eventOwnership: 'own-only', patchOwnership: 'own-only', fault: 'copy-on-noop' })

export const makeCopyUnchangedContextSubject = (): FsmHandle =>
  subjectOf({ eventOwnership: 'own-only', patchOwnership: 'own-only', fault: 'copy-unchanged-context' })

export const makeInheritedEventSubject = (): FsmHandle =>
  subjectOf({ eventOwnership: 'materialised', patchOwnership: 'own-only', fault: 'none' })

export const makeInheritedPatchSubject = (): FsmHandle =>
  subjectOf({ eventOwnership: 'own-only', patchOwnership: 'materialised', fault: 'none' })

export const runFsmCommand = (command: FsmCommand): Effect.Effect<FsmObservation, never, FsmSubject> =>
  Effect.gen(function*() {
    const run = yield* FsmSubject
    return run(command)
  })
