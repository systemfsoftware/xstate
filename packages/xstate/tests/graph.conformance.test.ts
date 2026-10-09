import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  createActor,
  createLogic,
  createMachine,
  type EventFromLogic,
  type InputFrom,
  setup,
  type SnapshotFrom,
  types,
} from '@systemfsoftware/xstate'
import * as graphEntrypoint from '@systemfsoftware/xstate/graph'
import {
  adjacencyMapToArray,
  type DirectedGraphNode,
  getAdjacencyMap,
  getPathsFromEvents,
  getShortestPaths,
  getSimplePaths,
  joinPaths,
  serializeSnapshot,
  toDirectedGraph,
} from '@systemfsoftware/xstate/graph'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  type GraphHandle,
  type GraphLedger,
  makeAdjacencyIgnoreFilterSubject,
  makeGraphSubject,
  makeReplayFirstCandidateSubject,
  makeShortestLastSubject,
  makeSimpleRevisitSubject,
  runGraphCommand,
} from './__fixtures__/graph.js'
import { type Call, GraphCommand, graphModel } from './__fixtures__/graph.model.js'

const typedSetup = setup({
  schemas: { events: { FOO: types<{}>(), BAR: types<{}>() } },
})

const typedMachine = typedSetup.createMachine({})

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

export const typeLevelContract = () => {
  const typedJoinState = createMachine({ initial: 'a', states: { a: {} } }).resolveState({ value: 'a' })
  const typedJoinPath = {
    state: typedJoinState,
    weight: 1,
    steps: [{ state: typedJoinState, event: { type: 'GO' } }],
  }

  const shortestDataFirst = getShortestPaths(typedMachine, { events: [{ type: 'FOO' }] })
  const shortestDataLast = getShortestPaths<typeof typedMachine>({ events: [{ type: 'FOO' }] })(typedMachine)
  const shortestDataLastByDefault = getShortestPaths<typeof typedMachine>()(typedMachine)
  const simpleDataFirst = getSimplePaths(typedMachine, { events: [{ type: 'FOO' }] })
  const simpleDataLast = getSimplePaths<typeof typedMachine>({ events: [{ type: 'FOO' }] })(typedMachine)
  const simpleDataLastByDefault = getSimplePaths<typeof typedMachine>()(typedMachine)
  const adjacencyDataFirst = getAdjacencyMap(typedMachine, {})
  const adjacencyDataLast = getAdjacencyMap<
    SnapshotFrom<typeof typedMachine>,
    EventFromLogic<typeof typedMachine>,
    InputFrom<typeof typedMachine>
  >({})(typedMachine)
  const replayDataFirst = getPathsFromEvents(typedMachine, [{ type: 'FOO' }])
  const replayDataLast = getPathsFromEvents<
    SnapshotFrom<typeof typedMachine>,
    EventFromLogic<typeof typedMachine>,
    InputFrom<typeof typedMachine>
  >([{ type: 'FOO' }], { events: [{ type: 'FOO' }] })(typedMachine)
  const replayDataLastByDefault = getPathsFromEvents<
    SnapshotFrom<typeof typedMachine>,
    EventFromLogic<typeof typedMachine>,
    InputFrom<typeof typedMachine>
  >([{ type: 'FOO' }])(typedMachine)
  const joinDataFirst = joinPaths(typedJoinPath, typedJoinPath)
  const joinDataLast = joinPaths(typedJoinPath)(typedJoinPath)

  return [
    getShortestPaths(typedMachine, { events: [{ type: 'FOO' }] }),
    getShortestPaths(typedMachine, { events: [{ type: 'FOO' }] as const }),
    getShortestPaths(typedMachine, { events: () => [{ type: 'FOO' }] as const }),
    // @ts-expect-error an undeclared event type is refused
    getShortestPaths(typedMachine, { events: [{ type: 'UNKNOWN' }] }),
    // @ts-expect-error a declared event cannot receive another event's property
    getShortestPaths(typedMachine, { events: [{ type: 'FOO', other: 'x' }] }),
    getShortestPaths(typedMachine, { serializeEvent: () => '' }),
    getShortestPaths(typedMachine, { serializeState: () => '' }),
    getAdjacencyMap(typedMachine, {}),
    getShortestPaths<typeof typedMachine>({ events: [{ type: 'FOO' }] })(typedMachine),
    getShortestPaths<typeof typedMachine>()(typedMachine),
    getSimplePaths<typeof typedMachine>({ events: [{ type: 'FOO' }] })(typedMachine),
    getSimplePaths<typeof typedMachine>()(typedMachine),
    getAdjacencyMap<
      SnapshotFrom<typeof typedMachine>,
      EventFromLogic<typeof typedMachine>,
      InputFrom<typeof typedMachine>
    >({})(typedMachine),
    getPathsFromEvents<
      SnapshotFrom<typeof typedMachine>,
      EventFromLogic<typeof typedMachine>,
      InputFrom<typeof typedMachine>
    >([{ type: 'FOO' }], { events: [{ type: 'FOO' }] })(typedMachine),
    getPathsFromEvents<
      SnapshotFrom<typeof typedMachine>,
      EventFromLogic<typeof typedMachine>,
      InputFrom<typeof typedMachine>
    >([{ type: 'FOO' }])(typedMachine),
    joinPaths(typedJoinPath)(typedJoinPath),
    // @ts-expect-error the data-last form refuses an undeclared event type too
    getShortestPaths<typeof typedMachine>({ events: [{ type: 'UNKNOWN' }] })(typedMachine),
    true satisfies Same<typeof shortestDataLast, typeof shortestDataFirst>,
    true satisfies Same<typeof shortestDataLastByDefault, typeof shortestDataFirst>,
    true satisfies Same<typeof simpleDataLast, typeof simpleDataFirst>,
    true satisfies Same<typeof simpleDataLastByDefault, typeof simpleDataFirst>,
    true satisfies Same<typeof adjacencyDataLast, typeof adjacencyDataFirst>,
    true satisfies Same<typeof replayDataLast, typeof replayDataFirst>,
    true satisfies Same<typeof replayDataLastByDefault, typeof replayDataFirst>,
    true satisfies Same<typeof joinDataLast, typeof joinDataFirst>,
  ] as const
}

