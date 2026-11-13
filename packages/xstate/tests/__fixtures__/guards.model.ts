import { Match, Schema } from 'effect'

export const NODE_KEYS = ['root', 'L', 'R', 'p', 'c1', 'c2', 'q', 'r1', 'r2'] as const
export type NodeKey = (typeof NODE_KEYS)[number]

const IN_PATHS = ['L.p.c1', 'L.p.c2', 'L.q', 'R.r1', 'R.r2'] as const
type InPath = (typeof IN_PATHS)[number]

export type SlotTag = 'Absent' | 'Target' | 'Pattern' | 'Fn'

export const GuardsValueSchema = Schema.Struct({
  L: Schema.Union([Schema.Literal('q'), Schema.Struct({ p: Schema.Literals(['c1', 'c2']) })]),
  R: Schema.Literals(['r1', 'r2']),
})
export type GuardsValue = Schema.Schema.Type<typeof GuardsValueSchema>

export const GuardsContextSchema = Schema.Struct({ n: Schema.Finite })

export interface GuardsContext {
  readonly n: number
}

export interface GuardsEffectLike {
  readonly type: string
}

export interface GuardsEffect extends GuardsEffectLike {
  readonly type: 'effect'
  readonly at: NodeKey
}

interface Sim {
  readonly value: GuardsValue
  readonly n: number
}

const INITIAL_SIM: Sim = { value: { L: { p: 'c1' }, R: 'r1' }, n: 0 }

const Bump = Schema.Literals([0, 1])
const Zero = Schema.Literals([0])
const K = Schema.Literals([0, 1, 2, 3])
const T = Schema.Literals([1, 2, 3])
const AllTargets = Schema.Literals(['#c1', '#c2', '#p', '#q', '#r1', '#r2'])
const LTargets = Schema.Literals(['#c1', '#c2', '#p', '#q'])
const RTargets = Schema.Literals(['#r1', '#r2'])
const C2Targets = Schema.Literals(['#c1', '#q'])

const Evaluator = Schema.Union([
  Schema.TaggedStruct('Always', {}),
  Schema.TaggedStruct('Never', {}),
  Schema.TaggedStruct('ContextAtLeast', { t: T }),
  Schema.TaggedStruct('PayloadAtLeast', { t: T }),
  Schema.TaggedStruct('Named', { t: T }),
  Schema.TaggedStruct('In', { path: Schema.Literals(IN_PATHS) }),
])
export type Evaluator = Schema.Schema.Type<typeof Evaluator>

const StayBump = Schema.TaggedStruct('Stay', { bump: Bump })
const StayZero = Schema.TaggedStruct('Stay', { bump: Zero })
const EffectOutcome = Schema.TaggedStruct('Effect', {})
const GoAll = Schema.TaggedStruct('Go', { target: AllTargets, bump: Bump })
const GoL = Schema.TaggedStruct('Go', { target: LTargets, bump: Bump })
const GoR = Schema.TaggedStruct('Go', { target: RTargets, bump: Zero })
const GoC2 = Schema.TaggedStruct('Go', { target: C2Targets, bump: Zero })

export const Slot = Schema.Union([
  Schema.TaggedStruct('Absent', {}),
  Schema.TaggedStruct('Target', { target: AllTargets }),
  Schema.TaggedStruct('Pattern', { k: K, target: AllTargets }),
  Schema.TaggedStruct('Fn', { when: Evaluator, outcome: Schema.Union([GoAll, StayBump, EffectOutcome]) }),
])
export type Slot = Schema.Schema.Type<typeof Slot>

const Absent = Schema.TaggedStruct('Absent', {})
const TargetL = Schema.TaggedStruct('Target', { target: LTargets })
const PatternL = Schema.TaggedStruct('Pattern', { k: K, target: LTargets })
const FnL = Schema.TaggedStruct('Fn', { when: Evaluator, outcome: Schema.Union([GoL, StayBump, EffectOutcome]) })
const LGoSlot = Schema.Union([Absent, TargetL, PatternL, FnL])
const LTickSlot = Schema.Union([Absent, TargetL, FnL])

const TargetR = Schema.TaggedStruct('Target', { target: RTargets })
const PatternR = Schema.TaggedStruct('Pattern', { k: K, target: RTargets })
const FnR = Schema.TaggedStruct('Fn', { when: Evaluator, outcome: Schema.Union([GoR, StayZero, EffectOutcome]) })
const RGoSlot = Schema.Union([Absent, TargetR, PatternR, FnR])
const RTickSlot = Schema.Union([Absent, TargetR, FnR])

