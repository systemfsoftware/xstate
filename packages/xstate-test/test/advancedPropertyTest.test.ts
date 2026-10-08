import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, SimulatedClock, types } from '@systemfsoftware/xstate'
import type { EventObject, Snapshot } from '@systemfsoftware/xstate'
import { getShortestPaths } from '@systemfsoftware/xstate/graph'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import type { TestAdapterRequest, TestAdapterResult } from '../src/engine/index.js'
import { ModelTestFailure, propertyTest, replayTest } from '../src/index.js'
import type { TestAdapter } from '../src/index.js'

const rejectionOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the operation to fail')
    },
    (error: unknown) => error,
  )

describe('advanced property testing', () => {
  it('records exact parallel, guarded, and eventless transitions', function*({ expect }) {
    const machine = createMachine({
      id: 'topology',
      schemas: {
        events: {
          GO: types<{ allow: boolean }>(),
          NEXT: types<{}>(),
          UNUSED: types<{}>(),
        },
      },
      type: 'parallel',
      states: {
        left: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                GO: ({ event }) => event.allow ? { target: 'allowed' } : undefined,
                UNUSED: { target: 'idle' },
              },
            },
            allowed: {},
            unreachable: { on: { NEXT: { target: 'unreachable' } } },
          },
        },
        right: {
          initial: 'idle',
          states: {
            idle: { on: { GO: { target: 'settling' } } },
            settling: { always: { target: 'done' } },
            done: {},
          },
        },
      },
    })

    const result = yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 21,
        numRuns: 50,
        maxCommands: 1,
        events: {
          GO: fc.record({ allow: fc.boolean() }),
          NEXT: fc.constant({}),
        },
        invariant: () => {},
      })
    )

    const coverage = result.coverage
    const goTransitions = coverage.transitions.covered.filter((id) => id.includes('GO'))
    yield* expect({
      goTransitionCount: goTransitions.length,
      coveredTransitions: coverage.transitions.covered,
      unknownStateNodes: coverage.stateNodes.unknown,
      uncoveredTransitions: coverage.transitions.uncovered,
      unknownTransitions: coverage.transitions.unknown,
      unknownStates: coverage.states.unknown,
    }).toEqual({
      goTransitionCount: 2,
      coveredTransitions: expect.arrayContaining([
        expect.stringContaining('@eventless'),
      ]),
      unknownStateNodes: expect.arrayContaining([
        'topology.left.unreachable',
      ]),
      uncoveredTransitions: expect.arrayContaining([
        expect.stringContaining('UNUSED'),
      ]),
      unknownTransitions: expect.arrayContaining([
        expect.stringContaining('NEXT'),
      ]),
      unknownStates: expect.arrayContaining([
        '(runtime serialized states)',
      ]),
    })
  })

  it('reports statically unreachable state nodes and transitions', function*({ expect }) {
    const machine = createMachine({
      id: 'topology',
      schemas: {
        events: {
          GO: types<{}>(),
          NEXT: types<{}>(),
          UNUSED: types<{}>(),
        },
      },
      type: 'parallel',
      states: {
        left: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                GO: { target: 'allowed' },
                UNUSED: { target: 'idle' },
              },
            },
            allowed: {},
            unreachable: { on: { NEXT: { target: 'unreachable' } } },
          },
        },
        right: {
          initial: 'idle',
          states: {
            idle: { on: { GO: { target: 'settling' } } },
            settling: { always: { target: 'done' } },
            done: {},
          },
        },
      },
    })

    const result = yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 21,
        numRuns: 20,
        maxCommands: 1,
        events: {
          GO: fc.constant({}),
          NEXT: fc.constant({}),
        },
        invariant: () => {},
      })
    )

    const coverage = result.coverage
    yield* expect({
      unreachableStateNodes: coverage.stateNodes.unreachable,
      uncoveredTransitions: coverage.transitions.uncovered,
      unreachableTransitions: coverage.transitions.unreachable,
      unknownTransitions: coverage.transitions.unknown,
    }).toEqual({
      unreachableStateNodes: expect.arrayContaining([
        'topology.left.unreachable',
      ]),
      uncoveredTransitions: expect.arrayContaining([
        expect.stringContaining('UNUSED'),
      ]),
      unreachableTransitions: expect.arrayContaining([
        expect.stringContaining('NEXT'),
      ]),
      unknownTransitions: [],
    })
  })

  it('separates supplied event cases, event types, and exploration bounds', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: { RUN: types<{}>(), BLOCKED: types<{}>() },
      },
      on: {
        RUN: {},
        BLOCKED: {},
      },
    })

    const result = yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 31,
        numRuns: 50,
        maxCommands: 2,
        events: {
          RUN: {
            case: 'applicable',
            generate: fc.constant({}),
            when: () => true,
          },
          BLOCKED: {
            case: 'disabled',
            generate: fc.constant({}),
            when: () => false,
          },
        },
        invariant: () => {},
      })
    )

    const coverage = result.coverage
    const applicable = coverage.eventCases[
      JSON.stringify(['event-case', 'RUN', 'applicable'])
    ]
    const disabled = coverage.eventCases[
      JSON.stringify(['event-case', 'BLOCKED', 'disabled'])
    ]
    if (applicable === undefined || disabled === undefined) {
      throw new Error('expected RUN and BLOCKED event case coverage')
    }
    yield* expect({
      applicable: {
        generatedPositive: applicable.generated > 0,
        ignored: applicable.ignored,
      },
      applicableCounts: {
        applicable: applicable.applicable,
        executed: applicable.executed,
      },
      disabled: {
        generatedPositive: disabled.generated > 0,
        applicable: disabled.applicable,
        executed: disabled.executed,
        ignored: disabled.ignored,
      },
      eventTypes: {
        runPositive: (coverage.eventTypes.counts['RUN'] ?? 0) > 0,
        blockedCounted: 'BLOCKED' in coverage.eventTypes.counts,
      },
      exploration: coverage.exploration,
      maximumObservedSequenceLengthPositive: coverage.exploration.maximumObservedSequenceLength > 0,
      truncationReasons: coverage.exploration.truncationReasons,
    }).toMatchObject({
      applicable: {
        generatedPositive: true,
        ignored: 0,
      },
      applicableCounts: {
        applicable: applicable.generated,
        executed: applicable.generated,
      },
      disabled: {
        generatedPositive: true,
        applicable: 0,
        executed: 0,
        ignored: disabled.generated,
      },
      eventTypes: { runPositive: true, blockedCounted: false },
      exploration: {
        configuredRuns: 50,
        completedRuns: 50,
        attemptedRuns: 50,
        maximumSequenceLength: 2,
        truncated: true,
        frontiers: [
          {
            prefixLength: 0,
            runBudget: null,
            configuredRuns: 50,
            completedRuns: 50,
            attemptedRuns: 50,
          },
        ],
        seeds: [{ engine: 'fast-check', seed: 31 }],
      },
      maximumObservedSequenceLengthPositive: true,
      truncationReasons: expect.arrayContaining([
        'maximum sequence length reached',
      ]),
    })
  })

  it('tracks multiple named behavioral cases for one event type', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: { UPDATE: types<{ value: number }>() },
      },
      on: { UPDATE: {} },
    })

    const result = yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 7,
        numRuns: 100,
        maxCommands: 3,
        events: {
          UPDATE: [
            {
              case: 'positive',
              generate: fc.constant({ value: 1 }),
            },
            {
              case: 'negative-disabled',
              generate: fc.constant({ value: -1 }),
              when: () => false,
            },
          ],
        },
        invariant: () => {},
      })
    )

    const coverage = result.coverage
    const positive = coverage.eventCases[
      JSON.stringify(['event-case', 'UPDATE', 'positive'])
    ]
    const disabled = coverage.eventCases[
      JSON.stringify(['event-case', 'UPDATE', 'negative-disabled'])
    ]
    if (positive === undefined || disabled === undefined) {
      throw new Error('expected UPDATE positive/disabled event case coverage')
    }
    yield* expect({
      positive: {
        generatedPositive: positive.generated > 0,
        counts: {
          applicable: positive.applicable,
          executed: positive.executed,
        },
      },
      disabled: {
        generatedPositive: disabled.generated > 0,
        executed: disabled.executed,
        ignored: disabled.ignored,
      },
    }).toEqual({
      positive: {
        generatedPositive: true,
        counts: {
          applicable: positive.generated,
          executed: positive.generated,
        },
      },
      disabled: {
        generatedPositive: true,
        executed: 0,
        ignored: disabled.generated,
      },
    })
  })

  it('rejects duplicate named cases for one event type', function*({ expect }) {
    const machine = createMachine({
      schemas: { events: { GO: types<{}>() } },
      on: { GO: {} },
    })

    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          events: {
            GO: [
              { case: 'same', generate: fc.constant({}) },
              { case: 'same', generate: fc.constant({}) },
            ],
          },
          invariant: () => {},
        }),
      )
    )) as Error
    yield* expect(failure.message).toMatch(
      'Property event case "same" is duplicated for "GO"',
    )
  })

  it('shrinks symbolic references resolved from earlier model state', function*({ expect }) {
    const machine = createMachine({
      id: 'symbolic-resources',
      schemas: {
        context: types<{ ids: string[]; used?: string }>(),
        events: {
          CREATE: types<{ id: string }>(),
          USE: types<{ id: string }>(),
        },
      },
      context: { ids: [] },
      on: {
        CREATE: ({ context, event }) => ({
          context: { ...context, ids: [...context.ids, event.id] },
        }),
        USE: ({ context, event }) => ({
          context: { ...context, used: event.id },
        }),
      },
    })

    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          seed: 19,
          numRuns: 500,
          maxCommands: 5,
          events: {
            CREATE: fc.constant({ id: 'created' }),
            USE: {
              case: 'existing-resource',
              generate: fc.nat(),
              resolve: ({ snapshot, generated }) => {
                if (snapshot.context.ids.length === 0) {
                  return undefined
                }
                const index = (generated as number) % snapshot.context.ids.length
                const id = snapshot.context.ids[index]
                if (id === undefined) {
                  return undefined
                }
                return { id }
              },
            },
          },
          invariant: ({ event }) => {
            if (event?.type === 'USE') {
              throw new Error('capture symbolic trace')
            }
          },
        }),
      )
    )) as ModelTestFailure

    yield* expect({
      failure,
      events: failure.trace.events,
      commands: failure.fixture?.timeline.map((entry) => entry.command),
    }).toEqual({
      failure: expect.any(ModelTestFailure),
      events: [
        { type: 'CREATE', id: 'created' },
        { type: 'USE', id: 'created' },
      ],
      commands: [
        expect.objectContaining({ event: { type: 'CREATE', id: 'created' } }),
        expect.objectContaining({ event: { type: 'USE', id: 'created' } }),
      ],
    })

    const replayFailure = yield* Effect.promise(() =>
      rejectionOf(
        replayTest(machine, failure.fixture!, {
          invariant: ({ event }) => {
            if (event?.type === 'USE') {
              throw new Error('portable replay')
            }
          },
        }),
      )
    )
    yield* expect({ replayFailure }).toEqual({
      replayFailure: expect.any(ModelTestFailure),
    })
  })

  it('covers dynamic transition definitions', function*({ expect }) {
    const machine = createMachine({
      id: 'dynamic',
      schemas: {
        events: { MOVE: types<{ target: 'left' | 'right' }>() },
      },
      initial: 'start',
      states: {
        start: {
          on: {
            MOVE: ({ event }) => ({ target: event.target }),
          },
        },
        left: {},
        right: {},
      },
    })

    const result = yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 17,
        numRuns: 50,
        maxCommands: 1,
        events: {
          MOVE: fc.record({ target: fc.constantFrom('left', 'right') }),
        },
        invariant: () => {},
      })
    )

    const coverage = result.coverage
    const id = coverage.transitions.covered.find((id) => id.includes('MOVE'))
    yield* expect({
      moveId: id,
      unknownExcludesMoveId: coverage.transitions.unknown.every(
        (unknownId) => unknownId !== id,
      ),
    }).toEqual({
      moveId: expect.stringContaining('MOVE'),
      unknownExcludesMoveId: true,
    })
  })

  it('keeps SCXML macrostep transition coverage distinct from visitation', function*({ expect }) {
    const machine = createMachine({
      id: 'macrostep',
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b' } } },
        b: { always: { target: 'c' } },
        c: {},
      },
    })

    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          seed: 1,
          numRuns: 10,
          maxCommands: 1,
          events: { GO: fc.constant({}) },
          invariant: ({ event }) => {
            if (event?.type === 'GO') {
              throw new Error('capture')
            }
          },
        }),
      )
    )) as ModelTestFailure

    const firstStep = failure.trace.steps[0]
    if (firstStep === undefined) {
      throw new Error('expected a first trace step')
    }
    yield* expect({
      stepCount: failure.trace.steps.length,
      transitionIdCount: firstStep.transitionIds.length,
      transitionIdsAreStrings: firstStep.transitionIds.every(
        (transitionId) => typeof transitionId === 'string',
      ),
      activeStateIds: firstStep.activeStateIds,
    }).toEqual({
      stepCount: 1,
      transitionIdCount: 2,
      transitionIdsAreStrings: true,
      activeStateIds: expect.arrayContaining(['macrostep.c']),
    })
  })

  it('selects frontiers, applies per-frontier budgets, and preserves prefixes while shrinking', function*({ expect }) {
    const machine = createMachine({
      id: 'frontiers',
      schemas: {
        context: types<{ count: number }>(),
        events: {
          ACTIVATE: types<{}>(),
          INC: types<{ value: number }>(),
        },
      },
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: { on: { ACTIVATE: { target: 'active' } } },
        active: {
          on: {
            INC: ({ context, event }) => ({
              context: { count: context.count + event.value },
            }),
          },
        },
      },
    })
    const model = machine
    const frontiers = getShortestPaths(machine, {
      events: [{ type: 'ACTIVATE' }],
      serializeState: (snapshot) => JSON.stringify(snapshot.value),
    }).filter(
      (path) =>
        path.steps.filter(
            (step) => (step.event.type as string) !== '@xstate.init',
          ).length === 1 &&
        path.steps.some((step) => step.event.type === 'ACTIVATE'),
    )

    const successful = yield* Effect.promise(() =>
      propertyTest(model, {
        seed: 3,
        numRuns: 100,
        maxCommands: 1,
        frontiers: {
          paths: frontiers,
          select: ({ index }) => index === 0,
          runsPerFrontier: 3,
        },
        events: { INC: fc.constant({ value: 0 }) },
        invariant: () => {},
      })
    )
    yield* expect({
      runs: successful.coverage.runs,
      prefixSteps: successful.coverage.prefixSteps,
      coveredFrontiers: successful.coverage.frontiers.covered,
    }).toEqual({
      runs: 3,
      prefixSteps: 3,
      coveredFrontiers: [expect.any(String)],
    })

    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(model, {
          seed: 9,
          numRuns: 100,
          maxCommands: 8,
          frontiers: { paths: frontiers, runsPerFrontier: 100 },
          events: { INC: fc.record({ value: fc.integer({ min: 1, max: 20 }) }) },
          invariant: ({ snapshot }) => {
            const count = snapshot.context.count
            if (!(count < 1)) {
              throw new Error(
                `the model count reached ${count}, expected fewer than 1`,
              )
            }
          },
        }),
      )
    )) as ModelTestFailure

    const firstTimelineEntry = failure.fixture?.timeline[0]
    if (firstTimelineEntry === undefined) {
      throw new Error('expected a first timeline entry')
    }
    const incEventCase = failure.coverage?.eventCases[
      JSON.stringify(['event-case', 'INC', 'default'])
    ]
    if (incEventCase === undefined) {
      throw new Error('expected the INC event case coverage')
    }
    yield* expect({
      prefixEvents: failure.trace.prefixEvents,
      eventCount: failure.trace.events.length,
      firstCommand: firstTimelineEntry.command,
      lastCommand: failure.fixture?.timeline.at(-1)?.command,
      exploration: failure.coverage?.exploration,
      incExecutedPositive: (incEventCase.executed ?? 0) > 0,
      failureMessage: failure.message,
    }).toMatchObject({
      prefixEvents: [{ type: 'ACTIVATE' }],
      eventCount: 1,
      firstCommand: {
        type: 'event',
        phase: 'prefix',
        event: { type: 'ACTIVATE' },
      },
      lastCommand: {
        caseId: JSON.stringify(['event-case', 'INC', 'default']),
      },
      exploration: {
        configuredRuns: 100,
        maximumSequenceLength: 8,
        truncated: true,
      },
      incExecutedPositive: true,
      failureMessage: expect.stringContaining('expected fewer than 1'),
    })
  })

  it('shrinks independent reference divergence with model, reference, and SUT observations', function*({ expect }) {
    const machine = createMachine({
      id: 'reference',
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

    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          seed: 11,
          numRuns: 50,
          maxCommands: 8,
          events: { ADD: fc.record({ value: fc.integer({ min: 1, max: 50 }) }) },
          reference: {
            create: () => {
              let count = 0
              return {
                transition: (event) => {
                  count += event.value + 1
                },
                read: () => count,
              }
            },
            projectModel: (snapshot) => snapshot.context.count,
          },
          sut: {
            create: () => {
              let count = 0
              return {
                send: (event) => {
                  count += event.value
                },
                read: () => count,
              }
            },
            projectModel: (snapshot) => snapshot.context.count,
          },
          invariant: () => {},
        }),
      )
    )) as ModelTestFailure

    const cause = failure.cause as {
      model: number
      reference: { model: number; observed: number }
      sut: { model: number; observed: number }
      referenceMatches: boolean
      sutMatches: boolean
    }
    const observation = failure.trace.timeline.at(-1)?.observation as {
      model: number
      reference: { model: number; observed: number }
      sut: { model: number; observed: number }
    }
    yield* expect({
      failure,
      events: failure.trace.events,
      cause,
      observation,
      observationHasOracle: 'oracle' in observation,
      referenceObservedDiffers: cause.reference.observed !== cause.reference.model,
      sutObservedVsModel: {
        observed: cause.sut.observed,
        model: cause.sut.model,
      },
      referenceModelVsModel: {
        reference: cause.reference.model,
        model: cause.model,
      },
      observationReferenceDiffers: observation.reference.observed !== observation.reference.model,
      observationSutVsModel: {
        observed: observation.sut.observed,
        model: observation.sut.model,
      },
    }).toMatchObject({
      failure: expect.any(ModelTestFailure),
      events: [expect.any(Object)],
      cause: {
        model: expect.any(Number),
        reference: {
          model: expect.any(Number),
          observed: expect.any(Number),
        },
        sut: {
          model: expect.any(Number),
          observed: expect.any(Number),
        },
        referenceMatches: false,
        sutMatches: true,
      },
      observation: {
        model: expect.any(Number),
        reference: {
          model: expect.any(Number),
          observed: expect.any(Number),
        },
        sut: {
          model: expect.any(Number),
          observed: expect.any(Number),
        },
      },
      observationHasOracle: false,
      referenceObservedDiffers: true,
      sutObservedVsModel: {
        observed: cause.sut.model,
        model: cause.sut.model,
      },
      referenceModelVsModel: {
        reference: cause.model,
        model: cause.model,
      },
      observationReferenceDiffers: true,
      observationSutVsModel: {
        observed: observation.sut.model,
        model: observation.sut.model,
      },
    })
  })

  it('replays temporal failures and chronological runtime commands portably', function*({ expect }) {
    const machine = createMachine({
      id: 'timeline',
      version: '1',
      schemas: {
        context: types<{ ticks: number }>(),
        events: { GO: types<{}>(), TICK: types<{}>() },
      },
      context: { ticks: 0 },
      on: {
        TICK: ({ context }) => ({ context: { ticks: context.ticks + 1 } }),
      },
    })
    const adapter = {
      run<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(
        request: TestAdapterRequest<TSnapshot, TEvent>,
      ): Promise<TestAdapterResult> {
        const runner = request.createRunner()
        const firstEvent = request.events[0]
        if (firstEvent === undefined) {
          return Promise.reject(
            new Error('expected at least one generated event case'),
          )
        }
        const caseId = firstEvent.caseId
        const go = request.createEvent('GO', {})
        const exploration = {
          configuredRuns: 1,
          maximumSequenceLength: 4,
        }
        return Promise.resolve()
          .then(() => runner.start())
          .then(() => {
            runner.canRun(go, caseId)
            return runner.run(go, caseId)
          })
          .then(() => {
            runner.canRunCommand(true)
            return runner.advance(1)
          })
          .then(() => {
            runner.canRunCommand(true)
            return runner.checkpoint('after-tick')
          })
          .then(() => {
            runner.canRunCommand(true)
            return runner.stop()
          })
          .then(() => runner.finish())
          .then(
            () => ({ runs: 1, exploration }),
            (error: unknown) => ({ runs: 1, error, exploration }),
          )
          .finally(() => runner.dispose())
      },
    } satisfies TestAdapter
    let disposed = 0
    const failure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          adapter,
          events: { GO: fc.constant({}) },
          sut: {
            create: () => {
              const clock = new SimulatedClock()
              const events: { type: 'TICK' }[] = []
              let ticks = 0
              let stopped = false
              clock.setTimeout(() => {
                ticks++
                events.push({ type: 'TICK' })
              }, 1)
              return {
                send: () => {},
                advance: (milliseconds) => {
                  clock.increment(milliseconds)
                  return events.splice(0)
                },
                checkpoint: () => Promise.resolve(),
                stop: () => {
                  stopped = true
                },
                settle: () => Promise.resolve(),
                read: () => ({ ticks, status: stopped ? 'stopped' : 'active' }),
                dispose: () => {
                  disposed++
                },
              }
            },
            projectModel: (snapshot) => ({
              ticks: snapshot.context.ticks,
              status: snapshot.status,
            }),
          },
          temporal: [
            {
              type: 'until',
              id: 'stay-active',
              within: 10,
              hold: ({ snapshot }) => snapshot.status === 'active',
              until: () => false,
            },
          ],
          invariant: () => {},
        }),
      )
    )) as ModelTestFailure

    yield* expect({
      failure,
      temporalFailure: failure.fixture?.temporalFailure,
      commands: failure.fixture?.timeline.map((entry) =>
        entry.command.type === 'event'
          ? `${entry.command.type}:${entry.command.origin}`
          : entry.command.type
      ),
      disposed,
    }).toMatchObject({
      failure: expect.any(ModelTestFailure),
      temporalFailure: { type: 'until', id: 'stay-active' },
      commands: [
        'event:generator',
        'advance',
        'event:clock',
        'checkpoint',
        'stop',
      ],
      disposed: 1,
    })

    const replayFailure = (yield* Effect.promise(() =>
      rejectionOf(
        replayTest(machine, failure.fixture!, {
          invariant: () => {},
          temporal: [
            {
              type: 'until',
              id: 'stay-active',
              within: 10,
              hold: ({ snapshot }) => snapshot.status === 'active',
              until: () => false,
            },
          ],
        }),
      )
    )) as ModelTestFailure
    yield* expect({
      replayFailure,
      temporalFailureId: replayFailure.fixture?.temporalFailure?.id,
    }).toEqual({
      replayFailure: expect.any(ModelTestFailure),
      temporalFailureId: 'stay-active',
    })

    const incompatible = createMachine({ id: 'timeline', version: '2' })
    const incompatibleFailure = (yield* Effect.promise(() =>
      rejectionOf(
        replayTest(incompatible, failure.fixture!, {
          invariant: () => {},
        }),
      )
    )) as Error
    yield* expect(incompatibleFailure.message).toMatch('machine version')
  })

  it('checks bounded eventuality over stable macrosteps', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: types<{ count: number }>(),
        events: { INC: types<{}>() },
      },
      context: { count: 0 },
      on: {
        INC: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })
    const adapter = {
      run<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(
        request: TestAdapterRequest<TSnapshot, TEvent>,
      ): Promise<TestAdapterResult> {
        const runner = request.createRunner()
        const firstEvent = request.events[0]
        if (firstEvent === undefined) {
          return Promise.reject(
            new Error('expected at least one generated event case'),
          )
        }
        const caseId = firstEvent.caseId
        const inc = request.createEvent('INC', {})
        return Promise.resolve()
          .then(() => runner.start())
          .then(() => {
            runner.canRun(inc, caseId)
            return runner.run(inc, caseId)
          })
          .then(() => {
            runner.canRun(inc, caseId)
            return runner.run(inc, caseId)
          })
          .then(() => runner.finish())
          .then(() => ({
            runs: 1,
            exploration: {
              configuredRuns: 1,
              maximumSequenceLength: 2,
            },
          }))
          .finally(() => runner.dispose())
      },
    } satisfies TestAdapter

    const result = yield* Effect.promise(() =>
      propertyTest(machine, {
        adapter,
        events: { INC: fc.constant({}) },
        temporal: [
          {
            type: 'eventually',
            id: 'reach-two',
            within: 2,
            predicate: ({ snapshot }) => snapshot.context.count === 2,
          },
        ],
        invariant: () => {},
      })
    )
    yield* expect(result.coverage.temporalChecks).toBe(3)
  })

  it('shrinks generated checkpoint and stop commands', function*({ expect }) {
    const machine = createMachine({})
    let active = 0
    let created = 0
    const checkpointFailure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          seed: 31,
          numRuns: 50,
          maxCommands: 6,
          events: {},
          commands: {
            checkpoint: fc.record({ label: fc.string() }),
          },
          sut: {
            create: () => {
              created++
              active++
              let valid = true
              return {
                send: () => {},
                checkpoint: () => {
                  valid = false
                },
                read: () => valid,
                dispose: () => {
                  active--
                },
              }
            },
            projectModel: () => true,
          },
          invariant: () => {},
        }),
      )
    )) as ModelTestFailure
    yield* expect({
      commands: checkpointFailure.trace.commands,
      commandCount: checkpointFailure.trace.commands.length,
      createdMoreThanOne: created > 1,
      active,
    }).toMatchObject({
      commands: [{ type: 'checkpoint' }],
      commandCount: 1,
      createdMoreThanOne: true,
      active: 0,
    })

    const stopFailure = (yield* Effect.promise(() =>
      rejectionOf(
        propertyTest(machine, {
          seed: 32,
          numRuns: 50,
          maxCommands: 6,
          events: {},
          commands: { stop: fc.constant({}) },
          invariant: ({ snapshot }) => {
            if (snapshot.status === 'stopped') {
              throw new Error('the runner stopped before the run could fail')
            }
          },
        }),
      )
    )) as ModelTestFailure
    yield* expect({
      commands: stopFailure.trace.commands,
      failureMessage: stopFailure.message,
    }).toEqual({
      commands: [{ type: 'stop' }],
      failureMessage: expect.stringContaining(
        'the runner stopped before the run could fail',
      ),
    })
  })

  it('creates and disposes fresh asynchronous runtimes across shrinking attempts', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: types<{ count: number }>(),
        events: { INC: types<{}>() },
      },
      context: { count: 0 },
      on: {
        INC: ({ context }) => ({ context: { count: context.count + 1 } }),
      },
    })
    let created = 0
    let disposed = 0
    let active = 0
    let freshClocksAtZero = 0
    yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 27,
        numRuns: 20,
        maxCommands: 5,
        events: { INC: fc.constant({}) },
        sut: {
          create: () => {
            created++
            active++
            const clock = new SimulatedClock()
            if (clock.now() !== 0) {
              throw new Error(
                `expected a fresh SimulatedClock at 0, saw ${clock.now()}`,
              )
            }
            freshClocksAtZero++
            let count = 0
            const pending: (() => void)[] = []
            return {
              send: () => {
                pending.push(() => count++)
              },
              settle: () =>
                Promise.resolve().then(() => {
                  pending.splice(0).forEach((run) => run())
                }),
              read: () => count,
              dispose: () => {
                disposed++
                active--
              },
            }
          },
          projectModel: (snapshot) => snapshot.context.count,
        },
        invariant: () => {},
      })
    )
    yield* expect({
      createdMoreThanOne: created > 1,
      attempts: {
        created,
        disposed,
        freshClocksAtZero,
      },
      active,
    }).toEqual({
      createdMoreThanOne: true,
      attempts: {
        created,
        disposed: created,
        freshClocksAtZero: created,
      },
      active: 0,
    })
  })
})