const Feature = makeFeature({ it })

const sequences = 64
const operations = 6

const requiredForms: ReadonlyArray<readonly [keyof GraphLedger['forms'], Call]> = [
  ['adjacency', 'data-first'],
  ['adjacency', 'data-last'],
  ['shortest', 'data-first'],
  ['shortest', 'data-first-default'],
  ['shortest', 'data-last'],
  ['shortest', 'data-last-default'],
  ['simple', 'data-first'],
  ['simple', 'data-first-default'],
  ['simple', 'data-last'],
  ['simple', 'data-last-default'],
  ['replay', 'data-first'],
  ['replay', 'data-first-default'],
  ['replay', 'data-last'],
  ['replay', 'data-last-default'],
]

const positives = (observed: GraphLedger): ReadonlyArray<number> => [
  ...Object.values(observed.operations),
  ...requiredForms.map(([operation, call]) => observed.forms[operation][call]),
  ...Object.values(observed.plainForms),
  ...Object.values(observed.joins).flatMap((outcomes) => Object.values(outcomes)),
  observed.counters,
  observed.plain,
  observed.plainLogic,
  observed.inputSeeded,
  observed.customEvents,
  observed.adjacencyArray,
  observed.parallel,
  observed.filtered,
  observed.stopped,
  observed.targeted,
  observed.limited,
  observed.fromSecond,
  observed.valueSerialize,
  observed.treeBranches,
  ...Object.values(observed.treeTargets),
]

const liveness = (observed: GraphLedger): boolean => positives(observed).every((count) => count > 0)

const checkOver = (subject: GraphHandle, seed: number) =>
  Conformance.sequential(subject.layer, {
    commands: GraphCommand,
    model: graphModel,
    run: runGraphCommand,
    sequences,
    operations,
    seed,
  })

const delayMachine = createMachine({
  initial: 'a',
  states: { a: { after: { 1000: { target: 'b' } } }, b: {} },
})

const counterLogic = createLogic({
  context: ({ input }: { readonly input: number }) => input,
  run: ({ context, event }: { readonly context: number; readonly event: { readonly type: string } }) =>
    event.type === 'INC' ? { context: context + 1 } : undefined,
})

const plainMachine = createMachine({ initial: 'a', states: { a: {} } })
const countedMachine = createMachine({ context: { count: 0 }, initial: 'a', states: { a: {} } })

