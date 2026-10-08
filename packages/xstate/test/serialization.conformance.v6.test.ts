import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
/**
 * Serializability conformance (see V6_REVIEW.md §3.4).
 *
 * Machine-as-data is a load-bearing property: machines must be storable,
 * diffable, and revivable as JSON, and the boundary between serializable
 * structure and runtime sources must be explicit — never silent.
 *
 * Contract:
 *
 * 1. `serializeMachine(machine)` never throws and is JSON-safe.
 * 2. Serializable structure (states, transitions, targets, serialized actions,
 *    guard refs, string actor srcs, delays, meta, context values) survives a
 *    JSON round-trip through `createMachineFromConfig`.
 * 3. Inline runtime functions appear as code expressions. Root source maps, actor
 *    logic, and runtime schemas are omitted.
 * 4. A machine created from JSON round-trips losslessly (byte-stable).
 */
import { z } from 'zod'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import {
  _createMachineFromCompiledConfig,
  type AnyStateMachine,
  createActor,
  createAsyncLogic,
  createMachine,
  type EventRejection,
  serializeMachine,
  setup,
  types,
} from '../src/index.js'

function findCodeExpressions(json: unknown, path = '$'): string[] {
  if (json === null || typeof json !== 'object') {
    return []
  }
  if ('@code' in (json as object)) {
    return [path]
  }
  return Object.entries(json as Record<string, unknown>).flatMap(([k, v]) => findCodeExpressions(v, `${path}.${k}`))
}

