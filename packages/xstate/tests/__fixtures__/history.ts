import {
  type AnyActor,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  createActor,
  createMachine,
  initialTransition,
  transition,
} from '@systemfsoftware/xstate'
import { Context, Effect, Layer } from 'effect'
import {
  declarationOf,
  type HistoryCommand,
  type HistoryDeclaration,
  type HistoryDriver,
  type HistoryEvent,
  type HistoryForm,
  type HistoryObservation,
  type HistoryStateValue,
  specOf,
  targetPaths,
} from './history.model.js'

type TraceEnqueue = { emit: (event: { type: 'trace'; at: string }) => void }

const enterTrace = (key: string) => (_: object, enq: TraceEnqueue) => {
  enq.emit({ type: 'trace', at: `enter:${key}` })
}

const leaveTrace = (key: string) => (_: object, enq: TraceEnqueue) => {
  enq.emit({ type: 'trace', at: `exit:${key}` })
}

interface Behaviour {
  readonly allShallow: boolean
  readonly stripHistoryValue: boolean
}

const publishedBehaviour: Behaviour = { allShallow: false, stripHistoryValue: false }

const declFor = (behaviour: Behaviour, form: HistoryForm, target: string) =>
  declarationOf({ form: behaviour.allShallow ? 'type-shallow' : form, target })

const machineOf = (config: object): AnyStateMachine => Reflect.apply(createMachine, undefined, [config])

export interface ReviveRequest {
  readonly machine: object
  readonly options: object
}

export const reviveActor = ({ machine, options }: ReviveRequest): AnyActor =>
  Reflect.apply(createActor, undefined, [machine, options])

const buildMachine = (command: HistoryCommand, behaviour: Behaviour): AnyStateMachine =>
  machineOf({
    initial: 'off',
    states: {
      off: {
        entry: enterTrace('off'),
        exit: leaveTrace('off'),
        on: {
          ON: 'on',
          ON_H: 'on.onH',
          B_H: 'on.b.bH',
          P_H: 'on.p.pH',
          R_H: 'on.p.r.rH',
          RS_H: ['on.p.r.rH', 'on.p.s.s2'],
          MID: 'mid',
        },
      },
      mid: {
        entry: enterTrace('mid'),
        exit: leaveTrace('mid'),
        on: { ON_H: 'on.onH', B_H: 'on.b.bH', P_H: 'on.p.pH' },
      },
      on: {
        entry: enterTrace('on'),
        exit: leaveTrace('on'),
        initial: 'a',
        on: { OFF: 'off', REH: '.onH' },
        states: {
          a: { entry: enterTrace('a'), exit: leaveTrace('a'), on: { TO_B: 'b', TO_P: 'p' } },
          b: {
            entry: enterTrace('b'),
            exit: leaveTrace('b'),
            initial: 'b1',
            on: { TO_A: 'a' },
            states: {
              b1: { entry: enterTrace('b1'), exit: leaveTrace('b1'), on: { NEXT: 'b2' } },
              b2: {
                entry: enterTrace('b2'),
                exit: leaveTrace('b2'),
                initial: 'x',
                on: { NEXT: 'b1' },
                states: {
                  x: { entry: enterTrace('x'), exit: leaveTrace('x'), on: { XY: 'y' } },
                  y: { entry: enterTrace('y'), exit: leaveTrace('y'), on: { XY: 'x' } },
                },
              },
              bH: declFor(behaviour, specOf(command).bH.form, command.bH.target),
            },
          },
          p: {
            entry: enterTrace('p'),
            exit: leaveTrace('p'),
            type: 'parallel',
            on: { TO_A: 'a' },
            states: {
              r: {
                entry: enterTrace('r'),
                exit: leaveTrace('r'),
                initial: 'r1',
                states: {
                  r1: { entry: enterTrace('r1'), exit: leaveTrace('r1'), on: { R: 'r2' } },
                  r2: {
                    entry: enterTrace('r2'),
                    exit: leaveTrace('r2'),
                    initial: 'u',
                    on: { R: 'r1' },
                    states: {
                      u: { entry: enterTrace('u'), exit: leaveTrace('u'), on: { UV: 'v' } },
                      v: { entry: enterTrace('v'), exit: leaveTrace('v'), on: { UV: 'u' } },
                    },
                  },
                  rH: declFor(behaviour, specOf(command).rH.form, command.rH.target),
                },
              },
              s: {
                entry: enterTrace('s'),
                exit: leaveTrace('s'),
                initial: 's1',
                states: {
                  s1: { entry: enterTrace('s1'), exit: leaveTrace('s1'), on: { S: 's2' } },
                  s2: { entry: enterTrace('s2'), exit: leaveTrace('s2'), on: { S: 's1' } },
                },
              },
              pH: declFor(behaviour, specOf(command).pH.form, command.pH.target),
            },
          },
          onH: declFor(behaviour, specOf(command).onH.form, command.onH.target),
        },
      },
    },
  })

