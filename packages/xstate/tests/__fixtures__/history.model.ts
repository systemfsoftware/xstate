import { Match, Schema } from 'effect'

export type HistoryDepth = 'shallow' | 'deep'

export const HistoryForm = Schema.Literals([
  'type-history',
  'type-shallow',
  'history-true',
  'history-shallow',
  'type-deep',
  'history-deep',
])
export type HistoryForm = Schema.Schema.Type<typeof HistoryForm>

const SHALLOW_FORMS: ReadonlyArray<HistoryForm> = ['type-history', 'type-shallow', 'history-true', 'history-shallow']

export const depthOfForm = (form: HistoryForm): HistoryDepth => SHALLOW_FORMS.includes(form) ? 'shallow' : 'deep'

export const OnHTarget = Schema.Literals(['a', 'b', 'b.b2.y', 'p', 'p.r.r2.v', '[p.r.r2|p.s.s2]'])
export type OnHTarget = Schema.Schema.Type<typeof OnHTarget>
export const BHTarget = Schema.Literals(['b1', 'b2', 'b2.y'])
export type BHTarget = Schema.Schema.Type<typeof BHTarget>
export const PHTarget = Schema.Literals(['r', 's.s2', '[r.r2.v|s.s2]', '[r|s]'])
export type PHTarget = Schema.Schema.Type<typeof PHTarget>
export const RHTarget = Schema.Literals(['r1', 'r2', 'r2.v'])
export type RHTarget = Schema.Schema.Type<typeof RHTarget>

const OnHDeclaration = Schema.Struct({ form: HistoryForm, target: OnHTarget })
const BHDeclaration = Schema.Struct({ form: HistoryForm, target: BHTarget })
const PHDeclaration = Schema.Struct({ form: HistoryForm, target: PHTarget })
const RHDeclaration = Schema.Struct({ form: HistoryForm, target: RHTarget })

export const HistoryEvent = Schema.Literals([
  'ON',
  'OFF',
  'ON_H',
  'B_H',
  'P_H',
  'R_H',
  'RS_H',
  'REH',
  'MID',
  'TO_B',
  'TO_P',
  'TO_A',
  'NEXT',
  'XY',
  'R',
  'UV',
  'S',
])
export type HistoryEvent = Schema.Schema.Type<typeof HistoryEvent>

export const HistoryDriver = Schema.Literals(['actor', 'pure', 'persisted'])
export type HistoryDriver = Schema.Schema.Type<typeof HistoryDriver>

export const HistoryCommand = Schema.Struct({
  onH: OnHDeclaration,
  bH: BHDeclaration,
  pH: PHDeclaration,
  rH: RHDeclaration,
  events: Schema.Array(HistoryEvent),
  driver: HistoryDriver,
})
export type HistoryCommand = Schema.Schema.Type<typeof HistoryCommand>

export const targetPaths = (target: string): ReadonlyArray<string> =>
  target.startsWith('[') ? target.slice(1, -1).split('|') : [target]

export type HistoryDeclaration =
  | { readonly type: 'history'; readonly target: string | string[]; readonly history?: 'shallow' | 'deep' }
  | { readonly history: true | 'shallow' | 'deep'; readonly target: string | string[] }

const declarationBuilders: Record<HistoryForm, (to: string | string[]) => HistoryDeclaration> = {
  'type-history': (to) => ({ type: 'history', target: to }),
  'type-shallow': (to) => ({ type: 'history', history: 'shallow', target: to }),
  'history-true': (to) => ({ history: true, target: to }),
  'history-shallow': (to) => ({ history: 'shallow', target: to }),
  'type-deep': (to) => ({ type: 'history', history: 'deep', target: to }),
  'history-deep': (to) => ({ history: 'deep', target: to }),
}

export interface HistoryDeclarationRequest {
  readonly form: HistoryForm
  readonly target: string
}

