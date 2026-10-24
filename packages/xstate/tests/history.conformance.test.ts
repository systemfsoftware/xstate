import { Conformance } from '@systemfsoftware/conformance-spec'
import { And, Gherkin, Given, it, makeFeature, Then, When } from '@systemfsoftware/effect-gherkin-spec'
import { type AnyActor, createActor, createCallbackLogic, createMachine } from '@systemfsoftware/xstate'
import { Effect, Layer } from 'effect'
import { failReportOf, passReportOf } from './__fixtures__/checkReports.js'
import {
  type HistoryHandle,
  type HistoryLedger,
  isLive,
  makeAllShallowSubject,
  makeHistorySubject,
  makeStrippedPersistedSubject,
  observeRehRe,
  persistedHistoryValueOf,
  rehReKinds,
  reviveActor,
  runHistoryCommand,
  valueOf,
} from './__fixtures__/history.js'
import { HistoryCommand, historyModel } from './__fixtures__/history.model.js'

const Feature = makeFeature({ it })

const sequences = 128
const operations = 8

const liveness = (observed: HistoryLedger): boolean => isLive(observed)

const checkOver = (handle: HistoryHandle, seed: number) =>
  Conformance.sequential(handle.layer, {
    commands: HistoryCommand,
    model: historyModel,
    run: runHistoryCommand,
    sequences,
    operations,
    seed,
  })

const withoutTarget = (): void => {
  Reflect.apply(createMachine, undefined, [{
    initial: 'on',
    states: {
      on: {
        initial: 'active',
        states: { active: {}, history: { type: 'history' } },
      },
    },
  }])
}

const historyAsInitial = () => {
  const machine = createMachine({
    initial: 'foo',
    states: { foo: { type: 'history', target: 'bar' }, bar: {} },
  })
  const actor = createActor(machine).start()
  const value = actor.getSnapshot().value
  actor.stop()
  return value
}

const historyAsCompoundInitial = () => {
  const entries: Array<string> = []
  const machine = createMachine({
    initial: 'foo',
    states: {
      foo: { on: { NEXT: { target: 'bar' } } },
      bar: {
        entry: () => {
          entries.push('bar entered')
        },
        initial: 'baz',
        states: { baz: { type: 'history', target: 'qwe' }, qwe: {} },
      },
    },
  })
  const actor = createActor(machine).start()
  actor.send({ type: 'NEXT' })
  const value = actor.getSnapshot().value
  actor.stop()
  return { value, entries }
}

const transientDetour = () => {
  const machine = createMachine({
    initial: 'idle',
    states: {
      idle: {
        id: 'idle',
        initial: 'absent',
        states: {
          absent: { on: { DEPLOY: { target: '#deploy' } } },
          present: { on: { DEPLOY: { target: '#deploy' }, DESTROY: { target: '#destroy' } } },
          hist: { type: 'history', target: 'absent' },
        },
      },
      deploy: { id: 'deploy', on: { SUCCESS: { target: 'idle.present' }, FAILURE: { target: 'idle.hist' } } },
      destroy: { id: 'destroy', always: { target: 'idle.absent' } },
    },
  })
  const actor = createActor(machine).start()
  actor.send({ type: 'DEPLOY' })
  actor.send({ type: 'SUCCESS' })
  actor.send({ type: 'DESTROY' })
  actor.send({ type: 'DEPLOY' })
  actor.send({ type: 'FAILURE' })
  const value = actor.getSnapshot().value
  actor.stop()
  return value
}

const reenteringSiblingHistory = () => {
  const actual: Array<string> = []
  const machine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: { REENTER: { target: '#b_hist', reenter: true } },
        initial: 'a1',
        states: {
          a1: { on: { NEXT: { target: 'a2' } } },
          a2: {
            entry: () => {
              actual.push('a2 entered')
            },
            exit: () => {
              actual.push('a2 exited')
            },
          },
          a3: { type: 'history', id: 'b_hist', target: 'a1' },
        },
      },
    },
  })
  const actor = createActor(machine).start()
  actor.send({ type: 'NEXT' })
  actual.length = 0
  actor.send({ type: 'REENTER' })
  actor.stop()
  return actual
}

const sourceViaOwnHistory = () => {
  let starts = 0
  const machine = createMachine({
    initial: 'running',
    states: {
      running: {
        on: { PING: { target: 'refresh' } },
        invoke: {
          src: createCallbackLogic(() => {
            starts += 1
          }),
        },
      },
      refresh: { type: 'history', target: 'running' },
    },
  })
  const actor = createActor(machine).start()
  starts = 0
  actor.send({ type: 'PING' })
  actor.stop()
  return starts
}

