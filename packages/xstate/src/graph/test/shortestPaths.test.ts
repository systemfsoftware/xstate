import { describe } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createMachine } from '../../index.js'
import { joinPaths } from '../graph.js'
import { getShortestPaths } from '../shortestPaths.js'

describe('getShortestPaths', (it) => {
  it('finds the shortest paths to a state without continuing traversal from that state', function*({ expect }) {
    const m = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'a',
      context: { count: 0 },
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            NEXT: { target: 'c' },
          },
        },
        c: {
          on: {
            NEXT: { target: 'd' },
          },
        },
        d: {
          on: {
            NEXT: ({ context }) => ({
              context: {
                count: context.count + 1,
              },
              target: 'd',
            }),
          },
        },
      },
    })

    const p = getShortestPaths(m, {
      toState: (state) => state.matches('c'),
    })

    yield* expect(
      p.map((path) => ({
        eventTypes: path.steps.map((step) => step.event.type),
        weight: path.weight,
        context: path.state.context,
        matchesC: path.state.matches('c'),
      })),
    ).toEqual([
      {
        eventTypes: ['@xstate.init', 'NEXT', 'NEXT'],
        weight: 2,
        context: { count: 0 },
        matchesC: true,
      },
    ])
  })

  it('finds the shortest paths from a state to another state', function*({ expect }) {
    const m = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'a',
      context: { count: 0 },
      states: {
        a: {
          on: {
            TO_Y: { target: 'y' },
            TO_B: { target: 'b' },
          },
        },
        b: {
          on: {
            NEXT_B_TO_X: { target: 'x' },
          },
        },
        x: {
          on: {
            NEXT_X_TO_Y: { target: 'y' },
          },
        },
        y: {},
      },
    })

    const pathsToB = getShortestPaths(m, {
      toState: (state) => state.matches('b'),
    })
    const paths = pathsToB.flatMap((path) => {
      const pathsToY = getShortestPaths(m, {
        fromState: path.state,
        toState: (state) => state.matches('y'),
      })

      return pathsToY.map((pathToY) => {
        return joinPaths(path, pathToY)
      })
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([
      ['@xstate.init', 'TO_B', 'NEXT_B_TO_X', 'NEXT_X_TO_Y'],
    ])
  })

  it('handles event cases', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          todos: z.array(z.string()),
        }),
        events: {
          'todo.add': z.object({
            todo: z.string(),
          }),
        },
      },
      context: {
        todos: [],
      },
      on: {
        'todo.add': ({ context, event }) => ({
          context: {
            todos: context.todos.concat(event.todo),
          },
        }),
      },
    })

    const shortestPaths = getShortestPaths(machine, {
      events: [
        {
          type: 'todo.add',
          todo: 'one',
        } as const,
        {
          type: 'todo.add',
          todo: 'two',
        } as const,
      ],
      stopWhen: (state) => state.context.todos.length >= 3,
    })

    const pathWithTwoTodos = shortestPaths.filter(
      (path) =>
        path.state.context.todos.includes('one') &&
        path.state.context.todos.includes('two'),
    )

    yield* expect(
      pathWithTwoTodos.map((path) => path.state.context.todos.join('|')).sort(),
    ).toEqual([
      'one|one|two',
      'one|two',
      'one|two|one',
      'one|two|two',
      'two|one',
      'two|one|one',
      'two|one|two',
      'two|two|one',
    ])
  })

  it('should work for machines with delays', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          after: {
            1000: { target: 'b' },
          },
        },
        b: {},
      },
    })

    const shortestPaths = getShortestPaths(machine)

    yield* expect(shortestPaths.map((p) => p.steps.map((s) => s.event.type)))
      .toEqual([
        ['@xstate.init'],
        ['@xstate.init', 'xstate.after'],
      ])
  })
})
