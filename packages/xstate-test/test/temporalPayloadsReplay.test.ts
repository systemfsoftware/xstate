import { it } from '@systemfsoftware/vitest'
import { createMachine, type EventObject, type Snapshot, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as DateTime from 'effect/DateTime'
import * as fc from 'fast-check'
import { describe } from 'vitest'
import type { TestAdapterRequest, TestAdapterResult } from '../src/engine/index.js'
import { defaultEquivalent } from '../src/engine/propertyTest.js'
import {
  extractReplayPath,
  fastCheckAdapter,
  ModelTestFailure,
  propertyTest,
  ReplayNotReproducedError,
  replayTest,
} from '../src/index.js'
import type { TestAdapter, TestFixture } from '../src/index.js'

const counterMachine = createMachine({
  id: 'p0-counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

type ScriptStep = 'check' | 'run'

type ReplayStart = {
  snapshot: SnapshotFrom<typeof counterMachine>
  serializeSnapshot: () => string
}

const scriptedAdapter = (steps: readonly ScriptStep[]): TestAdapter => ({
  run: <TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(
    request: TestAdapterRequest<TSnapshot, TEvent>,
  ): Promise<TestAdapterResult> => {
    const firstEvent = request.events[0]
    if (firstEvent === undefined) {
      throw new Error('expected an event generator in the adapter request')
    }
    const runner = request.createRunner()
    const event = request.createEvent('INC', {})
    return Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.promise(() => runner.start())
        for (const step of steps) {
          if (step === 'check') {
            runner.canRun(event, firstEvent.caseId)
          } else {
            yield* Effect.promise(() => runner.run(event, firstEvent.caseId))
          }
        }
        yield* Effect.sync(() => runner.finish())
        return {
          runs: 1,
          exploration: { configuredRuns: 1, maximumSequenceLength: null },
        }
      }).pipe(Effect.ensuring(Effect.promise(() => runner.dispose()))),
    )
  },
})

const rejectionOf = <A>(run: () => Promise<A>): Effect.Effect<unknown> =>
  Effect.promise(() => run().then(() => undefined, (error: unknown) => error))

const rejectionMessage = (run: () => Promise<unknown>): Promise<string> =>
  Promise.resolve()
    .then(() => run())
    .then(
      () => 'no error was thrown',
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )

const returned = (call: () => unknown): boolean => {
  try {
    call()
    return true
  } catch {
    return false
  }
}

const fixtureOf = (error: unknown): TestFixture | undefined =>
  error instanceof ModelTestFailure ? error.fixture : undefined

