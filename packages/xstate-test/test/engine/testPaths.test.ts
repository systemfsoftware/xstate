import { describe, it } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as graph from '../../src/engine/index.js'
import {
  formatTestCoverage,
  ModelTestFailure,
  propertyTest,
  replayTest,
  type TestFixture,
  testPaths,
} from '../../src/engine/index.js'
import { constant, randomAdapter } from './propertyTestAdapter.js'

const lightMachine = createMachine({
  id: 'light',
  initial: 'green',
  states: {
    green: { on: { NEXT: { target: 'yellow' } } },
    yellow: { on: { NEXT: { target: 'red' } } },
    red: {
      initial: 'walk',
      states: {
        walk: { on: { NEXT: { target: 'stop' } } },
        stop: { id: 'stopSign' },
      },
    },
  },
})

const captureFailure = (run: () => Promise<unknown>): Effect.Effect<ModelTestFailure> =>
  Effect.promise(() =>
    run().then(
      () => {
        throw new Error('expected a ModelTestFailure')
      },
      (error: unknown) => {
        if (error instanceof ModelTestFailure) {
          return error
        }
        throw error
      },
    )
  )

const rejection = <A>(run: () => Promise<A>): Effect.Effect<unknown> =>
  Effect.promise(() => run().then(() => undefined, (cause: unknown) => cause))

describe('`states` keys with a plain machine', () => {
  const recordStates = () => {
    const seen = new Set<string>()
    const states = Object.fromEntries(
      ['green', 'red', 'red.walk', '#stopSign', '*'].map((key) => [
        key,
        () => {
          seen.add(key)
        },
      ]),
    )
    return { seen, states }
  }

  it('runs value, nested value, and `#id` keys in propertyTest()', function*({ expect }) {
    const { seen, states } = recordStates()
    yield* Effect.promise(() =>
      propertyTest(lightMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 10, maxCommands: 4 }),
        events: { NEXT: constant({}) },
        states,
      })
    )

    yield* expect([...seen].sort()).toEqual(
      ['#stopSign', '*', 'green', 'red', 'red.walk'].sort(),
    )
  })

  it('runs them in testPaths(), top-level and on the session', function*({ expect }) {
    const topLevel = recordStates()
    yield* Effect.promise(() => testPaths(lightMachine, { states: topLevel.states }))
    const session = recordStates()
    yield* Effect.promise(() =>
      testPaths(lightMachine, {
        sut: { create: () => ({ send: () => {}, states: session.states }) },
      })
    )

    yield* expect({
      topLevelWalk: topLevel.seen.has('red.walk'),
      topLevelStopSign: topLevel.seen.has('#stopSign'),
      sessionGreen: session.seen.has('green'),
      sessionStopSign: session.seen.has('#stopSign'),
    }).toEqual({
      topLevelWalk: true,
      topLevelStopSign: true,
      sessionGreen: true,
      sessionStopSign: true,
    })
  })

  it('runs them in replayTest()', function*({ expect }) {
    let invariantSawRedStop = false
    const failure = yield* captureFailure(() =>
      propertyTest(lightMachine, {
        adapter: randomAdapter({ seed: 3, numRuns: 20, maxCommands: 5 }),
        events: { NEXT: constant({}) },
        invariant: ({ snapshot }) => {
          if (snapshot.matches('red.stop')) {
            invariantSawRedStop = true
            throw new Error('reached red.stop')
          }
        },
      })
    )
    const { seen, states } = recordStates()
    yield* Effect.promise(() =>
      replayTest(lightMachine, failure.fixture!, {
        states,
        expect: 'pass',
      })
    )

    yield* expect({
      invariantSawRedStop,
      redWalk: seen.has('red.walk'),
      stopSign: seen.has('#stopSign'),
    }).toEqual({ invariantSawRedStop: true, redWalk: true, stopSign: true })
  })
})

