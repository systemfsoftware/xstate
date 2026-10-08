import { describe, it } from '@systemfsoftware/vitest'
import { createMachine } from '../../index.js'
import { getShortestPaths, getSimplePaths, joinPaths } from '../index.js'
import type { StatePath } from '../index.js'

const multiPathMachine = createMachine({
  initial: 'a',
  states: {
    a: {
      on: {
        EVENT: { target: 'b' },
      },
    },
    b: {
      on: {
        EVENT: { target: 'c' },
      },
    },
    c: {
      on: {
        EVENT: { target: 'd' },
        EVENT_2: { target: 'e' },
      },
    },
    d: {},
    e: {},
  },
})

function eventTypes(path: StatePath<any, any>): string {
  return path.steps.map((step) => step.event.type).join(' → ')
}

describe('getSimplePaths', () => {
  it('returns one path per reachable state', function*({ expect }) {
    const paths = getSimplePaths(multiPathMachine)

    yield* expect(paths.map((path) => path.state.value).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('should support filtering disabled events', function*({ expect }) {
    const machine = createMachine({
      id: 'guarded-test-model',
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
      filterEvents: (state, event) => state.can(event),
      toState: (state) => state.status === 'done',
    })

    yield* expect(paths.map(eventTypes)).toEqual([
      '@xstate.init → NEXT → ALLOW → PROCEED',
    ])
  })
})

describe('transition coverage', () => {
  it('shortest paths reach every state', function*({ expect }) {
    const paths = getShortestPaths(multiPathMachine)

    yield* expect({
      states: paths.map((path) => path.state.value),
      eventPaths: paths.map(eventTypes),
    }).toEqual({
      states: ['a', 'b', 'c', 'd', 'e'],
      eventPaths: expect.arrayContaining([
        '@xstate.init → EVENT → EVENT → EVENT_2',
      ]),
    })
  })

  it('transition coverage should consider multiple transitions with the same target', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            GO_TO_B: { target: 'b' },
            GO_TO_C: { target: 'c' },
          },
        },
        b: {
          on: {
            GO_TO_A: { target: 'a' },
          },
        },
        c: {
          on: {
            GO_TO_A: { target: 'a' },
          },
        },
      },
    })

    const paths = getSimplePaths(machine)

    yield* expect(paths.map(eventTypes)).toEqual(
      expect.arrayContaining([
        '@xstate.init → GO_TO_B',
        '@xstate.init → GO_TO_C',
      ]),
    )
  })
})

describe('toState', () => {
  const machine = createMachine({
    initial: 'open',
    states: {
      open: {
        on: {
          CLOSE: { target: 'closed' },
        },
      },
      closed: {
        on: {
          OPEN: { target: 'open' },
        },
      },
    },
  })

  it('Should find a path to a non-initial target state', function*({ expect }) {
    const closedPaths = getShortestPaths(machine, {
      toState: (state) => state.matches('closed'),
    })

    yield* expect(closedPaths.map(eventTypes)).toEqual(['@xstate.init → CLOSE'])
  })

  it('Should find a path to an initial target state', function*({ expect }) {
    const openPaths = getShortestPaths(machine, {
      toState: (state) => state.matches('open'),
    })

    yield* expect(openPaths.map(eventTypes)).toEqual(['@xstate.init'])
  })
})

describe('paths from paths', () => {
  const machine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: {
          NEXT: { target: 'b' },
          OTHER: { target: 'b' },
          TO_C: { target: 'c' },
          TO_D: { target: 'd' },
          TO_E: { target: 'e' },
        },
      },
      b: {
        on: {
          TO_C: { target: 'c' },
          TO_D: { target: 'd' },
        },
      },
      c: {},
      d: {},
      e: {},
    },
  })

  it('should join shortest paths from the end of other paths', function*({ expect }) {
    const pathsToB = getSimplePaths(machine, {
      toState: (state) => state.matches('b'),
    })

    const joined = pathsToB.flatMap((path) =>
      getShortestPaths(machine, {
        fromState: path.state,
        toState: (state) => state.matches('c') || state.matches('d'),
      }).map((next) => joinPaths(path, next))
    )

    yield* expect({
      pathsToB: pathsToB.map(eventTypes).sort(),
      joined: joined.map(eventTypes).sort(),
      joinedStepCounts: joined.map((path) => path.steps.length),
    }).toEqual({
      pathsToB: [
        '@xstate.init → NEXT',
        '@xstate.init → OTHER',
      ],
      joined: [
        '@xstate.init → NEXT → TO_C',
        '@xstate.init → NEXT → TO_D',
        '@xstate.init → OTHER → TO_C',
        '@xstate.init → OTHER → TO_D',
      ],
      joinedStepCounts: [3, 3, 3, 3],
    })
  })
})