const reviveMachine = () =>
  createMachine({
    initial: 'on',
    states: {
      on: {
        initial: 'first',
        states: {
          first: { on: { SWITCH: { target: 'second' } } },
          second: {},
          hist: { type: 'history', target: 'first' },
        },
        on: { POWER: { target: 'off' } },
      },
      off: { on: { POWER: { target: 'on.hist' } } },
    },
  })

const persistedSample = () => {
  const machine = reviveMachine()
  const source = createActor(machine).start()
  source.send({ type: 'SWITCH' })
  source.send({ type: 'POWER' })
  const persisted = source.getPersistedSnapshot()
  const live = source.getSnapshot()
  source.stop()
  return { machine, persisted, live }
}

const unknownHistoryId = () => {
  const { machine, persisted } = persistedSample()
  const warned: Array<string> = []
  const document = { ...persisted, historyValue: { '(machine).on.hist': [{ id: 'nonexistent' }] } }
  const actor: AnyActor = reviveActor({
    machine,
    options: { snapshot: document, warn: (message: string) => warned.push(message) },
  })
  actor.start()
  actor.send({ type: 'POWER' })
  const value = valueOf(actor)
  const historyValue = persistedHistoryValueOf(actor)
  actor.stop()
  return { warned, value, historyValue }
}

const liveSnapshotRestore = () => {
  const { machine, live } = persistedSample()
  const actor: AnyActor = reviveActor({ machine, options: { snapshot: live } })
  actor.start()
  actor.send({ type: 'POWER' })
  const value = valueOf(actor)
  actor.stop()
  return value
}

const primitiveHistoryValues = () => {
  const { machine, persisted } = persistedSample()
  return [null, undefined, 42, 'foo', true, false].map((primitive) => {
    const document = { ...persisted, historyValue: primitive }
    const actor: AnyActor = reviveActor({ machine, options: { snapshot: document } })
    actor.start()
    actor.send({ type: 'POWER' })
    const value = valueOf(actor)
    const historyValue = persistedHistoryValueOf(actor)
    actor.stop()
    return { value, historyValue }
  })
}