export const declarationOf = ({ form, target }: HistoryDeclarationRequest): HistoryDeclaration => {
  const paths = targetPaths(target)
  const to = paths.length === 1 ? paths[0] ?? target : [...paths]
  return declarationBuilders[form](to)
}

const join = (parent: string, path: string): string => parent === '' ? path : `${parent}.${path}`

export interface HistoryNodeSpec {
  readonly depth: HistoryDepth
  readonly form: HistoryForm
  readonly defaultTargets: ReadonlyArray<string>
}

export interface HistorySpec {
  readonly onH: HistoryNodeSpec
  readonly bH: HistoryNodeSpec
  readonly pH: HistoryNodeSpec
  readonly rH: HistoryNodeSpec
}

const nodeSpec = (parent: string, form: HistoryForm, target: string): HistoryNodeSpec => ({
  depth: depthOfForm(form),
  form,
  defaultTargets: targetPaths(target).map((path) => join(parent, path)),
})

export const specOf = (command: HistoryCommand): HistorySpec => ({
  onH: nodeSpec('on', command.onH.form, command.onH.target),
  bH: nodeSpec('on.b', command.bH.form, command.bH.target),
  pH: nodeSpec('on.p', command.pH.form, command.pH.target),
  rH: nodeSpec('on.p.r', command.rH.form, command.rH.target),
})

type NodeKind = 'atomic' | 'compound' | 'parallel' | 'history'

interface Transition {
  readonly targets: ReadonlyArray<string>
  readonly internal?: boolean
  readonly reenter?: boolean
}

interface Node {
  readonly key: string
  readonly local: string
  readonly kind: NodeKind
  readonly parent: string | undefined
  readonly children: ReadonlyArray<string>
  readonly initial: string | undefined
  readonly on: Readonly<Record<string, Transition>>
  readonly historyDepth?: HistoryDepth
  readonly historyDefault?: ReadonlyArray<string>
}

export type Topology = Readonly<Record<string, Node>>

const ROOT = ''

interface FixedNode {
  readonly key: string
  readonly kind: NodeKind
  readonly parent: string
  readonly children?: ReadonlyArray<string>
  readonly initial?: string
  readonly on?: Readonly<Record<string, Transition>>
}

