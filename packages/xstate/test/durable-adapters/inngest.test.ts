import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable, type DurableExecutionAdapter } from '../../src/durable/index.js'
import { type ActorSystemRuntime, createLogic, createMachine } from '../../src/index.js'
import type { AnyActorLogic, EventFromLogic } from '../../src/types.js'

interface InngestStepTools {
  run(id: string, run: () => unknown | Promise<unknown>): Promise<unknown>
  waitForEvent(
    id: string,
    options: { event: string; timeout: string },
  ): Promise<unknown | null>
}

interface ThrownSummary {
  readonly name: string
  readonly message: string
}

const settledError = (
  promise: PromiseLike<unknown>,
): Effect.Effect<ThrownSummary | undefined> =>
  Effect.promise(() =>
    promise.then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: typeof error, message: String(error) },
    )
  )

const stepMessageEvent = <TEvent>(message: unknown): TEvent => {
  if (
    typeof message !== 'object' || message === null || !('data' in message)
  ) {
    throw new Error('The host step resolved a value without a data payload')
  }
  const { data } = message
  if (typeof data !== 'object' || data === null || !('event' in data)) {
    throw new Error(
      'The host step resolved a value without a data.event payload',
    )
  }
  return data.event as TEvent
}

function createInngestPoc<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options: {
    step: InngestStepTools
    event: string
    timeout: string
    runtime?: DurableExecutionAdapter<TLogic>['runtime']
  },
) {
  return createDurable(logic, {
    executeAction(action, metadata, runtime) {
      return options.step.run(metadata.id, () => action.exec(runtime)).then(
        () => {},
      )
    },
    runtime(metadata, effect) {
      const runtime = options.runtime?.(metadata, effect) ?? {}
      if (
        effect.type !== '@xstate.terminate' ||
        runtime.terminateActor !== undefined
      ) {
        return runtime
      }

      return {
        ...runtime,
        terminateActor() {
          return options.step.run(metadata.id, () => undefined).then(() => {})
        },
      }
    },
    waitForEvent(metadata) {
      return options.step.waitForEvent(metadata.id, {
        event: options.event,
        timeout: options.timeout,
      }).then((received) => {
        if (received === null) {
          throw new Error(`Timed out waiting in step "${metadata.id}"`)
        }
        return stepMessageEvent<EventFromLogic<TLogic>>(received)
      })
    },
  })
}

describe('Inngest durable execution PoC', () => {
  it('runs actions as steps and resumes from an event wait', function*({ expect }) {
    const calls: string[] = []
    const machine = createMachine({
      output: 'complete',
      initial: 'active',
      states: {
        active: {
          on: {
            FINISH: (_, enq) => {
              enq(() => calls.push('finished'))
              return { target: 'done' }
            },
          },
        },
        done: { type: 'final' },
      },
    })
    const events = [
      { name: 'machine/event', data: { event: { type: 'FINISH' } } },
    ]
    const waitForEventCalls: unknown[][] = []
    const step: InngestStepTools = {
      run: (_id, run) => Promise.resolve(run()),
      waitForEvent: (id, options) => {
        waitForEventCalls.push([id, options])
        return Promise.resolve(events.shift() ?? null)
      },
    }

    const output = yield* Effect.promise(() =>
      createInngestPoc(machine, {
        step,
        event: 'machine/event',
        timeout: '1 day',
      }).run(undefined)
    )

    yield* expect({
      output,
      calls,
      waitForEventCalls,
    }).toEqual({
      output: 'complete',
      calls: ['finished'],
      waitForEventCalls: [
        ['event:0', { event: 'machine/event', timeout: '1 day' }],
      ],
    })
  })

  it('exposes built-in effects to host runtime mappings', function*({ expect }) {
    const effects: unknown[] = []
    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 10: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const durable = createInngestPoc(machine, {
      step: {
        run: (_id: string, run: () => unknown) => Promise.resolve(run()),
        waitForEvent: () => Promise.resolve(null),
      },
      event: 'machine/event',
      timeout: '1 day',
      runtime: (_metadata, effect) => {
        effects.push(effect)
        return { scheduleTimer: () => {} }
      },
    })
    const [, initialEffects] = durable.initialTransition(undefined)

    yield* Effect.promise(() => durable.executeEffects(initialEffects))

    yield* expect(effects).toEqual([
      expect.objectContaining({ type: '@xstate.raise', delay: 10 }),
    ])
  })

  it('forwards the host runtime to custom effects', function*({ expect }) {
    const sendEventCalls: unknown[][] = []
    const runtime = {
      sendEvent: (...args: unknown[]) => {
        sendEventCalls.push(args)
      },
    }
    let providedRuntime: Partial<ActorSystemRuntime> | undefined
    const logic = createLogic({
      context: undefined,
      run: ({ event }, enq) => {
        if (event.type === '@xstate.init') {
          enq.effect((effectRuntime) => {
            providedRuntime = effectRuntime
          })
        }
      },
    })
    const durable = createInngestPoc(logic, {
      step: {
        run: (_id: string, run: () => unknown) => Promise.resolve(run()),
        waitForEvent: () => Promise.resolve(null),
      },
      event: 'machine/event',
      timeout: '1 day',
      runtime: () => runtime,
    })
    const [, effects] = durable.initialTransition(undefined)

    yield* Effect.promise(() => durable.executeEffects(effects))

    const target = { address: 'elsewhere' } as never
    const event = { type: 'X' }
    const effectRuntime = providedRuntime
    if (effectRuntime === undefined) {
      throw new Error('The custom effect received no runtime')
    }
    yield* Effect.promise(() => Promise.resolve(effectRuntime.sendEvent!(undefined, target, event)))
    yield* expect(sendEventCalls).toEqual([
      [undefined, target, event],
    ])
  })

  it('reports an expired wait explicitly', function*({ expect }) {
    const durable = createInngestPoc(createMachine({}), {
      step: {
        run: () => Promise.resolve(undefined),
        waitForEvent: () => Promise.resolve(null),
      },
      event: 'machine/event',
      timeout: '1 second',
    })

    durable.initialTransition(undefined)
    yield* expect(yield* settledError(durable.waitForEvent())).toEqual({
      name: 'Error',
      message: 'Timed out waiting in step "event:0"',
    })
  })
})
