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
  getAdjacencyMap,
  getPathsFromEvents,
  getShortestPaths,
  getSimplePaths,
  joinPaths,
  serializeSnapshot,
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

export const typeLevelContract = [
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
  ...Object.values(observed.joins).flatMap((outcomes) => Object.values(outcomes)),
  observed.counters,
  observed.plain,
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
  })
