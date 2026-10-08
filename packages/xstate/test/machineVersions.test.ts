import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { createActor, createMachine, machineVersions, types } from '../src/index.js'

const createNotCalledRecorder = () => {
  const calls: unknown[] = []
  const record = (...args: unknown[]): never => {
    calls.push(args)
    throw new Error('this handler was not expected to be called')
  }
  return { calls, record }
}

const errorShape = (error: Error) => ({
  name: error.name,
  message: error.message,
})

describe('machineVersions', (it) => {
  it('exposes the same version schemas on machines and descriptors', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        context: z.object({ count: z.number() }),
        events: { ADD: z.object({ value: z.number() }) },
      },
      context: { count: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const persisted = createActor(checkout).getPersistedSnapshot()

    const contextResult = yield* Effect.promise(() =>
      Promise.resolve(
        checkout.snapshotSchema['~standard'].validate({
          ...persisted,
          context: { count: 1 },
        }),
      )
    )
    yield* expect(contextResult).toMatchObject({
      value: { context: { count: 1 } },
    })

    const eventResult = yield* Effect.promise(() =>
      Promise.resolve(
        checkout.eventSchema['~standard'].validate({
          type: 'ADD',
          value: 2,
        }),
      )
    )
    yield* expect(eventResult).toEqual({ value: { type: 'ADD', value: 2 } })

    const invalidResult = yield* Effect.promise(() =>
      Promise.resolve(
        checkout.snapshotSchema['~standard'].validate({
          ...persisted,
          value: 'removed',
        }),
      )
    )
    yield* expect(invalidResult).toEqual({
      issues: [{ message: "State 'removed' does not exist on 'checkout'" }],
    })
  })

  it('migrates a historical snapshot validated by its complete schema', function*({
    expect,
  }) {
    const checkoutV1 = {
      id: 'checkout',
      version: '1',
      snapshotSchema: z
        .object({
          status: z.literal('active'),
          output: z.undefined().optional(),
          error: z.undefined().optional(),
          value: z.literal('active'),
          context: z.object({ count: z.number() }),
          children: z.record(z.string(), z.unknown()),
          historyValue: z.record(z.string(), z.unknown()),
          timers: z.record(z.string(), z.unknown()),
          _nextActorId: z.number(),
          _nextTimerId: z.number(),
          machine: z.object({
            id: z.literal('checkout'),
            version: z.literal('1'),
          }),
          version: z.literal('1'),
        })
        .passthrough(),
    } as const
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])
    const persisted = {
      status: 'active',
      value: 'active',
      context: { count: 3 },
      children: {},
      historyValue: {},
      timers: {},
      _nextActorId: 0,
      _nextTimerId: 0,
      machine: { id: 'checkout', version: '1' },
      version: '1',
    } as const

    const compatible = yield* Effect.promise(() =>
      versions.migrateSnapshot(persisted, {
        to: '2',
        migrations: {
          '1': (snapshot) => ({
            ...snapshot,
            context: { total: snapshot.context.count },
          }),
        },
      })
    )

    yield* expect(compatible.context).toEqual({ total: 3 })

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.migrateSnapshot(
            { ...persisted, value: 'removed-state' },
            {
              to: '2',
              migrations: {
                '1': (snapshot) => ({
                  ...snapshot,
                  context: { total: snapshot.context.count },
                }),
              },
            },
          ),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Invalid snapshot for machine 'checkout' version '1': Invalid literal value, expected \"active\"",
    })
  })

  it('does not use a snapshot-only version as a restoration target', function*({
    expect,
  }) {
    const historical = {
      id: 'checkout',
      version: '1',
      snapshotSchema: types<{
        status: 'active'
        value: 'active'
        context: {}
        children: {}
        historyValue: {}
        timers: {}
        _nextTimerId: number
      }>(),
    } as const
    const current = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([historical, current])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () => versions.migrateSnapshot({}, { to: '1', migrations: {} } as any),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Target version '1' is not backed by a machine for 'checkout'.",
    })
  })

  it('uses the unknown event adapter for snapshot-only source versions', function*({
    expect,
  }) {
    const historical = {
      id: 'checkout',
      version: '1',
      snapshotSchema: types<{
        status: 'active'
        value: 'active'
        context: {}
        children: {}
        historyValue: {}
        timers: {}
        _nextTimerId: number
      }>(),
    } as const
    const current = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([historical, current])
    const seenEvents: unknown[] = []
    const seenSources: unknown[] = []

    const events = yield* Effect.promise(() =>
      versions.adaptEvents([{ type: 'ADD', value: 2 }], {
        from: { version: '1' },
        to: '2',
        adapters: {
          '*': (unknownEvents, source) => {
            seenEvents.push(unknownEvents)
            seenSources.push(source)
            return [{ type: 'CHANGE', delta: 2 }]
          },
        },
      })
    )

    yield* expect({ events, seenEvents, seenSources }).toEqual({
      events: [{ type: 'CHANGE', delta: 2 }],
      seenEvents: [[{ type: 'ADD', value: 2 }]],
      seenSources: [{ version: '1' }],
    })
  })

  it('reports when a registered source has no event schema', function*({
    expect,
  }) {
    const historical = {
      id: 'checkout',
      version: '1',
      snapshotSchema: types<{
        status: 'active'
        value: 'active'
        context: {}
        children: {}
        historyValue: {}
        timers: {}
      }>(),
    } as const
    const current = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([historical, current])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.adaptEvents([], {
            from: { version: '1' },
            to: '2',
            adapters: {},
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message:
        "Machine version '1' does not define an event schema; only the '*' adapter can handle its event history.",
    })
  })

  it('adapts events from a historical event schema', function*({ expect }) {
    const historical = {
      id: 'checkout',
      version: '1',
      eventSchema: z.discriminatedUnion('type', [
        z.object({ type: z.literal('ADD'), value: z.number() }),
        z.object({ type: z.literal('REMOVE'), value: z.number() }),
      ]),
    } as const
    const current = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([historical, current])
    const wildcard = createNotCalledRecorder()

    const events = yield* Effect.promise(() =>
      versions.adaptEvents(
        [
          { type: 'ADD', value: 5 },
          { type: 'REMOVE', value: 2 },
        ],
        {
          from: { version: '1' },
          to: '2',
          adapters: {
            '1': (events) => [
              {
                type: 'CHANGE',
                delta: events.reduce(
                  (total, event) => total + (event.type === 'ADD' ? event.value : -event.value),
                  0,
                ),
              },
            ],
            '*': wildcard.record,
          },
        },
      )
    )

    yield* expect({ events, wildcardCalls: wildcard.calls }).toEqual({
      events: [{ type: 'CHANGE', delta: 3 }],
      wildcardCalls: [],
    })
  })

  it('routes invalid historical event-schema input to the wildcard', function*({
    expect,
  }) {
    const historical = {
      id: 'checkout',
      version: '1',
      eventSchema: z.object({
        type: z.literal('ADD'),
        value: z.number(),
      }),
    } as const
    const current = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([historical, current])
    const exact = createNotCalledRecorder()
    const seenEvents: unknown[] = []

    const events = yield* Effect.promise(() =>
      versions.adaptEvents([{ type: 'ADD', value: 'invalid' }], {
        from: { version: '1' },
        to: '2',
        adapters: {
          '1': exact.record,
          '*': (unknownEvents) => {
            seenEvents.push(unknownEvents)
            return [{ type: 'CHANGE', delta: 0 }]
          },
        },
      })
    )

    yield* expect({ events, seenEvents, exactCalls: exact.calls }).toEqual({
      events: [{ type: 'CHANGE', delta: 0 }],
      seenEvents: [[{ type: 'ADD', value: 'invalid' }]],
      exactCalls: [],
    })
  })

  it('adapts a whole event history through an async exact-version adapter', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        events: {
          ADD: z.object({ value: z.number() }),
          REMOVE: z.object({ value: z.number() }),
        },
      },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: {
          CHANGE: z.object({ delta: z.number() }),
        },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])
    const wildcard = createNotCalledRecorder()

    const events = yield* Effect.promise(() =>
      versions.adaptEvents(
        [
          { type: 'ADD', value: 5 },
          { type: 'REMOVE', value: 2 },
        ],
        {
          from: { id: 'checkout', version: '1' },
          to: '2',
          adapters: {
            '1': (sourceEvents) =>
              Promise.resolve([
                {
                  type: 'CHANGE',
                  delta: sourceEvents.reduce(
                    (total, event) =>
                      total +
                      (event.type === 'ADD' ? event.value : -event.value),
                    0,
                  ),
                },
              ]),
            '*': wildcard.record,
          },
        },
      )
    )

    yield* expect({ events, wildcardCalls: wildcard.calls }).toEqual({
      events: [{ type: 'CHANGE', delta: 3 }],
      wildcardCalls: [],
    })
  })

  it('defaults an omitted source ID to the retained machine ID', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])

    const events = yield* Effect.promise(() =>
      versions.adaptEvents([{ type: 'ADD' }], {
        from: { version: '1' },
        to: '2',
        adapters: {
          '1': () => [{ type: 'CHANGE' }],
        },
      })
    )

    yield* expect(events).toEqual([{ type: 'CHANGE' }])
  })

  it('adapts an unknown history through an async wildcard adapter', function*({
    expect,
  }) {
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: {
          CHANGE: z.object({ delta: z.number() }),
        },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV2])
    const history = [{ kind: 'added', amount: 3 }]
    const source = { id: 'legacy-checkout', version: 'draft' }
    const seen: Array<{ events: unknown; source: unknown }> = []

    const events = yield* Effect.promise(() =>
      versions.adaptEvents(history, {
        from: source,
        to: '2',
        adapters: {
          '*': (unknownEvents, actualSource) => {
            seen.push({ events: unknownEvents, source: actualSource })
            return Promise.resolve([
              {
                type: 'CHANGE',
                delta: (unknownEvents[0] as { amount: number }).amount,
              },
            ])
          },
        },
      })
    )

    yield* expect({
      events,
      sameEvents: seen[0]?.events === history,
      sameSource: seen[0]?.source === source,
    }).toEqual({
      events: [{ type: 'CHANGE', delta: 3 }],
      sameEvents: true,
      sameSource: true,
    })
  })

  it('validates and returns same-version histories without calling adapters', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: {
          CHANGE: z.object({ delta: z.number() }),
        },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])
    const wildcard = createNotCalledRecorder()

    const events = yield* Effect.promise(() =>
      versions.adaptEvents([{ type: 'CHANGE', delta: 3 }], {
        from: { id: 'checkout', version: '2' },
        to: '2',
        adapters: { '*': wildcard.record },
      })
    )

    yield* expect({ events, wildcardCalls: wildcard.calls }).toEqual({
      events: [{ type: 'CHANGE', delta: 3 }],
      wildcardCalls: [],
    })
  })

  it('routes invalid retained-source histories to the wildcard adapter', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        events: { ADD: z.object({ value: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])
    const history = [{ type: 'legacy-add', amount: 4 }]
    const exact = createNotCalledRecorder()
    const seenEvents: unknown[] = []

    const events = yield* Effect.promise(() =>
      versions.adaptEvents(history, {
        from: { id: 'checkout', version: '1' },
        to: '2',
        adapters: {
          '1': exact.record,
          '*': (unknownEvents) => {
            seenEvents.push(unknownEvents)
            return [
              {
                type: 'CHANGE',
                delta: (unknownEvents[0] as { amount: number }).amount,
              },
            ]
          },
        },
      })
    )

    yield* expect({ events, seenEvents, exactCalls: exact.calls }).toEqual({
      events: [{ type: 'CHANGE', delta: 4 }],
      seenEvents: [[{ type: 'legacy-add', amount: 4 }]],
      exactCalls: [],
    })
  })

  it('rejects a retained source without an exact or wildcard adapter', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.adaptEvents([{ type: 'ADD' }], {
            from: { id: 'checkout', version: '1' },
            to: '2',
            adapters: {},
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "No event adapter from version '1' to '2' for machine 'checkout'.",
    })
  })

  it('propagates exact adapter errors without falling back to wildcard', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])
    const wildcard = createNotCalledRecorder()

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.adaptEvents([], {
            from: { id: 'checkout', version: '1' },
            to: '2',
            adapters: {
              '1': () => {
                throw new Error('adapter failed')
              },
              '*': wildcard.record,
            },
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect({
      message: error.message,
      wildcardCalls: wildcard.calls,
    }).toEqual({ message: 'adapter failed', wildcardCalls: [] })
  })

  it('rejects an unknown source without a wildcard adapter', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.adaptEvents([], {
            from: { id: 'checkout', version: 'unknown' },
            to: '2',
            adapters: {},
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Unknown event history source 'checkout' version 'unknown'.",
    })
  })

  it('validates adapted output against target event schemas', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.adaptEvents([], {
            from: { version: 'legacy' },
            to: '2',
            adapters: {
              '*': () => [{ type: 'CHANGE', delta: 'invalid' }] as any,
            },
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Invalid event 'CHANGE' at index 0: Expected number, received string",
    })
  })

  it('rejects inherited event schema keys as unknown events', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.adaptEvents([{ type: 'constructor' }], {
            from: { id: 'checkout', version: '2' },
            to: '2',
            adapters: {},
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Unknown event 'constructor' for machine 'checkout' version '2'.",
    })
  })

  it('preserves reserved framework events without schema validation', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        events: { CHANGE: z.object({ delta: z.number() }) },
      },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])
    const events = [
      { type: 'xstate.done.actor', actorId: 'child' },
      { type: '@xstate.init' },
    ]

    const adapted = yield* Effect.promise(() =>
      versions.adaptEvents(events, {
        from: { id: 'checkout', version: '2' },
        to: '2',
        adapters: {},
      })
    )

    yield* expect(adapted).toEqual(events)
  })

  it('migrates an unknown snapshot through an async wildcard handler', function*({
    expect,
  }) {
    const legacyCheckout = createMachine({
      id: 'checkout',
      context: { count: 2 },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        context: z.object({ total: z.number() }),
      },
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const persisted = JSON.parse(
      JSON.stringify(createActor(legacyCheckout).getPersistedSnapshot()),
    )
    const versions = machineVersions([checkoutV2])
    const seen: Array<{ snapshot: unknown; source: unknown }> = []

    const compatible = yield* Effect.promise(() =>
      versions.migrateSnapshot(persisted, {
        to: '2',
        migrations: {
          '*': (snapshot, source) => {
            seen.push({ snapshot, source })
            return Promise.resolve({
              ...(snapshot as Record<string, unknown>),
              context: {
                total: (snapshot as { context: { count: number } }).context
                  .count,
              },
            } as any)
          },
        },
      })
    )
    const actor = createActor(checkoutV2, { snapshot: compatible }).start()

    yield* expect({
      context: actor.getSnapshot().context,
      snapshot: seen[0]?.snapshot,
      source: seen[0]?.source,
    }).toEqual({
      context: { total: 2 },
      snapshot: persisted,
      source: { id: undefined, version: undefined },
    })
  })

  it('validates wildcard migration output against the target machine', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        context: z.object({ total: z.number() }),
      },
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.migrateSnapshot(
            {},
            {
              to: '2',
              migrations: {
                '*': () =>
                  ({
                    ...createActor(checkout).getPersistedSnapshot(),
                    context: { total: 'invalid' },
                  }) as any,
              },
            },
          ),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message:
        "Invalid snapshot for machine 'checkout' version '2': Invalid context for machine 'checkout' version '2': Expected number, received string",
    })
  })

  it('defaults restoration-optional bookkeeping in migration output', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])

    const compatible = yield* Effect.promise(() =>
      versions.migrateSnapshot(
        {},
        {
          to: '2',
          migrations: {
            '*': () => ({
              status: 'active',
              output: undefined,
              error: undefined,
              value: 'active',
              context: { total: 3 },
              children: {},
            }),
          },
        },
      )
    )
    const context = createActor(checkout, { snapshot: compatible })
      .start()
      .getSnapshot().context

    yield* expect({ compatible, context }).toMatchObject({
      compatible: { historyValue: {}, timers: {} },
      context: { total: 3 },
    })
  })

  it('routes an unretained source version to the wildcard', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '2',
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkout])
    const persisted = {
      ...createActor(checkout).getPersistedSnapshot(),
      machine: { id: 'checkout', version: '1' },
      version: '1',
      context: { count: 3 },
    }
    const seen: Array<{ snapshot: unknown; source: unknown }> = []

    const compatible = yield* Effect.promise(() =>
      versions.migrateSnapshot(persisted, {
        to: '2',
        migrations: {
          '*': (snapshot, source) => {
            seen.push({ snapshot, source })
            return {
              ...(snapshot as typeof persisted),
              context: { total: 3 },
            } as any
          },
        },
      })
    )

    yield* expect({
      context: compatible.context,
      snapshotIsPersisted: seen[0]?.snapshot === persisted,
      source: seen[0]?.source,
    }).toEqual({
      context: { total: 3 },
      snapshotIsPersisted: true,
      source: { id: 'checkout', version: '1' },
    })
  })

  it('exposes snapshot migration and event adaptation separately', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })

    yield* expect(machineVersions([checkout])).toEqual({
      parseSnapshot: expect.any(Function),
      adaptEvents: expect.any(Function),
      migrateSnapshot: expect.any(Function),
    })
  })

  it('rejects machines without a version', function*({ expect }) {
    const unversionedMachine = createMachine({
      id: 'checkout',
      initial: 'active',
      states: { active: {} },
    })

    const error = yield* Effect.flip(
      Effect.try({
        try: () => machineVersions([unversionedMachine] as any),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Machine 'checkout' must define a version.",
    })
  })

  it("reserves '*' for wildcard migrations", function*({ expect }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '*',
      initial: 'active',
      states: { active: {} },
    })

    const error = yield* Effect.flip(
      Effect.try({
        try: () => machineVersions([checkout]),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Machine version '*' is reserved for wildcard migrations.",
    })
  })

  it('rejects machines with different IDs', function*({ expect }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const cart = createMachine({
      id: 'cart',
      version: '2',
      initial: 'active',
      states: { active: {} },
    })

    const error = yield* Effect.flip(
      Effect.try({
        try: () => machineVersions([checkout, cart]),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Machine 'cart' does not match machine ID 'checkout'.",
    })
  })

  it('rejects an unversioned policy that references an unretained version', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })

    const error = yield* Effect.flip(
      Effect.try({
        try: () => machineVersions([checkout], { unversioned: '0' } as any),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Unversioned snapshot version '0' is not retained for machine 'checkout'.",
    })
  })

  it('rejects restoring a snapshot from a different machine ID', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const cart = createMachine({
      id: 'cart',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const persisted = createActor(checkout).getPersistedSnapshot()

    const restored = createActor(cart, {
      // @ts-expect-error -- cross-ID restore is also rejected at the type level
      snapshot: persisted,
    })
    restored.subscribe({ error: () => {} })
    restored.start()

    yield* expect(restored.getSnapshot()).toMatchObject({
      status: 'error',
      error: expect.objectContaining({
        message:
          "Machine ID mismatch: persisted snapshot was created by machine 'checkout', but machine 'cart' was provided.",
      }),
    })
  })

  it('parses a persisted snapshot with the matching machine schema', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        context: types<{ count: number }>(),
      },
      context: { count: 1 },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        context: types<{ total: number }>(),
      },
      context: { total: 1 },
      initial: 'active',
      states: { active: {} },
    })

    const persisted = JSON.parse(
      JSON.stringify(createActor(checkoutV1).getPersistedSnapshot()),
    )
    const versions = machineVersions([checkoutV1, checkoutV2])

    const parsed = yield* Effect.promise(() => versions.parseSnapshot(persisted))

    yield* expect({
      machineIsV1: parsed.machine === checkoutV1,
      context: parsed.snapshot.context,
    }).toEqual({ machineIsV1: true, context: { count: 1 } })
  })

  it('parses legacy snapshots that only contain a top-level version', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        context: types<{ count: number }>(),
      },
      context: { count: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1])
    const { machine: _, ...legacyPersisted } = createActor(
      checkoutV1,
    ).getPersistedSnapshot() as Record<string, unknown>

    const parsed = yield* Effect.promise(() =>
      versions.parseSnapshot({
        ...legacyPersisted,
        context: { count: 2 },
      })
    )

    yield* expect({
      machineIsV1: parsed.machine === checkoutV1,
      machine: parsed.snapshot.machine,
    }).toEqual({
      machineIsV1: true,
      machine: {
        id: 'checkout',
        version: '1',
      },
    })
  })

  it('migrates unversioned snapshots through the configured retained version', function*({
    expect,
  }) {
    const legacyCheckout = createMachine({
      id: 'checkout',
      context: { count: 2 },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV0 = createMachine({
      id: 'checkout',
      version: '0',
      schemas: {
        context: z.object({ count: z.number() }),
      },
      context: { count: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        context: z.object({ total: z.number() }),
      },
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV0, checkoutV1], {
      unversioned: '0',
    })

    const persisted = JSON.parse(
      JSON.stringify(createActor(legacyCheckout).getPersistedSnapshot()),
    )
    const parsed = yield* Effect.promise(() => versions.parseSnapshot(persisted))

    yield* expect({
      machineIsV0: parsed.machine === checkoutV0,
      snapshot: parsed.snapshot,
    }).toEqual({
      machineIsV0: true,
      snapshot: expect.objectContaining({
        context: { count: 2 },
        machine: { id: 'checkout', version: '0' },
      }),
    })

    const compatible = yield* Effect.promise(() =>
      versions.migrateSnapshot(persisted, {
        to: '1',
        migrations: {
          '0': (snapshot) => ({
            ...snapshot,
            context: { total: snapshot.context.count },
          }),
        },
      })
    )
    const actor = createActor(checkoutV1, { snapshot: compatible }).start()

    yield* expect(actor.getSnapshot().context).toEqual({ total: 2 })
  })

  it('parses an unversioned snapshot through a historical schema', function*({
    expect,
  }) {
    const historical = {
      id: 'checkout',
      version: '0',
      snapshotSchema: z
        .object({
          status: z.literal('active'),
          output: z.undefined().optional(),
          error: z.undefined().optional(),
          value: z.literal('active'),
          context: z.object({ count: z.number() }),
          children: z.object({}),
          historyValue: z.object({}),
          timers: z.object({}),
          _nextActorId: z.number().optional(),
          _nextTimerId: z.number(),
        })
        .transform(({ _nextActorId, ...rest }) => _nextActorId === undefined ? rest : { ...rest, _nextActorId }),
    } as const
    const versions = machineVersions([historical], { unversioned: '0' })

    const parsed = yield* Effect.promise(() =>
      versions.parseSnapshot({
        status: 'active',
        value: 'active',
        context: { count: 1 },
        children: {},
        historyValue: {},
        timers: {},
        _nextTimerId: 0,
      })
    )

    yield* expect({
      sourceIsHistorical: parsed.source === historical,
      snapshot: parsed.snapshot,
    }).toEqual({
      sourceIsHistorical: true,
      snapshot: expect.objectContaining({
        context: { count: 1 },
        machine: { id: 'checkout', version: '0' },
      }),
    })
  })

  it('does not use the unversioned policy for an explicit unknown version', function*({
    expect,
  }) {
    const checkoutV0 = createMachine({
      id: 'checkout',
      version: '0',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV0], {
      unversioned: '0',
    })

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () => versions.parseSnapshot({ version: 'unknown' }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Unknown machine identity 'checkout' version 'unknown'.",
    })
  })

  it('rejects contradictory snapshot version metadata', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.parseSnapshot({
            machine: { id: 'checkout', version: '1' },
            version: '2',
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message: "Persisted snapshot version '2' conflicts with machine version '1'.",
    })
  })

  it('rejects contradictory version metadata during direct restoration', function*({
    expect,
  }) {
    const checkout = createMachine({
      id: 'checkout',
      version: '1',
      initial: 'active',
      states: { active: {} },
    })
    const persisted = {
      ...createActor(checkout).getPersistedSnapshot(),
      machine: { id: 'checkout', version: '2' },
    }

    const restored = createActor(checkout, { snapshot: persisted })
    restored.subscribe({ error: () => {} })
    restored.start()

    yield* expect(restored.getSnapshot()).toMatchObject({
      status: 'error',
      error: expect.objectContaining({
        message: "Persisted snapshot version '1' conflicts with machine version '2'.",
      }),
    })
  })

  it('validates persisted snapshots with the retained machine schema', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        context: z.object({ count: z.number() }),
      },
      context: { count: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1])

    const error = yield* Effect.flip(
      Effect.tryPromise({
        try: () =>
          versions.parseSnapshot({
            machine: { id: 'checkout', version: '1' },
            version: '1',
            context: { count: '1' },
          }),
        catch: (cause) => cause as Error,
      }),
    )
    yield* expect(errorShape(error)).toEqual({
      name: 'Error',
      message:
        "Invalid snapshot for machine 'checkout' version '1': Invalid context for machine 'checkout' version '1': Expected number, received string",
    })
  })

  it('prefers an async exact-version migration over the wildcard', function*({
    expect,
  }) {
    const checkoutV1 = createMachine({
      id: 'checkout',
      version: '1',
      schemas: {
        context: types<{ count: number }>(),
      },
      context: { count: 1 },
      initial: 'active',
      states: { active: {} },
    })
    const checkoutV2 = createMachine({
      id: 'checkout',
      version: '2',
      schemas: {
        context: types<{ total: number }>(),
      },
      context: { total: 0 },
      initial: 'active',
      states: { active: {} },
    })
    const versions = machineVersions([checkoutV1, checkoutV2])
    const persisted = JSON.parse(
      JSON.stringify(createActor(checkoutV1).getPersistedSnapshot()),
    )
    const wildcard = createNotCalledRecorder()

    const compatible = yield* Effect.promise(() =>
      versions.migrateSnapshot(persisted, {
        to: '2',
        migrations: {
          '1': (snapshot) =>
            Promise.resolve({
              ...snapshot,
              context: { total: snapshot.context.count },
            }),
          '*': wildcard.record,
        },
      })
    )
    const actor = createActor(checkoutV2, { snapshot: compatible }).start()
    const machine: unknown = Reflect.get(compatible, 'machine')

    yield* expect({
      context: actor.getSnapshot().context,
      machine,
      wildcardCalls: wildcard.calls,
    }).toEqual({
      context: { total: 1 },
      machine: {
        id: 'checkout',
        version: '2',
      },
      wildcardCalls: [],
    })
  })
})
