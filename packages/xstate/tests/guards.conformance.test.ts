import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  checkStateIn,
  createActor,
  createMachine,
  matchesState,
  setup,
  type StateValue,
  types,
} from '@systemfsoftware/xstate'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  type GuardsHandle,
  type GuardsLedger,
  makeDropsEffectSubject,
  makeGuardsSubject,
  makeRejectsAsEmptySubject,
  runGuardsCommand,
} from './__fixtures__/guards.js'
import { GuardsCommand, guardsModel } from './__fixtures__/guards.model.js'

export const typeLevelContract = () => {
  const machine = createMachine({
    type: 'parallel',
    states: { a: { initial: 'a1', states: { a1: {}, a2: {} } }, b: { initial: 'b1', states: { b1: {}, b2: {} } } },
  })
  const snapshot = machine.getInitialSnapshot()

  return [
    checkStateIn(snapshot, 'a.a1') satisfies boolean,
    checkStateIn('a.a1')(snapshot) satisfies boolean,
    checkStateIn(snapshot, { a: 'a1' }) satisfies boolean,
    checkStateIn({ a: 'a1' })(snapshot) satisfies boolean,
    matchesState('a.a1', snapshot.value) satisfies boolean,
    matchesState('a.a1')(snapshot.value) satisfies boolean,
  ] as const
}

const Feature = makeFeature({ it })

const sequences = 96
const operations = 6

const liveness = (observed: GuardsLedger): boolean =>
  observed.drivers.actor > 0 &&
  observed.drivers.pure > 0 &&
  observed.factories.createMachine > 0 &&
  observed.factories.setup > 0 &&
  observed.factories.provide > 0 &&
  observed.admitted.Target > 0 &&
  observed.admitted.Pattern > 0 &&
  observed.admitted.Fn > 0 &&
  observed.rejected.Absent > 0 &&
  observed.rejected.Pattern > 0 &&
  observed.rejected.Fn > 0 &&
  observed.fallbackToP > 0 &&
  observed.fallbackToRegion > 0 &&
  observed.fallbackToRoot > 0 &&
  observed.rootAdmitted > 0 &&
  observed.rootRejected > 0 &&
  observed.effectsAdmitted > 0 &&
  observed.patternMatched > 0 &&
  observed.patternMismatched > 0 &&
  observed.namedAsked.createMachine > 0 &&
  observed.namedAsked.setup > 0 &&
  observed.namedAsked.provide > 0 &&
  observed.inTrue > 0 &&
  observed.inFalse > 0 &&
  observed.eventlessL > 0 &&
  observed.eventlessR > 0 &&
  observed.crossRegionInterim > 0 &&
  observed.canTrue > 0 &&
  observed.canFalse > 0 &&
  observed.checkStateIn.dataFirst.true > 0 &&
  observed.checkStateIn.dataFirst.false > 0 &&
  observed.checkStateIn.dataLast.true > 0 &&
  observed.checkStateIn.dataLast.false > 0

const checkOver = (handle: GuardsHandle, seed: number) =>
  Conformance.sequential(handle.layer, {
    commands: GuardsCommand,
    model: guardsModel,
    run: runGuardsCommand,
    sequences,
    operations,
    seed,
  })

interface ActorStatus {
  readonly status: string
  readonly message: string
}

