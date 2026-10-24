import {
  type AnyMachineSnapshot,
  type AnyStateMachine,
  checkStateIn,
  createActor,
  createMachine,
  initialTransition,
  matchesState,
  setup,
  type StateValue,
  transition,
  types,
} from '@systemfsoftware/xstate'
import { Context, Effect, Layer, Match, Result, Schema } from 'effect'
import {
  analyseRun,
  type Driver,
  type Evaluator,
  type Factory,
  type GuardsCommand,
  type GuardsContext,
  GuardsContextSchema,
  type GuardsEffect,
  type GuardsEffectLike,
  type GuardsObservation,
  type GuardsStep,
  GuardsValueSchema,
  type MachineSpec,
  NODE_KEYS,
  type NodeKey,
  type Resolution,
  type Slot,
  type SlotTag,
} from './guards.model.js'

type GuardSource = (...args: ReadonlyArray<number>) => boolean

const atLeast: GuardSource = (x, t) => x >= t

const neverAtLeast: GuardSource = () => false

type SubjectEvent = { readonly type: 'GO'; readonly k: number } | { readonly type: 'TICK' }

interface SelectionArgs {
  readonly context: GuardsContext
  readonly event: SubjectEvent
  readonly value: StateValue
  readonly guards: Readonly<Record<string, GuardSource | undefined>>
}

interface Enqueue {
  emit(event: GuardsEffect): void
}

interface TransitionOutcome {
  readonly target?: string
  readonly context?: { readonly n: number }
}

type TransitionEntry = (args: SelectionArgs, enq: Enqueue) => TransitionOutcome | undefined

type ObjectEntry =
  | { readonly target: string; readonly matches?: { readonly k: number } }
  | TransitionEntry

type Fault = 'none' | 'rejects-as-empty' | 'drops-effect'

const count = (flag: boolean): number => flag ? 1 : 0

const holdsInSubject = (when: Evaluator, args: SelectionArgs): boolean =>
  Match.value(when).pipe(
    Match.when({ _tag: 'Always' }, () => true),
    Match.when({ _tag: 'Never' }, () => false),
    Match.when({ _tag: 'ContextAtLeast' }, ({ t }) => args.context.n >= t),
    Match.when({ _tag: 'PayloadAtLeast' }, ({ t }) => args.event.type === 'GO' && args.event.k >= t),
    Match.when({ _tag: 'Named' }, ({ t }) => {
      const source = args.guards['atLeast']
      return source === undefined ? false : source(args.context.n, t)
    }),
    Match.when({ _tag: 'In' }, ({ path }) => matchesState(path, args.value)),
    Match.exhaustive,
  )

const outcomeOf = (
  outcome: Extract<Slot, { readonly _tag: 'Fn' }>['outcome'],
  node: NodeKey,
  args: SelectionArgs,
  enq: Enqueue,
): TransitionOutcome | undefined =>
  Match.value(outcome).pipe(
    Match.when({ _tag: 'Go' }, ({ target, bump }) => ({
      target,
      ...(bump === 0 ? {} : { context: { n: (args.context.n + bump) % 4 } }),
    })),
    Match.when({ _tag: 'Stay' }, ({ bump }) => bump === 0 ? {} : { context: { n: (args.context.n + bump) % 4 } }),
    Match.when({ _tag: 'Effect' }, () => {
      enq.emit({ type: 'effect', at: node })
      return undefined
    }),
    Match.exhaustive,
  )

const dropsEffect = (outcome: Extract<Slot, { readonly _tag: 'Fn' }>['outcome']): boolean =>
  Match.value(outcome).pipe(
    Match.tag('Effect', () => true),
    Match.orElse(() => false),
  )

const transitionFn =
  (slot: Extract<Slot, { readonly _tag: 'Fn' }>, node: NodeKey, fault: Fault): TransitionEntry =>
  (args: SelectionArgs, enq: Enqueue): TransitionOutcome | undefined => {
    if (!holdsInSubject(slot.when, args)) {
      return fault === 'rejects-as-empty' ? {} : undefined
    }
    if (dropsEffect(slot.outcome) && fault === 'drops-effect') {
      return undefined
    }
    return outcomeOf(slot.outcome, node, args, enq)
  }

const entryOf = (spec: MachineSpec, node: NodeKey, slot: Slot, fault: Fault): ObjectEntry | string | undefined =>
  Match.value(slot).pipe(
    Match.when({ _tag: 'Absent' }, () => undefined),
    Match.when({ _tag: 'Target' }, ({ target }) => target),
    Match.when({ _tag: 'Pattern' }, ({ k, target }) => ({ target, matches: { k } })),
    Match.when({ _tag: 'Fn' }, (fn) => transitionFn(fn, node, fault)),
    Match.exhaustive,
  )