const fixedNodes: ReadonlyArray<FixedNode> = [
  { key: ROOT, kind: 'compound', parent: ROOT, children: ['off', 'mid', 'on'], initial: 'off' },
  {
    key: 'off',
    kind: 'atomic',
    parent: ROOT,
    on: {
      ON: { targets: ['on'] },
      ON_H: { targets: ['on.onH'] },
      B_H: { targets: ['on.b.bH'] },
      P_H: { targets: ['on.p.pH'] },
      R_H: { targets: ['on.p.r.rH'] },
      RS_H: { targets: ['on.p.r.rH', 'on.p.s.s2'] },
      MID: { targets: ['mid'] },
    },
  },
  {
    key: 'mid',
    kind: 'atomic',
    parent: ROOT,
    on: { ON_H: { targets: ['on.onH'] }, B_H: { targets: ['on.b.bH'] }, P_H: { targets: ['on.p.pH'] } },
  },
  {
    key: 'on',
    kind: 'compound',
    parent: ROOT,
    children: ['on.a', 'on.b', 'on.p', 'on.onH'],
    initial: 'on.a',
    on: {
      OFF: { targets: ['off'] },
      REH: { targets: ['on.onH'], internal: true },
    },
  },
  { key: 'on.a', kind: 'atomic', parent: 'on', on: { TO_B: { targets: ['on.b'] }, TO_P: { targets: ['on.p'] } } },
  {
    key: 'on.b',
    kind: 'compound',
    parent: 'on',
    children: ['on.b.b1', 'on.b.b2', 'on.b.bH'],
    initial: 'on.b.b1',
    on: { TO_A: { targets: ['on.a'] } },
  },
  { key: 'on.b.b1', kind: 'atomic', parent: 'on.b', on: { NEXT: { targets: ['on.b.b2'] } } },
  {
    key: 'on.b.b2',
    kind: 'compound',
    parent: 'on.b',
    children: ['on.b.b2.x', 'on.b.b2.y'],
    initial: 'on.b.b2.x',
    on: { NEXT: { targets: ['on.b.b1'] } },
  },
  { key: 'on.b.b2.x', kind: 'atomic', parent: 'on.b.b2', on: { XY: { targets: ['on.b.b2.y'] } } },
  { key: 'on.b.b2.y', kind: 'atomic', parent: 'on.b.b2', on: { XY: { targets: ['on.b.b2.x'] } } },
  {
    key: 'on.p',
    kind: 'parallel',
    parent: 'on',
    children: ['on.p.r', 'on.p.s', 'on.p.pH'],
    on: { TO_A: { targets: ['on.a'] } },
  },
  {
    key: 'on.p.r',
    kind: 'compound',
    parent: 'on.p',
    children: ['on.p.r.r1', 'on.p.r.r2', 'on.p.r.rH'],
    initial: 'on.p.r.r1',
  },
  { key: 'on.p.r.r1', kind: 'atomic', parent: 'on.p.r', on: { R: { targets: ['on.p.r.r2'] } } },
  {
    key: 'on.p.r.r2',
    kind: 'compound',
    parent: 'on.p.r',
    children: ['on.p.r.r2.u', 'on.p.r.r2.v'],
    initial: 'on.p.r.r2.u',
    on: { R: { targets: ['on.p.r.r1'] } },
  },
  { key: 'on.p.r.r2.u', kind: 'atomic', parent: 'on.p.r.r2', on: { UV: { targets: ['on.p.r.r2.v'] } } },
  { key: 'on.p.r.r2.v', kind: 'atomic', parent: 'on.p.r.r2', on: { UV: { targets: ['on.p.r.r2.u'] } } },
  { key: 'on.p.s', kind: 'compound', parent: 'on.p', children: ['on.p.s.s1', 'on.p.s.s2'], initial: 'on.p.s.s1' },
  { key: 'on.p.s.s1', kind: 'atomic', parent: 'on.p.s', on: { S: { targets: ['on.p.s.s2'] } } },
  { key: 'on.p.s.s2', kind: 'atomic', parent: 'on.p.s', on: { S: { targets: ['on.p.s.s1'] } } },
]

const historyParents: Readonly<Record<string, string>> = {
  'on.onH': 'on',
  'on.b.bH': 'on.b',
  'on.p.pH': 'on.p',
  'on.p.r.rH': 'on.p.r',
}

const localOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1)

const historyNode = (key: string, spec: HistoryNodeSpec): Node => ({
  key,
  local: localOf(key),
  kind: 'history',
  parent: historyParents[key] ?? ROOT,
  children: [],
  initial: undefined,
  on: {},
  historyDepth: spec.depth,
  historyDefault: spec.defaultTargets,
})

const fixedNode = (node: FixedNode): Node => ({
  key: node.key,
  local: localOf(node.key),
  kind: node.kind,
  parent: node.parent === ROOT && node.key === ROOT ? undefined : node.parent,
  children: node.children ?? [],
  initial: node.initial,
  on: node.on ?? {},
})

export const topologyOf = (spec: HistorySpec): Topology => {
  const historySpec: Record<string, HistoryNodeSpec> = {
    'on.onH': spec.onH,
    'on.b.bH': spec.bH,
    'on.p.pH': spec.pH,
    'on.p.r.rH': spec.rH,
  }
  const entries = [
    ...fixedNodes.map((node): [string, Node] => [node.key, fixedNode(node)]),
    ...Object.entries(historySpec).map(([key, spec]): [string, Node] => [key, historyNode(key, spec)]),
  ]
  return Object.fromEntries(entries)
}

export const nodeId = (key: string): string => key === ROOT ? '(machine)' : `(machine).${key}`