const plainReplay = () => {
  const path = getPathsFromEvents(counterLogic, [{ type: 'INC' }], { input: 10, limit: 1 })[0]
  return path === undefined ? { context: -1, weight: -1 } : { context: path.state.context, weight: path.weight }
}

const snapshotRendering = () => ({
  plain: serializeSnapshot(createActor(plainMachine).getSnapshot()),
  counted: serializeSnapshot(createActor(countedMachine).getSnapshot()),
})

const lightMachine = createMachine({
  id: 'light',
  initial: 'green',
  states: {
    green: { on: { TIMER: { target: 'yellow' } } },
    yellow: { on: { TIMER: { target: 'red' } } },
    red: {
      initial: 'walk',
      states: {
        walk: { on: { COUNTDOWN: { target: 'wait' } } },
        wait: { on: { COUNTDOWN: { target: 'stop' } } },
        stop: { on: { COUNTDOWN: { target: 'finished' } } },
        finished: { type: 'final' },
      },
      onDone: { target: 'green' },
    },
  },
})

const expectedLightGraph = {
  id: 'light',
  edges: [],
  children: [
    {
      id: 'light.green',
      children: [],
      edges: [{ source: 'light.green', target: 'light.yellow', label: { text: 'TIMER' } }],
    },
    {
      id: 'light.yellow',
      children: [],
      edges: [{ source: 'light.yellow', target: 'light.red', label: { text: 'TIMER' } }],
    },
    {
      id: 'light.red',
      children: [
        {
          id: 'light.red.walk',
          children: [],
          edges: [{ source: 'light.red.walk', target: 'light.red.wait', label: { text: 'COUNTDOWN' } }],
        },
        {
          id: 'light.red.wait',
          children: [],
          edges: [{ source: 'light.red.wait', target: 'light.red.stop', label: { text: 'COUNTDOWN' } }],
        },
        {
          id: 'light.red.stop',
          children: [],
          edges: [{ source: 'light.red.stop', target: 'light.red.finished', label: { text: 'COUNTDOWN' } }],
        },
        { id: 'light.red.finished', children: [], edges: [] },
      ],
      edges: [{ source: 'light.red', target: 'light.green', label: { text: 'xstate.done.state' } }],
    },
  ],
}

const renderGraph = (node: DirectedGraphNode): object => ({
  id: node.id,
  children: node.children.map(renderGraph),
  edges: node.edges.map((edge) => {
    const json = edge.toJSON()
    return { source: json.source, target: json.target, label: { text: json.label.text } }
  }),
})

const digraphViews = () => ({
  machine: renderGraph(toDirectedGraph(lightMachine)),
  root: renderGraph(toDirectedGraph(lightMachine.root)),
  proxied: renderGraph(toDirectedGraph(new Proxy(lightMachine, { getPrototypeOf: () => null }))),
})

const provenanceMachine = createMachine({
  initial: 'a',
  states: {
    a: { on: { toB: { target: 'b' } } },
    b: { on: { toC: { target: 'c' } } },
    c: { on: { toA: { target: 'a' } } },
  },
})

const provenanceSerializedKeys = (): ReadonlyArray<string> =>
  Object.keys(
    getAdjacencyMap(provenanceMachine, {
      serializeState: (state, event, prevState) =>
        `${state.value}|${event?.type ?? 'init'}|${prevState === undefined ? 'none' : prevState.value}`,
    }),
  )

const replayFromSecondState = (): string => {
  const machine = createMachine({
    initial: 'red',
    states: {
      red: { on: { TIMER: { target: 'green' } } },
      green: { on: { TIMER: { target: 'yellow' } } },
      yellow: { on: { TIMER: { target: 'red' } } },
    },
  })
  const path = getPathsFromEvents(machine, [{ type: 'TIMER' }], {
    fromState: machine.resolveState({ value: 'yellow' }),
  })[0]
  return path === undefined ? 'none' : String(path.state.value)
}

const metadataLogicPath = (): number => {
  const logic = Object.assign(
    createLogic({
      context: 0,
      run: ({ context, event }: { readonly context: number; readonly event: { readonly type: string } }) =>
        event.type === 'INC' ? { context: context + 1 } : undefined,
    }),
    { getStateNodeById: () => 'custom metadata' },
  )
  const path = getPathsFromEvents(logic, [{ type: 'INC' }], {
    toState: (state) => state.context === 1,
  })[0]
  return path === undefined ? -1 : path.state.context
}