describe('temporal operators (STA-6400)', () => {
  it('does not fail a bounded `eventually` whose `within` bound was never reached', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'eventually',
            id: 'reach-ten',
            within: 10,
            predicate: ({ snapshot }) => snapshot.context.count === 10,
          },
        ],
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.temporalChecks).toBeGreaterThan(0)
  })

  it('does not fail a bounded `until` whose `within` bound was never reached', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'until',
            id: 'never-closes',
            within: 10,
            hold: () => true,
            until: () => false,
          },
        ],
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.temporal).toMatchObject({
      inconclusive: ['never-closes'],
      failed: [],
    })
  })

  it('still fails an unbounded `eventually` that the run never satisfied', function*({ expect }) {
    const failure = yield* rejectionOf(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'eventually',
            id: 'reach-ten-unbounded',
            predicate: ({ snapshot }) => snapshot.context.count === 10,
          },
        ],
        invariant: () => {},
      })
    )

    const temporalFailure = failure instanceof ModelTestFailure
      ? failure.fixture?.temporalFailure
      : undefined

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      type: temporalFailure?.type,
      id: temporalFailure?.id,
      within: temporalFailure?.within,
    }).toEqual({
      isModelTestFailure: true,
      type: 'eventually',
      id: 'reach-ten-unbounded',
      within: undefined,
    })
  })

  it('fails `always` on the first stable step where the predicate does not hold', function*({ expect }) {
    const failure = yield* rejectionOf(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run', 'check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'always',
            id: 'below-two',
            predicate: ({ snapshot }) => snapshot.context.count < 2,
          },
        ],
        invariant: () => {},
      })
    )

    const temporalFailure = failure instanceof ModelTestFailure
      ? failure.fixture?.temporalFailure
      : undefined

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      type: temporalFailure?.type,
      id: temporalFailure?.id,
      within: temporalFailure?.within,
    }).toEqual({
      isModelTestFailure: true,
      type: 'always',
      id: 'below-two',
      within: undefined,
    })
  })

  it('passes `always` when the predicate holds on every stable step', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'always',
            id: 'non-negative',
            predicate: ({ snapshot }) => snapshot.context.count >= 0,
          },
        ],
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.temporal).toMatchObject({
      satisfied: ['non-negative'],
      failed: [],
    })
  })

  it('fails `never` on the first stable step where the predicate holds', function*({ expect }) {
    const failure = yield* rejectionOf(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'never',
            id: 'never-one',
            predicate: ({ snapshot }) => snapshot.context.count === 1,
          },
        ],
        invariant: () => {},
      })
    )

    const temporalFailure = failure instanceof ModelTestFailure
      ? failure.fixture?.temporalFailure
      : undefined

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      type: temporalFailure?.type,
      id: temporalFailure?.id,
      within: temporalFailure?.within,
    }).toEqual({
      isModelTestFailure: true,
      type: 'never',
      id: 'never-one',
      within: undefined,
    })
  })

  it('passes `never` when the predicate never holds', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'never',
            id: 'never-negative',
            predicate: ({ snapshot }) => snapshot.context.count < 0,
          },
        ],
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.temporal).toMatchObject({
      satisfied: ['never-negative'],
      failed: [],
    })
  })
})