type HistoryNodeKey = 'onH' | 'bH' | 'pH' | 'rH'

const HISTORY_IDS: Record<HistoryNodeKey, string> = {
  onH: '(machine).on.onH',
  bH: '(machine).on.b.bH',
  pH: '(machine).on.p.pH',
  rH: '(machine).on.p.r.rH',
}

const RESTORE_TARGETS: Partial<Record<HistoryEvent, ReadonlyArray<HistoryNodeKey>>> = {
  ON_H: ['onH'],
  B_H: ['bH'],
  P_H: ['pH'],
  R_H: ['rH'],
  RS_H: ['rH'],
}

const MULTISTAGE_EVENTS: ReadonlyArray<HistoryEvent> = ['ON_H', 'B_H', 'P_H']

interface HistoryLedger {
  restoredFromRecord: Record<HistoryNodeKey, number>
  restoredFromDefault: Record<HistoryNodeKey, number>
  deepRecordBelowChild: number
  forms: Record<HistoryForm, number>
  depths: Record<string, number>
  parallelMultiTargetDefault: number
  regionHistoryBesidePlain: number
  internalSelfHistoryNoRecord: number
  multistageViaMid: number
  drivers: Record<HistoryDriver, number>
  restartsWithHistory: number
}

const EMPTY_FORMS: Record<HistoryForm, number> = {
  'type-history': 0,
  'type-shallow': 0,
  'history-true': 0,
  'history-shallow': 0,
  'type-deep': 0,
  'history-deep': 0,
}

const emptyLedger = (): HistoryLedger => ({
  restoredFromRecord: { onH: 0, bH: 0, pH: 0, rH: 0 },
  restoredFromDefault: { onH: 0, bH: 0, pH: 0, rH: 0 },
  deepRecordBelowChild: 0,
  forms: { ...EMPTY_FORMS },
  depths: { shallow: 0, deep: 0 },
  parallelMultiTargetDefault: 0,
  regionHistoryBesidePlain: 0,
  internalSelfHistoryNoRecord: 0,
  multistageViaMid: 0,
  drivers: { actor: 0, pure: 0, persisted: 0 },
  restartsWithHistory: 0,
})

const isLive = (observed: HistoryLedger): boolean =>
  [
    ...Object.values(observed.restoredFromRecord),
    ...Object.values(observed.restoredFromDefault),
    observed.deepRecordBelowChild,
    ...Object.values(observed.forms),
    ...Object.values(observed.depths),
    observed.parallelMultiTargetDefault,
    observed.regionHistoryBesidePlain,
    observed.internalSelfHistoryNoRecord,
    observed.multistageViaMid,
    ...Object.values(observed.drivers),
    observed.restartsWithHistory,
  ].every((occurrences) => occurrences > 0)

export type RecordedIds = Readonly<Record<string, ReadonlyArray<string>>>

type ForeignValue = object | string | number | boolean | null | undefined

interface Probe {
  readonly value: HistoryStateValue
  readonly historyValue: RecordedIds
}

type Observe = (event: HistoryEvent, before: Probe, after: Probe, restartedWithHistory: boolean) => void

const stateValueOf = <Value>(foreign: Value): HistoryStateValue => {
  if (typeof foreign === 'string') {
    return foreign
  }
  if (typeof foreign !== 'object' || foreign === null) {
    return ''
  }
  const entries: Array<readonly [string, HistoryStateValue]> = []
  Reflect.ownKeys(foreign).forEach((key) => {
    if (typeof key === 'string') {
      entries.push([key, stateValueOf(Reflect.get(foreign, key))])
    }
  })
  return Object.fromEntries(entries)
}

