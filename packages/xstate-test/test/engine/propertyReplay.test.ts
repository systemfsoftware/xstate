import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, initialTransition, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { ModelTestFailure, propertyTest, replayTest, type TestFixture } from '../../src/engine/index.js'
import { constant, randomAdapter } from './propertyTestAdapter.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{ value: number }>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context, event }) => ({
      context: { count: context.count + event.value },
    }),
  },
})

const failingInvariant = ({ snapshot }: { snapshot: unknown }) => {
  const machineSnapshot = snapshot as { context: { count: number } }
  if (machineSnapshot.context.count >= 5) {
    throw new Error(`count reached ${machineSnapshot.context.count}`)
  }
}

const catchFailure = (run: () => Promise<unknown>): Promise<ModelTestFailure> =>
  run().then(
    () => {
      throw new Error('Expected the campaign to fail')
    },
    (error: unknown) => error as ModelTestFailure,
  )

const legacyFixture = {
  formatVersion: 1,
  machine: { id: 'counter' },
  start: { type: 'input', input: undefined },
  prefixEvents: [],
  events: [{ type: 'INC', value: 5 }],
  failedAt: 1,
} as const

describe('replayTest', () => {
  it('replays a v2 fixture produced by a failing property test', function*({ expect }) {
    const failure = yield* Effect.promise(() =>
      catchFailure(() =>
        propertyTest(counterMachine, {
          adapter: randomAdapter({ seed: 1, numRuns: 5, maxCommands: 2 }),
          events: { INC: constant({ value: 5 }) },
          invariant: failingInvariant,
        })
      )
    )
    yield* expect(failure.fixture).toMatchObject({ formatVersion: 2 })

    const replayed = (yield* Effect.promise(() =>
      replayTest(counterMachine, failure.fixture!, {
        invariant: failingInvariant,
      }).catch((error: unknown) => error)
    )) as ModelTestFailure

    yield* expect({
      isModelTestFailure: replayed instanceof ModelTestFailure,
      stepCount: replayed.trace.steps.length,
    }).toEqual({
      isModelTestFailure: true,
      stepCount: failure.trace.steps.length,
    })
  })

  it('migrates a formatVersion 1 fixture', function*({ expect }) {
    const replayed = (yield* Effect.promise(() =>
      replayTest(counterMachine, legacyFixture, {
        invariant: failingInvariant,
      }).catch((error: unknown) => error)
    )) as ModelTestFailure

    const firstStep = replayed.trace.steps[0]
    if (firstStep === undefined) {
      throw new Error('expected a first step')
    }
    yield* expect({
      isModelTestFailure: replayed instanceof ModelTestFailure,
      stepCount: replayed.trace.steps.length,
      firstPhase: firstStep.phase,
      firstEvent: firstStep.event,
    }).toEqual({
      isModelTestFailure: true,
      stepCount: 1,
      firstPhase: 'generated',
      firstEvent: { type: 'INC', value: 5 },
    })
  })

  it('migrates prefix events from a formatVersion 1 fixture', function*({ expect }) {
    const replayed = (yield* Effect.promise(() =>
      replayTest(
        counterMachine,
        {
          ...legacyFixture,
          prefixEvents: [{ type: 'INC', value: 3 }],
          events: [{ type: 'INC', value: 3 }],
          failedAt: 2,
        },
        { invariant: failingInvariant },
      ).catch((error: unknown) => error)
    )) as ModelTestFailure

    yield* expect({
      isModelTestFailure: replayed instanceof ModelTestFailure,
      prefixEvents: replayed.trace.prefixEvents,
      events: replayed.trace.events,
    }).toEqual({
      isModelTestFailure: true,
      prefixEvents: [{ type: 'INC', value: 3 }],
      events: [{ type: 'INC', value: 3 }],
    })
  })

  it('rejects a fixture recorded against another machine id', function*({ expect }) {
    const rejection = yield* Effect.promise(() =>
      replayTest(
        counterMachine,
        { ...legacyFixture, machine: { id: 'other' } },
        { invariant: () => {} },
      ).catch((reason: unknown) => reason)
    )
    const name = rejection instanceof Error ? rejection.name : String(rejection)
    const message = rejection instanceof Error ? rejection.message : String(rejection)

    yield* expect({ name, message }).toEqual({
      name: 'Error',
      message: 'Property replay fixture targets machine "other", received "counter"',
    })
  })

  it('rejects a fixture recorded against another machine version', function*({ expect }) {
    const rejection = yield* Effect.promise(() =>
      replayTest(
        counterMachine,
        { ...legacyFixture, machine: { id: 'counter', version: '2.0.0' } },
        { invariant: () => {} },
      ).catch((reason: unknown) => reason)
    )
    const name = rejection instanceof Error ? rejection.name : String(rejection)
    const message = rejection instanceof Error ? rejection.message : String(rejection)

    yield* expect({ name, message }).toEqual({
      name: 'Error',
      message: 'Property replay fixture targets machine version "2.0.0", received "(unversioned)"',
    })
  })

  it('requires `restoreSnapshot` when the fixture starts from a snapshot', function*({ expect }) {
    const [snapshot] = initialTransition(counterMachine)
    const fixture: TestFixture = {
      formatVersion: 2,
      machine: { id: 'counter' },
      start: { type: 'snapshot', snapshot: snapshot.toJSON() },
      timeline: [],
      failedAt: 0,
    }

    const rejection = yield* Effect.promise(() =>
      replayTest(counterMachine, fixture, { invariant: () => {} }).catch((reason: unknown) => reason)
    )
    const name = rejection instanceof Error ? rejection.name : String(rejection)
    const message = rejection instanceof Error ? rejection.message : String(rejection)

    yield* expect({ name, message }).toEqual({
      name: 'Error',
      message: 'Property replay fixture contains a snapshot but no restoreSnapshot function was provided',
    })
  })

  it('throws when the replay does not reproduce the recorded failure', function*({ expect }) {
    const rejection = yield* Effect.promise(() =>
      replayTest(counterMachine, legacyFixture, {
        invariant: () => {},
      }).catch((reason: unknown) => reason)
    )
    const name = rejection instanceof Error ? rejection.name : String(rejection)
    const message = rejection instanceof Error ? rejection.message : String(rejection)

    yield* expect({ name, message }).toEqual({
      name: 'ReplayNotReproducedError',
      message: 'Property replay did not reproduce the recorded failure at step 1',
    })
  })
})