const entryObjectOf = (spec: MachineSpec, node: NodeKey, slot: Slot, fault: Fault): ObjectEntry | undefined =>
  Match.value(slot).pipe(
    Match.when({ _tag: 'Absent' }, () => undefined),
    Match.when({ _tag: 'Target' }, ({ target }) => ({ target })),
    Match.when({ _tag: 'Pattern' }, ({ k, target }) => ({ target, matches: { k } })),
    Match.when({ _tag: 'Fn' }, (fn) => transitionFn(fn, node, fault)),
    Match.exhaustive,
  )

const onOf = (spec: MachineSpec, node: NodeKey, fault: Fault) => {
  const go = entryOf(spec, node, spec[node].GO, fault)
  const tick = entryOf(spec, node, spec[node].TICK, fault)
  return { ...(go === undefined ? {} : { GO: go }), ...(tick === undefined ? {} : { TICK: tick }) }
}

const onObjectOf = (spec: MachineSpec, node: NodeKey, fault: Fault) => {
  const go = entryObjectOf(spec, node, spec[node].GO, fault)
  const tick = entryObjectOf(spec, node, spec[node].TICK, fault)
  return { ...(go === undefined ? {} : { GO: go }), ...(tick === undefined ? {} : { TICK: tick }) }
}

const alwaysOf = (spec: MachineSpec): TransitionEntry => (args: SelectionArgs): TransitionOutcome | undefined =>
  holdsInSubject(spec.c2.always.when, args) ? { target: spec.c2.always.outcome.target } : undefined

const alwaysOfR2 = (spec: MachineSpec): TransitionEntry => (args: SelectionArgs): TransitionOutcome | undefined =>
  holdsInSubject(spec.r2.always.when, args) ? { target: '#r1' } : undefined

const configWith = (
  spec: MachineSpec,
  onOfNode: (node: NodeKey) => Readonly<Record<string, ObjectEntry | string>>,
) => ({
  id: 'root',
  type: 'parallel' as const,
  context: { n: 0 },
  on: onOfNode('root'),
  states: {
    L: {
      id: 'L',
      type: 'compound' as const,
      initial: 'p',
      on: onOfNode('L'),
      states: {
        p: {
          id: 'p',
          type: 'compound' as const,
          initial: 'c1',
          on: onOfNode('p'),
          states: {
            c1: { id: 'c1', type: 'atomic' as const, on: onOfNode('c1') },
            c2: { id: 'c2', type: 'atomic' as const, on: onOfNode('c2'), always: alwaysOf(spec) },
          },
        },
        q: { id: 'q', type: 'atomic' as const, on: onOfNode('q') },
      },
    },
    R: {
      id: 'R',
      type: 'compound' as const,
      initial: 'r1',
      on: onOfNode('R'),
      states: {
        r1: { id: 'r1', type: 'atomic' as const, on: onOfNode('r1') },
        r2: { id: 'r2', type: 'atomic' as const, on: onOfNode('r2'), always: alwaysOfR2(spec) },
      },
    },
  },
})

const configObjectWith = (
  spec: MachineSpec,
  onOfNode: (node: NodeKey) => { GO?: ObjectEntry; TICK?: ObjectEntry },
) => ({
  id: 'root',
  type: 'parallel' as const,
  context: { n: 0 },
  on: onOfNode('root'),
  states: {
    L: {
      id: 'L',
      type: 'compound' as const,
      initial: 'p',
      on: onOfNode('L'),
      states: {
        p: {
          id: 'p',
          type: 'compound' as const,
          initial: 'c1',
          on: onOfNode('p'),
          states: {
            c1: { id: 'c1', type: 'atomic' as const, on: onOfNode('c1') },
            c2: { id: 'c2', type: 'atomic' as const, on: onOfNode('c2'), always: alwaysOf(spec) },
          },
        },
        q: { id: 'q', type: 'atomic' as const, on: onOfNode('q') },
      },
    },
    R: {
      id: 'R',
      type: 'compound' as const,
      initial: 'r1',
      on: onOfNode('R'),
      states: {
        r1: { id: 'r1', type: 'atomic' as const, on: onOfNode('r1') },
        r2: { id: 'r2', type: 'atomic' as const, on: onOfNode('r2'), always: alwaysOfR2(spec) },
      },
    },
  },
})