const traceOf = (action: object): string | undefined => {
  if (Reflect.get(action, 'kind') !== 'emit') {
    return undefined
  }
  const event = Reflect.get(action, 'event')
  if (typeof event !== 'object' || event === null) {
    return undefined
  }
  const at = Reflect.get(event, 'at')
  return typeof at === 'string' ? at : undefined
}

const recordedIdOf = (item: ForeignValue): string => {
  if (typeof item === 'string') {
    return item
  }
  if (typeof item === 'object' && item !== null) {
    const id = Reflect.get(item, 'id')
    if (typeof id === 'string') {
      return id
    }
  }
  return ''
}

const canonicalHistory = (historyValue: ForeignValue): RecordedIds => {
  if (typeof historyValue !== 'object' || historyValue === null) {
    return {}
  }
  const entries: Array<readonly [string, ReadonlyArray<string>]> = []
  Object.entries(historyValue).forEach(([key, list]) => {
    if (Array.isArray(list)) {
      entries.push([key, list.map(recordedIdOf).sort()] as const)
    }
  })
  return Object.fromEntries(entries.sort((left, right) => left[0] < right[0] ? -1 : 1))
}

const historyValueOfDocument = (document: object): ForeignValue => {
  const found = Reflect.get(document, 'historyValue')
  return typeof found === 'string' || typeof found === 'number' || typeof found === 'boolean' ||
      typeof found === 'object'
    ? found
    : undefined
}

const probeOf = (actor: AnyActor): Probe => ({
  value: stateValueOf(actor.getSnapshot().value),
  historyValue: canonicalHistory(historyValueOfDocument(actor.getPersistedSnapshot())),
})

export const valueOf = (actor: AnyActor): HistoryStateValue => stateValueOf(actor.getSnapshot().value)

export const persistedHistoryValueOf = (actor: AnyActor): RecordedIds =>
  canonicalHistory(historyValueOfDocument(actor.getPersistedSnapshot()))

const runActor = (machine: AnyStateMachine, command: HistoryCommand, observe: Observe): HistoryObservation => {
  const actor: AnyActor = createActor(machine)
  actor.start()
  const trace: Array<string> = []
  actor.on('trace', (event: { at: string }) => {
    trace.push(event.at)
  })
  command.events.forEach((event) => {
    const before = probeOf(actor)
    actor.send({ type: event })
    observe(event, before, probeOf(actor), false)
  })
  const observation = probeOf(actor)
  actor.stop()
  return { value: observation.value, trace, historyValue: observation.historyValue }
}

const runPure = (machine: AnyStateMachine, command: HistoryCommand, observe: Observe): HistoryObservation => {
  let snapshot: AnyMachineSnapshot = initialTransition(machine)[0]
  const trace: Array<string> = []
  command.events.forEach((event) => {
    const before: Probe = {
      value: stateValueOf(snapshot.value),
      historyValue: canonicalHistory(snapshot.historyValue),
    }
    const [next, actions] = transition(machine, snapshot, { type: event })
    actions.forEach((action) => {
      const at = traceOf(action)
      if (at !== undefined) {
        trace.push(at)
      }
    })
    snapshot = next
    observe(event, before, {
      value: stateValueOf(snapshot.value),
      historyValue: canonicalHistory(snapshot.historyValue),
    }, false)
  })
  return {
    value: stateValueOf(snapshot.value),
    trace,
    historyValue: canonicalHistory(snapshot.historyValue),
  }
}

const runPersisted = (
  machine: AnyStateMachine,
  command: HistoryCommand,
  observe: Observe,
  stripHistoryValue: boolean,
): HistoryObservation => {
  const persist = (actor: AnyActor): object => {
    const document: object = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()))
    return stripHistoryValue ? { ...document, historyValue: {} } : document
  }
  const bootstrap: AnyActor = createActor(machine)
  bootstrap.start()
  let persisted: object = persist(bootstrap)
  const trace: Array<string> = []
  let value: HistoryStateValue = stateValueOf(bootstrap.getSnapshot().value)
  let historyValue: RecordedIds = probeOf(bootstrap).historyValue
  bootstrap.stop()
  command.events.forEach((event) => {
    const actor: AnyActor = reviveActor({ machine, options: { snapshot: persisted } })
    actor.start()
    const before: Probe = {
      value: stateValueOf(actor.getSnapshot().value),
      historyValue: canonicalHistory(historyValueOfDocument(persisted)),
    }
    const here: Array<string> = []
    actor.on('trace', (emitted: { at: string }) => {
      here.push(emitted.at)
    })
    actor.send({ type: event })
    trace.push(...here)
    persisted = persist(actor)
    const after = probeOf(actor)
    value = after.value
    historyValue = after.historyValue
    observe(event, before, after, (before.historyValue[HISTORY_IDS.onH] ?? []).length > 0)
    actor.stop()
  })
  return { value, trace, historyValue }
}