const rootedLogicAdjacencyKeys = (): ReadonlyArray<string> => {
  const logic = Object.assign(
    createLogic({ context: 0, run: () => undefined }),
    { root: { id: 'x' }, getStateNodeById: () => 'x' },
  )
  return Object.keys(getAdjacencyMap(logic, { serializeState: (state) => `s${state.context}` }))
}

const countedCustomLogic = () => {
  let calls = 0
  const logic = createLogic({
    context: ({ input }: { readonly input: number }) => {
      calls += 1
      return input
    },
    run: () => undefined,
  })
  return { logic, calls: () => calls }
}

const initOnceCustom = () => {
  const shortest = countedCustomLogic()
  const shortestPaths = getShortestPaths(shortest.logic, { input: 0, events: [] })
  const simple = countedCustomLogic()
  const simplePaths = getSimplePaths(simple.logic, { input: 0, events: [] })
  return {
    shortest: { length: shortestPaths.length, calls: shortest.calls() },
    simple: { length: simplePaths.length, calls: simple.calls() },
  }
}

const initOnceExplicitFromState = () => {
  const run = (mode: 'shortest' | 'simple' | 'replay') => {
    const counted = countedCustomLogic()
    const options = { fromState: undefined, events: [] }
    const paths = mode === 'replay'
      ? getPathsFromEvents(counted.logic, [], options)
      : mode === 'shortest'
      ? getShortestPaths(counted.logic, options)
      : getSimplePaths(counted.logic, options)
    return { length: paths.length, calls: counted.calls() }
  }
  return { shortest: run('shortest'), simple: run('simple'), replay: run('replay') }
}

const prototypeKeys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ''] as const

const prototypeKeyCoverage = () =>
  prototypeKeys.map((key) => {
    const logic = createLogic({
      context: ({ input }: { readonly input: number }) => input,
      run: ({ context, event }: { readonly context: number; readonly event: { readonly type: string } }) =>
        event.type === 'INC' ? { context: context + 1 } : undefined,
    })
    const options = {
      input: 0,
      events: [{ type: 'INC' }],
      stopWhen: (state: { readonly context: number }) => state.context === 1,
      serializeState: (state: { readonly context: number }) => state.context === 0 ? key : 'end',
      serializeEvent: () => key,
    }
    const adjacency = getAdjacencyMap(logic, options)
    const evidences = adjacencyMapToArray(adjacency).map((row) =>
      `${row.nextState.context}|${JSON.stringify(row.event)}`
    )
    const shortest = getShortestPaths(logic, options).find((path) => path.state.context === 1)
    const simple = getSimplePaths(logic, options).find((path) => path.state.context === 1)
    return {
      key,
      adjacencyKeys: Object.keys(adjacency),
      evidences,
      shortest: shortest === undefined ? null : { weight: shortest.weight, steps: shortest.steps.length },
      simple: simple === undefined ? null : { weight: simple.weight, steps: simple.steps.length },
    }
  })

const expectedPrototypeCoverage = prototypeKeys.map((key) => ({
  key,
  adjacencyKeys: [key, 'end'],
  evidences: ['1|{"type":"INC"}'],
  shortest: { weight: 1, steps: 2 },
  simple: { weight: 1, steps: 2 },
}))

const sameSourceSequences = (): ReadonlyArray<string> => {
  const machine = createMachine({
    initial: 'a',
    states: {
      a: { on: { GO_TO_B: { target: 'b' }, GO_TO_C: { target: 'c' } } },
      b: { on: { GO_TO_A: { target: 'a' } } },
      c: { on: { GO_TO_A: { target: 'a' } } },
    },
  })
  return getSimplePaths(machine).map((path) => path.steps.map((step) => step.event.type).join(' → '))
}

const expectedEntrypointNames = [
  'adjacencyMapToArray',
  'getAdjacencyMap',
  'getDescendantStateNodes',
  'getPathsFromEvents',
  'getShortestPaths',
  'getSimplePaths',
  'joinPaths',
  'serializeSnapshot',
  'toDirectedGraph',
]

