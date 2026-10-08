import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import {
  createLogic,
  createMachine,
  type EventObject,
  isMachineSnapshot,
  type Snapshot,
  StateNode,
} from '../../index.js'
import { createMockActorScope } from '../actorScope.js'
import {
  getDescendantStateNodes,
  getPathsFromEvents,
  getShortestPaths,
  getSimplePaths,
  joinPaths,
  type StatePath,
  toDirectedGraph,
} from '../index.js'

const snapshotState = (state: Snapshot<unknown>): unknown =>
  isMachineSnapshot(state)
    ? state.value
    : 'context' in state
    ? state.context
    : state

function getPathsSnapshot<
  TSnapshot extends Snapshot<unknown>,
  TEvent extends EventObject,
>(
  paths: Array<StatePath<TSnapshot, TEvent>>,
) {
  return paths.map((path) => getPathSnapshot(path))
}

function getPathSnapshot<
  TSnapshot extends Snapshot<unknown>,
  TEvent extends EventObject,
>(path: StatePath<TSnapshot, TEvent>): {
  state: unknown
  steps: Array<{ state: unknown; eventType: string }>
} {
  return {
    state: snapshotState(path.state),
    steps: path.steps.map((step) => ({
      state: snapshotState(step.state),
      eventType: step.event.type,
    })),
  }
}

const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

const pathSteps = <TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(
  path: StatePath<TSnapshot, TEvent>,
) =>
  path.steps.map((step) => ({
    eventType: step.event.type,
    state: snapshotState(step.state),
  }))