describe('non-object event payloads (STA-6402)', () => {
  it('throws a descriptive error for a non-object generated payload', function*({ expect }) {
    const message = yield* Effect.promise(() =>
      rejectionMessage(() =>
        propertyTest(counterMachine, {
          seed: 1,
          numRuns: 1,
          maxCommands: 2,
          events: { INC: { generate: fc.integer({ min: 1, max: 3 }) } },
          invariant: () => {},
        })
      )
    )

    yield* expect({ message }).toEqual({
      message: expect.stringMatching(
        /^Property event case \["event-case","INC","default"\] generated a non-object payload \([1-3]\)\. Event payloads must be plain objects; use a `resolve` function to map generated values onto an event payload\.$/,
      ),
    })
  })

  it('names the event case and points at `resolve`', function*({ expect }) {
    const message = yield* Effect.promise(() =>
      rejectionMessage(() =>
        propertyTest(counterMachine, {
          seed: 2,
          numRuns: 1,
          maxCommands: 2,
          events: { INC: { generate: fc.constant(7) } },
          invariant: () => {},
        })
      )
    )

    yield* expect({
      message,
      namesTheEventType: message.includes('INC'),
      namesTheDrawnValue: message.includes('7'),
      pointsAtResolve: message.includes('`resolve`'),
    }).toEqual({
      message:
        'Property event case ["event-case","INC","default"] generated a non-object payload (7). Event payloads must be plain objects; use a `resolve` function to map generated values onto an event payload.',
      namesTheEventType: true,
      namesTheDrawnValue: true,
      pointsAtResolve: true,
    })
  })

  it('throws when `resolve` itself returns a non-object payload', function*({ expect }) {
    const message = yield* Effect.promise(() =>
      rejectionMessage(() =>
        propertyTest(counterMachine, {
          seed: 3,
          numRuns: 1,
          maxCommands: 2,
          events: {
            INC: {
              generate: fc.record({ value: fc.integer({ min: 1, max: 3 }) }),
              resolve: ({ generated }) =>
                typeof generated === 'object' &&
                  generated !== null &&
                  'value' in generated &&
                  typeof generated.value === 'number'
                  ? generated.value
                  : undefined,
            },
          },
          invariant: () => {},
        })
      )
    )

    yield* expect({ message }).toEqual({
      message: expect.stringMatching(
        /^Property event case \["event-case","INC","default"\] generated a non-object payload \([1-3]\)\. Event payloads must be plain objects; use a `resolve` function to map generated values onto an event payload\.$/,
      ),
    })
  })

  it('throws when an adapter calls `createEvent` with a non-object payload', function*({ expect }) {
    const message = yield* Effect.promise(() =>
      rejectionMessage(() =>
        propertyTest(counterMachine, {
          adapter: {
            run: (request) =>
              Effect.runPromise(
                Effect.sync(() => {
                  request.createEvent('INC', 42)
                  return {
                    runs: 1,
                    exploration: {
                      configuredRuns: 1,
                      maximumSequenceLength: null,
                    },
                  }
                }),
              ),
          },
          events: { INC: fc.constant({}) },
          invariant: () => {},
        })
      )
    )

    yield* expect({ message }).toEqual({
      message:
        'Property event "INC" generated a non-object payload (42). Event payloads must be plain objects; use a `resolve` function to map generated values onto an event payload.',
    })
  })

  it('accepts an array-free plain object payload', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 4,
        numRuns: 5,
        maxCommands: 3,
        events: { INC: fc.record({}) },
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.runs).toBe(5)
  })

  it('rejects an array payload', function*({ expect }) {
    const message = yield* Effect.promise(() =>
      rejectionMessage(() =>
        propertyTest(counterMachine, {
          seed: 5,
          numRuns: 1,
          maxCommands: 2,
          events: { INC: { generate: fc.constant([1, 2]) } },
          invariant: () => {},
        })
      )
    )

    yield* expect({ message }).toEqual({
      message: expect.stringMatching(
        /^Property event case \["event-case","INC","default"\] generated a non-object payload \(1,2\)\. Event payloads must be plain objects; use a `resolve` function to map generated values onto an event payload\.$/,
      ),
    })
  })
})

describe('exploration metrics (STA-6403)', () => {
  it('counts executed commands only, not rejected precondition checks', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter([
          'check',
          'check',
          'check',
          'run',
          'check',
          'check',
          'check',
          'run',
        ]),
        events: { INC: fc.constant({}) },
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.exploration.maximumObservedSequenceLength).toBe(2)
  })

  it('reports `attemptedRuns` on the exploration output', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 7,
        numRuns: 5,
        maxCommands: 3,
        events: { INC: fc.record({}) },
        invariant: () => {},
      })
    )

    yield* expect({
      runs: result.coverage.runs,
      attemptedRuns: result.coverage.exploration.attemptedRuns,
      frontierAttemptedRuns: result.coverage.exploration.frontiers.reduce(
        (total, frontier) => total + frontier.attemptedRuns,
        0,
      ),
    }).toEqual({ runs: 5, attemptedRuns: 5, frontierAttemptedRuns: 5 })
  })
})