Feature('Judging the published guard evaluation against a hand-written model of admission', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'Every machine and event sequence the model draws from seed <seed> admits exactly what the published guards admit',
      [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published machine entrypoints, with a fresh ledger')(
            'subject',
            () => Effect.succeed(makeGuardsSubject()),
          ),
          When('the sequential model check runs the generated machines and event sequences through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every sequence is explained by the hand-written admission model')((s, expect) =>
            expect(passReportOf(s.report), 'the published guards agree with the model').toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          ),
          When('the steps the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And(
            'every slot kind was admitted and rejected, every fallback depth and the root were reached, patterns matched and mismatched, an effect fired, a named source was asked under every factory, an in check answered both ways, each region stepped eventlessly with one cross-region interim step, can answered both ways, and checkStateIn answered both ways and both call forms',
          )(
            (s, expect) =>
              expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
                liveness,
                'the run exercised the whole admission surface across both drivers and all three factories',
              ),
          ),
        ),
    )

    const divergesFromTheModel = (makeSubject: () => GuardsHandle) =>
      Gherkin.Do.pipe(
        Given('a planted subject that admits differently from the published guards')(
          'subject',
          () => Effect.succeed(makeSubject()),
        ),
        When('the same check runs the machines drawn from seed 1 through it')('report', (s) => checkOver(s.subject, 1)),
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
      'A rejection that returns an empty object consumes the event and is caught as a model divergence',
      divergesFromTheModel(makeRejectsAsEmptySubject),
    )
    scenario(
      'An effect outcome that enqueues nothing falls through and is caught as a model divergence',
      divergesFromTheModel(makeDropsEffectSubject),
    )

    scenario(
      'A guard source the machine does not implement leaves the actor in error status with a TypeError naming it',
      Gherkin.Do.pipe(
        Given('a machine whose routing step calls a guard source it does not implement')(
          'outcome',
          () =>
            Effect.sync(() => {
              const declared = {
                isReady: (ready: boolean) => ready === true,
                isRedy: (ready: boolean) => ready,
              }
              Reflect.deleteProperty(declared, 'isRedy')
              const machine = createMachine({
                context: { ready: false },
                guards: declared,
                initial: 'routing',
                states: {
                  routing: {
                    always: ({ context, guards }) =>
                      guards.isRedy(context.ready) ? { target: 'go' } : { target: 'wait' },
                  },
                  go: {},
                  wait: {},
                },
              })
              const actor = createActor(machine)
              const failures: Array<Error> = []
              actor.subscribe({
                error: (error) => {
                  failures.push(
                    error instanceof Error
                      ? error
                      : new Error('the missing source threw a non-Error', { cause: error }),
                  )
                },
              })
              actor.start()
              const status = actor.getSnapshot().status
              actor.stop()
              const failure = failures.at(0)
              return { status, message: failure === undefined ? '' : failure.message }
            }),
        ),
        Then('the actor is in error status with a message naming the missing source')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: ActorStatus) =>
              outcome.status === 'error' && /guards[^\s]*isRedy[^\s]* is not a function/.test(outcome.message),
            'the actor reports a TypeError naming guards.isRedy',
          )
        ),
      ),
    )

    scenario(
      'A transition function that throws leaves the actor in error status with that error',
      Gherkin.Do.pipe(
        Given('a machine whose transition function throws')('outcome', () =>
          Effect.sync(() => {
            const machine = createMachine({
              initial: 'a',
              states: {
                a: {
                  on: {
                    GO: () => {
                      throw new Error('boom-guard')
                    },
                  },
                },
              },
            })
            const actor = createActor(machine)
            const failures: Array<Error> = []
            actor.subscribe({
              error: (error) => {
                failures.push(
                  error instanceof Error ? error : new Error('the transition threw a non-Error', { cause: error }),
                )
              },
            })
            actor.start()
            actor.send({ type: 'GO' })
            const status = actor.getSnapshot().status
            actor.stop()
            const failure = failures.at(0)
            return { status, message: failure === undefined ? '' : failure.message }
          })),
        Then('the actor carries the thrown error')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: ActorStatus) => outcome.status === 'error' && outcome.message === 'boom-guard',
            'the actor is in error status with the thrown error as its message',
          )
        ),
      ),
    )

    scenario(
      'A guard source receives exactly the arguments the transition function passes',
      Gherkin.Do.pipe(
        Given('a machine whose guard source records what it received')('outcome', () =>
          Effect.sync(() => {
            const received: Array<ReadonlyArray<number>> = []
            const machine = createMachine({
              context: { count: 5 },
              guards: {
                isAbove: (count: number, threshold: number) => {
                  received.push([count, threshold])
                  return count > threshold
                },
              },
              initial: 'a',
              states: {
                a: {
                  on: {
                    GO: ({ context, guards }) => (guards.isAbove(context.count, 3) ? { target: 'b' } : undefined),
                  },
                },
                b: {},
              },
            })
            const actor = createActor(machine).start()
            actor.send({ type: 'GO' })
            const value = actor.getSnapshot().value
            actor.stop()
            return { value, received }
          })),
        Then('the source saw the caller-supplied arguments and the transition admitted')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: { readonly value: StateValue; readonly received: ReadonlyArray<ReadonlyArray<number>> }) =>
              outcome.value === 'b' && JSON.stringify(outcome.received) === JSON.stringify([[5, 3]]),
            'the guard source received [5, 3] and the transition admitted',
          )
        ),
      ),
    )

    scenario(
      'A zero-parameter guard source is called with no arguments',
      Gherkin.Do.pipe(
        Given('a machine whose guard source declares no parameters')('outcome', () =>
          Effect.sync(() => {
            const machine = createMachine({
              guards: { isEnabled: (): boolean => true },
              initial: 'a',
              states: {
                a: { on: { GO: ({ guards }) => (guards.isEnabled() ? { target: 'b' } : undefined) } },
                b: {},
              },
            })
            const actor = createActor(machine).start()
            actor.send({ type: 'GO' })
            const value = actor.getSnapshot().value
            actor.stop()
            return { value }
          })),
        Then('the transition admits')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: { readonly value: StateValue }) => outcome.value === 'b',
            'a zero-parameter source is callable and admits the transition',
          )
        ),
      ),
    )

    scenario(
      'checkStateIn answers path strings and state values like snapshot.matches, in both forms',
      Gherkin.Do.pipe(
        Given('a hand-written parallel machine resting in a1 and b2')('outcome', () =>
          Effect.sync(() => {
            const machine = createMachine({
              type: 'parallel',
              states: {
                a: { initial: 'a1', states: { a1: {}, a2: {} } },
                b: { initial: 'b2', states: { b1: { id: 'b_b1' }, b2: { id: 'b_b2' } } },
              },
            })
            const actor = createActor(machine).start()
            const snapshot = actor.getSnapshot()
            actor.stop()
            const values: ReadonlyArray<StateValue> = [{ a: 'a1', b: 'b2' }, 'a.a1', { a: 'a2' }, '#b_b2', '#b_b1']
            return {
              dataFirst: values.map((value) => checkStateIn(snapshot, value)),
              dataLast: values.map((value) => checkStateIn(value)(snapshot)),
              matches: values.map((value) => snapshot.matches(value)),
            }
          })),
        Then('both call forms answer the hand-written truth table')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: {
              readonly dataFirst: ReadonlyArray<boolean>
              readonly dataLast: ReadonlyArray<boolean>
            }) =>
              JSON.stringify(outcome.dataFirst) === JSON.stringify([true, true, false, true, false]) &&
              JSON.stringify(outcome.dataLast) === JSON.stringify([true, true, false, true, false]),
            'checkStateIn answers a state value, a path and an inactive path, and both active ids, in both forms',
          )
        ),
      ),
    )

    scenario(
      'A declared target admits the event and moves the actor to it',
      Gherkin.Do.pipe(
        Given('a machine whose event handler names a sibling state as its target')('outcome', () =>
          Effect.sync(() => {
            const machine = createMachine({
              initial: 'a',
              states: { a: { on: { EVENT: { target: 'c' } } }, b: {}, c: {} },
            })
            const actor = createActor(machine).start()
            actor.send({ type: 'EVENT' })
            const value = actor.getSnapshot().value
            actor.stop()
            return { value }
          })),
        Then('the actor reaches the declared target')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: { readonly value: StateValue }) => outcome.value === 'c',
            'the declared target admits the event and moves the actor to c',
          )
        ),
      ),
    )

    scenario(
      'A custom guard with parameters admits only when the context and the event together clear the threshold',
      Gherkin.Do.pipe(
        Given('a setup machine whose guard reads the context count and the event value')(
          'outcome',
          () =>
            Effect.sync(() => {
              const guardSetup = setup({
                schemas: {
                  context: types<{ count: number }>(),
                  events: { EVENT: types<{ value: number }>() },
                },
              })
              const machine = guardSetup.createMachine({
                context: { count: 0 },
                initial: 'inactive',
                states: {
                  inactive: {
                    on: {
                      EVENT: ({ context, event }) => context.count + event.value > 3 ? { target: 'active' } : undefined,
                    },
                  },
                  active: {},
                },
              })
              const passing = createActor(machine).start()
              passing.send({ type: 'EVENT', value: 4 })
              const reached = passing.getSnapshot().value
              passing.stop()
              const failing = createActor(machine).start()
              failing.send({ type: 'EVENT', value: 3 })
              const held = failing.getSnapshot().value
              failing.stop()
              return { reached, held }
            }),
        ),
        Then('the guard admits above the threshold and refuses at it')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: { readonly reached: StateValue; readonly held: StateValue }) =>
              outcome.reached === 'active' && outcome.held === 'inactive',
            'the parameterised guard admits value 4 and refuses value 3',
          )
        ),
      ),
    )

    scenario(
      'A guard in one region reads the interim value another region reached in the same macrostep',
      Gherkin.Do.pipe(
        Given('a parallel machine whose right region reacts to the left region being in lq')(
          'outcome',
          () =>
            Effect.sync(() => {
              const machine = createMachine({
                type: 'parallel',
                states: {
                  L: { initial: 'c1', states: { c1: { on: { GO: { target: 'lq' } } }, lq: {} } },
                  R: {
                    initial: 'r1',
                    states: {
                      r1: { always: ({ value }) => (matchesState('L.lq', value) ? { target: 'r2' } : undefined) },
                      r2: {},
                    },
                  },
                },
              })
              const actor = createActor(machine).start()
              const initial = actor.getSnapshot().value
              actor.send({ type: 'GO' })
              const interim = actor.getSnapshot().value
              actor.stop()
              return { initial, interim }
            }),
        ),
        Then('the right region moves on the left region having moved in the same macrostep')((s, expect) =>
          expect(s.outcome, JSON.stringify(s.outcome)).toSatisfy(
            (outcome: { readonly initial: StateValue; readonly interim: StateValue }) =>
              JSON.stringify(outcome.initial) === JSON.stringify({ L: 'c1', R: 'r1' }) &&
              JSON.stringify(outcome.interim) === JSON.stringify({ L: 'lq', R: 'r2' }),
            'the eventless guard in R sees L having reached lq',
          )
        ),
      ),
    )
  })