Feature('Judging the published history resolution against a hand-written model', { timeout: 0 })
  .withLayer(Layer.empty)
  .live('each scenario drives the simulation kernel itself, and a conformance check cannot run inside a kernel run')
  .body(({ scenario, scenarioOutline }) => {
    scenarioOutline(
      'Every topology, history declaration and event sequence the model draws from seed <seed> agrees with the published history resolution',
      [{ seed: 1 }, { seed: 2 }, { seed: 3 }],
      (row) =>
        Gherkin.Do.pipe(
          Given('a subject bound to the published API, with a fresh ledger')(
            'subject',
            () => Effect.succeed(makeHistorySubject()),
          ),
          When('the sequential model check runs the generated machines and event sequences through it')(
            'report',
            (s) => checkOver(s.subject, row.seed),
          ),
          Then('every sequence is explained by the hand-written model of history resolution')((s, expect) =>
            expect(passReportOf(s.report), 'the published history resolution agrees with the model').toMatchObject({
              _tag: 'Pass',
              histories: sequences,
            })
          ),
          When('the history behaviours the run produced are read off the fixture ledger')(
            'observed',
            (s) => Effect.succeed(s.subject.observed),
          ),
          And(
            'every history node was restored from a record and from its default, deep records reached below a child, every declaration form and depth occurred, a parallel multi-target default and a region history beside a plain target were entered, an internal self-history without a record ran, a multistage restore went through the detour, all three drivers ran, and a restart carried a non-empty history value',
          )(
            (s, expect) =>
              expect(s.observed, JSON.stringify(s.observed)).toSatisfy(
                liveness,
                'the run exercised every history restore kind, form, depth, driver and restart shape',
              ),
          ),
        ),
    )

    const divergesFromTheModel = (makeSubject: () => HistoryHandle) =>
      Gherkin.Do.pipe(
        Given('a planted subject that behaves differently from the published history resolution')(
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
      'A builder that declares every history node shallow is caught as a model divergence',
      divergesFromTheModel(makeAllShallowSubject),
    )
    scenario(
      'A persisted driver that strips the history value before restarting is caught as a model divergence',
      divergesFromTheModel(makeStrippedPersistedSubject),
    )

    scenario(
      'A history node without a non-empty default target is rejected at createMachine',
      Gherkin.Do.pipe(
        Given('a machine whose history node declares no target')('thrown', () =>
          Effect.sync(() => {
            try {
              withoutTarget()
              return 'no error'
            } catch (error) {
              return error instanceof Error ? error.message : 'unrecognized'
            }
          })),
        Then('createMachine throws the exact missing-target message')((s, expect) =>
          expect(s.thrown, s.thrown).toEqual(
            'History state "(machine).on.history" must declare a non-empty `target`.',
          )
        ),
      ),
    )

    scenario(
      'A history node as the machine initial state enters its configured default',
      Gherkin.Do.pipe(
        Given('a machine whose initial state is a history node defaulting to bar')(
          'value',
          () => Effect.sync(historyAsInitial),
        ),
        Then('the actor starts in bar')((s, expect) => expect(s.value, s.value).toEqual('bar')),
      ),
    )

    scenario(
      "A history node as a compound's initial state enters its default and the parent enters once",
      Gherkin.Do.pipe(
        Given('a machine whose bar state is entered through a history initial')(
          'observed',
          () => Effect.sync(historyAsCompoundInitial),
        ),
        Then('the value is {bar: qwe} and the parent entry ran once')((s, expect) =>
          expect(s.observed, JSON.stringify(s.observed)).toEqual({ value: { bar: 'qwe' }, entries: ['bar entered'] })
        ),
      ),
    )

    scenario(
      'A history restore through an eventless detour reaches the most recently visited state',
      Gherkin.Do.pipe(
        Given('the most recent history after a transient detour')(
          'value',
          () => Effect.sync(transientDetour),
        ),
        Then('the restore lands in {idle: absent}')((s, expect) =>
          expect(s.value, JSON.stringify(s.value)).toEqual({ idle: 'absent' })
        ),
      ),
    )

    scenario(
      'A reentering transition to a sibling history records and restores the active child',
      Gherkin.Do.pipe(
        Given('the entry and exit order of a reentering sibling-history transition')(
          'actual',
          () => Effect.sync(reenteringSiblingHistory),
        ),
        Then('the active child exits then enters')((s, expect) =>
          expect(s.actual, JSON.stringify(s.actual)).toEqual(['a2 exited', 'a2 entered'])
        ),
      ),
    )

    scenario(
      'Restoring the source through its own history restarts its invoked callback logic once',
      Gherkin.Do.pipe(
        Given('the callback starts of an invoked logic after a self-history restore')(
          'starts',
          () => Effect.sync(sourceViaOwnHistory),
        ),
        Then('the callback logic started exactly once')((s, expect) => expect(s.starts, String(s.starts)).toEqual(1)),
      ),
    )

    scenario(
      'An unresolved history id warns with the exact message, falls back to the default and clears the value',
      Gherkin.Do.pipe(
        Given('a persisted snapshot whose history id names a nonexistent node')(
          'observed',
          () => Effect.sync(unknownHistoryId),
        ),
        Then('the warn option received the message, the default was used and historyValue is {}')((s, expect) =>
          expect(s.observed, JSON.stringify(s.observed)).toEqual({
            warned: ['Could not resolve StateNode for id: nonexistent'],
            value: { on: 'first' },
            historyValue: {},
          })
        ),
      ),
    )

    scenario(
      'A live snapshot holding state nodes restores its records',
      Gherkin.Do.pipe(
        Given('a snapshot taken from a live actor after a history record was made')(
          'value',
          () => Effect.sync(liveSnapshotRestore),
        ),
        Then('the restored actor continues to the recorded state')((s, expect) =>
          expect(s.value, JSON.stringify(s.value)).toEqual({ on: 'second' })
        ),
      ),
    )

    scenario(
      'Null, undefined and primitive history values revive as an empty record and use the default',
      Gherkin.Do.pipe(
        Given('a persisted snapshot for each of null, undefined, 42, foo, true and false')(
          'observed',
          () => Effect.sync(primitiveHistoryValues),
        ),
        Then('each falls back to the default and persists an empty history value')((s, expect) =>
          expect(s.observed, JSON.stringify(s.observed)).toEqual(
            [null, undefined, 42, 'foo', true, false].map(() => ({ value: { on: 'first' }, historyValue: {} })),
          )
        ),
      ),
    )

    scenarioOutline(
      "A reentering transition to its source's own history exits and re-enters exactly the recorded states (<kind>)",
      rehReKinds.map((kind) => ({ kind })),
      (row) =>
        Gherkin.Do.pipe(
          Given('a machine whose reentering transition targets the history node inside its source')(
            'observed',
            () => Effect.sync(() => observeRehRe(row.kind)),
          ),
          Then('the transition exits and re-enters exactly the recorded states, reports them and records them')((
            s,
            expect,
          ) =>
            expect(
              { trace: s.observed.trace, value: s.observed.value, historyValue: s.observed.historyValue },
              JSON.stringify(s.observed),
            ).toEqual({
              trace: ['exit:a', 'exit:on', 'enter:on', 'enter:a'],
              value: { on: 'a' },
              historyValue: { '(machine).on.onH': ['(machine).on.a'] },
            })
          ),
        ),
    )
  })
