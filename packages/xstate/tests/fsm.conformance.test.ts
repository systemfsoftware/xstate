import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { createActor, initialTransition, transition } from '@systemfsoftware/xstate'
import * as fsmEntrypoint from '@systemfsoftware/xstate/fsm'
import { createFSM, setup, types } from '@systemfsoftware/xstate/fsm'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  type FsmHandle,
  type FsmLedger,
  makeCopyOnNoopSubject,
  makeFsmSubject,
  makeInheritedEventSubject,
  runFsmCommand,
} from './__fixtures__/fsm.js'
import { FsmCommand, fsmModel } from './__fixtures__/fsm.model.js'

const singleStateMachine = createFSM<
  { count: number },
  { type: 'inc' },
  'active'
>({
  initial: 'active',
  context: { count: 0 },
  states: { active: { on: { inc: { context: { count: 1 } } } } },
})

const incMachine = createFSM<
  { count: number },
  { type: 'inc' } | { type: 'stop' },
  'active' | 'stopped'
>({
  initial: 'active',
  context: { count: 0 },
  states: {
    active: {
      on: {
        inc: ({ context }) => ({ context: { count: context.count + 1 } }),
        stop: 'stopped',
      },
    },
    stopped: {},
  },
})

const typedSetup = setup({
  schemas: { events: { load: types<{ id: string }>() } },
  states: { idle: {}, loaded: { schemas: { context: types<{ id: string }>() } } },
})

const loadedMachine = typedSetup.createFSM({
  initial: 'idle',
  context: {},
  states: {
    idle: {
      on: {
        load: ({ event }) => ({ target: 'loaded', context: { id: event.id } }),
      },
    },
    loaded: {},
  },
})

export const typeLevelContract = [
  singleStateMachine.initialState.value satisfies 'active',
  singleStateMachine.initialState.context.count satisfies number,
  singleStateMachine.transition(singleStateMachine.initialState, { type: 'inc' })[0].context.count satisfies number,
  singleStateMachine.transition(singleStateMachine.initialState, { type: 'inc' })[1] satisfies never[],
  initialTransition(singleStateMachine)[0].value satisfies 'active',
  transition(incMachine, incMachine.initialState, { type: 'inc' })[0].value satisfies 'active' | 'stopped',
  createActor(singleStateMachine).getSnapshot().value satisfies 'active',
  // @ts-expect-error unknown event
  singleStateMachine.transition(singleStateMachine.initialState, { type: 'unknown' }),
  createFSM<{ count: number }, { type: 'inc' }, 'active'>({
    initial: 'active',
    states: {
      active: {
        on: {
          inc: {
            // @ts-expect-error target must name a declared state
            target: 'missing',
          },
        },
      },
    },
  }),
  loadedMachine.initialState.value satisfies 'idle' | 'loaded',
  // @ts-expect-error undeclared event
  loadedMachine.transition(loadedMachine.initialState, { type: 'unknown' }),
  // @ts-expect-error event payload must match its schema
  loadedMachine.transition(loadedMachine.initialState, { type: 'load', id: 1 }),
  // @ts-expect-error a declared context schema makes initial context required
  typedSetup.createFSM({ initial: 'idle', states: { idle: {}, loaded: {} } }),
] as const

const Feature = makeFeature({ it })

const sequences = 64
const operations = 6

const expectedEntrypointNames = ['createFSM', 'setup', 'types']

const liveness = (observed: FsmLedger): boolean =>
  [
    observed.noopTransitions,
    observed.targetChanges,
    observed.contextPatches,
    observed.functionTransitions,
    observed.inheritedEventsIgnored,
    observed.drivers.pure,
    observed.drivers.entry,
    observed.drivers.actor,
    observed.drivers.persisted,
  ].every((occurrences) => occurrences > 0)

const checkOver = (handle: FsmHandle, seed: number) =>
  Conformance.sequential(handle.layer, {
    commands: FsmCommand,
    model: fsmModel,
    run: runFsmCommand,
    sequences,
    operations,
    seed,
  })

Feature('Judging the published FSM against a model of its flat event table', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'Every machine and event sequence the model draws from seed <seed> agrees with the published FSM',
      [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published createFSM, with a fresh ledger')(
            'subject',
            () => Effect.succeed(makeFsmSubject()),
          ),
          When('the sequential model check runs the generated machines and event sequences through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every sequence is explained by the flat event table model')((s, expect) =>
            expect(passReportOf(s.report), 'the published FSM agrees with the model').toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          ),
          When('the steps the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And(
            'no-op transitions, target changes, context patches, function transitions and ignored inherited events all occurred, for every driver',
          )(
            (s, expect) =>
              expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
                liveness,
                'the run exercised no-op transitions, target changes, context patches, function transitions and ignored inherited events, across all four drivers',
              ),
          ),
        ),
    )

    const divergesFromTheModel = (makeSubject: () => FsmHandle) =>
      Gherkin.Do.pipe(
        Given('a planted subject that behaves differently from the published FSM')(
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
      'A subject that copies the snapshot on a no-op is caught as a model divergence',
      divergesFromTheModel(makeCopyOnNoopSubject),
    )
    scenario(
      'A subject that reads inherited event names is caught as a model divergence',
      divergesFromTheModel(makeInheritedEventSubject),
    )

    scenario(
      'The published FSM entrypoint exposes only the pure FSM API',
      Gherkin.Do.pipe(
        Given('the published entrypoint namespace is read once')(
          'names',
          () => Effect.succeed(Object.keys(fsmEntrypoint).sort()),
        ),
        Then('it publishes createFSM, setup and types, and nothing else')((s, expect) =>
          expect(s.names.join(','), JSON.stringify(s.names)).toSatisfy(
            (names) => names === expectedEntrypointNames.join(','),
            'the entrypoint namespace holds exactly createFSM, setup and types',
          )
        ),
      ),
    )
  })