const noteRestores = (ledger: HistoryLedger, event: HistoryEvent, before: Probe): void => {
  RESTORE_TARGETS[event]?.forEach((nodeKey) => {
    const id = HISTORY_IDS[nodeKey]
    if ((before.historyValue[id] ?? []).length > 0) {
      ledger.restoredFromRecord[nodeKey] += 1
    } else {
      ledger.restoredFromDefault[nodeKey] += 1
    }
  })
}

const noteAfter = (
  ledger: HistoryLedger,
  command: HistoryCommand,
  event: HistoryEvent,
  before: Probe,
  after: Probe,
): void => {
  Object.entries(after.historyValue).forEach(([id, recorded]) => {
    if (recorded.some((recordedId) => recordedId.slice(id.length + 1).includes('.'))) {
      ledger.deepRecordBelowChild += 1
    }
  })
  if (event === 'RS_H') {
    ledger.regionHistoryBesidePlain += 1
  }
  if (event === 'REH' && (before.historyValue[HISTORY_IDS.onH] ?? []).length === 0) {
    ledger.internalSelfHistoryNoRecord += 1
  }
  if (MULTISTAGE_EVENTS.includes(event) && before.value === 'mid') {
    ledger.multistageViaMid += 1
  }
  if (
    event === 'P_H' &&
    (before.historyValue[HISTORY_IDS.pH] ?? []).length === 0 &&
    targetPaths(command.pH.target).length > 1
  ) {
    ledger.parallelMultiTargetDefault += 1
  }
}

const noteCommand = (ledger: HistoryLedger, command: HistoryCommand): void => {
  const spec = specOf(command)
  const forms = [spec.onH, spec.bH, spec.pH, spec.rH]
  forms.forEach((entry) => {
    ledger.forms[entry.form] += 1
    ledger.depths[entry.depth] = (ledger.depths[entry.depth] ?? 0) + 1
  })
  ledger.drivers[command.driver] += 1
}

const drive = (
  machine: AnyStateMachine,
  command: HistoryCommand,
  observe: Observe,
  behaviour: Behaviour,
): HistoryObservation => {
  if (command.driver === 'pure') {
    return runPure(machine, command, observe)
  }
  if (command.driver === 'persisted') {
    return runPersisted(machine, command, observe, behaviour.stripHistoryValue)
  }
  return runActor(machine, command, observe)
}

export class HistorySubject extends Context.Service<HistorySubject, (command: HistoryCommand) => HistoryObservation>()(
  '@systemfsoftware/xstate/tests/history/HistorySubject',
) {}

export interface HistoryHandle {
  readonly layer: Layer.Layer<HistorySubject>
  readonly observed: HistoryLedger
  readonly run: (command: HistoryCommand) => HistoryObservation
}

const subjectOf = (behaviour: Behaviour): HistoryHandle => {
  const observed = emptyLedger()
  const run = (command: HistoryCommand): HistoryObservation => {
    noteCommand(observed, command)
    const observe: Observe = (event, before, after, restartedWithHistory) => {
      noteRestores(observed, event, before)
      noteAfter(observed, command, event, before, after)
      if (restartedWithHistory) {
        observed.restartsWithHistory += 1
      }
    }
    return drive(buildMachine(command, behaviour), command, observe, behaviour)
  }
  return { observed, layer: Layer.succeed(HistorySubject, run), run }
}

export const makeHistorySubject = (): HistoryHandle => subjectOf(publishedBehaviour)

export const makeAllShallowSubject = (): HistoryHandle => subjectOf({ ...publishedBehaviour, allShallow: true })

export const makeStrippedPersistedSubject = (): HistoryHandle =>
  subjectOf({ ...publishedBehaviour, stripHistoryValue: true })

export const runHistoryCommand = (command: HistoryCommand): Effect.Effect<HistoryObservation, never, HistorySubject> =>
  Effect.gen(function*() {
    const run = yield* HistorySubject
    return run(command)
  })