describe('testPaths() follows the planned path', () => {
  const raceMachine = createMachine({
    id: 'race',
    initial: 's',
    states: {
      s: { after: { 100: { target: 'x' }, 200: { target: 'y' } } },
      x: {},
      y: {},
    },
  })

  it('offers only the timer that is due first', function*({ expect }) {
    const observed: unknown[] = []
    for (const mode of ['pure', 'executed'] as const) {
      const { coverage, results } = yield* Effect.promise(() => testPaths(raceMachine, { mode }))
      observed.push({
        mode,
        allPassed: results.every(({ passed }) => passed),
        containsY: results.map(({ path }) => path.state.value).includes('y'),
        uncovered: coverage.transitions.uncovered,
      })
    }

    yield* expect(observed).toEqual([
      {
        mode: 'pure',
        allPassed: true,
        containsY: false,
        uncovered: ['["transition","race.s","xstate.after",1]'],
      },
      {
        mode: 'executed',
        allPassed: true,
        containsY: false,
        uncovered: ['["transition","race.s","xstate.after",1]'],
      },
    ])
  })

  it('fails a path the run departs from', function*({ expect }) {
    const failure = yield* captureFailure(() =>
      testPaths(raceMachine, {
        mode: 'executed',
        fromEvents: [
          { type: 'xstate.after', delay: 200, stateId: 'race.s' } as never,
        ],
      })
    )

    yield* expect(failure.summary).toBe(
      'Path 1 (xstate.after) failed: path diverged at step 1: expected {"value":"y","context":{}}, got {"value":"x","context":{}}',
    )
  })

  it('fails instead of skipping an event that is no longer applicable', function*({ expect }) {
    const failure = yield* captureFailure(() =>
      testPaths(lightMachine, {
        events: { NEXT: { generate: () => ({}), when: () => false } },
        paths: [
          {
            state: lightMachine.resolveState({ value: 'yellow' }) as never,
            steps: [
              {
                state: lightMachine.resolveState({ value: 'green' }) as never,
                event: { type: '@xstate.init' } as never,
              },
              {
                state: lightMachine.resolveState({ value: 'yellow' }) as never,
                event: { type: 'NEXT' },
              },
            ],
            weight: 1,
          },
        ],
      })
    )

    yield* expect(failure.summary).toMatch(
      /^Path 1 \(NEXT\) failed: path diverged at step 1: NEXT could not be sent/,
    )
  })

  it('counts time spent in enclosing states towards nested timers', function*({ expect }) {
    const nestedMachine = createMachine({
      id: 'nested',
      initial: 'p',
      states: {
        p: {
          initial: 'a',
          after: { 200: { target: 'done' } },
          states: {
            a: { after: { 100: { target: 'b' } } },
            b: { after: { 150: { target: 'c' } } },
            c: {},
          },
        },
        done: {},
      },
    })
    const advances: number[][] = []
    const { coverage, results } = yield* Effect.promise(() =>
      testPaths(nestedMachine, {
        mode: 'executed',
        collect: (trace) => {
          advances.push(
            trace.commands.flatMap((command) => command.type === 'advance' ? [command.milliseconds] : []),
          )
        },
      })
    )

    yield* expect({
      allPassed: results.every(({ passed }) => passed),
      pathValues: results.map(({ path }) => path.state.value),
      advanceSteps: advances,
      uncovered: coverage.transitions.uncovered,
    }).toEqual({
      allPassed: true,
      pathValues: expect.not.arrayContaining([{ p: 'c' }]),
      advanceSteps: expect.arrayContaining([[100, 100]]),
      uncovered: ['["transition","nested.p.b","xstate.after",0]'],
    })
  })
})