describe('@xstate/graph', () => {
  const lightMachine = createMachine({
    id: 'light',
    initial: 'green',
    schemas: {
      events: {
        TIMER: z.object({}),
        POWER_OUTAGE: z.object({}),
        PUSH_BUTTON: z.object({}),
        PED_COUNTDOWN: z.object({}),
      },
    },
    states: {
      green: {
        on: {
          TIMER: { target: 'yellow' },
          POWER_OUTAGE: { target: 'red.flashing' },
          PUSH_BUTTON: (_, enq) => {
            enq(function doNothing() {})
          },
        },
      },
      yellow: {
        on: {
          TIMER: { target: 'red' },
          POWER_OUTAGE: { target: 'red.flashing' },
        },
      },
      red: {
        on: {
          TIMER: { target: 'green' },
          POWER_OUTAGE: { target: 'red.flashing' },
        },
        initial: 'walk',
        states: {
          walk: {
            on: {
              PED_COUNTDOWN: (_, enq) => {
                enq(function startCountdown() {})

                return { target: 'wait' }
              },
            },
          },
          wait: {
            on: {
              PED_COUNTDOWN: { target: 'stop' },
            },
          },
          stop: {},
          flashing: {},
        },
      },
    },
  })

  const condMachine = createMachine({
    schemas: {
      context: z.object({
        id: z.string().optional(),
      }),
      events: {
        EVENT: z.object({
          id: z.string(),
        }),
        STATE: z.object({}),
      },
    },
    initial: 'pending',
    context: {
      id: undefined,
    },
    states: {
      pending: {
        on: {
          EVENT: ({ event }) => {
            if (event.id === 'foo') {
              return { target: 'foo' }
            }
            return { target: 'bar' }
          },
          STATE: ({ context }) => {
            if (context.id === 'foo') {
              return { target: 'foo' }
            }
            return { target: 'bar' }
          },
        },
      },
      foo: {},
      bar: {},
    },
  })

  const parallelMachine = createMachine({
    type: 'parallel',
    id: 'p',
    states: {
      a: {
        initial: 'a1',
        states: {
          a1: {
            on: { 2: { target: 'a2' }, 3: { target: 'a3' } },
          },
          a2: {
            on: { 3: { target: 'a3' }, 1: { target: 'a1' } },
          },
          a3: {},
        },
      },
      b: {
        initial: 'b1',
        states: {
          b1: {
            on: { 2: { target: 'b2' }, 3: { target: 'b3' } },
          },
          b2: {
            on: { 3: { target: 'b3' }, 1: { target: 'b1' } },
          },
          b3: {},
        },
      },
    },
  })

  describe('getDescendantStateNodes()', () => {
    it('should return an array of all nodes', function*({ expect }) {
      const nodes = getDescendantStateNodes(lightMachine)

      yield* expect({
        areStateNodes: nodes.map((node) => node instanceof StateNode),
        ids: nodes.map((node) => node.id).sort(),
      }).toEqual({
        areStateNodes: [true, true, true, true, true, true, true],
        ids: [
          'light.green',
          'light.red',
          'light.red.flashing',
          'light.red.stop',
          'light.red.wait',
          'light.red.walk',
          'light.yellow',
        ],
      })
    })

    it('should return an array of all nodes (parallel)', function*({ expect }) {
      const nodes = getDescendantStateNodes(parallelMachine)

      yield* expect({
        areStateNodes: nodes.map((node) => node instanceof StateNode),
        ids: nodes.map((node) => node.id).sort(),
      }).toEqual({
        areStateNodes: [true, true, true, true, true, true, true, true],
        ids: [
          'p.a',
          'p.a.a1',
          'p.a.a2',
          'p.a.a3',
          'p.b',
          'p.b.b1',
          'p.b.b2',
          'p.b.b3',
        ],
      })
    })
  })

  describe('getShortestPaths()', () => {
    it('should return a mapping of shortest paths to all states', function*({ expect }) {
      const paths = getShortestPaths(lightMachine)

      yield* expect(getPathsSnapshot(paths)).toEqual([
        {
          state: 'green',
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
          ],
        },
        {
          state: 'yellow',
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
            {
              eventType: 'TIMER',
              state: 'yellow',
            },
          ],
        },
        {
          state: {
            red: 'flashing',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
            {
              eventType: 'POWER_OUTAGE',
              state: {
                red: 'flashing',
              },
            },
          ],
        },
        {
          state: {
            red: 'walk',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
            {
              eventType: 'TIMER',
              state: 'yellow',
            },
            {
              eventType: 'TIMER',
              state: {
                red: 'walk',
              },
            },
          ],
        },
        {
          state: {
            red: 'wait',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
            {
              eventType: 'TIMER',
              state: 'yellow',
            },
            {
              eventType: 'TIMER',
              state: {
                red: 'walk',
              },
            },
            {
              eventType: 'PED_COUNTDOWN',
              state: {
                red: 'wait',
              },
            },
          ],
        },
        {
          state: {
            red: 'stop',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
            {
              eventType: 'TIMER',
              state: 'yellow',
            },
            {
              eventType: 'TIMER',
              state: {
                red: 'walk',
              },
            },
            {
              eventType: 'PED_COUNTDOWN',
              state: {
                red: 'wait',
              },
            },
            {
              eventType: 'PED_COUNTDOWN',
              state: {
                red: 'stop',
              },
            },
          ],
        },
      ])
    })

    it('should return a mapping of shortest paths to all states (parallel)', function*({ expect }) {
      const paths = getShortestPaths(parallelMachine)

      yield* expect(getPathsSnapshot(paths)).toEqual([
        {
          state: {
            a: 'a1',
            b: 'b1',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: {
                a: 'a1',
                b: 'b1',
              },
            },
          ],
        },
        {
          state: {
            a: 'a2',
            b: 'b2',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: {
                a: 'a1',
                b: 'b1',
              },
            },
            {
              eventType: '2',
              state: {
                a: 'a2',
                b: 'b2',
              },
            },
          ],
        },
        {
          state: {
            a: 'a3',
            b: 'b3',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: {
                a: 'a1',
                b: 'b1',
              },
            },
            {
              eventType: '3',
              state: {
                a: 'a3',
                b: 'b3',
              },
            },
          ],
        },
      ])
    })

    it('the initial state should have a single-length path', function*({ expect }) {
      const shortestPaths = getShortestPaths(lightMachine)

      yield* expect(
        pathSteps(
          shortestPaths.find((path) =>
            path.state.matches(
              lightMachine.getInitialSnapshot(createMockActorScope()).value,
            )
          )!,
        ),
      ).toEqual([
        {
          eventType: '@xstate.init',
          state: 'green',
        },
      ])
    })

    it.skip('should not throw when a condition is present', function*({ expect }) {
      yield* expect(() => getShortestPaths(condMachine)).not.toThrow()
    })

    it.skip('should represent conditional paths based on context', function*({ expect }) {
      const machine = createMachine({
        schemas: {
          context: z.object({
            id: z.string().optional(),
          }),
          events: {
            EVENT: z.object({
              id: z.string(),
            }),
            STATE: z.object({}),
          },
        },
        initial: 'pending',
        context: {
          id: 'foo',
        },
        states: {
          pending: {
            on: {
              EVENT: ({ event }) => {
                if (event.id === 'foo') {
                  return { target: 'foo' }
                }
                return { target: 'bar' }
              },
              STATE: ({ context }) => {
                if (context.id === 'foo') {
                  return { target: 'foo' }
                }
                return { target: 'bar' }
              },
            },
          },
          foo: {},
          bar: {},
        },
      })

      const paths = getShortestPaths(machine, {
        events: [
          {
            type: 'EVENT',
            id: 'whatever',
          },
          {
            type: 'STATE',
          },
        ],
      })

      yield* expect(getPathsSnapshot(paths)).toEqual([
        {
          state: 'pending',
          steps: [
            {
              eventType: '@xstate.init',
              state: 'pending',
            },
          ],
        },
        {
          state: 'bar',
          steps: [
            {
              eventType: '@xstate.init',
              state: 'pending',
            },
            {
              eventType: 'EVENT',
              state: 'bar',
            },
          ],
        },
        {
          state: 'foo',
          steps: [
            {
              eventType: '@xstate.init',
              state: 'pending',
            },
            {
              eventType: 'STATE',
              state: 'foo',
            },
          ],
        },
      ])
    })
  })

  describe('getSimplePaths()', () => {
    it('should return a mapping of arrays of simple paths to all states', function*({ expect }) {
      const paths = getSimplePaths(lightMachine)

      yield* expect({
        values: paths.map((path) => path.state.value),
        paths: getPathsSnapshot(paths),
      }).toEqual({
        values: [
          'green',
          'yellow',
          {
            red: 'flashing',
          },
          {
            red: 'flashing',
          },
          {
            red: 'flashing',
          },
          {
            red: 'flashing',
          },
          {
            red: 'flashing',
          },
          {
            red: 'walk',
          },
          {
            red: 'wait',
          },
          {
            red: 'stop',
          },
        ],
        paths: [
          {
            state: 'green',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
            ],
          },
          {
            state: 'yellow',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
            ],
          },
          {
            state: {
              red: 'flashing',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'TIMER',
                state: {
                  red: 'walk',
                },
              },
              {
                eventType: 'POWER_OUTAGE',
                state: {
                  red: 'flashing',
                },
              },
            ],
          },
          {
            state: {
              red: 'flashing',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'TIMER',
                state: {
                  red: 'walk',
                },
              },
              {
                eventType: 'PED_COUNTDOWN',
                state: {
                  red: 'wait',
                },
              },
              {
                eventType: 'POWER_OUTAGE',
                state: {
                  red: 'flashing',
                },
              },
            ],
          },
          {
            state: {
              red: 'flashing',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'TIMER',
                state: {
                  red: 'walk',
                },
              },
              {
                eventType: 'PED_COUNTDOWN',
                state: {
                  red: 'wait',
                },
              },
              {
                eventType: 'PED_COUNTDOWN',
                state: {
                  red: 'stop',
                },
              },
              {
                eventType: 'POWER_OUTAGE',
                state: {
                  red: 'flashing',
                },
              },
            ],
          },
          {
            state: {
              red: 'flashing',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'POWER_OUTAGE',
                state: {
                  red: 'flashing',
                },
              },
            ],
          },
          {
            state: {
              red: 'flashing',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'POWER_OUTAGE',
                state: {
                  red: 'flashing',
                },
              },
            ],
          },
          {
            state: {
              red: 'walk',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'TIMER',
                state: {
                  red: 'walk',
                },
              },
            ],
          },
          {
            state: {
              red: 'wait',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'TIMER',
                state: {
                  red: 'walk',
                },
              },
              {
                eventType: 'PED_COUNTDOWN',
                state: {
                  red: 'wait',
                },
              },
            ],
          },
          {
            state: {
              red: 'stop',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: 'green',
              },
              {
                eventType: 'TIMER',
                state: 'yellow',
              },
              {
                eventType: 'TIMER',
                state: {
                  red: 'walk',
                },
              },
              {
                eventType: 'PED_COUNTDOWN',
                state: {
                  red: 'wait',
                },
              },
              {
                eventType: 'PED_COUNTDOWN',
                state: {
                  red: 'stop',
                },
              },
            ],
          },
        ],
      })
    })

    const equivMachine = createMachine({
      initial: 'a',
      states: {
        a: { on: { FOO: { target: 'b' }, BAR: { target: 'b' } } },
        b: { on: { FOO: { target: 'a' }, BAR: { target: 'a' } } },
      },
    })

    it('should return a mapping of simple paths to all states (parallel)', function*({ expect }) {
      const paths = getSimplePaths(parallelMachine)

      yield* expect({
        values: paths.map((p) => p.state.value),
        paths: getPathsSnapshot(paths),
      }).toEqual({
        values: [
          {
            a: 'a1',
            b: 'b1',
          },
          {
            a: 'a2',
            b: 'b2',
          },
          {
            a: 'a3',
            b: 'b3',
          },
          {
            a: 'a3',
            b: 'b3',
          },
        ],
        paths: [
          {
            state: {
              a: 'a1',
              b: 'b1',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: {
                  a: 'a1',
                  b: 'b1',
                },
              },
            ],
          },
          {
            state: {
              a: 'a2',
              b: 'b2',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: {
                  a: 'a1',
                  b: 'b1',
                },
              },
              {
                eventType: '2',
                state: {
                  a: 'a2',
                  b: 'b2',
                },
              },
            ],
          },
          {
            state: {
              a: 'a3',
              b: 'b3',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: {
                  a: 'a1',
                  b: 'b1',
                },
              },
              {
                eventType: '2',
                state: {
                  a: 'a2',
                  b: 'b2',
                },
              },
              {
                eventType: '3',
                state: {
                  a: 'a3',
                  b: 'b3',
                },
              },
            ],
          },
          {
            state: {
              a: 'a3',
              b: 'b3',
            },
            steps: [
              {
                eventType: '@xstate.init',
                state: {
                  a: 'a1',
                  b: 'b1',
                },
              },
              {
                eventType: '3',
                state: {
                  a: 'a3',
                  b: 'b3',
                },
              },
            ],
          },
        ],
      })
    })

    it('should return multiple paths for equivalent transitions', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: { on: { FOO: { target: 'b' }, BAR: { target: 'b' } } },
          b: { on: { FOO: { target: 'a' }, BAR: { target: 'a' } } },
        },
      })

      const paths = getSimplePaths(machine)

      yield* expect({
        values: paths.map((p) => p.state.value),
        paths: getPathsSnapshot(paths),
      }).toEqual({
        values: ['a', 'b', 'b'],
        paths: [
          {
            state: 'a',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'a',
              },
            ],
          },
          {
            state: 'b',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'a',
              },
              {
                eventType: 'FOO',
                state: 'b',
              },
            ],
          },
          {
            state: 'b',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'a',
              },
              {
                eventType: 'BAR',
                state: 'b',
              },
            ],
          },
        ],
      })
    })

    it('should return a single-length path for the initial state', function*({ expect }) {
      yield* expect({
        lightInitial: pathSteps(
          getSimplePaths(lightMachine).find((p) =>
            p.state.matches(
              lightMachine.getInitialSnapshot(createMockActorScope()).value,
            )
          )!,
        ),
        equivInitial: pathSteps(
          getSimplePaths(equivMachine).find((p) =>
            p.state.matches(
              equivMachine.getInitialSnapshot(createMockActorScope()).value,
            )
          )!,
        ),
      }).toEqual({
        lightInitial: [
          {
            eventType: '@xstate.init',
            state: 'green',
          },
        ],
        equivInitial: [
          {
            eventType: '@xstate.init',
            state: 'a',
          },
        ],
      })
    })

    it('should return value-based paths', function*({ expect }) {
      const countMachine = createMachine({
        schemas: {
          context: z.object({
            count: z.number(),
          }),
          events: {
            INC: z.object({ value: z.number() }),
            FINISH: z.object({}),
          },
        },
        id: 'count',
        initial: 'start',
        context: {
          count: 0,
        },
        states: {
          start: {
            always: ({ context }) => {
              if (context.count === 3) {
                return {
                  target: 'finish',
                }
              }
              return undefined
            },
            on: {
              INC: ({ context }) => ({
                context: {
                  count: context.count + 1,
                },
              }),
            },
          },
          finish: {},
        },
      })

      const paths = getSimplePaths(countMachine, {
        events: [{ type: 'INC', value: 1 } as const],
      })

      yield* expect({
        values: paths.map((p) => p.state.value),
        paths: getPathsSnapshot(paths),
      }).toEqual({
        values: ['start', 'start', 'start', 'finish'],
        paths: [
          {
            state: 'start',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'start',
              },
            ],
          },
          {
            state: 'start',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'start',
              },
              {
                eventType: 'INC',
                state: 'start',
              },
            ],
          },
          {
            state: 'start',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'start',
              },
              {
                eventType: 'INC',
                state: 'start',
              },
              {
                eventType: 'INC',
                state: 'start',
              },
            ],
          },
          {
            state: 'finish',
            steps: [
              {
                eventType: '@xstate.init',
                state: 'start',
              },
              {
                eventType: 'INC',
                state: 'start',
              },
              {
                eventType: 'INC',
                state: 'start',
              },
              {
                eventType: 'INC',
                state: 'finish',
              },
            ],
          },
        ],
      })
    })

    it('should support filtering disabled events', function*({ expect }) {
      const machine = createMachine({
        id: 'guarded-default-events',
        initial: 'start',
        context: { allowed: false as boolean },
        states: {
          start: {
            on: { NEXT: { target: 'idle' } },
          },
          idle: {
            on: {
              PROCEED: ({ context }) => {
                if (context.allowed) {
                  return { target: 'done' }
                }
                return undefined
              },
              ALLOW: () => ({
                context: {
                  allowed: true,
                },
              }),
            },
          },
          done: {
            type: 'final',
          },
        },
      })

      const paths = getSimplePaths(machine, {
        filterEvents: (state, event) => !isMachineSnapshot(state) || state.can(event),
        toState: (state) => state.status === 'done',
      })

      yield* expect(
        paths.map((path) => path.steps.map((step) => step.event.type)),
      ).toEqual([
        [
          '@xstate.init',
          'NEXT',
          'ALLOW',
          'PROCEED',
        ],
      ])
    })
  })

  describe('getPathFromEvents()', () => {
    it('should return a path to the last entered state by the event sequence', function*({ expect }) {
      const paths = getPathsFromEvents(lightMachine, [
        { type: 'TIMER' },
        { type: 'TIMER' },
        { type: 'TIMER' },
        { type: 'POWER_OUTAGE' },
      ])

      const path = paths[0]
      if (path === undefined) {
        throw new Error('expected a path from events')
      }

      yield* expect({
        count: paths.length,
        path: getPathSnapshot(path),
      }).toEqual({
        count: 1,
        path: {
          state: {
            red: 'flashing',
          },
          steps: [
            {
              eventType: '@xstate.init',
              state: 'green',
            },
            {
              eventType: 'TIMER',
              state: 'yellow',
            },
            {
              eventType: 'TIMER',
              state: {
                red: 'walk',
              },
            },
            {
              eventType: 'TIMER',
              state: 'green',
            },
            {
              eventType: 'POWER_OUTAGE',
              state: {
                red: 'flashing',
              },
            },
          ],
        },
      })
    })

    it.skip('should throw when an invalid event sequence is provided', function*({ expect }) {
      yield* expect(() =>
        getPathsFromEvents(lightMachine, [
          { type: 'TIMER' },
          {
            // @ts-expect-error
            type: 'INVALID_EVENT',
          },
        ])
      ).toThrow('Invalid transition from')
    })

    it('should return a path from a specified from-state', function*({ expect }) {
      const path = getPathsFromEvents(lightMachine, [{ type: 'TIMER' }], {
        fromState: lightMachine.resolveState({ value: 'yellow' }),
      })[0]

      if (path === undefined) {
        throw new Error('expected a path')
      }

      yield* expect({
        value: path.state.value,
        matchesRed: path.state.matches('red'),
      }).toEqual({
        value: {
          red: 'walk',
        },
        matchesRed: true,
      })
    })

    it('does not treat custom logic with a getStateNodeById property as a machine', function*({ expect }) {
      const logic = Object.assign(
        createLogic({
          context: 0,
          run: ({ context, event }) => {
            if (event.type === 'INC') {
              return { context: context + 1 }
            }
            return undefined
          },
        }),
        { getStateNodeById: () => 'custom metadata' },
      )

      const path = getPathsFromEvents(logic, [{ type: 'INC' }], {
        toState: (state) => state.context === 1,
      })[0]

      if (path === undefined) {
        throw new Error('expected a path')
      }

      yield* expect(path.state.context).toBe(1)
    })
  })

  describe('toDirectedGraph', () => {
    it('should represent a statechart as a directed graph', function*({ expect }) {
      const machine = createMachine({
        id: 'light',
        initial: 'green',
        states: {
          green: { on: { TIMER: { target: 'yellow' } } },
          yellow: { on: { TIMER: { target: 'red' } } },
          red: {
            initial: 'walk',
            states: {
              walk: { on: { COUNTDOWN: { target: 'wait' } } },
              wait: { on: { COUNTDOWN: { target: 'stop' } } },
              stop: { on: { COUNTDOWN: { target: 'finished' } } },
              finished: { type: 'final' },
            },
            onDone: { target: 'green' },
          },
        },
      })

      const digraph = toDirectedGraph(machine)

      const digraphJson: unknown = JSON.parse(JSON.stringify(digraph))

      yield* expect(digraphJson).toEqual({
        children: [
          {
            children: [],
            edges: [
              {
                label: {
                  text: 'TIMER',
                },
                source: 'light.green',
                target: 'light.yellow',
              },
            ],
            id: 'light.green',
          },
          {
            children: [],
            edges: [
              {
                label: {
                  text: 'TIMER',
                },
                source: 'light.yellow',
                target: 'light.red',
              },
            ],
            id: 'light.yellow',
          },
          {
            children: [
              {
                children: [],
                edges: [
                  {
                    label: {
                      text: 'COUNTDOWN',
                    },
                    source: 'light.red.walk',
                    target: 'light.red.wait',
                  },
                ],
                id: 'light.red.walk',
              },
              {
                children: [],
                edges: [
                  {
                    label: {
                      text: 'COUNTDOWN',
                    },
                    source: 'light.red.wait',
                    target: 'light.red.stop',
                  },
                ],
                id: 'light.red.wait',
              },
              {
                children: [],
                edges: [
                  {
                    label: {
                      text: 'COUNTDOWN',
                    },
                    source: 'light.red.stop',
                    target: 'light.red.finished',
                  },
                ],
                id: 'light.red.stop',
              },
              {
                children: [],
                edges: [],
                id: 'light.red.finished',
              },
            ],
            edges: [
              {
                label: {
                  text: 'xstate.done.state',
                },
                source: 'light.red',
                target: 'light.green',
              },
            ],
            id: 'light.red',
          },
        ],
        edges: [],
        id: 'light',
      })
    })

    it('does not rely on StateMachine constructor identity', function*({ expect }) {
      const machine = createMachine({
        id: 'light',
        initial: 'green',
        states: {
          green: { on: { TIMER: { target: 'yellow' } } },
          yellow: {},
        },
      })
      const machineFromAnotherPackageInstance = new Proxy(machine, {
        getPrototypeOf: () => null,
      })

      yield* expect({
        prototype: Object.getPrototypeOf(machineFromAnotherPackageInstance),
        id: toDirectedGraph(machineFromAnotherPackageInstance).id,
      }).toEqual({
        prototype: null,
        id: 'light',
      })
    })
  })
})