const node = (topology: Topology, key: string): Node => {
  const found = topology[key]
  if (found === undefined) {
    throw new Error(`unknown state node ${key}`)
  }
  return found
}

const order = (topology: Topology): Record<string, number> => {
  const visited: Record<string, number> = {}
  let next = 0
  const walk = (key: string): void => {
    visited[key] = next++
    node(topology, key).children.forEach(walk)
  }
  walk(ROOT)
  return visited
}

const depth = (topology: Topology, key: string): number => {
  let marker = node(topology, key).parent
  let levels = 0
  while (marker !== undefined) {
    levels += 1
    marker = node(topology, marker).parent
  }
  return levels
}

const isStrictDescendant = (topology: Topology, child: string, parent: string): boolean => {
  let marker = node(topology, child).parent
  while (marker !== undefined && marker !== parent) {
    marker = node(topology, marker).parent
  }
  return marker === parent
}

const properAncestors = (topology: Topology, key: string, stop: string | undefined): ReadonlyArray<string> => {
  const ancestors: Array<string> = []
  let marker = node(topology, key).parent
  while (marker !== undefined && marker !== stop) {
    ancestors.push(marker)
    marker = node(topology, marker).parent
  }
  return ancestors
}

const regions = (topology: Topology, key: string): ReadonlyArray<string> =>
  node(topology, key).children.filter((child) => node(topology, child).kind !== 'history')

const activeStrictDescendants = (
  topology: Topology,
  active: ReadonlySet<string>,
  domain: string,
): ReadonlyArray<string> => [...active].filter((key) => isStrictDescendant(topology, key, domain))

const activeChild = (topology: Topology, active: ReadonlySet<string>, key: string): string | undefined =>
  node(topology, key).children.find((child) => active.has(child))

export interface SimulationState {
  readonly active: ReadonlySet<string>
  readonly records: Readonly<Record<string, ReadonlyArray<string>>>
}

const initialSimulation = (): SimulationState => ({ active: new Set([ROOT, 'off']), records: {} })

const deepestHandler = (topology: Topology, active: ReadonlySet<string>, event: string): string | undefined => {
  const visited = order(topology)
  const handlers = [...active].filter((key) => node(topology, key).on[event] !== undefined)
  return handlers.sort((left, right) =>
    depth(topology, right) - depth(topology, left) || (visited[left] ?? 0) - (visited[right] ?? 0)
  )[0]
}

const narrowParallel = (
  topology: Topology,
  domain: string,
  targets: ReadonlyArray<string>,
): string => {
  let narrowed = domain
  while (node(topology, narrowed).kind === 'parallel') {
    const region = regions(topology, narrowed).find((candidate) =>
      targets.every((target) => target === candidate || isStrictDescendant(topology, target, candidate))
    )
    if (region === undefined) {
      break
    }
    narrowed = region
  }
  return narrowed
}

const domainOf = (
  topology: Topology,
  handler: string,
  targets: ReadonlyArray<string>,
  transition: Transition,
): string => {
  const insideSource = targets.every((target) => target === handler || isStrictDescendant(topology, target, handler))
  if (transition.internal === true && insideSource) {
    return handler
  }
  if (insideSource) {
    return transition.reenter === true ? handler : narrowParallel(topology, handler, targets)
  }
  const head = targets[0] ?? handler
  const rest = [...targets.slice(1), handler]
  const ancestor = properAncestors(topology, head, undefined).find((candidate) =>
    rest.every((target) => isStrictDescendant(topology, target, candidate))
  )
  if (ancestor !== undefined) {
    return transition.reenter === true ? ancestor : narrowParallel(topology, ancestor, targets)
  }
  return transition.reenter === true ? ROOT : narrowParallel(topology, ROOT, targets)
}

const recordSetFor = (topology: Topology, active: ReadonlySet<string>, historyKey: string): ReadonlyArray<string> => {
  const spec = node(topology, historyKey)
  const parent = spec.parent ?? ROOT
  const visited = order(topology)
  return spec.historyDepth === 'deep'
    ? [...active]
      .filter((key) => node(topology, key).kind === 'atomic' && isStrictDescendant(topology, key, parent))
      .sort((left, right) => (visited[left] ?? 0) - (visited[right] ?? 0))
    : node(topology, parent).children.filter((child) => active.has(child))
}

