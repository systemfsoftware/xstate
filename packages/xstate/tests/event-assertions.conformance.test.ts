import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { assertEvent } from '@systemfsoftware/xstate'
import { Effect, Layer } from 'effect'
import {
  type AssertionSubject,
  boundGreetMessageOf,
  failReportOf,
  greetMessageOf,
  greetOrNotifyMessageOf,
  makeBoundAssertionSubject,
  makeEventAssertionSubject,
  makeWildcardBlindSubject,
  passReportOf,
  runAssertionCommand,
  userWildcardTypeOf,
} from './__fixtures__/eventAssertion.js'
import { AssertionCommand, eventDescriptorModel } from './__fixtures__/eventDescriptor.model.js'

type Greet = { readonly type: 'greet'; readonly message: string }
type Notify = { readonly type: 'notify'; readonly level: 'info' | 'error' }
type Login = { readonly type: 'user.login'; readonly name: string }
type Logout = { readonly type: 'user.logout' }
type TypedEvent = Greet | Notify | Login | Logout

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

const boundGreet = assertEvent<TypedEvent, 'greet'>('greet')
const boundGreetOrNotify = assertEvent<TypedEvent, 'greet' | 'notify'>(['greet', 'notify'])
const boundUser = assertEvent<TypedEvent, 'user.*'>('user.*')
const boundAny = assertEvent<TypedEvent, '*'>('*')

export const typeLevelContract = [true, true, true, true] as const satisfies readonly [
  Same<typeof boundGreet, (event: TypedEvent) => asserts event is Greet>,
  Same<typeof boundGreetOrNotify, (event: TypedEvent) => asserts event is Greet | Notify>,
  Same<typeof boundUser, (event: TypedEvent) => asserts event is Login | Logout>,
  Same<typeof boundAny, (event: TypedEvent) => asserts event is TypedEvent>,
]

export const refusedDescriptors = [
  // @ts-expect-error 'nope' names no event type of TypedEvent
  assertEvent<TypedEvent, 'nope'>('nope'),
  // @ts-expect-error 'user.nope.*' matches no event type of TypedEvent
  (event: TypedEvent) => assertEvent(event, 'user.nope.*'),
  (event: TypedEvent) => {
    // @ts-expect-error TS2776: the assertion narrows only through an explicitly typed binding, never inline
    assertEvent<TypedEvent, 'greet'>('greet')(event)
  },
] as const

const Feature = makeFeature({ it })

const sequences = 32
const operations = 6

const subjectFor = {
  'event and types': makeEventAssertionSubject,
  'types alone, bound to a typed const': makeBoundAssertionSubject,
} as const

const rows = [1, 2, 3].flatMap((seed) =>
  (['event and types', 'types alone, bound to a typed const'] as const).map((form) => ({ seed, form }))
)

const checkOver = (subject: AssertionSubject, seed: number) =>
  Conformance.sequential(subject.layer, {
    commands: AssertionCommand,
    model: eventDescriptorModel,
    run: runAssertionCommand,
    sequences,
    operations,
    seed,
  })

Feature('Judging the published assertEvent against a pure descriptor model', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'The published assertion called with <form> keeps every sequence the model draws from seed <seed> in step',
      rows,
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published assertion in that call form, with a fresh ledger')(
            'subject',
            () => Effect.succeed(subjectFor[row.form]()),
          ),
          When('the sequential model check runs the generated sequences through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every sequence is explained by the descriptor model')((s, expect) => {
            const passed = passReportOf(s.report)
            return expect(passed, Conformance.render(s.report)).toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          }),
          When('the responses the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And('every kind of assertion was observed, and the declared narrowing reads through')((s, expect) =>
            expect({
              counts: [
                s.observed.exactAccepted,
                s.observed.exactRefused,
                s.observed.unionAccepted,
                s.observed.unionRefused,
                s.observed.listRefused,
              ],
              greet: greetMessageOf({ type: 'greet', message: 'hello' }),
              boundGreet: boundGreetMessageOf({ type: 'greet', message: 'hello' }),
              both: greetOrNotifyMessageOf({ type: 'notify', message: 'disk full', level: 'error' }),
              wildcard: userWildcardTypeOf({ type: 'user.logout' }),
            }).toSatisfy(
              (value) =>
                value.counts.every((count) => count > 0) &&
                value.greet === 'hello' &&
                value.boundGreet === 'hello' &&
                value.both === 'disk full' &&
                value.wildcard === 'user.logout',
              'every kind of assertion was observed at least once and each declared narrowing read through',
            )
          ),
        ),
    )

    scenario(
      'A matcher that ignores wildcard descriptors is caught as a model divergence',
      Gherkin.Do.pipe(
        Given('a subject whose matcher accepts an event only when the descriptor names its type exactly')(
          'subject',
          () => Effect.succeed(makeWildcardBlindSubject()),
        ),
        When('the same check runs the sequences drawn from seed 1 through it')(
          'report',
          (s) => checkOver(s.subject, 1),
        ),
        Then(
          'the run is rejected with the model-diverged judgement, at the first step the model did not explain',
        )((s, expect) => {
          const failure = failReportOf(s.report).failure
          const rendered = Conformance.render(s.report)
          return expect(
            { problem: failure.judgement.problem, step: failure.judgement.step, rendered },
            rendered,
          ).toSatisfy(
            (value) =>
              value.problem === 'model-diverged' &&
              value.step !== undefined &&
              value.step > 0 &&
              value.rendered.includes(`the model diverged at step ${value.step}`),
            'the run diverged from the model at a numbered step, reported as the model-diverged judgement',
          )
        }),
      ),
    )
  })
