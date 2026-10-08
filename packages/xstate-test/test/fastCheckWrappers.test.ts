import { describe, expectTypeOf, it } from '@systemfsoftware/vitest'
import { createMachine, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import * as z from 'zod'
import type { TestStateKey } from '../src/engine/propertyTest.js'
import { ModelTestFailure, propertyTest, testPaths } from '../src/index.js'

const lightMachine = createMachine({
  id: 'light',
  schemas: { events: { NEXT: types<{}>() } },
  initial: 'green',
  states: {
    green: { on: { NEXT: { target: 'yellow' } } },
    yellow: { on: { NEXT: { target: 'red' } } },
    red: {
      initial: 'walk',
      states: { walk: { on: { NEXT: { target: 'stop' } } }, stop: {} },
    },
  },
})

describe('testPaths() with top-level `states` and no `sut`', () => {
  const recordStates = () => {
    const seen: string[] = []
    return {
      seen,
      states: {
        yellow: () => {
          seen.push('yellow')
        },
        'red.walk': () => {
          seen.push('red.walk')
        },
      },
    }
  }

  it('accepts fast-check arbitraries', function*({ expect }) {
    const { seen, states } = recordStates()
    yield* Effect.promise(() =>
      testPaths(lightMachine, {
        events: { NEXT: fc.constant({}) },
        states,
      })
    )

    yield* expect({
      sawYellow: seen.includes('yellow'),
      sawRedWalk: seen.includes('red.walk'),
    }).toEqual({ sawYellow: true, sawRedWalk: true })
  })

  it('accepts schema-derived events', function*({ expect }) {
    const schemaMachine = createMachine({
      schemas: { events: { SET: z.object({ value: z.number().int() }) } },
      initial: 'idle',
      states: {
        idle: { on: { SET: { target: 'set' } } },
        set: {},
      },
    })
    const seen: unknown[] = []
    const { results } = yield* Effect.promise(() =>
      testPaths(schemaMachine, {
        states: {
          set: (snapshot) => {
            seen.push(snapshot.value)
          },
        },
      })
    )

    yield* expect({
      resultCountPositive: results.length > 0,
      sawSet: seen.includes('set'),
    }).toEqual({ resultCountPositive: true, sawSet: true })
  })

  it('accepts `(rng) => payload` generators', function*({ expect }) {
    const { seen, states } = recordStates()
    yield* Effect.promise(() =>
      testPaths(lightMachine, {
        events: { NEXT: (() => ({})) as never },
        states,
      })
    )

    yield* expect({ sawRedWalk: seen.includes('red.walk') }).toEqual({ sawRedWalk: true })
  })
})

describe('fast-check run bounds', () => {
  const counterMachine = createMachine({
    schemas: {
      context: types<{ count: number }>(),
      events: { INC: types<{}>() },
    },
    context: { count: 0 },
    on: { INC: ({ context }) => ({ context: { count: context.count + 1 } }) },
  })

  it('reaches a `maxCommands` above fast-check’s default size', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 50,
        maxCommands: 20,
        events: { INC: fc.constant({}) },
      })
    )

    yield* expect(coverage.exploration.maximumObservedSequenceLength).toBe(20)
  })

  it('bounds a batched campaign by `numRuns`', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 7,
        until: () => false,
        events: { INC: fc.constant({}) },
      })
    )

    yield* expect({
      completedRuns: coverage.exploration.completedRuns,
      configuredRuns: coverage.exploration.configuredRuns,
    }).toEqual({ completedRuns: 7, configuredRuns: 7 })
  })
})

describe('types', () => {
  it('keeps the snapshot type in testPaths() results', function*({ expect }) {
    if (false as boolean) {
      void testPaths(lightMachine).then(({ results }) => {
        const first = results[0]
        if (first === undefined) {
          throw new Error('expected a first result')
        }
        expectTypeOf(first.path.state).toEqualTypeOf<
          SnapshotFrom<typeof lightMachine>
        >()
      })
    }

    yield* expect(lightMachine.id).toEqual('light')
  })

  it('suggests state-value keys for `states`', function*({ expect }) {
    type Key = TestStateKey<SnapshotFrom<typeof lightMachine>>
    expectTypeOf<'red.walk'>().toMatchTypeOf<Key>()
    expectTypeOf<'green'>().toMatchTypeOf<Key>()
    expectTypeOf<'#light.red'>().toMatchTypeOf<Key>()
    expectTypeOf<'*'>().toMatchTypeOf<Key>()

    yield* expect(lightMachine.id).toEqual('light')
  })

  it('keeps the trace typed after `instanceof`', function*({ expect }) {
    const error: unknown = undefined
    if (error instanceof ModelTestFailure) {
      expectTypeOf(error.trace).not.toBeAny()
      expectTypeOf(error.trace.finalSnapshot).not.toBeAny()
    }

    yield* expect(ModelTestFailure.name).toEqual('ModelTestFailure')
  })
})
