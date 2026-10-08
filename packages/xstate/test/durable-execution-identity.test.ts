import { describe, it } from '@systemfsoftware/vitest'
import { Effect, Exit } from 'effect'
import { createDurable } from '../src/durable/index.js'
import { type AnyEventObject, createAsyncLogic, setup } from '../src/index.js'

const fraudCheck = createAsyncLogic({
  id: 'fraudCheck',
  run: (_, enq) => enq.step('score', () => 0.2),
})

const machine = setup({ actors: { fraudCheck } }).createMachine({
  id: 'order',
  initial: 'verifying',
  states: {
    verifying: {
      invoke: { id: 'fraud', src: 'fraudCheck', onDone: { target: 'approved' } },
    },
    approved: {},
  },
})

const isEventObject = (value: unknown): value is AnyEventObject =>
  typeof value === 'object' && value !== null && 'type' in value &&
  typeof value.type === 'string'

const takeRootEvents = (
  execution: { waitForEvent(): Promise<unknown> },
): Effect.Effect<AnyEventObject[]> =>
  Effect.gen(function*() {
    const next = yield* Effect.exit(
      Effect.promise(() => execution.waitForEvent()),
    )
    if (Exit.isFailure(next)) {
      return []
    }
    if (!isEventObject(next.value)) {
      throw new Error('expected the durable execution to yield an event object')
    }
    const rest = yield* takeRootEvents(execution)
    return [next.value, ...rest]
  })

function createHost(steps: Map<string, unknown>, executionId?: string) {
  return createDurable(machine, {
    ...(executionId === undefined ? {} : { executionId }),
    executeAction: () => {},
    startActor: (actor) => {
      actor.start()
    },
    runStep: (actor, key, exec) => {
      const id = `${actor.address}:${key}`
      if (steps.has(id)) {
        return Promise.resolve(steps.get(id))
      }
      return Promise.resolve(exec()).then((output) => {
        steps.set(id, output)
        return output
      })
    },
    waitForEvent: () => {
      throw new Error('host-driven loop')
    },
  })
}

describe('deterministic execution identity', () => {
  it('a replay re-creates the same session ids', function*({ expect }) {
    const steps = new Map<string, unknown>()
    const first = createHost(steps, 'exec-1')
    const [s1, e1] = first.initialTransition()
    yield* Effect.promise(() => first.executeEffects(e1))
    const events1 = yield* takeRootEvents(first)

    const second = createHost(steps, 'exec-1')
    const [s2, e2] = second.initialTransition()
    yield* Effect.promise(() => second.executeEffects(e2))
    const events2 = yield* takeRootEvents(second)

    yield* expect({
      first: events1,
      replay: events2,
      sessionId: events1[0]?.['sessionId'],
    }).toEqual({
      first: events2,
      replay: events1,
      sessionId: expect.stringMatching(/^exec-1:/),
    })
    void s1
    void s2
  })

  it('a journaled completion event still matches the child a replay re-creates', function*({ expect }) {
    const steps = new Map<string, unknown>()

    const first = createHost(steps, 'exec-1')
    const [snapshot1, effects1] = first.initialTransition()
    yield* Effect.promise(() => first.executeEffects(effects1))
    const [journaled] = yield* takeRootEvents(first)
    yield* expect(journaled?.type).toMatch(/^xstate\.done\.actor/)

    const second = createHost(steps, 'exec-1')
    const [snapshot2, effects2] = second.initialTransition()
    yield* Effect.promise(() => second.executeEffects(effects2))
    const [replayed] = second.transition(snapshot2 as never, journaled as never)
    yield* expect('value' in replayed ? replayed.value : undefined).toBe(
      'approved',
    )
    void snapshot1
  })

  it('without an executionId, journaled completions go stale across replays', function*({ expect }) {
    const steps = new Map<string, unknown>()
    const first = createHost(steps)
    const [, effects1] = first.initialTransition()
    yield* Effect.promise(() => first.executeEffects(effects1))
    const [journaled] = yield* takeRootEvents(first)

    const second = createHost(steps)
    const [snapshot2, effects2] = second.initialTransition()
    yield* Effect.promise(() => second.executeEffects(effects2))
    const [replayed] = second.transition(snapshot2 as never, journaled as never)

    yield* expect('value' in replayed ? replayed.value : undefined).toBe(
      'verifying',
    )
  })
})

