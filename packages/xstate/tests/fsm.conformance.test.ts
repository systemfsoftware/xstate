import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import {
  type ActorLogic,
  createActor,
  type EventFromLogic,
  initialTransition,
  type SnapshotFrom,
  transition,
} from '@systemfsoftware/xstate'
import * as fsmEntrypoint from '@systemfsoftware/xstate/fsm'
import { createFSM, type FSMSnapshot, setup, types } from '@systemfsoftware/xstate/fsm'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  type FsmHandle,
  type FsmLedger,
  makeCopyOnNoopSubject,
  makeFsmSubject,
  makeInheritedEventSubject,
  makeInheritedPatchSubject,
  runFsmCommand,
} from './__fixtures__/fsm.js'
import { FsmCommand, fsmModel } from './__fixtures__/fsm.model.js'

type User = { id: string }
type LoadingContext = { status: 'loading' }
type LoadedContext = { status: 'loaded'; user: User }
type FinishContext = { status: 'idle'; count: number } | { status: 'done'; count: number; result: string }
type FinishEvent = { type: 'finish'; result: string } | { type: 'reset' }
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

export const typeLevelContract = () => {
  const singleStateMachine = createFSM<{ count: number }, { type: 'inc' }, 'active'>({
    initial: 'active',
    context: { count: 0 },
    states: { active: { on: { inc: { context: { count: 1 } } } } },
  })

  const incMachine = createFSM<{ count: number }, { type: 'inc' } | { type: 'stop' }, 'active' | 'stopped'>({
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

  const finishMachine = createFSM<FinishContext, FinishEvent, 'idle' | 'done'>({
    initial: 'idle',
    context: { status: 'idle', count: 0 },
    states: {
      idle: {
        on: {
          finish: ({ context, event }) => ({
            target: 'done',
            context: { status: 'done' as const, count: context.count + 1, result: event.result },
          }),
          reset: { context: { status: 'idle', count: 0 } },
        },
      },
      done: {},
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

  const userSetup = setup({
    schemas: {
      context: types<LoadingContext | LoadedContext>(),
      events: { resolve: types<{ user: User }>(), reset: types<{}>(), retry: types<{}>() },
    },
    states: {
      loading: { schemas: { context: types<LoadingContext>() } },
      loaded: { schemas: { context: types<LoadedContext>() } },
    },
  })

  const userMachine = userSetup.createFSM({
    initial: 'loading',
    context: { status: 'loading' },
    states: {
      loading: {
        on: {
          resolve: ({ event }) => ({ target: 'loaded', context: { status: 'loaded' as const, user: event.user } }),
          reset: { context: { status: 'loading' as const } },
          retry: 'loading',
        },
      },
      loaded: {
        on: { reset: () => ({ target: 'loading', context: { status: 'loading' as const } }) },
      },
    },
  })

  const stateSchemaSetup = setup({
    states: {
      loading: { schemas: { context: types<LoadingContext>() } },
      loaded: { schemas: { context: types<LoadedContext>() } },
    },
  })

  const draftSetup = setup({
    schemas: {
      context: types<{ requestId: string; draft?: string }>(),
      events: { review: types<{ draft: string }>(), skip: types<{}>() },
    },
    states: { reviewing: { schemas: { context: types<{ draft: string }>() } } },
  })

  const draftMachine = draftSetup.createFSM({
    initial: 'editing',
    context: { requestId: 'req-1' },
    states: {
      editing: {
        on: {
          review: ({ event }) => ({ target: 'reviewing', context: { draft: event.draft } }),
          // @ts-expect-error entering reviewing requires a draft
          skip: { target: 'reviewing' },
        },
      },
      reviewing: {
        on: {
          review: ({ context }) => ({
            context: { draft: [context.requestId satisfies string, context.draft satisfies string].join() },
          }),
        },
      },
    },
  })

  const singleSnapshot = singleStateMachine.initialState
  const singleActor = createActor(singleStateMachine)

  return [
    singleStateMachine satisfies ActorLogic<FSMSnapshot<{ count: number }, 'active'>, { type: 'inc' }>,
    true satisfies Equal<SnapshotFrom<typeof singleStateMachine>, FSMSnapshot<{ count: number }, 'active'>>,
    true satisfies Equal<EventFromLogic<typeof singleStateMachine>, { type: 'inc' }>,
    singleSnapshot.value satisfies 'active',
    singleSnapshot.context.count satisfies number,
    singleStateMachine.transition(singleSnapshot, { type: 'inc' })[0].context.count satisfies number,
    singleStateMachine.transition(singleSnapshot, { type: 'inc' })[1] satisfies never[],
    initialTransition(singleStateMachine)[0].value satisfies 'active',
    transition(incMachine, incMachine.initialState, { type: 'inc' })[0].value satisfies 'active' | 'stopped',
    singleActor.getSnapshot().value satisfies 'active',
    singleActor.getSnapshot().context.count satisfies number,
    // @ts-expect-error an actor of the FSM refuses an undeclared event
    singleActor.send({ type: 'unknown' }),
    // @ts-expect-error unknown event
    singleStateMachine.transition(singleSnapshot, { type: 'unknown' }),
    createFSM<{ count: number }, { type: 'inc' }, 'active'>({
      initial: 'active',
      context: { count: 0 },
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
    // @ts-expect-error a declared context cannot be omitted
    createFSM<FinishContext, FinishEvent, 'idle' | 'done'>({ initial: 'idle', states: { idle: {}, done: {} } }),
    // @ts-expect-error event payload must match its type
    finishMachine.transition(finishMachine.initialState, { type: 'finish', result: 1 }),
    loadedMachine.initialState.value satisfies 'idle' | 'loaded',
    (snapshot: SnapshotFrom<typeof loadedMachine>) =>
      snapshot.value === 'loaded' && snapshot.context.id satisfies string,
    // @ts-expect-error undeclared event
    loadedMachine.transition(loadedMachine.initialState, { type: 'unknown' }),
    // @ts-expect-error event payload must match its schema
    loadedMachine.transition(loadedMachine.initialState, { type: 'load', id: 1 }),
    // @ts-expect-error a declared context schema makes initial context required
    typedSetup.createFSM({ initial: 'idle', states: { idle: {}, loaded: {} } }),
    (snapshot: SnapshotFrom<typeof userMachine>) =>
      snapshot.value === 'loaded' && snapshot.context.user.id satisfies string,
    (snapshot: SnapshotFrom<typeof userMachine>) =>
      snapshot.value === 'loaded' &&
      // @ts-expect-error a loaded snapshot's context has no loading-only shape
      snapshot.context.status satisfies 'loading',
    // @ts-expect-error event payload must match its schema
    userMachine.transition(userMachine.initialState, { type: 'resolve', user: 1 }),
    // @ts-expect-error a declared state context schema makes initial context required
    stateSchemaSetup.createFSM({ initial: 'loading', states: { loading: {}, loaded: {} } }),
    stateSchemaSetup.createFSM({
      initial: 'loading',
      context: { status: 'loading' },
      states: {
        loading: {
          on: {
            // @ts-expect-error a string target cannot keep a context the target state refuses
            finish: 'loaded',
          },
        },
        loaded: {},
      },
    }),
    stateSchemaSetup.createFSM({
      initial: 'loading',
      context: { status: 'loading' },
      states: {
        loading: {
          on: {
            // @ts-expect-error the target context is missing the required user
            finish: { target: 'loaded', context: { status: 'loaded' } },
          },
        },
        loaded: {},
      },
    }),
    stateSchemaSetup.createFSM({
      initial: 'loading',
      context: { status: 'loading' },
      states: {
        loading: {
          on: {
            // @ts-expect-error a function transition must provide the target context
            finish: () => ({ target: 'loaded' }),
          },
        },
        loaded: {},
      },
    }),
    (snapshot: SnapshotFrom<typeof draftMachine>) =>
      snapshot.value === 'reviewing' &&
      [snapshot.context.requestId satisfies string, snapshot.context.draft satisfies string],
  ] as const
}

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
    observed.inheritedPatchKeys,
    observed.bareContexts,
    observed.emissions,
    observed.drivers.pure,
    observed.drivers.entry,
    observed.drivers.actor,
    observed.drivers.persisted,
    observed.factories.createFSM,
    observed.factories.setup,
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
            'no-op transitions, target changes, context patches, function transitions, ignored inherited events and patch keys, bare contexts and actor emissions all occurred, for every driver and factory',
          )(
            (s, expect) =>
              expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
                liveness,
                'the run exercised every transition kind, inherited event names and patch keys, a machine without context and actor emissions, across all four drivers and both factories',
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
      'A subject that reads inherited context patch keys is caught as a model divergence',
      divergesFromTheModel(makeInheritedPatchSubject),
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
