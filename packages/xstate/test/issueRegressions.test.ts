import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { getShortestPaths } from '../src/graph/index.js'
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createMachine,
  setup,
  toPromise,
  types,
} from '../src/index.js'

function roundTrip<T>(persisted: T): T {
  return JSON.parse(JSON.stringify(persisted)) as T
}

const spawnedChildSrc = (persisted: unknown): unknown => {
  if (typeof persisted !== 'object' || persisted === null || !('children' in persisted)) {
    return undefined
  }
  const children = persisted.children
  if (typeof children !== 'object' || children === null || !('w1' in children)) {
    return undefined
  }
  const child = children.w1
  if (typeof child !== 'object' || child === null || !('src' in child)) {
    return undefined
  }
  return child.src
}

const pollUntil = (done: () => boolean) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    let attempts = 0
    const poll = () => {
      if (done() || attempts >= 200) {
        resolve()
        return
      }
      attempts += 1
      setTimeout(poll, 1)
    }
    poll()
    return promise
  })

const capturedMessage = (run: () => unknown): string | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : 'a non-Error was thrown'
  }
}

describe('persistence', () => {
  it('#4166 state meta is rehydrated after a JSON round-trip', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({ title: z.string() }),
      },
      initial: 'a',
      states: {
        a: {
          meta: { title: 'A' },
          on: { NEXT: { target: 'b' } },
        },
        b: {
          meta: { title: 'B' },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    const persisted = roundTrip(actor.getPersistedSnapshot())
    actor.stop()

    const restored = createActor(machine, { snapshot: persisted }).start()

    yield* expect(restored.getSnapshot().getMeta()).toEqual({
      '(machine).b': { title: 'B' },
    })
  })

  it('#5057 a spawned child can be persisted when spawned from a registered source', function*({ expect }) {
    const worker = createMachine({
      context: { count: 0 },
      on: {
        INC: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })
    const machine = createMachine({
      actors: { worker },
      on: {
        SPAWN: (_, enq) => {
          enq.spawn('worker', { id: 'w1' })
        },
        SPAWN_INLINE: (_, enq) => {
          enq.spawn(createMachine({}), { id: 'inline' })
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'SPAWN' })

    const persistedSnapshot = roundTrip(actor.getPersistedSnapshot())
    const persistedChildSrc = spawnedChildSrc(persistedSnapshot)

    const restored = createActor(machine, { snapshot: persistedSnapshot }).start()
    const restoredChildDefined = restored.getSnapshot().children['w1'] !== undefined

    const inlinePersistMessage = capturedMessage(() => {
      restored.send({ type: 'SPAWN_INLINE' })
      restored.getPersistedSnapshot()
    })

    yield* expect({ persistedChildSrc, restoredChildDefined, inlinePersistMessage }).toEqual({
      persistedChildSrc: 'worker',
      restoredChildDefined: true,
      inlinePersistMessage: 'An inline child actor cannot be persisted.',
    })
  })
})

describe('lifecycle', () => {
  it('#5219 eventless source entry runs before the target state invoke starts', function*({ expect }) {
    const log: string[] = []
    const machine = setup({
      actors: {
        invoker: createAsyncLogic({
          run: () => {
            log.push('next')
            return Promise.resolve()
          },
        }),
      },
    }).createMachine({
      id: 'myMachine',
      initial: 'start',
      states: {
        start: {
          entry: () => {
            log.push('start')
          },
          always: { target: 'next' },
        },
        next: {
          invoke: {
            id: 'next',
            src: 'invoker',
            onDone: { target: 'complete' },
          },
        },
        complete: { type: 'final' },
      },
    })

    const actor = createActor(machine).start()
    yield* Effect.promise(() => toPromise(actor))

    yield* expect({ log, value: actor.getSnapshot().value }).toEqual({ log: ['start', 'next'], value: 'complete' })
  })

  it('#5433 an invoked callback is cleaned up after onError leaves the state', function*({ expect }) {
    const warnings: string[] = []
    let cleanupCalls = 0
    const cleanup = () => {
      cleanupCalls += 1
    }
    let sendBackAfterStop: (() => void) | undefined
    const { promise, reject } = Promise.withResolvers<never>()

    const machine = createMachine({
      initial: 'invoking',
      states: {
        invoking: {
          invoke: [
            {
              src: createCallbackLogic(({ sendBack }) => {
                sendBackAfterStop = () => sendBack({ type: 'UPDATE' })
                return cleanup
              }),
            },
            {
              src: createAsyncLogic({ run: () => promise }),
              onError: { target: '#failed' },
            },
          ],
        },
        failed: { id: 'failed' },
      },
    })

    const actor = createActor(machine, { warn: (message) => warnings.push(message) }).start()
    reject(new Error('refresh failed'))
    yield* pollUntil(() => actor.getSnapshot().value === 'failed')

    sendBackAfterStop?.()

    yield* expect({
      value: actor.getSnapshot().value,
      cleanupCalls,
      warnings: [...warnings],
    }).toEqual({
      value: 'failed',
      cleanupCalls: 1,
      warnings: [],
    })
  })

  it.live('#4726 invoked callback cleanup runs when the machine errors', function*({ expect }) {
    let counter = 1
    let isOver = false
    const machine = setup({
      actors: {
        test: createCallbackLogic(({ sendBack }) => {
          const id = setInterval(() => {
            counter++
            sendBack({ type: 'haha' + counter })
          }, 100)
          return () => {
            clearInterval(id)
            isOver = true
          }
        }),
      },
    }).createMachine({
      invoke: { src: 'test' },
      initial: 'idle',
      states: {
        idle: {
          on: {
            haha3: () => {
              throw new Error('haha')
            },
          },
        },
      },
    })

    const actor = createActor(machine)
    actor.start()
    const outcomePromise = toPromise(actor).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'a non-Error was thrown'),
    )

    yield* pollUntil(() => actor.getSnapshot().status === 'error')

    const outcome = yield* Effect.promise(() => outcomePromise)

    yield* expect({
      outcome,
      status: actor.getSnapshot().status,
      moreThanTwoIncrements: counter > 2,
      isOver,
    }).toEqual({
      outcome: 'haha',
      status: 'error',
      moreThanTwoIncrements: true,
      isOver: true,
    })
  })

  it('#5120 sending to the parent of a root actor does not throw', function*({ expect }) {
    const machine = setup({}).createMachine({
      initial: 'init',
      states: {
        init: {
          entry: ({ parent }, enq) => {
            enq.sendTo(parent, { type: 'init' })
          },
        },
      },
    })

    const actor = createActor(machine)
    actor.start()
    yield* expect(actor.getSnapshot().status).toBe('active')
  })
})

describe('misc', () => {
  it.live('#2419 delay functions can see the state that declares the delay', function*({ expect }) {
    const seen: string[] = []
    const machine = createMachine({
      initial: 'start',
      context: { multiplier: 2 },
      delays: {
        dynamic: ({ context, stateNode }) => {
          seen.push(stateNode.key)
          return 100 * context.multiplier
        },
      },
      states: {
        start: { on: { GO: { target: 'process' } } },
        process: { after: { dynamic: { target: 'done' } } },
        done: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'GO' })

    yield* expect(seen).toEqual(['process'])
    yield* pollUntil(() => actor.getSnapshot().value === 'done')
    yield* expect(actor.getSnapshot().value).toBe('done')
  })

  it('#4146 path traversal only takes a guarded transition while the guard passes', function*({ expect }) {
    const cond = (context: { counter: number }) => context.counter === 0
    const paths = getShortestPaths(
      createMachine({
        initial: 'idle',
        schemas: {
          events: { INC: types<{}>() },
        },
        context: { counter: 0 },
        states: {
          idle: {
            on: {
              INC: ({ context }) =>
                cond(context)
                  ? { context: { counter: context.counter + 1 } }
                  : undefined,
            },
          },
        },
      }),
    )

    const eventTypes = paths.map((p) => p.steps.map((s) => s.event.type))
    const secondPath = paths[1]
    if (secondPath === undefined) {
      throw new Error('expected a second path')
    }

    yield* expect({ eventTypes, counter: secondPath.state.context.counter }).toEqual({
      eventTypes: [
        ['@xstate.init'],
        ['@xstate.init', 'INC'],
      ],
      counter: 1,
    })
  })
})