describe('runLogic: the async actor as the durable unit', () => {
  const plainMachine = setup({
    actors: {
      score: createAsyncLogic({
        id: 'score',
        run: ({ input }: { input: { total: number } }) => Promise.resolve(input.total > 1000 ? 0.9 : 0.1),
      }),
    },
  }).createMachine({
    id: 'order',
    initial: 'verifying',
    context: ({ input }: { input: { total: number } }) => ({
      total: input.total,
    }),
    states: {
      verifying: {
        invoke: {
          id: 'fraud',
          src: 'score',
          input: ({ context }) => ({ total: context['total'] }),
          onDone: { target: 'approved' },
        },
      },
      approved: {},
    },
  })

  it('a journaling host wraps the body once and replays the result', function*({ expect }) {
    const journal = new Map<string, unknown>()
    const host = (executionId: string) =>
      createDurable(plainMachine, {
        executionId,
        executeAction: () => {},
        startActor: (actor) => {
          actor.start()
        },
        runLogic: (actor, exec) => {
          if (journal.has(actor.address)) {
            return Promise.resolve(journal.get(actor.address))
          }
          return Promise.resolve(exec()).then((output) => {
            journal.set(actor.address, output)
            return output
          })
        },
        waitForEvent: () => {
          throw new Error('host-driven loop')
        },
      })

    const first = host('exec-1')
    const [, e1] = first.initialTransition({ total: 1500 })
    yield* Effect.promise(() => first.executeEffects(e1))
    const [done1] = yield* takeRootEvents(first)

    yield* expect({
      doneType: done1?.type,
      executions: journal.size,
    }).toEqual({
      doneType: expect.stringMatching(/^xstate\.done\.actor/),
      executions: 1,
    })

    const second = host('exec-1')
    const [s2, e2] = second.initialTransition({ total: 1500 })
    yield* Effect.promise(() => second.executeEffects(e2))
    const [replayed] = second.transition(s2 as never, done1 as never)

    yield* expect({
      executions: journal.size,
      value: 'value' in replayed ? replayed.value : undefined,
    }).toEqual({
      executions: 1,
      value: 'approved',
    })
  })

  it('a remote-executor host ignores the closure and re-runs from (src, input)', function*({ expect }) {
    const workerSide = {
      score: (input: { total: number }) => Promise.resolve(input.total > 1000 ? 0.9 : 0.1),
    }
    const shipped: Array<{ src: unknown; input: unknown }> = []
    const durable = createDurable(plainMachine, {
      executionId: 'exec-1',
      executeAction: () => {},
      startActor: (actor) => {
        actor.start()
      },
      runLogic: (actor) => {
        const snapshot = actor.getSnapshot()
        const input = typeof snapshot === 'object' && snapshot !== null &&
            'input' in snapshot
          ? snapshot.input
          : undefined
        shipped.push({ src: actor.src, input })
        return workerSide[actor.src as keyof typeof workerSide](
          input as { total: number },
        )
      },
      waitForEvent: () => {
        throw new Error('host-driven loop')
      },
    })

    const [snapshot, effects] = durable.initialTransition({ total: 1500 })
    yield* Effect.promise(() => durable.executeEffects(effects))
    const [done] = yield* takeRootEvents(durable)
    const [next] = durable.transition(snapshot as never, done as never)

    yield* expect({
      shipped,
      serialized: shipped.map(({ src, input }) => JSON.stringify({ src, input })),
      value: 'value' in next ? next.value : undefined,
    }).toEqual({
      shipped: [{ src: 'score', input: { total: 1500 } }],
      serialized: ['{"src":"score","input":{"total":1500}}'],
      value: 'approved',
    })
  })
})