describe('serializability conformance', () => {
  it('a fully-serializable definition round-trips losslessly', function*({ expect }) {
    const definition = {
      initial: 'idle',
      version: '1.0.0',
      context: { retries: 0 },
      states: {
        idle: {
          on: {
            START: { target: 'running' },
          },
        },
        running: {
          entry: [{ type: '@xstate.raise', event: { type: 'kick' } }],
          invoke: { src: 'worker', onDone: { target: 'done' } },
          on: {
            kick: [
              {
                target: 'done',
                guard: { type: 'canFinish', params: { limit: 3 } },
              },
            ],
          },
          after: {
            1000: { target: 'done' },
          },
        },
        done: { type: 'final', output: { ok: true } },
      },
    }

    const sources = {
      actors: {
        worker: createAsyncLogic({
          run: () => Promise.resolve(undefined),
        }),
      },
      guards: {
        canFinish: () => true,
      },
    }
    const machine = createMachineFromConfig(definition as any, sources)
    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    const revived = createMachineFromConfig(json, sources)

    yield* expect({
      json,
      codeExpressions: findCodeExpressions(json),
      revivedMatchesMachine: JSON.stringify(serializeMachine(revived)) ===
        JSON.stringify(serializeMachine(machine)),
    }).toEqual({
      json: definition,
      codeExpressions: [],
      revivedMatchesMachine: true,
    })
  })

  it('JSON.stringify never throws on an inline-authored machine', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({ count: z.number() }),
        events: { INC: z.object({ by: z.number() }) },
      },
      context: { count: 0 },
      actors: {},
      actions: {
        track: () => {},
      },
      initial: 'a',
      states: {
        a: {
          on: {
            INC: ({ context, event }) => ({
              context: { count: context.count + event.by },
            }),
          },
        },
      },
    })

    const outcome = yield* Effect.exit(
      Effect.sync(() => JSON.stringify(serializeMachine(machine))),
    )

    yield* expect(outcome._tag).toEqual('Success')
  })

  it('setup/createMachine root sources are omitted', function*({ expect }) {
    function track() {}
    function isReady() {
      return true
    }
    function shortDelay() {
      return 10
    }

    const machine = setup({
      schemas: {
        context: types<{ ok: boolean }>(),
      },
    }).createMachine({
      context: { ok: true },
      actions: {
        track,
      },
      guards: {
        isReady,
      },
      delays: {
        shortDelay,
      },
      initial: 'idle',
      states: {
        idle: {
          entry: ({ actions }, enq) => {
            enq(actions.track)
          },
          after: {
            shortDelay: ({ guards }) => {
              if (guards.isReady()) {
                return { target: 'done' }
              }
              return undefined
            },
          },
        },
        done: {},
      },
    })

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect({
      actions: json.actions,
      guards: json.guards,
      delays: json.delays,
      idle: json.states.idle,
    }).toEqual({
      actions: undefined,
      guards: undefined,
      delays: undefined,
      idle: {
        after: {
          shortDelay: {
            '@code':
              '({ guards }) => {\n\t\t\t\t\t\tif (guards.isReady()) {\n\t\t\t\t\t\t\treturn { target: "done" };\n\t\t\t\t\t\t};\n\t\t\t\t\t\treturn undefined;\n\t\t\t\t\t}',
            '@lang': 'ts',
          },
        },
        entry: {
          '@code': '({ actions }, enq) => {\n\t\t\t\t\t\tenq(actions.track);\n\t\t\t\t\t}',
          '@lang': 'ts',
        },
      },
    })
  })

  it('inline guards/actions serialize to code directives', function*({ expect }) {
    const entry = (_: any) => undefined
    const guard = ({ context }: any) => context.ok
    const transition = (args: any, enq: any) => {
      if (guard(args)) {
        enq(entry)
        return { target: 'b' }
      }
      return undefined
    }

    const machine = createMachine({
      context: { ok: true },
      initial: 'a',
      states: {
        a: {
          entry,
          on: {
            GO: transition,
          },
        },
        b: {},
      },
    })

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect(json.states.a).toEqual({
      entry: { '@code': '(_) => undefined', '@lang': 'ts' },
      on: {
        GO: {
          '@code':
            '(args, enq) => {\n\t\t\tif (guard(args)) {\n\t\t\t\tenq(entry);\n\t\t\t\treturn { target: "b" };\n\t\t\t};\n\t\t\treturn undefined;\n\t\t}',
          '@lang': 'ts',
        },
      },
    })
  })

  it('actors and schemas are omitted instead of marked', function*({ expect }) {
    const worker = createAsyncLogic({
      run: () => Promise.resolve(undefined),
    })
    const machine = createMachine({
      context: { ok: true },
      schemas: {
        context: z.object({ ok: z.boolean() }),
        events: {
          GO: z.object({}),
        },
      },
      actors: {
        worker,
      },
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: worker,
          },
          on: {
            GO: { target: 'b' },
          },
        },
        b: {},
      },
    })

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect(json).toEqual({
      context: {
        ok: true,
      },
      initial: 'a',
      schemas: {
        events: {},
      },
      states: {
        a: {
          on: {
            GO: {
              target: 'b',
            },
          },
        },
        b: {},
      },
    })
  })

  it('drops nonportable values from objects and arrays', function*({ expect }) {
    const machine = createMachine({
      context: {
        kept: 'value',
        dropped: new Date(0),
        list: ['a', new Date(0), 'b'],
      },
      initial: 'idle',
      states: {
        idle: {},
      },
    } as any)

    const directJSON = serializeMachine(machine)
    const json = JSON.parse(JSON.stringify(directJSON))

    yield* expect({
      dropped: (directJSON as any).context.dropped,
      contextKeys: Object.keys((directJSON as any).context),
      json,
    }).toEqual({
      dropped: undefined,
      contextKeys: ['kept', 'list'],
      json: {
        context: {
          kept: 'value',
          list: [
            'a',
            'b',
          ],
        },
        initial: 'idle',
        states: {
          idle: {},
        },
      },
    })
  })

  it('serializable structure survives even when sources do not', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          timeout: '5s',
          onTimeout: { target: 'expired' },
          on: { NEXT: { target: 'expired' } },
        },
        expired: { type: 'final' },
      },
    })

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect(json).toEqual({
      initial: 'idle',
      states: {
        expired: {
          type: 'final',
        },
        idle: {
          on: {
            NEXT: {
              target: 'expired',
            },
          },
          onTimeout: {
            target: 'expired',
          },
          timeout: '5s',
        },
      },
    })
  })

  it('internal event names survive and stay internal after revival', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        internalEvents: { tick: types<{}>() },
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            start: { target: 'raising' },
            tick: { target: 'failed' },
          },
        },
        raising: {
          entry: (_, enq) => {
            enq.raise({ type: 'tick' })
          },
          on: { tick: { target: 'done' } },
        },
        done: {},
        failed: {},
      },
    })

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    const revived = createMachineFromConfig(json, {
      evaluators: {
        ts: ({ source, scope }: any) => Function(`return (${source});`)()(scope, scope.enq),
      },
    })

    const stray = _createMachineFromCompiledConfig({
      internalEvents: ['stray'],
      schemas: { internalEvents: { tick: types<{}>() } },
      initial: 'idle',
      states: { idle: {} },
    })

    const strictStray = serializeMachine(
      _createMachineFromCompiledConfig({
        internalEvents: ['stray'],
        initial: 'idle',
        states: { idle: {} },
      }),
    )

    const observations = [machine, revived] as AnyStateMachine[]

    const runs = observations.map((logic) => {
      const rejections: EventRejection[] = []
      const actor = createActor(logic, {
        onRejectedEvent: (rejection) => rejections.push(rejection),
      }).start()

      actor.send({ type: 'tick' })
      const afterTick = actor.getSnapshot().value
      const afterTickRejections = rejections.map((r) => [r.event.type, r.reason])

      actor.send({ type: 'start' })
      return {
        afterTick,
        afterTickRejections,
        afterStart: actor.getSnapshot().value,
        rejectionCount: rejections.length,
      }
    })

    yield* expect({
      internalEvents: json.internalEvents,
      revivedMatchesJson: JSON.stringify(serializeMachine(revived)) === JSON.stringify(json),
      strayInternalEvents: serializeMachine(stray)['internalEvents'],
      strictStrayKeys: Object.keys(strictStray),
      runs,
    }).toEqual({
      internalEvents: ['tick'],
      revivedMatchesJson: true,
      strayInternalEvents: ['tick'],
      strictStrayKeys: ['initial', 'states'],
      runs: [
        {
          afterTick: 'idle',
          afterTickRejections: [['tick', 'internalEvent']],
          afterStart: 'done',
          rejectionCount: 1,
        },
        {
          afterTick: 'idle',
          afterTickRejections: [['tick', 'internalEvent']],
          afterStart: 'done',
          rejectionCount: 1,
        },
      ],
    })
  })

  it('JSON-safe unknown data is preserved', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      customData: {
        label: 'Portable',
        values: [1, true, null],
      },
      states: {
        idle: {
          'x-viz': {
            x: 10,
            y: 20,
          },
        },
      },
    } as any)

    const json = JSON.parse(JSON.stringify(serializeMachine(machine)))

    yield* expect(json).toEqual({
      customData: {
        label: 'Portable',
        values: [
          1,
          true,
          null,
        ],
      },
      initial: 'idle',
      states: {
        idle: {
          'x-viz': {
            x: 10,
            y: 20,
          },
        },
      },
    })
  })

  it('revived machines run: structure + provided sources', function*({ expect }) {
    const definition = JSON.parse(
      JSON.stringify(
        serializeMachine(
          createMachineFromConfig({
            initial: 'inactive',
            states: {
              inactive: { on: { toggle: { target: 'active' } } },
              active: { on: { toggle: { target: 'inactive' } } },
            },
          } as any),
        ),
      ),
    )

    const machine = createMachineFromConfig(definition)
    const actor = createActor(machine).start()
    actor.send({ type: 'toggle' })

    yield* expect(actor.getSnapshot().value).toBe('active')
  })
})