const FnRoot = Schema.TaggedStruct('Fn', { when: Evaluator, outcome: Schema.Union([StayBump, EffectOutcome]) })
const RootSlot = Schema.Union([Absent, FnRoot])

const LSlots = Schema.Struct({ GO: LGoSlot, TICK: LTickSlot })
const RSlots = Schema.Struct({ GO: RGoSlot, TICK: RTickSlot })
const RootSlots = Schema.Struct({ GO: RootSlot, TICK: RootSlot })
const C2Slots = Schema.Struct({
  GO: LGoSlot,
  TICK: LTickSlot,
  always: Schema.Struct({ when: Evaluator, outcome: GoC2 }),
})
const R2Slots = Schema.Struct({ GO: RGoSlot, TICK: RTickSlot, always: Schema.Struct({ when: Evaluator }) })

export const MachineSpec = Schema.Struct({
  root: RootSlots,
  L: LSlots,
  R: RSlots,
  p: LSlots,
  c1: LSlots,
  c2: C2Slots,
  q: LSlots,
  r1: RSlots,
  r2: R2Slots,
})
export type MachineSpec = Schema.Schema.Type<typeof MachineSpec>

const Driver = Schema.Literals(['actor', 'pure'])
export type Driver = Schema.Schema.Type<typeof Driver>

const Factory = Schema.Literals(['createMachine', 'setup', 'provide'])
export type Factory = Schema.Schema.Type<typeof Factory>

const ModelEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('GO'), k: K }),
  Schema.Struct({ type: Schema.Literal('TICK') }),
])
export type ModelEvent = Schema.Schema.Type<typeof ModelEvent>

export const GuardsCommand = Schema.TaggedStruct('Run', {
  machine: MachineSpec,
  events: Schema.Array(ModelEvent).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  driver: Driver,
  factory: Factory,
})
export type GuardsCommand = Schema.Schema.Type<typeof GuardsCommand>

export interface GuardsStep {
  readonly can: boolean
  readonly effects: ReadonlyArray<GuardsEffectLike>
}

export interface GuardsObservation {
  readonly value: GuardsValue
  readonly n: number
  readonly steps: ReadonlyArray<GuardsStep>
  readonly activeIds: ReadonlyArray<NodeKey>
  readonly activeIdsDataLast: ReadonlyArray<NodeKey>
}

export interface Resolution {
  readonly can: boolean
  readonly effects: ReadonlyArray<NodeKey>
  readonly admitted: ReadonlyArray<{ readonly node: NodeKey; readonly kind: SlotTag }>
  readonly rejected: ReadonlyArray<{ readonly node: NodeKey; readonly kind: SlotTag }>
  readonly namedAsked: boolean
  readonly inTrue: boolean
  readonly inFalse: boolean
  readonly rootAdmitted: boolean
  readonly rootRejected: boolean
  readonly eventlessL: boolean
  readonly eventlessR: boolean
  readonly crossRegionInterim: boolean
  readonly after: Sim
}

const tagOf = (slot: Slot): SlotTag =>
  Match.value(slot).pipe(
    Match.tag('Absent', (): SlotTag => 'Absent'),
    Match.tag('Target', (): SlotTag => 'Target'),
    Match.tag('Pattern', (): SlotTag => 'Pattern'),
    Match.tag('Fn', (): SlotTag => 'Fn'),
    Match.exhaustive,
  )

const evaluatorOf = (slot: Slot): Evaluator | undefined =>
  Match.value(slot).pipe(
    Match.tag('Fn', (fn) => fn.when),
    Match.orElse(() => undefined),
  )

const answersTag = (evaluator: Evaluator, tag: 'Named' | 'In'): boolean =>
  Match.value(evaluator).pipe(
    Match.tag('Named', () => tag === 'Named'),
    Match.tag('In', () => tag === 'In'),
    Match.orElse(() => false),
  )

const slotOf = (spec: MachineSpec, node: NodeKey, event: ModelEvent): Slot =>
  event.type === 'GO' ? spec[node].GO : spec[node].TICK

const matchesOf = (path: InPath, value: GuardsValue): boolean =>
  Match.value(path).pipe(
    Match.when('L.p.c1', () => value.L !== 'q' && value.L.p === 'c1'),
    Match.when('L.p.c2', () => value.L !== 'q' && value.L.p === 'c2'),
    Match.when('L.q', () => value.L === 'q'),
    Match.when('R.r1', () => value.R === 'r1'),
    Match.when('R.r2', () => value.R === 'r2'),
    Match.exhaustive,
  )

