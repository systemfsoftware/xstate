import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createMachine } from '../../index.js'
import { getPathsFromEvents, getShortestPaths, getSimplePaths } from '../index.js'
import type { StatePath } from '../index.js'

describe('die hard example', () => {
  class Jugs {
    public version = 0
    public three = 0
    public five = 0

    public fillThree() {
      this.three = 3
    }
    public fillFive() {
      this.five = 5
    }
    public emptyThree() {
      this.three = 0
    }
    public emptyFive() {
      this.five = 0
    }
    public transferThree() {
      const poured = Math.min(5 - this.five, this.three)

      this.three = this.three - poured
      this.five = this.five + poured
    }
    public transferFive() {
      const poured = Math.min(3 - this.three, this.five)

      this.three = this.three + poured
      this.five = this.five - poured
    }
  }

  const dieHardMachine = createMachine({
    schemas: {
      context: z.object({
        three: z.number(),
        five: z.number(),
      }),
    },
    id: 'dieHard',
    initial: 'pending',
    context: { three: 0, five: 0 },
    states: {
      pending: {
        always: ({ context }) => {
          if (context.five === 4) {
            return {
              target: 'success',
            }
          }
          return undefined
        },
        on: {
          POUR_3_TO_5: ({ context }) => {
            const poured = Math.min(5 - context.five, context.three)

            return {
              context: {
                three: context.three - poured,
                five: context.five + poured,
              },
            }
          },
          POUR_5_TO_3: ({ context }) => {
            const poured = Math.min(3 - context.three, context.five)

            return {
              context: {
                three: context.three + poured,
                five: context.five - poured,
              },
            }
          },

          FILL_3: () => ({
            context: {
              three: 3,
            },
          }),

          FILL_5: () => ({
            context: {
              five: 5,
            },
          }),

          EMPTY_3: () => ({
            context: {
              three: 0,
            },
          }),
          EMPTY_5: () => ({
            context: {
              five: 0,
            },
          }),
        },
      },
      success: {
        type: 'final',
      },
    },
  })

  const newJugs = (): Jugs => {
    const jugs = new Jugs()
    jugs.version = Math.random()
    return jugs
  }

  const actionsFor = (jugs: Jugs): Record<string, () => void> => ({
    POUR_3_TO_5: () => jugs.transferThree(),
    POUR_5_TO_3: () => jugs.transferFive(),
    EMPTY_3: () => jugs.emptyThree(),
    EMPTY_5: () => jugs.emptyFive(),
    FILL_3: () => jugs.fillThree(),
    FILL_5: () => jugs.fillFive(),
  })

  function replay(jugs: Jugs, path: StatePath<any, any>) {
    const actions = actionsFor(jugs)
    const observed: Array<[number, number]> = []
    const predicted: Array<[number, number]> = []

    for (const step of path.steps) {
      actions[step.event.type]?.()
      observed.push([jugs.three, jugs.five])
      predicted.push([step.state.context.three, step.state.context.five])
    }

    return {
      observed,
      predicted,
      matchesSuccess: path.state.matches('success'),
      five: jugs.five,
    }
  }

  function describePath(path: StatePath<any, any>): string {
    return path.steps.map((step) => step.event.type).join(' → ')
  }

  describe('shortest paths to success', () => {
    const paths = getShortestPaths(dieHardMachine, {
      toState: (state) => state.matches('success'),
    })

    it('should generate the right number of paths', function*({ expect }) {
      yield* expect(paths.length).toEqual(2)
    })

    paths.forEach((path) => {
      it(`replays ${describePath(path)}`, function*({ expect }) {
        const { observed, predicted, matchesSuccess, five } = replay(newJugs(), path)

        yield* expect({
          threeByStep: observed.map(([three]) => three),
          fiveByStep: observed.map(([, amount]) => amount),
          matchesSuccess,
          five,
        }).toEqual({
          threeByStep: predicted.map(([three]) => three),
          fiveByStep: predicted.map(([, amount]) => amount),
          matchesSuccess: true,
          five: 4,
        })
      })
    })
  })

  describe('simple paths to success', () => {
    const paths = getSimplePaths(dieHardMachine, {
      toState: (state) => state.matches('success'),
    })

    it('should generate the right number of paths', function*({ expect }) {
      yield* expect(paths.length).toEqual(14)
    })

    paths.forEach((path) => {
      it(`replays ${describePath(path)}`, function*({ expect }) {
        const { observed, predicted, matchesSuccess, five } = replay(newJugs(), path)

        yield* expect({
          threeByStep: observed.map(([three]) => three),
          fiveByStep: observed.map(([, amount]) => amount),
          matchesSuccess,
          five,
        }).toEqual({
          threeByStep: predicted.map(([three]) => three),
          fiveByStep: predicted.map(([, amount]) => amount),
          matchesSuccess: true,
          five: 4,
        })
      })
    })
  })

  describe('paths from events', () => {
    const [path] = getPathsFromEvents(
      dieHardMachine,
      [
        { type: 'FILL_5' },
        { type: 'POUR_5_TO_3' },
        { type: 'EMPTY_3' },
        { type: 'POUR_5_TO_3' },
        { type: 'FILL_5' },
        { type: 'POUR_5_TO_3' },
      ],
      { toState: (state) => state.matches('success') },
    )

    it('replays the path', function*({ expect }) {
      if (path === undefined) {
        throw new Error('expected a path')
      }

      const { observed, predicted, matchesSuccess, five } = replay(newJugs(), path)

      yield* expect({
        threeByStep: observed.map(([three]) => three),
        fiveByStep: observed.map(([, amount]) => amount),
        matchesSuccess,
        five,
      }).toEqual({
        threeByStep: predicted.map(([three]) => three),
        fiveByStep: predicted.map(([, amount]) => amount),
        matchesSuccess: true,
        five: 4,
      })
    })

    it('should return no paths if the target does not match the last entered state', function*({ expect }) {
      const paths = getPathsFromEvents(dieHardMachine, [{ type: 'FILL_5' }], {
        toState: (state) => state.matches('success'),
      })

      yield* expect(paths).toEqual([])
    })
  })

  describe('simple paths with a narrower target', () => {
    const paths = getSimplePaths(dieHardMachine, {
      toState: (state) => state.matches('success') && state.context.three === 0,
    })

    it('should generate the right number of paths', function*({ expect }) {
      yield* expect(paths.length).toEqual(6)
    })

    paths.forEach((path) => {
      it(`replays ${describePath(path)}`, function*({ expect }) {
        const { observed, predicted, matchesSuccess, five } = replay(newJugs(), path)

        yield* expect({
          threeByStep: observed.map(([three]) => three),
          fiveByStep: observed.map(([, amount]) => amount),
          matchesSuccess,
          five,
        }).toEqual({
          threeByStep: predicted.map(([three]) => three),
          fiveByStep: predicted.map(([, amount]) => amount),
          matchesSuccess: true,
          five: 4,
        })
      })
    })
  })
})