describe('testPaths() with invoke sources', () => {
  const fetchMachine = (fetcher?: unknown) =>
    createMachine({
      id: 'fetch',
      schemas: { events: { FETCH: types<{}>() } },
      ...(Boolean(fetcher) ? { actors: { fetcher: fetcher as never } } : {}),
      initial: 'idle',
      states: {
        idle: { on: { FETCH: { target: 'loading' } } },
        loading: {
          invoke: {
            src: 'fetcher',
            onDone: { target: 'success' },
            onError: { target: 'failure' },
          },
        },
        success: {},
        failure: {},
      },
    })

  it('needs no implementation for a source named in `outcomes`', function*({ expect }) {
    const outcomes = {
      fetcher: () => ({ ok: true as const, output: 1 }),
    }
    const passed: boolean[] = []
    for (const mode of ['pure', 'executed'] as const) {
      const { results } = yield* Effect.promise(() =>
        testPaths(fetchMachine(), {
          mode,
          events: { FETCH: () => ({}) },
          outcomes,
        })
      )
      passed.push(results.every(({ passed }) => passed))
    }

    yield* expect(passed).toEqual([true, true])
  })

  it('records stubbed sources in the fixture, resolved or not', function*({ expect }) {
    const machine = fetchMachine(createAsyncLogic({ run: () => Promise.resolve('real') }))
    const createSut = () => {
      let sent = false
      return {
        create: () => ({
          send: () => {
            sent = true
          },
          read: () => (sent ? 'success' : 'idle'),
        }),
        projectModel: (snapshot: { value: unknown }) => snapshot.value,
      }
    }
    const failure = yield* captureFailure(() =>
      testPaths(machine, {
        mode: 'executed',
        events: { FETCH: () => ({}) },
        sut: createSut(),
      })
    )
    const fixture = JSON.parse(JSON.stringify(failure.fixture)) as TestFixture
    const replayOutcome = yield* rejection(() => replayTest(machine, fixture, { sut: createSut() }))

    yield* expect({
      stubs: failure.fixture?.stubs,
      replayOutcome,
    }).toEqual({ stubs: ['fetcher'], replayOutcome: expect.any(ModelTestFailure) })
  })

  it('records synthesized errors as portable data', function*({ expect }) {
    let invariantSawFailure = false
    const failure = yield* captureFailure(() =>
      testPaths(fetchMachine(), {
        events: { FETCH: () => ({}) },
        outcomes: { fetcher: () => ({ ok: true as const, output: 1 }) },
        invariant: ({ snapshot }) => {
          if (snapshot.value === 'failure') {
            invariantSawFailure = true
            throw new Error('reached failure')
          }
        },
      })
    )
    const errorEvent = failure.fixture!.timeline.find(
      (entry) =>
        entry.command.type === 'event' &&
        entry.command.event.type === 'xstate.error.actor',
    )!.command as unknown as { event: { error: unknown } }

    yield* expect({
      error: errorEvent.event.error,
      invariantSawFailure,
    }).toEqual({
      error: { xstate$$error: true, name: 'Error', message: 'generated failure' },
      invariantSawFailure: true,
    })

    const fixture = JSON.parse(JSON.stringify(failure.fixture)) as TestFixture
    let replayedSawFailure = false
    const failureAgain = yield* captureFailure(() =>
      replayTest(
        fetchMachine(createAsyncLogic({ run: () => Promise.resolve(1) })),
        fixture,
        {
          invariant: ({ snapshot }) => {
            if (snapshot.value === 'failure') {
              replayedSawFailure = true
              throw new Error('reached failure')
            }
          },
        },
      )
    )
    const replayed = failureAgain.trace.steps.at(-1)!.event as unknown as {
      error: unknown
    }

    yield* expect({
      error: replayed.error,
      message: replayed.error instanceof Error ? replayed.error.message : undefined,
      replayedSawFailure,
    }).toEqual({ error: expect.any(Error), message: 'generated failure', replayedSawFailure: true })
  })
})