describe('replay (STA-6407)', () => {
  it('never masks the underlying failure with a fixture-construction error', function*({ expect }) {
    const failure = yield* rejectionOf(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        start: {
          snapshot: counterMachine.getInitialSnapshot(),
          serializeSnapshot: () => {
            throw new Error('serializeSnapshot exploded')
          },
        },
        invariant: ({ snapshot }) => {
          if (snapshot.context.count > 0) {
            throw new Error('count must stay at zero')
          }
        },
      })
    )

    const cause = failure instanceof ModelTestFailure ? failure.cause : undefined

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      causeMessage: cause instanceof Error ? cause.message : undefined,
      fixture: failure instanceof ModelTestFailure ? failure.fixture : 'not a ModelTestFailure',
    }).toEqual({
      isModelTestFailure: true,
      causeMessage: 'count must stay at zero',
      fixture: undefined,
    })
  })

  it('throws a plain error when a `start.serializeSnapshot` function is missing', function*({ expect }) {
    const message = yield* Effect.promise(() =>
      rejectionMessage(() =>
        propertyTest(counterMachine, {
          seed: 8,
          numRuns: 1,
          events: { INC: fc.record({}) },
          start: {
            snapshot: counterMachine.getInitialSnapshot(),
          } as unknown as ReplayStart,
          invariant: () => {},
        })
      )
    )

    yield* expect({ message }).toEqual({
      message: 'Property tests starting from a snapshot require a `start.serializeSnapshot` function',
    })
  })

  it('reproduces a reference-oracle divergence when `reference` is passed through', function*({ expect }) {
    const machine = createMachine({
      id: 'p0-reference',
      schemas: {
        context: types<{ count: number }>(),
        events: { ADD: types<{ value: number }>() },
      },
      context: { count: 0 },
      on: {
        ADD: ({ context, event }) => ({
          context: { count: context.count + event.value },
        }),
      },
    })
    const reference = {
      create: () => {
        let count = 0
        return {
          transition: (event: { value: number }) => {
            count += event.value + 1
          },
          read: () => count,
        }
      },
      projectModel: (snapshot: { context: { count: number } }) => snapshot.context.count,
    }

    const failure = yield* rejectionOf(() =>
      propertyTest(machine, {
        seed: 9,
        numRuns: 20,
        maxCommands: 4,
        events: { ADD: fc.record({ value: fc.integer({ min: 1, max: 5 }) }) },
        reference,
        invariant: () => {},
      })
    )

    const fixture = fixtureOf(failure)

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      fixture,
    }).toMatchObject({
      isModelTestFailure: true,
      fixture: { formatVersion: 2, machine: { id: 'p0-reference' } },
    })

    if (fixture === undefined) {
      throw new Error('expected the campaign to fail with a replay fixture')
    }

    const notReproduced = yield* rejectionOf(() => replayTest(machine, fixture, { invariant: () => {} }))

    yield* expect({
      isReplayNotReproducedError: notReproduced instanceof ReplayNotReproducedError,
      step: notReproduced instanceof ReplayNotReproducedError ? notReproduced.step : undefined,
      fixtureStep: fixture.failedAt,
      message: notReproduced instanceof Error ? notReproduced.message : undefined,
    }).toEqual({
      isReplayNotReproducedError: true,
      step: fixture.failedAt,
      fixtureStep: fixture.failedAt,
      message: `Property replay did not reproduce the recorded failure at step ${fixture.failedAt}`,
    })

    const replayFailure = yield* rejectionOf(() =>
      replayTest(machine, fixture, {
        invariant: () => {},
        reference,
      })
    )

    yield* expect({
      isModelTestFailure: replayFailure instanceof ModelTestFailure,
      cause: replayFailure instanceof ModelTestFailure ? replayFailure.cause : undefined,
    }).toMatchObject({
      isModelTestFailure: true,
      cause: { referenceMatches: false },
    })
  })

  it('reproduces an SUT divergence when `sut` is passed through', function*({ expect }) {
    const machine = createMachine({
      id: 'p0-sut',
      schemas: {
        context: types<{ count: number }>(),
        events: { ADD: types<{ value: number }>() },
      },
      context: { count: 0 },
      on: {
        ADD: ({ context, event }) => ({
          context: { count: context.count + event.value },
        }),
      },
    })
    const sut = {
      create: () => {
        let count = 0
        return {
          send: (event: { value: number }) => {
            count += event.value * 2
          },
          read: () => count,
        }
      },
      projectModel: (snapshot: { context: { count: number } }) => snapshot.context.count,
    }

    const failure = yield* rejectionOf(() =>
      propertyTest(machine, {
        seed: 10,
        numRuns: 20,
        maxCommands: 4,
        events: { ADD: fc.record({ value: fc.integer({ min: 1, max: 5 }) }) },
        sut,
        invariant: () => {},
      })
    )

    const fixture = fixtureOf(failure)

    yield* expect({
      isModelTestFailure: failure instanceof ModelTestFailure,
      fixture,
    }).toMatchObject({
      isModelTestFailure: true,
      fixture: { formatVersion: 2, machine: { id: 'p0-sut' } },
    })

    if (fixture === undefined) {
      throw new Error('expected the campaign to fail with a replay fixture')
    }

    const replayFailure = yield* rejectionOf(() =>
      replayTest(machine, fixture, {
        invariant: () => {},
        sut,
      })
    )

    yield* expect({
      isModelTestFailure: replayFailure instanceof ModelTestFailure,
      cause: replayFailure instanceof ModelTestFailure ? replayFailure.cause : undefined,
    }).toMatchObject({
      isModelTestFailure: true,
      cause: { sutMatches: false },
    })
  })
})

