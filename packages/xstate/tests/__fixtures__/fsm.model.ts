import { Match, Schema } from 'effect'

const StateName = Schema.Literals(['idle', 'active', 'done'])

const TargetChoice = Schema.Union([Schema.Literals(['same']), StateName])
const CountChoice = Schema.Union([Schema.Literals(['keep']), Schema.Literals([0, 1, 2])])
const TagChoice = Schema.Union([Schema.Literals(['keep']), Schema.Literals(['base', 'next'])])

const EmptySlot = Schema.TaggedStruct('Empty', {})
const TargetSlot = Schema.TaggedStruct('Target', { target: TargetChoice })
const OwnPatch = Schema.Struct({ count: CountChoice, tag: TagChoice })
const InheritedPatchChoice = Schema.Literals(['none', 'count', 'tag'])
const ConfigSlot = Schema.TaggedStruct('Config', {
  target: TargetChoice,
  patch: OwnPatch,
  inherited: InheritedPatchChoice,
})
const AddSlot = Schema.TaggedStruct('Add', { target: TargetChoice })
const AbsentSlot = Schema.TaggedStruct('Absent', {})

const PlainSlot = Schema.Union([EmptySlot, TargetSlot, ConfigSlot])
const BumpSlot = Schema.Union([EmptySlot, TargetSlot, ConfigSlot, AddSlot, AbsentSlot])

const PrototypeChoice = Schema.Union([Schema.Literals(['keep']), StateName])
const BareStateChoice = Schema.Union([Schema.Literals(['none']), StateName])

export const FsmMachine = Schema.Struct({
  initial: StateName,
  withContext: Schema.Boolean,
  toggle: PlainSlot,
  noop: PlainSlot,
  bump: BumpSlot,
  inheritedToggle: PrototypeChoice,
  bareState: BareStateChoice,
})
export type FsmMachine = Schema.Schema.Type<typeof FsmMachine>
export type FsmSlot = Schema.Schema.Type<typeof BumpSlot>

export type FsmStateName = Schema.Schema.Type<typeof StateName>

const SentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literals(['toggle']) }),
  Schema.Struct({ type: Schema.Literals(['noop']) }),
  Schema.Struct({ type: Schema.Literals(['bump']), by: Schema.Literals([0, 1, 2]) }),
  Schema.Struct({ type: Schema.Literals(['toString']) }),
  Schema.Struct({ type: Schema.Literals(['constructor']) }),
])
export type FsmEvent = Schema.Schema.Type<typeof SentEvent>

const Driver = Schema.Literals(['pure', 'entry', 'actor', 'persisted'])
export type FsmDriver = Schema.Schema.Type<typeof Driver>

const Factory = Schema.Literals(['createFSM', 'setup'])

export const FsmCommand = Schema.TaggedStruct('Run', {
  machine: FsmMachine,
  events: Schema.Array(SentEvent),
  driver: Driver,
  factory: Factory,
})
export type FsmCommand = Schema.Schema.Type<typeof FsmCommand>

export interface FsmContext {
  readonly count?: number
  readonly tag?: string
}

export interface FsmObservation {
  readonly value: string
  readonly context: FsmContext
  readonly status: string
  readonly snapshotKeys: ReadonlyArray<string>
  readonly effects: number
  readonly emissions: ReadonlyArray<string>
  readonly sentinelKeptIdentity: boolean
  readonly contextKept: ReadonlyArray<boolean>
  readonly initialIdentity: boolean
}

export const emissionOf = (snapshot: { readonly value: string; readonly context: FsmContext }): string =>
  `${snapshot.value}:${String(snapshot.context.count)}:${String(snapshot.context.tag)}`

const emptySlot: FsmSlot = { _tag: 'Empty' }

const slotFor = (machine: FsmMachine, event: FsmEvent): FsmSlot =>
  Match.value(event.type).pipe(
    Match.when('toggle', () => machine.toggle),
    Match.when('noop', () => machine.noop),
    Match.when('bump', () => machine.bump),
    Match.orElse(() => emptySlot),
  )

const slotIn = (machine: FsmMachine, value: string, event: FsmEvent): FsmSlot =>
  value === machine.bareState ? emptySlot : slotFor(machine, event)

const bumpBy = (event: FsmEvent): number => event.type === 'bump' ? event.by : 0

const targetValue = (choice: 'same' | 'idle' | 'active' | 'done'): string | undefined =>
  choice === 'same' ? undefined : choice

const countEntry = (choice: 'keep' | 0 | 1 | 2): { readonly count?: number } =>
  choice === 'keep' ? {} : { count: choice }

const tagEntry = (choice: 'keep' | 'base' | 'next'): { readonly tag?: string } =>
  choice === 'keep' ? {} : { tag: choice }

export const patchValuesOf = (
  patch: { readonly count: 'keep' | 0 | 1 | 2; readonly tag: 'keep' | 'base' | 'next' },
) => ({
  ...countEntry(patch.count),
  ...tagEntry(patch.tag),
})