describe('testPaths() traversal bound', () => {
  it('names `limit` and `serializeState` when the context is unbounded', function*({ expect }) {
    const counterMachine = createMachine({
      schemas: { context: types<{ count: number }>() },
      context: { count: 0 },
      on: {
        INC: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })

    const limited = yield* rejection(() => testPaths(counterMachine, { limit: 500 }))

    yield* expect({ message: limited instanceof Error ? limited.message : undefined }).toEqual({
      message: expect.stringMatching(/exceeded `limit` \(500 traversal steps\).*`serializeState`/),
    })

    const unbounded = yield* rejection(() => testPaths(counterMachine))

    yield* expect({ message: unbounded instanceof Error ? unbounded.message : undefined }).toEqual({
      message: expect.stringMatching(/exceeded `limit` \(10000 traversal steps\)/),
    })

    const { results } = yield* Effect.promise(() =>
      testPaths(counterMachine, {
        stopWhen: (snapshot) => snapshot.context.count >= 3,
      })
    )

    yield* expect(results.length).toEqual(1)
  })
})

describe('executed-mode settling', () => {
  const tickMachine = (delay: number) =>
    createMachine({
      id: 'tick',
      schemas: { events: { START: types<{}>() } },
      actors: {
        tick: createAsyncLogic({
          run: () => Effect.runPromise(Effect.as(Effect.sleep(delay), 1)),
        }),
      },
      initial: 'idle',
      states: {
        idle: { on: { START: { target: 'running' } } },
        running: { invoke: { src: 'tick', onDone: { target: 'done' } } },
        done: {},
      },
    })

  interface TickObservation {
    readonly finalValue: unknown
    readonly timelineKinds: readonly unknown[]
    readonly pendingActors: number | undefined
  }

  const runOnce = (delay: number) =>
    Effect.promise(() => {
      const observations: TickObservation[] = []
      return propertyTest(tickMachine(delay), {
        adapter: randomAdapter({ seed: 5, numRuns: 1, maxCommands: 1 }),
        mode: 'executed',
        events: { START: constant({}) },
        collect: (trace) => {
          const entry = trace.timeline.find((candidate) => candidate.kind === 'event')
          observations.push({
            finalValue: trace.finalSnapshot.value,
            timelineKinds: trace.timeline.map((traceEntry) => traceEntry.kind),
            pendingActors: entry !== undefined && 'pendingActors' in entry
              ? entry.pendingActors.length
              : undefined,
          })
        },
      }).then(({ coverage }) => {
        const observation = observations[0]
        if (observation === undefined) {
          throw new Error('expected a collected trace')
        }
        return { coverage, observation }
      })
    })

  it('settles a `setTimeout(0)` service within the step that started it', function*({ expect }) {
    const first = yield* runOnce(0)
    const second = yield* runOnce(0)

    yield* expect({
      firstFinal: first.observation.finalValue,
      firstPendingSteps: first.coverage.exploration.pendingActorSteps,
      secondFinal: second.observation.finalValue,
      secondPendingSteps: second.coverage.exploration.pendingActorSteps,
      firstTimelineKinds: first.observation.timelineKinds,
    }).toEqual({
      firstFinal: 'done',
      firstPendingSteps: 0,
      secondFinal: 'done',
      secondPendingSteps: 0,
      firstTimelineKinds: second.observation.timelineKinds,
    })
  })

  it('reports a service still in flight when the step settles', function*({ expect }) {
    const { coverage, observation } = yield* runOnce(200)

    yield* expect({
      final: observation.finalValue,
      pendingActorSteps: coverage.exploration.pendingActorSteps,
      pendingActors: observation.pendingActors,
    }).toEqual({ final: 'running', pendingActorSteps: 1, pendingActors: 1 })
  })
})

describe('testPaths() coverage report', () => {
  it('reports that every path ran, without truncation or placeholders', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() => testPaths(lightMachine))
    const report = formatTestCoverage(coverage)

    yield* expect({
      stoppedBecause: coverage.exploration.stoppedBecause,
      truncated: coverage.exploration.truncated,
      mentionsStoppedBecause: report.includes('stopped because: paths'),
      mentionsTruncated: report.includes('truncated'),
      mentionsRuntime: report.includes('(runtime'),
      mentionsStatesSummary: report.includes(
        'states: 4/4 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
      ),
    }).toEqual({
      stoppedBecause: 'paths',
      truncated: false,
      mentionsStoppedBecause: true,
      mentionsTruncated: false,
      mentionsRuntime: false,
      mentionsStatesSummary: true,
    })
  })
})