describe('defaultEquivalent (STA-6407)', () => {
  it('compares structurally, ignoring key order', function*({ expect }) {
    yield* expect({
      reorderedKeys: defaultEquivalent({ a: 1, b: 2 }, { b: 2, a: 1 }),
      extraUndefinedKey: defaultEquivalent({ a: 1 }, { a: 1, b: undefined }),
      nestedArrays: defaultEquivalent([1, [2, 3]], [1, [2, 3]]),
      reorderedArray: defaultEquivalent([1, 2], [2, 1]),
    }).toEqual({
      reorderedKeys: true,
      extraUndefinedKey: false,
      nestedArrays: true,
      reorderedArray: false,
    })
  })

  it('is cycle-safe', function*({ expect }) {
    const left: { name: string; self?: unknown } = { name: 'node' }
    left.self = left
    const right: { name: string; self?: unknown } = { name: 'node' }
    right.self = right

    const other: { name: string; self?: unknown } = { name: 'other' }
    other.self = other

    yield* expect({
      sameShapeCycles: defaultEquivalent(left, right),
      differentNames: defaultEquivalent(left, other),
    }).toEqual({ sameShapeCycles: true, differentNames: false })
  })

  it('handles values `JSON.stringify` cannot distinguish', function*({ expect }) {
    yield* expect({
      nan: defaultEquivalent(NaN, NaN),
      undefinedVersusNull: defaultEquivalent(undefined, null),
      equalDates: defaultEquivalent(
        DateTime.toDate(DateTime.makeUnsafe(0)),
        DateTime.toDate(DateTime.makeUnsafe(0)),
      ),
      differentDates: defaultEquivalent(
        DateTime.toDate(DateTime.makeUnsafe(0)),
        DateTime.toDate(DateTime.makeUnsafe(1)),
      ),
      reorderedSet: defaultEquivalent(new Set([1, 2]), new Set([2, 1])),
      equalMaps: defaultEquivalent(new Map([['a', 1]]), new Map([['a', 1]])),
      differentMapValues: defaultEquivalent(
        new Map([['a', 1]]),
        new Map([['a', 2]]),
      ),
    }).toEqual({
      nan: true,
      undefinedVersusNull: false,
      equalDates: true,
      differentDates: false,
      reorderedSet: true,
      equalMaps: true,
      differentMapValues: false,
    })
  })
})

