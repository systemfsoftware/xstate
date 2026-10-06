import { it } from '@systemfsoftware/vitest'
import type { EventObject, Snapshot } from '@systemfsoftware/xstate'
import { fastCheckAdapter, PropertyScenarioRunner, type TestAdapter } from '@systemfsoftware/xstate-test'
import { Effect } from 'effect'
import fc from 'fast-check'

type AdapterRequest = Parameters<TestAdapter['run']>[0]

const scenarioRunner = (
  start: () => Promise<void>,
  dispose: () => Promise<void>,
): PropertyScenarioRunner<Snapshot<unknown>, EventObject> => {
  const runner: PropertyScenarioRunner<Snapshot<unknown>, EventObject> = Object.create(
    PropertyScenarioRunner.prototype,
  )
  runner.start = start
  runner.dispose = dispose
  runner.finish = () => {}
  runner.canRunGenerated = () => false
  return runner
}

const surfacedError = (
  start: () => Promise<void>,
  dispose: () => Promise<void>,
): Promise<unknown> => {
  const request: AdapterRequest = {
    events: [{ type: 'PING', caseId: 'ping', generator: fc.constant({}), weight: 1 }],
    commands: [],
    runBudget: 1,
    createEvent: () => ({ type: 'PING' }),
    createRunner: () => scenarioRunner(start, dispose),
  }
  return fastCheckAdapter({ numRuns: 1 })
    .run(request)
    .then((result) => result.error)
}

it(
  'Should_SurfaceTheFinalizerError_When_TheScenarioAndTheDisposalBothFail',
  function*({ expect }) {
    const bodyError = new Error('the scenario failed')
    const finalizerError = new Error('the disposal failed')
    const error = yield* Effect.promise(() =>
      surfacedError(
        () => Promise.reject(bodyError),
        () => Promise.reject(finalizerError),
      )
    )
    yield* expect(error).toBe(finalizerError)
  },
)

it(
  'Should_SurfaceTheFinalizerError_When_OnlyTheDisposalFails',
  function*({ expect }) {
    const finalizerError = new Error('the disposal failed')
    const error = yield* Effect.promise(() =>
      surfacedError(
        () => Promise.resolve(),
        () => Promise.reject(finalizerError),
      )
    )
    yield* expect(error).toBe(finalizerError)
  },
)

it(
  'Should_SurfaceTheScenarioError_When_OnlyTheScenarioFails',
  function*({ expect }) {
    const bodyError = new Error('the scenario failed')
    const error = yield* Effect.promise(() =>
      surfacedError(
        () => Promise.reject(bodyError),
        () => Promise.resolve(),
      )
    )
    yield* expect(error).toBe(bodyError)
  },
)