const configOf = (spec: MachineSpec, fault: Fault) => configWith(spec, (node) => onOf(spec, node, fault))

const configObjectOf = (spec: MachineSpec, fault: Fault) =>
  configObjectWith(spec, (node) => onObjectOf(spec, node, fault))

const configuredSetup = setup({
  guards: { atLeast },
  schemas: {
    context: types<{ n: number }>(),
    events: { GO: types<{ k: number }>(), TICK: types<{}>() },
  },
})

const machineOf = (spec: MachineSpec, factory: Factory, fault: Fault): AnyStateMachine =>
  Match.value(factory).pipe(
    Match.when('createMachine', () => createMachine({ guards: { atLeast }, ...configOf(spec, fault) })),
    Match.when('setup', () => configuredSetup.createMachine(configObjectOf(spec, fault))),
    Match.when('provide', () =>
      createMachine({ guards: { atLeast: neverAtLeast }, ...configOf(spec, fault) }).provide({
        guards: { atLeast },
      })),
    Match.exhaustive,
  )

export interface GuardsLedger {
  drivers: Record<Driver, number>
  factories: Record<Factory, number>
  admitted: Record<SlotTag, number>
  rejected: Record<SlotTag, number>
  fallbackToP: number
  fallbackToRegion: number
  fallbackToRoot: number
  rootAdmitted: number
  rootRejected: number
  effectsAdmitted: number
  patternMatched: number
  patternMismatched: number
  namedAsked: Record<Factory, number>
  inTrue: number
  inFalse: number
  eventlessL: number
  eventlessR: number
  crossRegionInterim: number
  canTrue: number
  canFalse: number
  checkStateIn: {
    dataFirst: { true: number; false: number }
    dataLast: { true: number; false: number }
  }
}

const emptyLedger = (): GuardsLedger => ({
  drivers: { actor: 0, pure: 0 },
  factories: { createMachine: 0, setup: 0, provide: 0 },
  admitted: { Absent: 0, Target: 0, Pattern: 0, Fn: 0 },
  rejected: { Absent: 0, Target: 0, Pattern: 0, Fn: 0 },
  fallbackToP: 0,
  fallbackToRegion: 0,
  fallbackToRoot: 0,
  rootAdmitted: 0,
  rootRejected: 0,
  effectsAdmitted: 0,
  patternMatched: 0,
  patternMismatched: 0,
  namedAsked: { createMachine: 0, setup: 0, provide: 0 },
  inTrue: 0,
  inFalse: 0,
  eventlessL: 0,
  eventlessR: 0,
  crossRegionInterim: 0,
  canTrue: 0,
  canFalse: 0,
  checkStateIn: { dataFirst: { true: 0, false: 0 }, dataLast: { true: 0, false: 0 } },
})

const noteResolution = (ledger: GuardsLedger, command: GuardsCommand, resolutions: ReadonlyArray<Resolution>): void => {
  for (const resolution of resolutions) {
    for (const entry of resolution.admitted) {
      ledger.admitted[entry.kind] += 1
      ledger.patternMatched += count(entry.kind === 'Pattern')
    }
    for (const entry of resolution.rejected) {
      ledger.rejected[entry.kind] += 1
      ledger.patternMismatched += count(entry.kind === 'Pattern')
    }
    ledger.fallbackToP += count(resolution.rejected.some((entry) => entry.node === 'c1' || entry.node === 'c2'))
    ledger.fallbackToRegion += count(resolution.rejected.some((entry) => entry.node === 'L' || entry.node === 'R'))
    ledger.fallbackToRoot += count(resolution.rootAdmitted || resolution.rootRejected)
    ledger.rootAdmitted += count(resolution.rootAdmitted)
    ledger.rootRejected += count(resolution.rootRejected)
    ledger.namedAsked[command.factory] += count(resolution.namedAsked)
    ledger.inTrue += count(resolution.inTrue)
    ledger.inFalse += count(resolution.inFalse)
    ledger.eventlessL += count(resolution.eventlessL)
    ledger.eventlessR += count(resolution.eventlessR)
    ledger.crossRegionInterim += count(resolution.crossRegionInterim)
  }
}

const activeIdsFirst = (snapshot: AnyMachineSnapshot, ledger: GuardsLedger): ReadonlyArray<NodeKey> =>
  NODE_KEYS.filter((key) => {
    const inside = checkStateIn(snapshot, `#${key}`)
    ledger.checkStateIn.dataFirst[inside ? 'true' : 'false'] += 1
    return inside
  })

