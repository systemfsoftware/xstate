import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import { createDurable, type DurableExecutionAdapter } from '../src/durable/index.js'
import {
  type AnyActorLogic,
  type AnyStateMachine,
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createMachine,
  serializeMachine,
  setup,
  type Snapshot,
} from '../src/index.js'

interface ThrownSummary {
  readonly name: string
  readonly message: string
}

interface Rejection {
  readonly rejected: boolean
  readonly error: unknown
}

const hasStartedAt = (timer: unknown): boolean => typeof timer === 'object' && timer !== null && 'startedAt' in timer

const startedAtOf = (timer: unknown): unknown =>
  typeof timer === 'object' && timer !== null && 'startedAt' in timer ? timer.startedAt : undefined

const thrownSummary = (error: unknown): ThrownSummary =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: typeof error, message: String(error) }

const summaryOf = (run: () => unknown): ThrownSummary | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    return thrownSummary(error)
  }
}

const rejectionOf = (promise: PromiseLike<unknown>): Effect.Effect<Rejection> =>
  Effect.promise(() =>
    Promise.resolve(promise).then(
      (): Rejection => ({ rejected: false, error: undefined }),
      (error: unknown): Rejection => ({ rejected: true, error }),
    )
  )

const afterPendingRealTimers = (): Effect.Effect<void> =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    return promise
  })

interface TimerRecorder {
  (...args: unknown[]): void
  readonly calls: unknown[][]
}

const scheduleTimerMock = (): TimerRecorder => {
  const calls: unknown[][] = []
  const record: TimerRecorder = Object.assign(
    (...args: unknown[]) => {
      calls.push(args)
    },
    { calls },
  )
  return record
}

function host(overrides: Partial<DurableExecutionAdapter<AnyActorLogic>> = {}) {
  return {
    executeAction: () => {},
    waitForEvent: () => ({ type: 'CONTINUE' }),
    scheduleTimer: () => {},
    ...overrides,
  }
}

function persisted(machine: AnyStateMachine, snapshot: Snapshot<unknown>) {
  return JSON.parse(JSON.stringify(machine.getPersistedSnapshot(snapshot)))
}

