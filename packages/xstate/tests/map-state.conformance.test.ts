import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { createActor, mapState, setup, types } from '@systemfsoftware/xstate'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  makeRootFirstSubject,
  makeStateMappingSubject,
  type MappingSubject,
  runMapStateCommand,
} from './__fixtures__/stateMapping.js'
import { MapStateCommand, stateMappingModel } from './__fixtures__/stateMapping.model.js'

const typedSnapshot = createActor(
  setup({ schemas: { context: types<{ count: number; name: string }>() } }).createMachine({
    context: { count: 0, name: 'n' },
    initial: 'parent',
    states: { parent: { initial: 'child', states: { child: {}, sibling: {} } }, idle: {} },
  }),
).getSnapshot()

const typedResults = mapState<typeof typedSnapshot, number>(typedSnapshot, {
  map: ({ context }) => context.count,
  states: { parent: { states: { child: { map: ({ context }) => context.name.length } } }, idle: {} },
})

export const typeLevelContract = [
  typedResults[0]?.result satisfies number | undefined,
  // @ts-expect-error the result type is the mapper's TResult, never a wider one
  typedResults[0]?.result satisfies string | undefined,
  mapState(typedSnapshot, {
    // @ts-expect-error 'nonexistent' names no state of the machine
    states: { nonexistent: {} },
  }),
  mapState(typedSnapshot, {
    // @ts-expect-error 'invalidChild' names no child of parent
    states: { parent: { states: { invalidChild: {} } } },
  }),
  mapState<typeof typedSnapshot, number>(typedSnapshot, {
    map: () => 1,
    // @ts-expect-error a nested map must return the same TResult as the root map
    states: { parent: { states: { child: { map: () => 'one' } } } },
  }),
] as const

const Feature = makeFeature({ it })

const sequences = 64
const operations = 6

const checkOver = (subject: MappingSubject, seed: number) =>
  Conformance.sequential(subject.layer, {
    commands: MapStateCommand,
    model: stateMappingModel,
    run: runMapStateCommand,
    sequences,
    operations,
    seed,
  })

Feature('Judging the published mapState against a model of active state nodes', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'Every machine and mapper the model draws from seed <seed> map to the active states it names, leaf first',
      [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published mapState, with a fresh ledger')(
            'subject',
            () => Effect.succeed(makeStateMappingSubject()),
          ),
          When('the sequential model check maps each generated machine snapshot through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every sequence is explained by the active-state-node model')((s, expect) =>
            expect(passReportOf(s.report), 'the published mapping agrees with the model').toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          ),
          When('the results the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And('some snapshots mapped several states and some mapped none')((s, expect) =>
            expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
              (observed) => observed.mappedResults > observed.calls && observed.emptyResults > 0,
              'the run mapped more states than snapshots, and at least one snapshot mapped no state',
            )
          ),
        ),
    )

    scenario(
      'A mapping that lists the root before the leaves is caught as a model divergence',
      Gherkin.Do.pipe(
        Given('a subject that returns the published results in reverse, root first')(
          'subject',
          () => Effect.succeed(makeRootFirstSubject()),
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
      ),
    )
  })