const holds = (when: Evaluator, sim: Sim, event: ModelEvent | undefined): boolean =>
  Match.value(when).pipe(
    Match.when({ _tag: 'Always' }, () => true),
    Match.when({ _tag: 'Never' }, () => false),
    Match.when({ _tag: 'ContextAtLeast' }, ({ t }) => sim.n >= t),
    Match.when({ _tag: 'PayloadAtLeast' }, ({ t }) => event !== undefined && event.type === 'GO' && event.k >= t),
    Match.when({ _tag: 'Named' }, ({ t }) => sim.n >= t),
    Match.when({ _tag: 'In' }, ({ path }) => matchesOf(path, sim.value)),
    Match.exhaustive,
  )

interface Admission {
  readonly target: string | undefined
  readonly bump: number
  readonly effect: boolean
}

const admit = (slot: Slot, sim: Sim, event: ModelEvent): Admission | undefined =>
  Match.value(slot).pipe(
    Match.when({ _tag: 'Absent' }, () => undefined),
    Match.when({ _tag: 'Target' }, ({ target }) => ({ target, bump: 0, effect: false })),
    Match.when(
      { _tag: 'Pattern' },
      ({ k, target }) => event.type === 'GO' && event.k === k ? { target, bump: 0, effect: false } : undefined,
    ),
    Match.when(
      { _tag: 'Fn' },
      ({ when, outcome }) =>
        holds(when, sim, event)
          ? Match.value(outcome).pipe(
            Match.when({ _tag: 'Go' }, ({ target, bump }) => ({ target, bump, effect: false })),
            Match.when({ _tag: 'Stay' }, ({ bump }) => ({ target: undefined, bump, effect: false })),
            Match.when({ _tag: 'Effect' }, () => ({ target: undefined, bump: 0, effect: true })),
            Match.exhaustive,
          )
          : undefined,
    ),
    Match.exhaustive,
  )

const withTarget = (value: GuardsValue, target: string): GuardsValue =>
  Match.value(target).pipe(
    Match.when('#c1', () => ({ ...value, L: { p: 'c1' as const } })),
    Match.when('#c2', () => ({ ...value, L: { p: 'c2' as const } })),
    Match.when('#p', () => ({ ...value, L: { p: 'c1' as const } })),
    Match.when('#q', () => ({ ...value, L: 'q' as const })),
    Match.when('#r1', () => ({ ...value, R: 'r1' as const })),
    Match.when('#r2', () => ({ ...value, R: 'r2' as const })),
    Match.orElse(() => value),
  )

const lKey = (value: GuardsValue): string => value.L === 'q' ? 'q' : value.L.p

const lOrder = (value: GuardsValue): ReadonlyArray<NodeKey> => value.L === 'q' ? ['q', 'L'] : [value.L.p, 'p', 'L']

const rOrder = (value: GuardsValue): ReadonlyArray<NodeKey> => [value.R, 'R']

interface Trace {
  readonly admitted: Array<{ readonly node: NodeKey; readonly kind: SlotTag }>
  readonly rejected: Array<{ readonly node: NodeKey; readonly kind: SlotTag }>
  namedAsked: boolean
  inTrue: boolean
  inFalse: boolean
}

const ask = (
  spec: MachineSpec,
  nodes: ReadonlyArray<NodeKey>,
  sim: Sim,
  event: ModelEvent,
  trace: Trace,
): { readonly node: NodeKey; readonly admission: Admission } | undefined => {
  for (const node of nodes) {
    const slot = slotOf(spec, node, event)
    const evaluator = evaluatorOf(slot)
    if (evaluator !== undefined) {
      if (answersTag(evaluator, 'Named')) {
        trace.namedAsked = true
      }
      if (answersTag(evaluator, 'In')) {
        if (holds(evaluator, sim, event)) {
          trace.inTrue = true
        } else {
          trace.inFalse = true
        }
      }
    }
    const admission = admit(slot, sim, event)
    if (admission === undefined) {
      trace.rejected.push({ node, kind: tagOf(slot) })
      continue
    }
    trace.admitted.push({ node, kind: tagOf(slot) })
    return { node, admission }
  }
  return undefined
}