describe('failure messages', () => {
  it('lead with the path, then the fixture line, then the trace', function*({ expect }) {
    const failure = yield* captureFailure(() =>
      testPaths(lightMachine, {
        states: {
          'red.walk': () => {
            throw new Error('no walking')
          },
        },
      })
    )

    yield* expect(failure.message).toEqual(
      `Path 1 (NEXT → NEXT → NEXT) failed: state assertion failed after 2 steps: no walking
Fixture: failure.fixture (replayTest)

start {"value":"green","context":{}}
1. generator NEXT -> {"value":"yellow","context":{}}
2. generator NEXT -> {"value":{"red":"walk"},"context":{}}`,
    )
  })

  it('label timers and outcomes, and honor `formatSnapshot`', function*({ expect }) {
    const machine = createMachine({
      id: 'order',
      schemas: { events: { PAY: types<{}>() } },
      initial: 'idle',
      states: {
        idle: { on: { PAY: { target: 'paying' } } },
        paying: {
          invoke: { src: 'charge', onDone: { target: 'paid' } },
        },
        paid: { after: { 1000: { target: 'archived' } } },
        archived: {},
      },
    })
    const failure = yield* captureFailure(() =>
      testPaths(machine, {
        mode: 'executed',
        events: { PAY: () => ({}) },
        outcomes: { charge: () => ({ ok: true as const, output: 'ch_1' }) },
        formatSnapshot: (snapshot) => snapshot.value,
        states: {
          archived: () => {
            throw new Error('archived too early')
          },
        },
      })
    )

    yield* expect(failure.message).toEqual(
      `Path 1 (PAY → xstate.done.actor → xstate.after) failed: state assertion failed after 3 steps: archived too early
Fixture: failure.fixture (replayTest)

start "idle"
1. generator PAY -> "paying"
2. outcome charge {"ok":true,"output":"ch_1"} -> "paid"
   ↳ outcome xstate.done.actor {"output":"ch_1","actorId":"0.order.paying"} -> "paid"
3. timer advance 1000ms -> "archived"
   ↳ timer xstate.after.1000.order.paid -> "archived"`,
    )
  })
})

describe('engine exports', () => {
  it('does not export internal helpers', function*({ expect }) {
    const internalHelpers = [
      'fnv1a',
      'createSeededRng',
      'assertNotTestParam',
      'PropertyOutcomeRegistry',
    ]

    yield* expect(internalHelpers.map((name) => name in graph)).toEqual([false, false, false, false])
  })
})

describe('pre-2.0 option shape', () => {
  it('accepts `(rng) => payload` generators with top-level `states` and no `sut`', function*({ expect }) {
    const seen: string[] = []
    yield* Effect.promise(() =>
      testPaths(lightMachine, {
        events: { NEXT: () => ({}) },
        states: {
          yellow: () => {
            seen.push('yellow')
          },
        },
      })
    )

    yield* expect(seen).toContain('yellow')
  })

  it('still explains an executor passed as a generator', function*({ expect }) {
    const error = yield* rejection(() =>
      testPaths(lightMachine, {
        events: { NEXT: (() => {}) as never },
        states: { yellow: () => {} },
      })
    )

    yield* expect({ message: error instanceof Error ? error.message : undefined }).toEqual({
      message: expect.stringMatching(/pre-2\.0 event executor/),
    })
  })
})