const recordOnExit = (
  topology: Topology,
  state: SimulationState,
  exited: ReadonlySet<string>,
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const records: Record<string, ReadonlyArray<string>> = { ...state.records }
  Object.keys(topology)
    .filter((key) => node(topology, key).kind === 'history')
    .forEach((historyKey) => {
      const parent = node(topology, historyKey).parent ?? ROOT
      if (exited.has(parent)) {
        records[historyKey] = recordSetFor(topology, state.active, historyKey)
      }
    })
  return records
}

const resolveTargets = (
  topology: Topology,
  declared: ReadonlyArray<string>,
  records: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<string> =>
  declared.flatMap((key) => {
    const spec = node(topology, key)
    if (spec.kind !== 'history') {
      return [key]
    }
    const recorded = records[key]
    return recorded !== undefined && recorded.length > 0 ? recorded : spec.historyDefault ?? []
  })

const enterStates = (
  topology: Topology,
  handler: string,
  declared: ReadonlyArray<string>,
  targets: ReadonlyArray<string>,
  domain: string,
  reenter: boolean,
  records: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlySet<string> => {
  const visited = order(topology)
  const toEnter = new Set<string>()
  const hasDescendant = (parent: string): boolean =>
    [...toEnter].some((key) => isStrictDescendant(topology, key, parent))
  const addAncestorStates = (ancestors: ReadonlyArray<string>, reentrancyDomain: string | undefined): void => {
    ancestors.forEach((ancestor) => {
      if (reentrancyDomain === undefined || isStrictDescendant(topology, ancestor, reentrancyDomain)) {
        toEnter.add(ancestor)
      }
      if (node(topology, ancestor).kind === 'parallel') {
        regions(topology, ancestor).forEach((region) => {
          if (!hasDescendant(region)) {
            toEnter.add(region)
            addDescendantStates(region)
          }
        })
      }
    })
  }
  const addDescendantStates = (key: string): void => {
    Match.value(node(topology, key).kind).pipe(
      Match.when('history', () => {
        const recorded = records[key]
        const chosen = recorded !== undefined && recorded.length > 0
          ? recorded
          : node(topology, key).historyDefault ?? []
        chosen.forEach((target) => {
          toEnter.add(target)
          addDescendantStates(target)
        })
        chosen.forEach((target) =>
          addAncestorStates(properAncestors(topology, target, node(topology, key).parent), undefined)
        )
      }),
      Match.when('compound', () => {
        const initial = node(topology, key).initial
        if (initial !== undefined) {
          if (node(topology, initial).kind !== 'history') {
            toEnter.add(initial)
          }
          addDescendantStates(initial)
          addAncestorStates(properAncestors(topology, initial, key), undefined)
        }
      }),
      Match.when('parallel', () => {
        regions(topology, key).forEach((region) => {
          if (!hasDescendant(region)) {
            toEnter.add(region)
            addDescendantStates(region)
          }
        })
      }),
      Match.orElse(() => {}),
    )
  }
  declared.forEach((target) => {
    const isHistory = node(topology, target).kind === 'history'
    if (!isHistory && !(handler === target && handler === domain && !reenter)) {
      toEnter.add(target)
    }
    addDescendantStates(target)
  })
  targets.forEach((target) => {
    const ancestors = properAncestors(topology, target, domain)
    const withDomain = node(topology, domain).kind === 'parallel' ? [...ancestors, domain] : ancestors
    addAncestorStates(withDomain, node(topology, handler).parent === undefined && reenter ? undefined : domain)
  })
  if (reenter && domain === handler) {
    toEnter.add(handler)
  }
  return new Set([...toEnter].sort((left, right) => (visited[left] ?? 0) - (visited[right] ?? 0)))
}

const step = (
  topology: Topology,
  state: SimulationState,
  event: string,
): { readonly state: SimulationState; readonly trace: ReadonlyArray<string> } => {
  const handler = deepestHandler(topology, state.active, event)
  const transition = handler === undefined ? undefined : node(topology, handler).on[event]
  if (handler === undefined || transition === undefined) {
    return { state, trace: [] }
  }
  const visited = order(topology)
  const declared = transition.targets.length > 1 ? [transition.targets[0] ?? handler] : transition.targets
  const domain = domainOf(topology, handler, resolveTargets(topology, declared, state.records), transition)
  const reenter = transition.reenter === true
  const exitKeys = [...activeStrictDescendants(topology, state.active, domain)]
  const exited = new Set(exitKeys)
  if (reenter && domain === handler) {
    exited.add(handler)
  }
  const exitedOrdered = [...exited].sort((left, right) => (visited[right] ?? 0) - (visited[left] ?? 0))
  const records = recordOnExit(topology, state, exited)
  const targets = resolveTargets(topology, declared, records)
  const entered = enterStates(topology, handler, declared, targets, domain, reenter, records)
  const active = new Set([...state.active].filter((key) => !exited.has(key)))
  entered.forEach((key) => active.add(key))
  return {
    state: { active, records },
    trace: [
      ...exitedOrdered.map((key) => `exit:${node(topology, key).local}`),
      ...[...entered].map((key) => `enter:${node(topology, key).local}`),
    ],
  }
}

const subtreeValue = (topology: Topology, active: ReadonlySet<string>, key: string): HistoryStateValue => {
  const spec = node(topology, key)
  if (spec.kind === 'parallel') {
    return Object.fromEntries(
      regions(topology, key).map((region) => [node(topology, region).local, subtreeValue(topology, active, region)]),
    )
  }
  if (spec.kind === 'atomic') {
    return spec.local
  }
  const child = activeChild(topology, active, key)
  if (child === undefined) {
    return spec.local
  }
  return node(topology, child).kind === 'atomic'
    ? node(topology, child).local
    : { [node(topology, child).local]: subtreeValue(topology, active, child) }
}

const historyValueOf = (
  topology: Topology,
  records: Readonly<Record<string, ReadonlyArray<string>>>,
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    Object.keys(topology)
      .filter((key) => node(topology, key).kind === 'history')
      .flatMap((key) => {
        const recorded = records[key]
        return recorded === undefined || recorded.length === 0
          ? []
          : [[nodeId(key), [...recorded].map(nodeId).sort()] as const]
      })
      .sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
  )

export type HistoryStateValue = string | { readonly [key: string]: HistoryStateValue }

export interface HistoryObservation {
  readonly value: HistoryStateValue
  readonly trace: ReadonlyArray<string>
  readonly historyValue: Readonly<Record<string, ReadonlyArray<string>>>
}

export const predict = (command: HistoryCommand): HistoryObservation => {
  const topology = topologyOf(specOf(command))
  const reduced = command.events.reduce<{ readonly state: SimulationState; readonly trace: ReadonlyArray<string> }>(
    (accumulated, event) => {
      const next = step(topology, accumulated.state, event)
      return { state: next.state, trace: [...accumulated.trace, ...next.trace] }
    },
    { state: initialSimulation(), trace: [] },
  )
  return {
    value: subtreeValue(topology, reduced.state.active, ROOT),
    trace: reduced.trace,
    historyValue: historyValueOf(topology, reduced.state.records),
  }
}

const HistoryModelState = Schema.Struct({})
export type HistoryModelState = Schema.Schema.Type<typeof HistoryModelState>

export const historyModel = {
  state: HistoryModelState,
  initial: {},
  precondition: (): boolean => true,
  step: (state: HistoryModelState, command: HistoryCommand): readonly [HistoryModelState, HistoryObservation] =>
    [state, predict(command)] as const,
}
