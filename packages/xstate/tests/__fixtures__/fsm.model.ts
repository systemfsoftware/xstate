import { Match, Schema } from 'effect'

const StateName = Schema.Literals(['idle', 'active', 'done'])

const TargetChoice = Schema.Union([Schema.Literals(['same']), StateName])
const CountChoice = Schema.Union([Schema.Literals(['keep']), Schema.Literals([0, 1, 2])])
const TagChoice = Schema.Union([Schema.Literals(['keep']), Schema.Literals(['base', 'next'])])

const EmptySlot = Schema.TaggedStruct('Empty', {})
const TargetSlot = Schema.TaggedStruct('Target', { target: TargetChoice })
const OwnPatch = Schema.Struct({ count: CountChoice, tag: TagChoice })
const ConfigSlot = Schema.TaggedStruct('Config', { target: TargetChoice, patch: OwnPatch })
const AddSlot = Schema.TaggedStruct('Add', { target: TargetChoice })

const PlainSlot = Schema.Union([EmptySlot, TargetSlot, ConfigSlot])
const BumpSlot = Schema.Union([EmptySlot, TargetSlot, ConfigSlot, AddSlot])

const PrototypeChoice = Schema.Union([Schema.Literals(['keep']), StateName])

export const FsmMachine = Schema.Struct({
  initial: StateName,
  toggle: PlainSlot,
  noop: PlainSlot,
  bump: BumpSlot,
  inheritedToggle: PrototypeChoice,
})
export type FsmMachine = Schema.Schema.Type<typeof FsmMachine>
export type FsmSlot = Schema.Schema.Type<typeof PlainSlot> | Schema.Schema.Type<typeof AddSlot>

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

export const FsmCommand = Schema.TaggedStruct('Run', {
  machine: FsmMachine,
  events: Schema.Array(SentEvent),
  driver: Driver,
})
export type FsmCommand = Schema.Schema.Type<typeof FsmCommand>

export interface FsmContext {
  readonly count: number
  readonly tag: string
}

export interface FsmObservation {
  readonly value: string
  readonly context: FsmContext
  readonly sentinelKeptIdentity: boolean
  readonly initialIdentity: boolean
}

const emptySlot: FsmSlot = { _tag: 'Empty' }

const slotFor = (machine: FsmMachine, event: FsmEvent): FsmSlot =>
  Match.value(event.type).pipe(
    Match.when('toggle', () => machine.toggle),
    Match.when('noop', () => machine.noop),
    Match.when('bump', () => machine.bump),
    Match.orElse(() => emptySlot),
  )

export const bumpBy = (event: FsmEvent): number => event.type === 'bump' ? event.by : 0

export const targetValue = (choice: 'same' | 'idle' | 'active' | 'done'): string | undefined =>
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
      patch: { count: context.count + bumpBy(event) },
    }),
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
  const resolution = resolveSlot(slotFor(machine, event), event, sim.context)
  const value = resolution.target ?? sim.value
  const context = patchChanges(resolution.patch, sim.context)
    ? { ...sim.context, ...resolution.patch }
    : sim.context
  return { value, context }
}

export const initialContext: FsmContext = { count: 0, tag: 'base' }

const simulate = (machine: FsmMachine, events: ReadonlyArray<FsmEvent>): FsmSim =>
  events.reduce<FsmSim>(
    (sim, event) => stepOf(machine, sim, event),
    { value: machine.initial, context: initialContext },
  )

const observationOf = (command: FsmCommand): FsmObservation => {
  const sim = simulate(command.machine, command.events)
  return {
    value: sim.value,
    context: sim.context,
    sentinelKeptIdentity: true,
    initialIdentity: command.driver === 'entry',
  }
}

export const FsmModelState = Schema.Struct({})
export type FsmModelState = Schema.Schema.Type<typeof FsmModelState>

export const fsmModel = {
  state: FsmModelState,
  initial: {},
  precondition: (): boolean => true,
  step: (state: FsmModelState, command: FsmCommand): readonly [FsmModelState, FsmObservation] =>
    [state, observationOf(command)] as const,
}
