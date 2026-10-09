import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  makeEscapeBlindSubject,
  makeLeafPathSubject,
  makeStateMatchingSubject,
  type MatchingSubject,
  runMatchCommand,
} from './__fixtures__/stateMatching.js'
import { MatchCommand, stateMatchingModel } from './__fixtures__/stateValue.model.js'

const Feature = makeFeature({ it })

const sequences = 64
const operations = 8

const checkOver = (subject: MatchingSubject, seed: number) =>
  Conformance.sequential(subject.layer, {
    commands: MatchCommand,
    model: stateMatchingModel,
    run: runMatchCommand,
    sequences,
    operations,
    seed,
  })

Feature('Judging the published state matching against a model of active state paths', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'Every match the model draws from seed <seed> agrees with the active state paths it names',
      [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published matchesState and snapshot matching, with a fresh ledger')(
            'subject',
            () => Effect.succeed(makeStateMatchingSubject()),
          ),
          When('the sequential model check runs the generated matches through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every sequence is explained by the active-state-path model')((s, expect) =>
            expect(passReportOf(s.report), 'the published matching agrees with the model').toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          ),
          When('the answers the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And(
            'each call form answered both ways, and every escape the id grammar allows reached the published matching',
          )(
            (s, expect) => {
              const { answers, ...argumentCounts } = s.observed
              return expect({ answers: Object.values(answers), argumentCounts }, JSON.stringify(s.observed)).toSatisfy(
                (value) =>
                  value.answers.every((tally) => tally.matched > 0 && tally.unmatched > 0) &&
                  Object.values(value.argumentCounts).every((count) => count > 0),
                'data-first, data-last and snapshot matching each returned true and false, and the run passed state ids, ids with an escaped dot, nested leaf names containing a dot, ids escaping whitespace, ids ending in a lone backslash, and string state values holding a backslash',
              )
            },
          ),
        ),
    )

    const divergesFromTheModel = (makeSubject: () => MatchingSubject) =>
      Gherkin.Do.pipe(
        Given('a planted subject that reads state values differently from the published matching')(
          'subject',
          () => Effect.succeed(makeSubject()),
        ),
        When('the same check runs the matches drawn from seed 1 through it')(
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
      'A matcher that splits state ids on escaped dots is caught as a model divergence',
      divergesFromTheModel(makeEscapeBlindSubject),
    )
    scenario(
      'A matcher that reads a leaf name inside a state value as a dotted path is caught as a model divergence',
      divergesFromTheModel(makeLeafPathSubject),
    )
  })