const activeIdsDataLast = (snapshot: AnyMachineSnapshot, ledger: GuardsLedger): ReadonlyArray<NodeKey> =>
  NODE_KEYS.filter((key) => {
    const inside = checkStateIn(`#${key}`)(snapshot)
    ledger.checkStateIn.dataLast[inside ? 'true' : 'false'] += 1
    return inside
  })

const throwUncaptured = (): never => {
  throw new Error('the published snapshot did not match the guards capture model')
}

const observationOf = (
  snapshot: AnyMachineSnapshot,
  steps: ReadonlyArray<GuardsStep>,
  ledger: GuardsLedger,
): GuardsObservation => {
  const value = Schema.decodeUnknownResult(GuardsValueSchema)(snapshot.value)
  const context = Schema.decodeUnknownResult(GuardsContextSchema)(snapshot.context)
  return {
    value: Result.isSuccess(value) ? value.success : throwUncaptured(),
    n: Result.isSuccess(context) ? context.success.n : throwUncaptured(),
    steps,
    activeIds: activeIdsFirst(snapshot, ledger),
    activeIdsDataLast: activeIdsDataLast(snapshot, ledger),
  }
}

const noteStep = (ledger: GuardsLedger, can: boolean, effects: ReadonlyArray<GuardsEffectLike>): void => {
  ledger.canTrue += count(can)
  ledger.canFalse += count(!can)
  ledger.effectsAdmitted += count(effects.length > 0)
}

const runPure = (
  machine: AnyStateMachine,
  command: GuardsCommand,
  ledger: GuardsLedger,
): { readonly steps: ReadonlyArray<GuardsStep>; readonly final: AnyMachineSnapshot } => {
  const [initial] = initialTransition(machine)
  let snapshot: AnyMachineSnapshot = initial
  const steps: Array<GuardsStep> = []
  for (const event of command.events) {
    const can = snapshot.can(event)
    const [next, actions] = transition(machine, snapshot, event)
    const effects: ReadonlyArray<GuardsEffectLike> = actions
      .filter((action) => action.kind === 'emit')
      .map((action) => action.event)
    noteStep(ledger, can, effects)
    steps.push({ can, effects })
    snapshot = next
  }
  return { steps, final: snapshot }
}

const runActor = (
  machine: AnyStateMachine,
  command: GuardsCommand,
  ledger: GuardsLedger,
): { readonly steps: ReadonlyArray<GuardsStep>; readonly final: AnyMachineSnapshot } => {
  const actor = createActor(machine)
  const emitted: Array<GuardsEffectLike> = []
  actor.subscribe({ error: () => {} })
  actor.on('effect', (event) => {
    emitted.push(event)
  })
  actor.start()
  const steps: Array<GuardsStep> = []
  for (const event of command.events) {
    const can = actor.getSnapshot().can(event)
    const before = emitted.length
    actor.send(event)
    const effects = emitted.slice(before)
    noteStep(ledger, can, effects)
    steps.push({ can, effects })
  }
  const final = actor.getSnapshot()
  actor.stop()
  return { steps, final }
}

export class GuardsSubject extends Context.Service<GuardsSubject, (command: GuardsCommand) => GuardsObservation>()(
  '@systemfsoftware/xstate/tests/guards/GuardsSubject',
) {}

export interface GuardsHandle {
  readonly layer: Layer.Layer<GuardsSubject>
  readonly observed: GuardsLedger
}

const subjectOf = (fault: Fault): GuardsHandle => {
  const observed = emptyLedger()
  const run = (command: GuardsCommand): GuardsObservation => {
    observed.drivers[command.driver] += 1
    observed.factories[command.factory] += 1
    noteResolution(observed, command, analyseRun(command))
    const machine = machineOf(command.machine, command.factory, fault)
    const { steps, final } = command.driver === 'pure' ? runPure(machine, command, observed) : runActor(
      machine,
      command,
      observed,
    )
    const observation = observationOf(final, steps, observed)
    return observation
  }
  return { observed, layer: Layer.succeed(GuardsSubject, run) }
}

export const makeGuardsSubject = (): GuardsHandle => subjectOf('none')

export const makeRejectsAsEmptySubject = (): GuardsHandle => subjectOf('rejects-as-empty')

export const makeDropsEffectSubject = (): GuardsHandle => subjectOf('drops-effect')

export const runGuardsCommand = (command: GuardsCommand): Effect.Effect<GuardsObservation, never, GuardsSubject> =>
  Effect.gen(function*() {
    const run = yield* GuardsSubject
    return run(command)
  })