Feature('Judging the published graph walk against a model of its traversal', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'Every machine, sequence and query the model draws from seed <seed> agrees with the published graph API',
      [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published graph API, with a fresh ledger')(
            'subject',
            () => Effect.succeed(makeGraphSubject()),
          ),
          When('the sequential model check runs the generated queries through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every query is explained by the hand-written model of the graph')((s, expect) =>
            expect(passReportOf(s.report), 'the published graph agrees with the model').toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          ),
          When('the query kinds the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And('every operation, call form, join outcome, machine shape, structural target and query option occurred')(
            (s, expect) =>
              expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
                liveness,
                'the run exercised adjacency, shortest, simple, replay and join queries in every published call form, joined and refused both joins, counted and plain machines, input seeding, filtering, stopping, targeting, limits, from-state overrides, value serialization, branches and every structural target kind',
              ),
          ),
        ),
    )

    const divergesFromTheModel = (makeSubject: () => GraphHandle, seed: number) =>
      Gherkin.Do.pipe(
        Given('a planted subject that behaves differently from the published graph API')(
          'subject',
          () => Effect.succeed(makeSubject()),
        ),
        When(`the same check runs the machines drawn from seed ${seed} through it`)(
          'report',
          (s) => checkOver(s.subject, seed),
        ),
        Then('the run is rejected with the model-diverged judgement at a numbered step')((s, expect) => {
          const failure = failReportOf(s.report).failure
          const rendered = Conformance.render(s.report)
          return expect({ problem: failure.judgement.problem, step: failure.judgement.step, rendered }, rendered)
            .toSatisfy(
              (value) =>
                value.problem === 'model-diverged' &&
                value.step !== undefined &&
                value.rendered.includes(`the model diverged at step ${value.step}`),
              'the run diverged from the model at a numbered step, reported as the model-diverged judgement',
            )
        }),
      )

    scenario(
      'Shortest paths that keep the last-discovered predecessor are caught as a model divergence',
      divergesFromTheModel(makeShortestLastSubject, 1),
    )
    scenario(
      'Simple paths that allow revisiting a vertex once are caught as a model divergence',
      divergesFromTheModel(makeSimpleRevisitSubject, 1),
    )
    scenario(
      'An adjacency map that ignores the event filter is caught as a model divergence',
      divergesFromTheModel(makeAdjacencyIgnoreFilterSubject, 1),
    )
    scenario(
      'A replay that takes the first matching override candidate is caught as a model divergence',
      divergesFromTheModel(makeReplayFirstCandidateSubject, 2),
    )

    scenario(
      'A machine with a delayed transition reaches its next state on the after event',
      Gherkin.Do.pipe(
        Given('the shortest paths of the delayed machine')(
          'events',
          () => Effect.succeed(getShortestPaths(delayMachine).map((path) => path.steps.map((step) => step.event.type))),
        ),
        Then('the after event is the only event beyond the init step')((s, expect) =>
          expect(s.events, JSON.stringify(s.events)).toEqual([['@xstate.init'], ['@xstate.init', 'xstate.after']])
        ),
      ),
    )

    scenario(
      'Replaying a finite sequence on plain logic uses the input and the default serializer',
      Gherkin.Do.pipe(
        Given('the plain counter logic replayed one step from input 10')(
          'observed',
          () => Effect.succeed(plainReplay()),
        ),
        Then('the path reaches the incremented context with weight one')((s, expect) =>
          expect(s.observed, JSON.stringify(s.observed)).toEqual({ context: 11, weight: 1 })
        ),
      ),
    )

    scenario(
      'The published serializeSnapshot omits an empty context and keeps a non-empty one',
      Gherkin.Do.pipe(
        Given('the rendered initial snapshots of a plain and a counted machine')(
          'rendered',
          () => Effect.succeed(snapshotRendering()),
        ),
        Then('the plain state serializes without a context and the counted state with one')((s, expect) =>
          expect(s.rendered, JSON.stringify(s.rendered)).toEqual({
            plain: '{"value":"a"}',
            counted: '{"value":"a","context":{"count":0}}',
          })
        ),
      ),
    )

    scenario(
      'The published graph entrypoint exposes only the graph API',
      Gherkin.Do.pipe(
        Given('the published entrypoint namespace is read once')(
          'names',
          () => Effect.succeed(Object.keys(graphEntrypoint).sort()),
        ),
        Then('it publishes the nine graph operations and nothing else')((s, expect) =>
          expect(s.names.join(','), JSON.stringify(s.names)).toSatisfy(
            (names) => names === expectedEntrypointNames.join(','),
            'the entrypoint namespace holds exactly the nine graph operations',
          )
        ),
      ),
    )

    scenario(
      'toDirectedGraph renders a machine, its root state node and an identity-independent proxy alike',
      Gherkin.Do.pipe(
        Given('the directed graph of the machine, of its root state node and of a null-prototype proxy')(
          'views',
          () => Effect.succeed(digraphViews()),
        ),
        Then('each view matches the hand-written shape of the light statechart')((s, expect) =>
          expect(s.views, JSON.stringify(s.views)).toEqual({
            machine: expectedLightGraph,
            root: expectedLightGraph,
            proxied: expectedLightGraph,
          })
        ),
      ),
    )

    scenario(
      'The serializer receives each state with its entering event and its previous state',
      Gherkin.Do.pipe(
        Given('the adjacency keys of a three-state cycle serialized with provenance')(
          'keys',
          () => Effect.succeed(provenanceSerializedKeys()),
        ),
        Then('every key records the state, the event that entered it and the state it came from')((s, expect) =>
          expect(s.keys, JSON.stringify(s.keys)).toEqual(['a|init|none', 'b|toB|a', 'c|toC|b', 'a|toA|c'])
        ),
      ),
    )

    scenario(
      'Replaying from a specified from-state begins at that state',
      Gherkin.Do.pipe(
        Given('a single timer replay starting from the yellow state')(
          'landed',
          () => Effect.succeed(replayFromSecondState()),
        ),
        Then('the path lands on the state yellow transitions to')((s, expect) =>
          expect(s.landed, s.landed).toEqual('red')
        ),
      ),
    )

    scenario(
      'A custom logic carrying getStateNodeById is traversed as plain logic',
      Gherkin.Do.pipe(
        Given('an increment replayed on a custom logic that also carries getStateNodeById')(
          'context',
          () => Effect.succeed(metadataLogicPath()),
        ),
        Then('the reached state is the incremented context')((s, expect) =>
          expect(s.context, JSON.stringify(s.context)).toEqual(1)
        ),
      ),
    )

    scenario(
      'A logic carrying a non-machine root member is traversed as plain logic, not as a machine',
      Gherkin.Do.pipe(
        Given('the adjacency keys of a custom logic whose root member is not a machine root')(
          'keys',
          () => Effect.succeed(rootedLogicAdjacencyKeys()),
        ),
        Then('the traversal starts from the plain initial state and derives no event from snapshot nodes')((
          s,
          expect,
        ) => expect(s.keys, JSON.stringify(s.keys)).toEqual(['s0'])),
      ),
    )

    scenario(
      'A custom logic initializes exactly once per traversal call, with and without an explicit from-state',
      Gherkin.Do.pipe(
        Given('the initialization counts of a custom logic across the path generators')(
          'observed',
          () => Effect.succeed({ custom: initOnceCustom(), explicitFromState: initOnceExplicitFromState() }),
        ),
        Then('each generator initializes its logic exactly once')((s, expect) =>
          expect(s.observed, JSON.stringify(s.observed)).toEqual({
            custom: { shortest: { length: 1, calls: 1 }, simple: { length: 1, calls: 1 } },
            explicitFromState: {
              shortest: { length: 1, calls: 1 },
              simple: { length: 1, calls: 1 },
              replay: { length: 1, calls: 1 },
            },
          })
        ),
      ),
    )

    scenario(
      'Serialized state and event keys that collide with Object.prototype members address real entries',
      Gherkin.Do.pipe(
        Given('the adjacency and paths of a counter logic serialized under prototype-colliding keys')(
          'observed',
          () => Effect.succeed(prototypeKeyCoverage()),
        ),
        Then('every colliding key addresses a node and reaches the target in one step')((s, expect) =>
          expect(s.observed, JSON.stringify(s.observed)).toEqual(expectedPrototypeCoverage)
        ),
      ),
    )

    scenario(
      'Two transitions out of one state are both drawn as distinct simple paths',
      Gherkin.Do.pipe(
        Given('the simple-path event sequences of a state with two transitions')(
          'sequences',
          () => Effect.succeed(sameSourceSequences()),
        ),
        Then('both transitions appear as their own one-step path')((s, expect) =>
          expect(s.sequences, JSON.stringify(s.sequences)).toSatisfy(
            (sequences) =>
              sequences.includes('@xstate.init → GO_TO_B') &&
              sequences.includes('@xstate.init → GO_TO_C'),
            'both transitions out of the source state are considered',
          )
        ),
      ),
    )
  })
