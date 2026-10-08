import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import { getSimplePaths } from '@systemfsoftware/xstate/graph'
import { Effect } from 'effect'
import { testPaths } from '../../src/engine/testPaths.js'

const toggleMachine = createMachine({
  id: 'toggle',
  initial: 'off',
  schemas: { events: { TOGGLE: types<{}>() } },
  states: {
    off: { on: { TOGGLE: { target: 'on' } } },
    on: { on: { TOGGLE: { target: 'off' } } },
  },
})

/** The rejection of `run`, or `undefined` when it resolved. */
const rejection = (run: () => Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(() => run().then(() => undefined, (cause: unknown) => cause))

describe('testPaths option validation', () => {
  it('accepts `outcomes` for a machine with no invoked actors', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      testPaths(toggleMachine, {
        mode: 'executed',
        outcomes: { fetcher: () => ({ ok: true, output: 1 }) },
      })
    )

    yield* expect(coverage.clockAdvances).toBe(0)
  })

  it('rejects `commands`', function*({ expect }) {
    const error = yield* rejection(() => testPaths(toggleMachine, { commands: { advance: () => 1 } } as never))

    yield* expect({ message: error instanceof Error ? error.message : undefined }).toEqual({
      message: expect.stringContaining('not supported by path generation'),
    })
  })

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects `samples: %s`',
    function*(samples, { expect }) {
      const error = yield* rejection(() => testPaths(toggleMachine, { samples }))

      yield* expect({ message: error instanceof Error ? error.message : undefined }).toEqual({
        message: expect.stringContaining('`samples` must be an integer of at least 1'),
      })
    },
  )
})

describe('testPaths event types', () => {
  it('offers declared event types a wildcard handler accepts', function*({ expect }) {
    const seen: string[] = []
    const wildcardMachine = createMachine({
      id: 'wildcard',
      initial: 'idle',
      schemas: { events: { ANYTHING: types<{}>() } },
      states: {
        idle: { on: { '*': { target: 'done' } } },
        done: {},
      },
    })

    yield* Effect.promise(() =>
      testPaths(wildcardMachine, {
        events: { ANYTHING: () => ({}) },
        sut: {
          create: () => ({
            send: (event) => {
              seen.push(event.type)
            },
          }),
        },
      })
    )

    yield* expect(seen).toContain('ANYTHING')
  })
})

describe('legacy `TestParam` detection', () => {
  it('rejects pre-2.0 event executors passed as generators', function*({ expect }) {
    const error = yield* rejection(() =>
      testPaths(toggleMachine, {
        events: {
          TOGGLE: (() => 'performed') as never,
        },
      })
    )

    yield* expect({ message: error instanceof Error ? error.message : undefined }).toEqual({
      message: expect.stringMatching(/pre-2\.0 event executor/),
    })
  })
})

describe('per-case seeding', () => {
  const sampledPayloads = (events: Record<string, unknown>): Effect.Effect<unknown[]> =>
    Effect.promise(() => {
      const payloads: unknown[] = []
      const machine = createMachine({
        id: 'payloads',
        initial: 'idle',
        schemas: { events: { A: types<{ n: number }>(), B: types<{}>() } },
        states: { idle: { on: { A: { target: 'idle' }, B: { target: 'idle' } } } },
      })
      return testPaths(machine, {
        pathGenerator: 'simple',
        limit: 20,
        events: events as never,
        sut: {
          create: () => ({
            send: (event: { readonly type: string; readonly n?: number }) => {
              if (event.type === 'A') {
                payloads.push(event.n)
              }
            },
          }),
        },
      }).then(() => payloads)
    })

  it('does not shift a case when another event type is added', function*({ expect }) {
    let counter = 0
    const a = () => ({ n: counter++ })
    const before = yield* sampledPayloads({ A: a })
    counter = 0
    const after = yield* sampledPayloads({ B: () => ({}), A: a })

    yield* expect(after).toEqual(before)
  })
})

describe('allowDuplicatePaths', () => {
  it('deduplicates paths from a custom path generator', function*({ expect }) {
    const deduplicated = yield* Effect.promise(() =>
      testPaths(toggleMachine, {
        pathGenerator: (logic, options) => getSimplePaths(logic, options),
      })
    )
    const all = yield* Effect.promise(() =>
      testPaths(toggleMachine, {
        pathGenerator: (logic, options) => getSimplePaths(logic, options),
        allowDuplicatePaths: true,
      })
    )

    yield* expect(deduplicated.results.length).toBeLessThan(all.results.length)
  })
})