it('simple paths for transition functions', function*({ expect }) {
  const transition = createLogic({
    context: 0,
    run: ({ context, event }) => {
      if (event.type === 'a') {
        return { context: 1 }
      }
      if (event.type === 'b' && context === 1) {
        return { context: 2 }
      }
      if (event.type === 'reset') {
        return { context: 0 }
      }
      return
    },
  })
  const a = getShortestPaths(transition, {
    events: [{ type: 'a' }, { type: 'b' }, { type: 'reset' }],
    serializeState: (v, e) => JSON.stringify(v) + ' | ' + JSON.stringify(e),
  })

  yield* expect(getPathsSnapshot(a)).toEqual([
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
      ],
    },
    {
      state: 1,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 2,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
      ],
    },
  ])
})

it('shortest paths for transition functions', function*({ expect }) {
  const transition = createLogic({
    context: 0,
    run: ({ context, event }) => {
      if (event.type === 'a') {
        return { context: 1 }
      }
      if (event.type === 'b' && context === 1) {
        return { context: 2 }
      }
      if (event.type === 'reset') {
        return { context: 0 }
      }
      return
    },
  })
  const a = getSimplePaths(transition, {
    events: [{ type: 'a' }, { type: 'b' }, { type: 'reset' }],
    serializeState: (v, e) => JSON.stringify(v) + ' | ' + JSON.stringify(e),
  })

  yield* expect(getPathsSnapshot(a)).toEqual([
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
      ],
    },
    {
      state: 1,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
      ],
    },
    {
      state: 1,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
      ],
    },
    {
      state: 1,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
      ],
    },
    {
      state: 1,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
      ],
    },
    {
      state: 1,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 0,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
      ],
    },
    {
      state: 2,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
      ],
    },
    {
      state: 2,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
      ],
    },
    {
      state: 2,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
      ],
    },
    {
      state: 2,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
      ],
    },
    {
      state: 2,
      steps: [
        {
          eventType: '@xstate.init',
          state: 0,
        },
        {
          eventType: 'reset',
          state: 0,
        },
        {
          eventType: 'b',
          state: 0,
        },
        {
          eventType: 'a',
          state: 1,
        },
        {
          eventType: 'b',
          state: 2,
        },
      ],
    },
  ])
})

