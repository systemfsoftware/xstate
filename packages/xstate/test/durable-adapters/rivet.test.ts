import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createDurable, type DurableExecutionAdapter } from '../../src/durable/index.js'
import { type ActorSystemRuntime, createLogic, createMachine, setup as setupXState } from '../../src/index.js'
import type { AnyActorLogic, EventFromLogic } from '../../src/types.js'

interface RivetWorkflowContext {
  step(name: string, run: () => unknown | Promise<unknown>): Promise<unknown>
  queue: {
    next(name: string, options: { names: readonly string[] }): Promise<unknown>
  }
}

interface QueueNextCall {
  readonly name: string
  readonly options: { readonly names: readonly string[] }
}

const messageEvent = <TEvent>(message: unknown): TEvent => {
  if (
    typeof message !== 'object' || message === null || !('body' in message)
  ) {
    throw new Error('The host queue resolved a value without a body payload')
  }
  const { body } = message
  if (typeof body !== 'object' || body === null || !('event' in body)) {
    throw new Error(
      'The host queue resolved a value without a body.event payload',
    )
  }
  return body.event as TEvent
}

function createRivetPoc<TLogic extends AnyActorLogic>(
  logic: TLogic,
  options: {
    context: RivetWorkflowContext
    queue: string
    runtime?: DurableExecutionAdapter<TLogic>['runtime']
  },
) {
  return createDurable(logic, {
    executeAction(action, metadata, runtime) {
      return options.context.step(metadata.id, () => action.exec(runtime)).then(
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
          return options.context.step(metadata.id, () => undefined).then(
            () => {},
          )
        },
      }
    },
    waitForEvent(metadata) {
      return options.context.queue.next(metadata.id, {
        names: [options.queue],
      }).then((message) => messageEvent<EventFromLogic<TLogic>>(message))
    },
  })
}

describe('Rivet durable execution PoC', () => {
  it('runs actions as workflow steps and receives queue events', function*({ expect }) {
    const calls: number[] = []
    const stepNames: string[] = []
    const queueNextCalls: QueueNextCall[] = []
    const messages = [{ body: { event: { type: 'FINISH' } } }]
    const machine = setupXState({
      actions: {
        record: (params: { value: number }) => {
          calls.push(params.value)
        },
      },
    }).createMachine({
      output: 'complete',
      initial: 'active',
      entry: ({ actions }, enq) => enq(actions.record, { value: 1 }),
      states: {
        active: {
          on: {
            FINISH: ({ actions }, enq) => {
              enq(actions.record, { value: 2 })
              return { target: 'done' }
            },
          },
        },
        done: { type: 'final' },
      },
    })
    const context: RivetWorkflowContext = {
      step(name: string, run: () => unknown | Promise<unknown>) {
        stepNames.push(name)
        return Promise.resolve(run())
      },
      queue: {
        next(name: string, options: { names: readonly string[] }) {
          queueNextCalls.push({ name, options })
          return Promise.resolve(messages.shift())
        },
      },
    }

    const output = yield* Effect.promise(() =>
      createRivetPoc(machine, {
        context,
        queue: 'machine-events',
      }).run(undefined)
    )

    yield* expect({ output, calls, stepNames, queueNextCalls }).toEqual({
      output: 'complete',
      calls: [1, 2],
      stepNames: ['0:0', '1:0', '1:1'],
      queueNextCalls: [
        { name: 'event:0', options: { names: ['machine-events'] } },
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
    const durable = createRivetPoc(machine, {
      context: {
        step(_name: string, run: () => unknown | Promise<unknown>) {
          return Promise.resolve(run())
        },
        queue: { next: () => Promise.resolve(undefined) },
      },
      queue: 'machine-events',
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
    const durable = createRivetPoc(logic, {
      context: {
        step(_name: string, run: () => unknown | Promise<unknown>) {
          return Promise.resolve(run())
        },
        queue: { next: () => Promise.resolve(undefined) },
      },
      queue: 'machine-events',
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
})
