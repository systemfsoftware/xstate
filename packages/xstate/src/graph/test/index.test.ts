import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createMachine } from '../../index.js'
import { getShortestPaths } from '../index.js'

const thrownBy = (run: () => unknown): unknown => {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}

describe('events', () => {
  it('should allow for dynamic generation of cases based on state', function*({ expect }) {
    const values = [1, 2, 3]
    const testMachine = createMachine({
      schemas: {
        context: z.object({
          values: z.array(z.number()),
        }),
        events: {
          EVENT: z.object({ value: z.number() }),
        },
      },
      initial: 'a',
      context: {
        values,
      },
      states: {
        a: {
          on: {
            EVENT: ({ event }) => {
              if (event.value === 1) {
                return { target: 'b' }
              }
              if (event.value === 2) {
                return { target: 'c' }
              }
              return { target: 'd' }
            },
          },
        },
        b: {},
        c: {},
        d: {},
      },
    })

    const paths = getShortestPaths(testMachine, {
      events: (state) => state.context.values.map((value) => ({ type: 'EVENT', value }) as const),
    })

    yield* expect(
      paths
        .filter((path) => path.steps.length > 1)
        .map((path) => {
          const step = path.steps[1]
          if (step === undefined) {
            throw new Error('expected a second step')
          }
          return step.event
        }),
    ).toEqual([
      {
        type: 'EVENT',
        value: 1,
      },
      {
        type: 'EVENT',
        value: 2,
      },
      {
        type: 'EVENT',
        value: 3,
      },
    ])
  })
})

describe('state limiting', () => {
  it('should limit states with stopWhen option', function*({ expect }) {
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
            INC: ({ context }) => {
              return {
                context: {
                  count: context.count + 1,
                },
              }
            },
          },
        },
      },
    })

    const paths = getShortestPaths(machine, {
      stopWhen: (state) => {
        return state.context.count >= 5
      },
    })

    yield* expect(paths.map((path) => path.state.context.count)).toEqual([
      0,
      1,
      2,
      3,
      4,
      5,
    ])
  })
})

// https://github.com/statelyai/xstate/issues/1935
it('prevents infinite recursion based on a provided limit', function*({ expect }) {
  const machine = createMachine({
    schemas: {
      context: z.object({
        count: z.number(),
      }),
    },
    id: 'machine',
    context: {
      count: 0,
    },
    on: {
      TOGGLE: ({ context }) => ({
        context: {
          count: context.count + 1,
        },
      }),
    },
  })

  const error = thrownBy(() => {
    getShortestPaths(machine, { limit: 100 })
  })

  yield* expect(
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: typeof error, message: 'no error was thrown' },
  ).toEqual({
    name: 'Error',
    message: 'Traversal limit exceeded',
  })
})

it('should traverse with input', function*({ expect }) {
  const machine = createMachine({
    schemas: {
      input: z.object({
        name: z.string(),
      }),
      context: z.object({
        name: z.string(),
      }),
    },
    context: (x) => ({
      name: x.input.name,
    }),
    initial: 'checking',
    states: {
      checking: {
        always: ({ context }) => {
          if (context.name.length > 3) {
            return { target: 'longName' }
          }
          return { target: 'shortName' }
        },
      },
      longName: {},
      shortName: {},
    },
  })

  const path1 = getShortestPaths(machine, {
    input: { name: 'ed' },
  })

  const firstPath1 = path1[0]
  if (firstPath1 === undefined) {
    throw new Error('expected a first path')
  }

  const path2 = getShortestPaths(machine, {
    input: { name: 'edward' },
  })

  const firstPath2 = path2[0]
  if (firstPath2 === undefined) {
    throw new Error('expected a first path')
  }

  yield* expect({
    shortName: firstPath1.steps.map((s) => s.state.value),
    longName: firstPath2.steps.map((s) => s.state.value),
  }).toEqual({
    shortName: ['shortName'],
    longName: ['longName'],
  })
})