describe('filtering', () => {
  it('should not traverse past filtered states', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'counting',
      context: { count: 0 },
      states: {
        counting: {
          on: {
            INC: ({ context }) => ({
              context: {
                count: context.count + 1,
              },
            }),
          },
        },
      },
    })

    const shortestPaths = getShortestPaths(machine, {
      events: [{ type: 'INC' }],
      stopWhen: (state) => state.context.count === 5,
    })

    yield* expect(shortestPaths.map((p) => p.state.context)).toEqual([
      {
        count: 0,
      },
      {
        count: 1,
      },
      {
        count: 2,
      },
      {
        count: 3,
      },
      {
        count: 4,
      },
      {
        count: 5,
      },
    ])
  })
})

it('should provide previous state for serializeState()', function*({ expect }) {
  const machine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: { toB: { target: 'b' } },
      },
      b: {
        on: { toC: { target: 'c' } },
      },
      c: {
        on: { toA: { target: 'a' } },
      },
    },
  })

  const shortestPaths = getShortestPaths(machine, {
    serializeState: (state, event, prevState) => {
      return `${JSON.stringify(state.value)} via ${event?.type}${
        prevState ? ` via ${JSON.stringify(prevState.value)}` : ''
      }`
    },
  })

  yield* expect(
    shortestPaths
      .filter((path) => path.state.matches('a'))
      .map((path) => path.steps.length),
  ).toEqual([1, 4])
})