const settle = (
  spec: MachineSpec,
  sim: Sim,
  event: ModelEvent,
): { readonly sim: Sim; readonly L: boolean; readonly R: boolean } => {
  let value = sim.value
  let l = false
  let r = false
  let rounds = 0
  for (;;) {
    const lFires = value.L !== 'q' && value.L.p === 'c2' &&
      holds(spec.c2.always.when, { value, n: sim.n }, event)
    const rFires = value.R === 'r2' && holds(spec.r2.always.when, { value, n: sim.n }, event)
    if (!lFires && !rFires) {
      return { sim: { value, n: sim.n }, L: l, R: r }
    }
    if (lFires) {
      value = withTarget(value, spec.c2.always.outcome.target)
      l = true
    }
    if (rFires) {
      value = withTarget(value, '#r1')
      r = true
    }
    rounds += 1
    if (rounds > 8) {
      throw new Error('eventless loop did not settle')
    }
  }
}

const resolveEvent = (spec: MachineSpec, sim: Sim, event: ModelEvent): Resolution => {
  const trace: Trace = { admitted: [], rejected: [], namedAsked: false, inTrue: false, inFalse: false }
  const L = ask(spec, lOrder(sim.value), sim, event, trace)
  const R = ask(spec, rOrder(sim.value), sim, event, trace)
  const regionAdmitted = L !== undefined || R !== undefined
  const root = regionAdmitted ? undefined : ask(spec, ['root'], sim, event, trace)

  let value = sim.value
  let n = sim.n
  const effects: Array<NodeKey> = []
  const apply = (asked: { readonly node: NodeKey; readonly admission: Admission }): void => {
    if (asked.admission.target !== undefined) {
      value = withTarget(value, asked.admission.target)
    }
    if (asked.admission.bump !== 0) {
      n = (n + asked.admission.bump) % 4
    }
    if (asked.admission.effect) {
      effects.push(asked.node)
    }
  }

  if (L !== undefined) {
    apply(L)
  }
  if (R !== undefined) {
    apply(R)
  }
  if (root !== undefined) {
    apply(root)
  }

  const movedL = lKey(value) !== lKey(sim.value)
  const settled = settle(spec, { value, n }, event)

  return {
    can: regionAdmitted || root !== undefined,
    effects,
    admitted: trace.admitted,
    rejected: trace.rejected,
    namedAsked: trace.namedAsked,
    inTrue: trace.inTrue,
    inFalse: trace.inFalse,
    rootAdmitted: root !== undefined,
    rootRejected: !regionAdmitted && root === undefined,
    eventlessL: settled.L,
    eventlessR: settled.R,
    crossRegionInterim: settled.R && movedL,
    after: settled.sim,
  }
}

export const analyseRun = (command: GuardsCommand): ReadonlyArray<Resolution> => {
  const resolutions: Array<Resolution> = []
  let sim = INITIAL_SIM
  for (const event of command.events) {
    const resolution = resolveEvent(command.machine, sim, event)
    resolutions.push(resolution)
    sim = resolution.after
  }
  return resolutions
}

const activeIdsOf = (value: GuardsValue): ReadonlyArray<NodeKey> =>
  NODE_KEYS.filter((key) =>
    Match.value(key).pipe(
      Match.when('root', () => true),
      Match.when('L', () => true),
      Match.when('R', () => true),
      Match.when('p', () => value.L !== 'q'),
      Match.when('c1', () => value.L !== 'q' && value.L.p === 'c1'),
      Match.when('c2', () => value.L !== 'q' && value.L.p === 'c2'),
      Match.when('q', () => value.L === 'q'),
      Match.when('r1', () => value.R === 'r1'),
      Match.when('r2', () => value.R === 'r2'),
      Match.exhaustive,
    )
  )

const GuardsModelState = Schema.Struct({})
type GuardsModelState = Schema.Schema.Type<typeof GuardsModelState>

export const guardsModel = {
  state: GuardsModelState,
  initial: {},
  precondition: (): boolean => true,
  step: (state: GuardsModelState, command: GuardsCommand): readonly [GuardsModelState, GuardsObservation] => {
    const run = analyseRun(command)
    const final = run.at(-1)?.after ?? INITIAL_SIM
    const ids = activeIdsOf(final.value)
    return [
      state,
      {
        value: final.value,
        n: final.n,
        steps: run.map((step) => ({
          can: step.can,
          effects: step.effects.map((at): GuardsEffect => ({ type: 'effect', at })),
        })),
        activeIds: ids,
        activeIdsDataLast: ids,
      },
    ]
  },
}