describe('extractReplayPath (STA-6407)', () => {
  it('prefers the `metadataForReplay()` accessor', function*({ expect }) {
    const counterexample = {
      metadataForReplay: () => 'replayPath="AAAAA:H"',
      toString: () => 'cmd1,cmd2 /*replayPath="WRONG"*/',
    }

    yield* expect(extractReplayPath(counterexample)).toBe('AAAAA:H')
  })

  it('falls back to parsing `toString()`', function*({ expect }) {
    const counterexample = {
      toString: () => 'INC(),INC() /*replayPath="BBBB:C"*/',
    }

    yield* expect(extractReplayPath(counterexample)).toBe('BBBB:C')
  })

  it('returns undefined when no replay path is present', function*({ expect }) {
    yield* expect({
      undefinedArgument: extractReplayPath(undefined),
      nullArgument: extractReplayPath(null),
      noMetadata: extractReplayPath({ toString: () => 'INC(),INC()' }),
      emptyMetadata: extractReplayPath({
        metadataForReplay: () => '',
        toString: () => '',
      }),
    }).toEqual({
      undefinedArgument: undefined,
      nullArgument: undefined,
      noMetadata: undefined,
      emptyMetadata: undefined,
    })
  })

  it('matches the shape fast-check actually produces', function*({ expect }) {
    const arbitrary = fc.commands<{ ran: boolean }, undefined>([
      fc.constant({
        check: () => true,
        run: (model: { ran: boolean }) => {
          model.ran = true
        },
        toString: () => 'RUN()',
      }),
    ])
    const result = fc.check(
      fc.property(arbitrary, (generated) => {
        const model = { ran: false }
        fc.modelRun(() => ({ model, real: undefined }), generated)
        return !model.ran
      }),
      { seed: 12, numRuns: 50 },
    )

    const replayPath = extractReplayPath(result.counterexample?.[0])
    const replayPathIsString = typeof replayPath === 'string'

    yield* expect({
      failed: result.failed,
      replayPathIsString,
      replayPathIsNonEmpty: replayPathIsString && replayPath.length > 0,
      roundTrips: returned(() =>
        fc.commands(
          [fc.constant({ check: () => true, run: () => {} })],
          replayPath === undefined ? {} : {
            replayPath,
          },
        )
      ),
    }).toEqual({
      failed: true,
      replayPathIsString: true,
      replayPathIsNonEmpty: true,
      roundTrips: true,
    })
  })
})

describe('temporal coverage (STA-6400)', () => {
  it('reports a bounded `eventually` whose `within` bound was never reached as inconclusive', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'eventually',
            id: 'reach-fifty',
            within: 50,
            predicate: ({ snapshot }) => snapshot.context.count === 50,
          },
        ],
        invariant: () => {},
      })
    )

    yield* expect({
      inconclusive: result.coverage.temporal.inconclusive,
      satisfied: result.coverage.temporal.satisfied,
      failed: result.coverage.temporal.failed,
    }).toEqual({ inconclusive: ['reach-fifty'], satisfied: [], failed: [] })
  })

  it('reports a satisfied `eventually` as satisfied', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        adapter: scriptedAdapter(['check', 'run']),
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'eventually',
            id: 'reach-one',
            within: 50,
            predicate: ({ snapshot }) => snapshot.context.count === 1,
          },
        ],
        invariant: () => {},
      })
    )

    yield* expect({
      satisfied: result.coverage.temporal.satisfied,
      inconclusive: result.coverage.temporal.inconclusive,
      failed: result.coverage.temporal.failed,
    }).toEqual({ satisfied: ['reach-one'], inconclusive: [], failed: [] })
  })
})

describe('event descriptors', () => {
  it('accepts a descriptor that only sets `generate`', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 21,
        numRuns: 10,
        maxCommands: 4,
        events: { INC: { generate: fc.constant({}) } },
        invariant: () => {},
      })
    )

    yield* expect(coverage.generatedSteps).toBeGreaterThan(0)
  })

  it('still treats a bare arbitrary as a generator', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 21,
        numRuns: 10,
        maxCommands: 4,
        events: { INC: fc.constant({}) },
        invariant: () => {},
      })
    )

    yield* expect(coverage.generatedSteps).toBeGreaterThan(0)
  })
})
