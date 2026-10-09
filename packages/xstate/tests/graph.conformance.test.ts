import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { createActor, createLogic, createMachine, setup, types } from '@systemfsoftware/xstate'
import * as graphEntrypoint from '@systemfsoftware/xstate/graph'
import {
  getAdjacencyMap,
  getPathsFromEvents,
  getShortestPaths,
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
import { GraphCommand, graphModel } from './__fixtures__/graph.model.js'

const typedSetup = setup({
  schemas: { events: { FOO: types<{}>(), BAR: types<{}>() } },
})

const typedMachine = typedSetup.createMachine({})

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
] as const

const Feature = makeFeature({ it })

const sequences = 64
const operations = 6

const positives = (observed: GraphLedger): ReadonlyArray<number> => [
  ...Object.values(observed.operations),
  observed.counters,
  observed.plain,
  observed.inputSeeded,
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

const joinMachine = createMachine({
  initial: 'a',
  states: {
    a: { on: { NEXT: { target: 'b' } } },
    b: { on: { TO_C: { target: 'c' } } },
    c: {},
  },
})

const joinEventTypes = (): ReadonlyArray<string> => {
  const toB = getPathsFromEvents(joinMachine, [{ type: 'NEXT' }])[0]
  const toC = toB === undefined
    ? undefined
    : getPathsFromEvents(joinMachine, [{ type: 'TO_C' }], { fromState: toB.state })[0]
  return toB === undefined || toC === undefined ? [] : joinPaths(toB, toC).steps.map((step) => step.event.type)
}

const joinRefusal = (): string => {
  const toB = getPathsFromEvents(joinMachine, [{ type: 'NEXT' }])[0]
  const toCFromA = getPathsFromEvents(joinMachine, [{ type: 'TO_C' }])[0]
  return toB === undefined || toCFromA === undefined ? 'missing path' : thrownMessageOf(() => joinPaths(toB, toCFromA))
}

const thrownMessageOf = (compute: () => object): string => {
  try {
    compute()
    return 'no error'
  } catch (error) {
    return error instanceof Error ? error.message : 'unrecognized failure'
  }
}

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
          And('every operation, machine shape, structural target and query option occurred')((s, expect) =>
            expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
              liveness,
              'the run exercised adjacency, shortest, simple, replay and structure queries, counted and plain machines, input seeding, filtering, stopping, targeting, limits, from-state overrides, value serialization, branches and every structural target kind',
            )
          ),
        ),
    )

    const divergesFromTheModel = (makeSubject: () => GraphHandle) =>
      Gherkin.Do.pipe(
        Given('a planted subject that behaves differently from the published graph API')(
          'subject',
          () => Effect.succeed(makeSubject()),
        ),
        When('the same check runs the machines drawn from seed 1 through it')(
          'report',
          (s) => checkOver(s.subject, 1),
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
      divergesFromTheModel(makeShortestLastSubject),
    )
    scenario(
      'Simple paths that allow revisiting a vertex once are caught as a model divergence',
      divergesFromTheModel(makeSimpleRevisitSubject),
    )
    scenario(
      'An adjacency map that ignores the event filter is caught as a model divergence',
      divergesFromTheModel(makeAdjacencyIgnoreFilterSubject),
    )
    scenario(
      'A replay that takes the first matching override candidate is caught as a model divergence',
      divergesFromTheModel(makeReplayFirstCandidateSubject),
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
      'Joining two paths that meet head to tail yields the concatenated path',
      Gherkin.Do.pipe(
        Given('a path to b joined with a path from b to c')('events', () => Effect.succeed(joinEventTypes())),
        Then('the joined events run init, NEXT, TO_C')((s, expect) =>
          expect(s.events, JSON.stringify(s.events)).toEqual(['@xstate.init', 'NEXT', 'TO_C'])
        ),
      ),
    )

    scenario(
      'Joining two paths whose source and target states differ is refused',
      Gherkin.Do.pipe(
        Given('a path to b joined with a path that starts at a')('message', () => Effect.succeed(joinRefusal())),
        Then('the join is refused by name')((s, expect) =>
          expect(s.message, JSON.stringify(s.message)).toContain('Paths cannot be joined')
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
