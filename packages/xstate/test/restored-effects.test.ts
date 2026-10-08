import { it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createActor, createAsyncLogic, createCallbackLogic, createLogic, waitFor } from '../src/index.js'

it('reattaches a JSON-restored callback and cleans up each incarnation', function*({ expect }) {
  let startCalls = 0
  const receiveCalls: unknown[] = []
  let cleanupCalls = 0
  const logic = createCallbackLogic(({ receive: listen }) => {
    startCalls += 1
    listen((event: unknown) => receiveCalls.push(event))
    return () => {
      cleanupCalls += 1
    }
  })
  const first = createActor(logic).start()
  const snapshot = JSON.parse(JSON.stringify(first.getPersistedSnapshot()))
  first.stop()
  const restored = createActor(logic, { snapshot }).start()
  restored.send({ type: 'PING' })
  restored.stop()

  yield* expect({ startCalls, receiveCalls, cleanupCalls }).toEqual({
    startCalls: 2,
    receiveCalls: [{ type: 'PING' }],
    cleanupCalls: 2,
  })
})

it('reattaches active keyed effects without replaying completed effects', function*({ expect }) {
  let activeCalls = 0
  let completedCalls = 0
  const logic = createLogic({
    context: undefined,
    run: (_, enq) => {
      enq.effect('active', () => {
        activeCalls += 1
      })
      enq.effect('completed', () => {
        completedCalls += 1
      })
    },
  })
  const first = createActor(logic).start()
  const snapshot = JSON.parse(JSON.stringify(first.getPersistedSnapshot()))
  snapshot.effects.completed = { status: 'done', output: 42 }
  first.stop()
  const restored = createActor(logic, { snapshot }).start()
  restored.send({ type: 'PING' })
  restored.stop()

  yield* expect({ activeCalls, completedCalls }).toEqual({
    activeCalls: 2,
    completedCalls: 1,
  })
})

it('deduplicates concurrently started local steps and settles waiters on stop', function*({ expect }) {
  let execCalls = 0
  const exec = () => {
    execCalls += 1
    return Promise.withResolvers<number>().promise
  }
  let first!: Promise<number>
  let second!: Promise<number>
  const actor = createActor(
    createAsyncLogic({
      run: (_, enq) => {
        first = enq.step('work', exec)
        second = enq.step('work', exec)
        return Promise.all([first, second])
      },
    }),
  ).start()
  yield* Effect.promise(() => waitFor(actor, (s) => s.effects?.['work']?.status === 'active'))
  const settled = [first, second].map((pending) =>
    pending.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : error),
    )
  )
  actor.stop()
  const settlements = yield* Effect.promise(() => Promise.all(settled))

  yield* expect({ execCalls, settlements }).toEqual({
    execCalls: 1,
    settlements: [
      'Actor terminated before step "work" completed',
      'Actor terminated before step "work" completed',
    ],
  })
})

it.each(['constructor', 'toString', '__proto__'])(
  'journals and restores an effect keyed %s',
  function*(key, { expect }) {
    let runCalls = 0
    const run = () => {
      runCalls += 1
    }
    const logic = createLogic({
      context: undefined,
      run: (_, enq) => enq.effect(key, run),
    })
    const first = createActor(logic).start()
    const runCallsAfterFirstStart = runCalls
    const snapshot = JSON.parse(JSON.stringify(first.getPersistedSnapshot()))
    const hasKey = Object.hasOwn(snapshot.effects, key)
    const journaled = { ...snapshot.effects[key] }
    first.stop()
    const restored = createActor(logic, { snapshot }).start()
    restored.stop()

    yield* expect({
      runCallsAfterFirstStart,
      runCallsAfterRestore: runCalls,
      hasKey,
      journaled,
    }).toEqual({
      runCallsAfterFirstStart: 1,
      runCallsAfterRestore: 2,
      hasKey: true,
      journaled: { status: 'active' },
    })
  },
)

it.each(['constructor', 'toString', '__proto__'])(
  'reuses JSON-restored completed steps keyed %s',
  function*(key, { expect }) {
    let workCalls = 0
    const work = () => {
      workCalls += 1
      return Promise.resolve(42)
    }
    let result!: Promise<number>
    const logic = createAsyncLogic({
      run: (_, enq) => {
        result = enq.step(key, work)
        return Promise.withResolvers<unknown>().promise
      },
    })
    const first = createActor(logic).start()
    const firstOutput = yield* Effect.promise(() => result)
    const snapshot = JSON.parse(JSON.stringify(first.getPersistedSnapshot()))
    const hasKey = Object.hasOwn(snapshot.effects, key)
    first.stop()
    const restored = createActor(logic, { snapshot }).start()
    const restoredOutput = yield* Effect.promise(() => result)
    restored.stop()

    yield* expect({ firstOutput, hasKey, restoredOutput, workCalls }).toEqual({
      firstOutput: 42,
      hasKey: true,
      restoredOutput: 42,
      workCalls: 1,
    })
  },
)

it.each(['constructor', 'toString'])(
  'does not mistake inherited journal values for an effect keyed %s',
  function*(key, { expect }) {
    let runCalls = 0
    const run = () => {
      runCalls += 1
    }
    const actor = createActor(
      createLogic({
        context: undefined,
        run: ({ event }, enq) => {
          if (event.type === 'RUN') enq.effect(key, run)
          else enq.effect('seed', () => {})
        },
      }),
    ).start()
    actor.send({ type: 'RUN' })
    const runCallsAfterSend = runCalls
    actor.stop()

    yield* expect(runCallsAfterSend).toEqual(1)
  },
)

it('drains all attachment cleanups once when the first throws', function*({ expect }) {
  const error = new Error('cleanup failed')
  let failedCalls = 0
  const failed = () => {
    failedCalls += 1
    throw error
  }
  let laterCalls = 0
  const later = () => {
    laterCalls += 1
  }
  const observedCalls: unknown[] = []
  const actor = createActor(
    createLogic({
      context: undefined,
      run: (_, enq) => {
        enq.effect('first', () => failed)
        enq.effect('later', () => later)
      },
    }),
  )
  actor.subscribe({ error: (thrown: unknown) => observedCalls.push(thrown) })
  actor.start()
  actor.stop()
  actor.stop()

  yield* expect({
    failedCalls,
    laterCalls,
    observedIsExactError: observedCalls.length === 1 && observedCalls[0] === error,
  }).toEqual({
    failedCalls: 1,
    laterCalls: 1,
    observedIsExactError: true,
  })
})