interface PatchValues {
  readonly count?: number
  readonly tag?: string
}

interface SlotResolution {
  readonly target: string | undefined
  readonly patch: PatchValues | undefined
}

const resolveSlot = (slot: FsmSlot, event: FsmEvent, context: FsmContext): SlotResolution =>
  Match.valueTags(slot, {
    Empty: (): SlotResolution => ({ target: undefined, patch: undefined }),
    Target: (target): SlotResolution => ({ target: targetValue(target.target), patch: undefined }),
    Config: (config): SlotResolution => ({ target: targetValue(config.target), patch: patchValuesOf(config.patch) }),
    Add: (add): SlotResolution => ({
      target: targetValue(add.target),
      patch: { count: (context.count ?? 0) + bumpBy(event) },
    }),
    Absent: (): SlotResolution => ({ target: undefined, patch: undefined }),
  })

const entryDiffers = (key: string, value: string | number, context: FsmContext): boolean =>
  key === 'count' ? value !== context.count : value !== context.tag

const patchChanges = (patch: PatchValues | undefined, context: FsmContext): boolean =>
  patch === undefined ? false : Object.entries(patch).some(([key, value]) => entryDiffers(key, value, context))

interface FsmSim {
  readonly value: string
  readonly context: FsmContext
}

const stepOf = (machine: FsmMachine, sim: FsmSim, event: FsmEvent): FsmSim => {
  const resolution = resolveSlot(slotIn(machine, sim.value, event), event, sim.context)
  const value = resolution.target ?? sim.value
  const context = patchChanges(resolution.patch, sim.context)
    ? { ...sim.context, ...resolution.patch }
    : sim.context
  return { value, context }
}

export const initialContextOf = (machine: FsmMachine): FsmContext =>
  machine.withContext ? { count: 0, tag: 'base' } : {}

const trace = (machine: FsmMachine, start: FsmSim, events: ReadonlyArray<FsmEvent>): ReadonlyArray<FsmSim> =>
  events.reduce<ReadonlyArray<FsmSim>>(
    (sims, event) => [...sims, stepOf(machine, sims.at(-1) ?? start, event)],
    [],
  )

const emissionsOf = (sims: ReadonlyArray<FsmSim>): ReadonlyArray<string> => sims.map(emissionOf)

const keptAlong = (machine: FsmMachine, start: FsmSim, events: ReadonlyArray<FsmEvent>): ReadonlyArray<boolean> =>
  trace(machine, start, events).reduce<{ readonly previous: FsmSim; readonly kept: ReadonlyArray<boolean> }>(
    (along, sim) => ({ previous: sim, kept: [...along.kept, sim.context === along.previous.context] }),
    { previous: start, kept: [] },
  ).kept

const restoredFrom = (machine: FsmMachine, start: FsmSim, first: FsmEvent | undefined): FsmSim =>
  first === undefined ? start : stepOf(machine, start, first)

const emittedAfterRestore = (machine: FsmMachine, start: FsmSim, events: ReadonlyArray<FsmEvent>) => {
  const [first, ...rest] = events
  return emissionsOf(trace(machine, restoredFrom(machine, start, first), rest))
}

const keptAfterRestore = (machine: FsmMachine, start: FsmSim, events: ReadonlyArray<FsmEvent>) => {
  const [first, ...rest] = events
  return keptAlong(machine, restoredFrom(machine, start, first), rest)
}

const expectedKept = (command: FsmCommand, start: FsmSim): ReadonlyArray<boolean> =>
  Match.value(command.driver).pipe(
    Match.when('persisted', () => keptAfterRestore(command.machine, start, command.events)),
    Match.orElse(() => keptAlong(command.machine, start, command.events)),
  )

const expectedEmissions = (command: FsmCommand, start: FsmSim): ReadonlyArray<string> =>
  Match.value(command.driver).pipe(
    Match.when('actor', () => emissionsOf(trace(command.machine, start, command.events))),
    Match.when('persisted', () => emittedAfterRestore(command.machine, start, command.events)),
    Match.orElse(() => []),
  )

const ownSnapshotKeys = ['status,value,context,output,error']

const observationOf = (command: FsmCommand): FsmObservation => {
  const start: FsmSim = { value: command.machine.initial, context: initialContextOf(command.machine) }
  const sim = trace(command.machine, start, command.events).at(-1) ?? start
  return {
    value: sim.value,
    context: sim.context,
    status: 'active',
    snapshotKeys: ownSnapshotKeys,
    effects: 0,
    emissions: expectedEmissions(command, start),
    sentinelKeptIdentity: true,
    contextKept: expectedKept(command, start),
    initialIdentity: command.driver === 'entry',
  }
}

const FsmModelState = Schema.Struct({})
type FsmModelState = Schema.Schema.Type<typeof FsmModelState>

export const fsmModel = {
  state: FsmModelState,
  initial: {},
  precondition: (): boolean => true,
  step: (state: FsmModelState, command: FsmCommand): readonly [FsmModelState, FsmObservation] =>
    [state, observationOf(command)] as const,
}