export { isLive }
export type { HistoryLedger }

export type RehReKind =
  | 'atomic-default'
  | 'parallel-multi-shallow'
  | 'parallel-multi-deep'
  | 'compound-default'
  | 'compound-deep-default'
  | 'parallel-child-default'

export const rehReKinds: ReadonlyArray<RehReKind> = [
  'atomic-default',
  'parallel-multi-shallow',
  'parallel-multi-deep',
  'compound-default',
  'compound-deep-default',
  'parallel-child-default',
]

const rehReRegion = (): object => ({
  r: {
    entry: enterTrace('r'),
    exit: leaveTrace('r'),
    initial: 'r1',
    states: {
      r1: { entry: enterTrace('r1'), exit: leaveTrace('r1'), on: { R: 'r2' } },
      r2: { entry: enterTrace('r2'), exit: leaveTrace('r2'), on: { R: 'r1' } },
    },
  },
  s: {
    entry: enterTrace('s'),
    exit: leaveTrace('s'),
    initial: 's1',
    states: {
      s1: { entry: enterTrace('s1'), exit: leaveTrace('s1'), on: { S: 's2' } },
      s2: { entry: enterTrace('s2'), exit: leaveTrace('s2'), on: { S: 's1' } },
    },
  },
})

const rehReCompound = (): Record<string, object> => ({
  b: {
    entry: enterTrace('b'),
    exit: leaveTrace('b'),
    initial: 'b1',
    states: {
      b1: { entry: enterTrace('b1'), exit: leaveTrace('b1') },
      b2: { entry: enterTrace('b2'), exit: leaveTrace('b2') },
    },
  },
})

const rehReParallel = (): Record<string, object> => ({
  p: { entry: enterTrace('p'), exit: leaveTrace('p'), type: 'parallel', states: rehReRegion() },
})

interface RehReLayout {
  readonly history: HistoryDeclaration
  readonly siblings: Record<string, object>
}

const rehReLayout: Readonly<Record<RehReKind, RehReLayout>> = {
  'atomic-default': {
    history: declarationOf({ form: 'type-history', target: 'b1' }),
    siblings: { b1: { entry: enterTrace('b1'), exit: leaveTrace('b1') } },
  },
  'parallel-multi-shallow': {
    history: declarationOf({ form: 'type-history', target: '[p.r.r2|p.s.s2]' }),
    siblings: rehReParallel(),
  },
  'parallel-multi-deep': {
    history: declarationOf({ form: 'history-deep', target: '[p.r.r2|p.s.s2]' }),
    siblings: rehReParallel(),
  },
  'compound-default': {
    history: declarationOf({ form: 'type-history', target: 'b' }),
    siblings: rehReCompound(),
  },
  'compound-deep-default': {
    history: declarationOf({ form: 'history-deep', target: 'b.b2' }),
    siblings: rehReCompound(),
  },
  'parallel-child-default': {
    history: declarationOf({ form: 'type-history', target: 'p.r.r2' }),
    siblings: rehReParallel(),
  },
}

const rehReMachineOf = (kind: RehReKind): object => {
  const layout = rehReLayout[kind]
  return {
    initial: 'off',
    states: {
      off: { entry: enterTrace('off'), exit: leaveTrace('off'), on: { ON: 'on' } },
      on: {
        entry: enterTrace('on'),
        exit: leaveTrace('on'),
        initial: 'a',
        on: { REH_RE: { target: '.onH', reenter: true } },
        states: {
          a: { entry: enterTrace('a'), exit: leaveTrace('a') },
          ...layout.siblings,
          onH: layout.history,
        },
      },
    },
  }
}

export interface RehReObservation {
  readonly kind: RehReKind
  readonly trace: ReadonlyArray<string>
  readonly value: HistoryStateValue
  readonly historyValue: RecordedIds
}

export const observeRehRe = (kind: RehReKind): RehReObservation => {
  const actor: AnyActor = createActor(machineOf(rehReMachineOf(kind)))
  actor.start()
  const trace: Array<string> = []
  actor.on('trace', (event: { at: string }) => {
    trace.push(event.at)
  })
  actor.send({ type: 'ON' })
  trace.length = 0
  actor.send({ type: 'REH_RE' })
  const value = valueOf(actor)
  const historyValue = persistedHistoryValueOf(actor)
  actor.stop()
  return { kind, trace, value, historyValue }
}