describe('durable scheduling checkpoints', () => {
  const machine = createMachine({
    initial: 'waiting',
    states: {
      waiting: {
        after: { 1000: { target: 'expired' } },
        on: { CONTINUE: {}, RESET: { target: 'waiting', reenter: true } },
      },
      expired: { type: 'final' },
    },
  })

  it.each([false, true])(
    'persists accepted deadlines (per-effect runtime: %s)',
    function*(perEffect, { expect }) {
      let time = 10_000
      const perEffectScheduleTimer = scheduleTimerMock()
      const execution = createDurable(
        machine,
        host({
          now: () => time,
          ...(perEffect
            ? { runtime: () => ({ scheduleTimer: perEffectScheduleTimer }) }
            : { scheduleTimer: perEffectScheduleTimer }),
        }),
      )
      const [snapshot, effects] = execution.initialTransition()
      const pending = persisted(machine, snapshot)
      yield* Effect.promise(() => execution.executeEffects(effects))
      const saved = persisted(machine, snapshot)
      yield* expect({
        pendingHasStartedAt: hasStartedAt(Object.values(pending.timers)[0]),
        savedStartedAt: startedAtOf(Object.values(saved.timers)[0]),
        liveHasStartedAt: hasStartedAt(Object.values(snapshot.timers)[0]),
      }).toEqual({
        pendingHasStartedAt: false,
        savedStartedAt: 10_000,
        liveHasStartedAt: false,
      })

      time += 300
      const resumedScheduleTimer = scheduleTimerMock()
      const resumedHost = host({ now: () => time, scheduleTimer: resumedScheduleTimer })
      const resumed = createDurable(machine, resumedHost)
      const [restored, restoration] = resumed.restore(saved)
      yield* Effect.promise(() => resumed.executeEffects(restoration))
      const [unchanged] = resumed.transition(restored, { type: 'CONTINUE' })
      yield* expect({
        resumedDelays: resumedScheduleTimer.calls.map((call) => call[2]),
        resumedIdsAreStrings: resumedScheduleTimer.calls.map((call) => typeof call[1] === 'string'),
        resumedSourcesArePresent: resumedScheduleTimer.calls.map((call) => call[0] !== null && call[0] !== undefined),
        unchangedStartedAt: startedAtOf(Object.values(persisted(machine, unchanged).timers)[0]),
      }).toEqual({
        resumedDelays: [700],
        resumedIdsAreStrings: [true],
        resumedSourcesArePresent: [true],
        unchangedStartedAt: 10_000,
      })

      time += 300
      const againScheduleTimer = scheduleTimerMock()
      const againHost = host({ now: () => time, scheduleTimer: againScheduleTimer })
      const again = createDurable(machine, againHost)
      const [, againEffects] = again.restore(persisted(machine, unchanged))
      yield* Effect.promise(() => again.executeEffects(againEffects))
      yield* expect({
        againDelays: againScheduleTimer.calls.map((call) => call[2]),
        againIdsAreStrings: againScheduleTimer.calls.map((call) => typeof call[1] === 'string'),
      }).toEqual({ againDelays: [400], againIdsAreStrings: [true] })
    },
  )

  it.each([false, true])(
    'records asynchronous timer acceptance (per-effect runtime: %s)',
    function*(perEffect, { expect }) {
      let time = 1000
      const scheduleTimerCalls: unknown[][] = []
      const scheduleTimer = (...args: unknown[]) => {
        scheduleTimerCalls.push(args)
        return Promise.resolve().then(() => {
          time += 500
        })
      }
      const execution = createDurable(
        machine,
        host({
          now: () => time,
          ...(perEffect ? { runtime: () => ({ scheduleTimer }) } : { scheduleTimer }),
        }),
      )
      const [snapshot, effects] = execution.initialTransition()
      yield* Effect.promise(() => execution.executeEffects(effects))
      const saved = persisted(machine, snapshot)
      yield* expect(startedAtOf(Object.values(saved.timers)[0])).toEqual(1500)

      time = 1600
      const resumedScheduleTimer = scheduleTimerMock()
      const resumedHost = host({ now: () => time, scheduleTimer: resumedScheduleTimer })
      const resumed = createDurable(machine, resumedHost)
      const [restored, restoration] = resumed.restore(saved)
      yield* Effect.promise(() => resumed.executeEffects(restoration))
      yield* expect({
        resumedDelays: resumedScheduleTimer.calls.map((call) => call[2]),
        restoredStartedAt: startedAtOf(Object.values(persisted(machine, restored).timers)[0]),
      }).toEqual({ resumedDelays: [900], restoredStartedAt: 1500 })

      yield* Effect.promise(() => execution.executeEffects(effects))
      const lastCall = scheduleTimerCalls.at(-1)
      yield* expect({
        lastDelay: lastCall?.[2],
        lastIdIsString: typeof lastCall?.[1] === 'string',
        lastSourcePresent: lastCall?.[0] !== null && lastCall?.[0] !== undefined,
        snapshotStartedAt: startedAtOf(Object.values(persisted(machine, snapshot).timers)[0]),
      }).toEqual({
        lastDelay: 900,
        lastIdIsString: true,
        lastSourcePresent: true,
        snapshotStartedAt: 1500,
      })
    },
  )

  it.live('preserves elapsed wall-clock time without an adapter clock', function*({ expect }) {
    const execution = createDurable(machine, host())
    const [snapshot, effects] = execution.initialTransition()
    yield* Effect.promise(() => execution.executeEffects(effects))
    const saved = persisted(machine, snapshot)
    const startedAt = startedAtOf(Object.values(saved.timers)[0])
    const startedAtValue = typeof startedAt === 'number' ? startedAt : undefined

    yield* Effect.sleep('300 millis')
    const resumedScheduleTimer = scheduleTimerMock()
    const resumedHost = host({ scheduleTimer: resumedScheduleTimer })
    const resumed = createDurable(machine, resumedHost)
    const [, restoration] = resumed.restore(saved)
    const beforeSchedule = Date.now()
    yield* Effect.promise(() => resumed.executeEffects(restoration))
    const afterSchedule = Date.now()
    const firstCall = resumedScheduleTimer.calls[0]
    const remaining = firstCall?.[2]

    yield* expect({
      startedAtIsNumber: startedAtValue !== undefined,
      idIsString: typeof firstCall?.[1] === 'string',
      elapsedAdvanced: startedAtValue !== undefined && afterSchedule - startedAtValue >= 300,
      remainingTracksElapsed: typeof remaining === 'number' &&
        startedAtValue !== undefined &&
        remaining >= 1000 - (afterSchedule - startedAtValue) &&
        remaining <= 1000 - (beforeSchedule - startedAtValue),
    }).toEqual({
      startedAtIsNumber: true,
      idIsString: true,
      elapsedAdvanced: true,
      remainingTracksElapsed: true,
    })
  })

  it('preserves an accepted deadline when effects are retried', function*({ expect }) {
    let time = 1000
    const scheduleTimer = scheduleTimerMock()
    const execution = createDurable(
      machine,
      host({ now: () => time, scheduleTimer }),
    )
    const [snapshot, effects] = execution.initialTransition()
    yield* Effect.promise(() => execution.executeEffects(effects))
    time += 300
    yield* Effect.promise(() => execution.executeEffects(effects))
    const lastCall = scheduleTimer.calls.at(-1)
    yield* expect({
      lastDelay: lastCall?.[2],
      lastIdIsString: typeof lastCall?.[1] === 'string',
      startedAt: startedAtOf(Object.values(persisted(machine, snapshot).timers)[0]),
    }).toEqual({ lastDelay: 700, lastIdIsString: true, startedAt: 1000 })
  })

  it('starts a new deadline when a state reenters', function*({ expect }) {
    let time = 1000
    const execution = createDurable(
      machine,
      host({ now: () => time, cancelTimer: () => {} }),
    )
    const [snapshot, effects] = execution.initialTransition()
    yield* Effect.promise(() => execution.executeEffects(effects))
    time += 300
    const [reentered, nextEffects] = execution.transition(snapshot, {
      type: 'RESET',
    })
    yield* Effect.promise(() => execution.executeEffects(nextEffects))
    yield* expect({
      reenteredStartedAt: startedAtOf(Object.values(persisted(machine, reentered).timers)[0]),
      originalStartedAt: startedAtOf(Object.values(persisted(machine, snapshot).timers)[0]),
    }).toEqual({ reenteredStartedAt: 1300, originalStartedAt: 1000 })
  })

  it('records a start only after scheduling succeeds', function*({ expect }) {
    const failure = new Error('scheduler unavailable')
    const execution = createDurable(
      machine,
      host({ scheduleTimer: () => Promise.reject(failure) }),
    )
    const [snapshot, effects] = execution.initialTransition()
    const outcome = yield* rejectionOf(execution.executeEffects(effects))
    yield* expect({
      rejected: outcome.rejected,
      sameError: outcome.error === failure,
      startedAtPresent: hasStartedAt(Object.values(persisted(machine, snapshot).timers)[0]),
    }).toEqual({ rejected: true, sameError: true, startedAtPresent: false })
  })

  it('does not read the host clock during pure transitions', function*({ expect }) {
    const nowReads: number[] = []
    const now = () => {
      nowReads.push(1234)
      return 1234
    }
    const execution = createDurable(machine, host({ now }))
    const [snapshot] = execution.initialTransition()
    execution.transition(snapshot, { type: 'CONTINUE' })
    yield* expect(nowReads).toEqual([])
  })

  it('stamps timers scheduled by live descendants', function*({ expect }) {
    const child = createMachine({
      initial: 'w',
      states: {
        w: { after: { 1000: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = setup({ actors: { child } }).createMachine({
      initial: 'w',
      states: { w: { invoke: { src: 'child', id: 'worker' } } },
    })
    const execution = createDurable(
      parent,
      host({
        now: () => 5000,
        startActor: (actor) => {
          actor.start()
        },
      }),
    )
    const [snapshot, effects] = execution.initialTransition()
    yield* Effect.promise(() => execution.executeEffects(effects))
    const saved = persisted(parent, snapshot)
    yield* expect(
      startedAtOf(Object.values(saved.children.worker.snapshot.timers)[0]),
    ).toEqual(5000)
    execution.getActorRef(snapshot)?.system.stopActor(snapshot.children['worker'])
  })
})

describe('durable root errors', () => {
  it('returns a child rejection without scheduling an unhandled root throw', function*({ expect }) {
    const failure = new Error('boom')
    const machine = setup({
      actors: {
        boom: createAsyncLogic({
          run: () => Promise.reject(failure),
        }),
      },
    }).createMachine({
      initial: 'waiting',
      states: { waiting: { invoke: { src: 'boom' } } },
    })
    const scheduleTimer = scheduleTimerMock()
    const execution = createDurable(
      machine,
      host({
        startActor: (actor) => {
          actor.start()
        },
        scheduleTimer,
      }),
    )
    const [snapshot, effects] = execution.initialTransition()
    yield* Effect.promise(() => execution.executeEffects(effects))
    const event = yield* Effect.promise(() => execution.waitForEvent())
    const [errored, termination] = execution.transition(snapshot, event)
    yield* Effect.promise(() => execution.executeEffects(termination))
    yield* afterPendingRealTimers()
    yield* expect({
      eventType: event.type,
      status: errored.status,
      sameError: errored.error === failure,
      scheduledTimers: scheduleTimer.calls,
    }).toEqual({
      eventType: 'xstate.error.actor',
      status: 'error',
      sameError: true,
      scheduledTimers: [],
    })
  })

  it('run rejects with the error once', function*({ expect }) {
    const failure = new Error('boom')
    const machine = createMachine({
      on: {
        FAIL: () => {
          throw failure
        },
      },
    })
    const execution = createDurable(
      machine,
      host({ waitForEvent: () => ({ type: 'FAIL' }) }),
    )
    const outcome = yield* rejectionOf(execution.run())
    yield* afterPendingRealTimers()
    yield* expect({
      rejected: outcome.rejected,
      sameError: outcome.error === failure,
    }).toEqual({ rejected: true, sameError: true })
  })
})

describe('deserialized actor source rebinding', () => {
  it('uses provided sources for initialization and checkpoint restoration', function*({ expect }) {
    let originalCallCount = 0
    let replacementCallCount = 0
    const original = () => {
      originalCallCount += 1
    }
    const replacement = () => {
      replacementCallCount += 1
    }
    const json = {
      initial: 'w',
      states: { w: { invoke: { src: 'worker', id: 'job' } } },
    }
    const machine = createMachineFromConfig(json, {
      actors: { worker: createCallbackLogic(original) },
    })
    const provided = machine.provide({
      actors: { worker: createCallbackLogic(replacement) },
    })
    const actor = createActor(provided).start()
    const childSrc = actor.getSnapshot().children.job.src
    const replacementCallsAfterStart = replacementCallCount
    const originalCalls = originalCallCount
    const saved = actor.getPersistedSnapshot()
    actor.stop()
    const restored = createActor(provided, { snapshot: saved }).start()
    const replacementCallsAfterRestore = replacementCallCount
    const serialized = serializeMachine(provided)
    yield* expect({
      childSrc,
      replacementCallsAfterStart,
      originalCalls,
      replacementCallsAfterRestore,
      serialized,
    }).toEqual({
      childSrc: 'worker',
      replacementCallsAfterStart: 1,
      originalCalls: 0,
      replacementCallsAfterRestore: 2,
      serialized: json,
    })
    restored.stop()
  })

  it('still rejects a missing actor implementation', function*({ expect }) {
    yield* expect(
      summaryOf(() => createMachineFromConfig({ invoke: { src: 'missing' } })),
    ).toEqual({ name: 'Error', message: 'Missing actor source "missing"' })
  })
})