it.each([getShortestPaths, getSimplePaths])(
  'from-state can be specified',
  function*(pathGetter, { expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { toB: { target: 'b' } },
        },
        b: {
          on: { toC: { target: 'c' } },
        },
        c: {
          on: { toA: { target: 'a' } },
        },
      },
    })

    const paths = pathGetter(machine, {
      fromState: machine.resolveState({ value: 'b' }),
    })

    const toB = paths.find((path) => path.state.matches('b') && path.steps.length === 1)
    const toA = paths.find((path) => path.state.matches('a') && path.steps.length > 0)

    yield* expect({
      stepsToOneStepB: toB?.steps.length ?? 0,
      toAHasSteps: (toA?.steps.length ?? 0) > 0,
    }).toEqual({
      stepsToOneStepB: 1,
      toAHasSteps: true,
    })
  },
)

describe('joinPaths()', () => {
  it('should join two paths', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          on: {
            TO_C: { target: 'c' },
          },
        },
        c: {},
      },
    })

    const pathToB = getPathsFromEvents(machine, [{ type: 'NEXT' }])[0]
    if (pathToB === undefined) {
      throw new Error('expected a path to b')
    }
    const pathToC = getPathsFromEvents(machine, [{ type: 'TO_C' }], {
      fromState: pathToB.state,
    })[0]
    if (pathToC === undefined) {
      throw new Error('expected a path to c')
    }

    const pathToBAndC = joinPaths(pathToB, pathToC)

    yield* expect({
      eventTypes: pathToBAndC.steps.map((step) => step.event.type),
      matchesC: pathToBAndC.state.matches('c'),
    }).toEqual({
      eventTypes: [
        '@xstate.init',
        'NEXT',
        'TO_C',
      ],
      matchesC: true,
    })
  })

  it('should not join two paths with mismatched source/target states', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: 'b' } },
        },
        b: {
          on: {
            TO_C: { target: 'c' },
          },
        },
        c: {},
      },
    })

    const pathToB = getPathsFromEvents(machine, [{ type: 'NEXT' }])[0]
    if (pathToB === undefined) {
      throw new Error('expected a path to b')
    }
    const pathToCFromA = getPathsFromEvents(machine, [{ type: 'TO_C' }])[0]
    if (pathToCFromA === undefined) {
      throw new Error('expected a path to c from a')
    }

    const error = thrownBy(() => {
      joinPaths(pathToB, pathToCFromA)
    })

    yield* expect({
      pathToB: pathToB.steps.map((step) => step.event.type),
      pathToCFromA: pathToCFromA.steps.map((step) => step.event.type),
      joinError: error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: typeof error, message: 'no error was thrown' },
    }).toEqual({
      pathToB: [
        '@xstate.init',
        'NEXT',
      ],
      pathToCFromA: [
        '@xstate.init',
        'TO_C',
      ],
      joinError: {
        name: 'Error',
        message: 'Paths cannot be joined',
      },
    })
  })
})
