import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, type EventObject, type Snapshot } from '@systemfsoftware/xstate'
import type { StatePath } from '@systemfsoftware/xstate/graph'
import {
  createTestCoverage,
  finalizeTestCoverage,
  type MutableTestCoverage,
  recordPropertyTransitions,
} from '../../src/engine/coverage.js'
import { deduplicatePaths } from '../../src/engine/deduplicatePaths.js'
import { simpleStringify } from '../../src/engine/utils.js'

type AnyPath = StatePath<Snapshot<unknown>, EventObject>

const dummyState = {} as unknown as Snapshot<unknown>

function deduplicatePathsOracle(
  paths: AnyPath[],
  serializeEvent: (event: EventObject) => string = simpleStringify,
): AnyPath[] {
  const all = paths.map((path) => ({
    path,
    eventSequence: path.steps.map((step) => serializeEvent(step.event)),
  }))
  all.sort((a, z) => z.path.steps.length - a.path.steps.length)
  const superpaths: typeof all = []
  pathLoop: for (const candidate of all) {
    superpathLoop: for (const superpath of superpaths) {
      for (let i = 0; i < candidate.eventSequence.length; i++) {
        if (candidate.eventSequence[i] !== superpath.eventSequence[i]) {
          continue superpathLoop
        }
      }
      continue pathLoop
    }
    superpaths.push(candidate)
  }
  return superpaths.map((entry) => entry.path)
}

function createRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
}

function randomPaths(
  random: () => number,
  count: number,
  maxLength: number,
  alphabet: number,
): AnyPath[] {
  return Array.from({ length: count }, (_, index) => ({
    state: { index } as unknown as Snapshot<unknown>,
    weight: 0,
    steps: Array.from(
      { length: Math.floor(random() * (maxLength + 1)) },
      () => ({
        state: dummyState,
        event: { type: `E${Math.floor(random() * alphabet)}` },
      }),
    ),
  }))
}

function getPairUniverse(coverage: MutableTestCoverage) {
  return finalizeTestCoverage(coverage).transitionPairs
}

describe('transition pair universe', () => {
  it('does not declare pairs involving dynamic transitions', function*({ expect }) {
    const machine = createMachine({
      id: 'dyn',
      initial: 'a',
      context: { next: 'b' as 'a' | 'b' },
      states: {
        a: {
          on: {
            GO: { target: 'b' },
            JUMP: ({ context }) => ({ target: context.next }),
          },
        },
        b: {
          on: { BACK: { target: 'a' } },
        },
      },
    })

    const coverage = createTestCoverage(machine)
    const pairs = getPairUniverse(coverage)
    const declared = [...coverage.transitionPairs.declarations.keys()]
    const jump = [...coverage.transitions.declarations.keys()].find((id) => id.includes('JUMP'))!

    const a = machine.root.states['a']
    if (a === undefined) {
      throw new Error('expected state node "a"')
    }
    const b = machine.root.states['b']
    if (b === undefined) {
      throw new Error('expected state node "b"')
    }
    const goTransition = a.transitions.get('GO')?.[0]
    if (goTransition === undefined) {
      throw new Error('expected a GO transition')
    }
    const jumpTransition = a.transitions.get('JUMP')?.[0]
    if (jumpTransition === undefined) {
      throw new Error('expected a JUMP transition')
    }
    const backTransition = b.transitions.get('BACK')?.[0]
    if (backTransition === undefined) {
      throw new Error('expected a BACK transition')
    }

    const idOf = (transition: { source: { id: string } }, event: string) =>
      JSON.stringify(['transition', transition.source.id, event, 0])
    const goId = idOf(goTransition, 'GO')
    const jumpId = idOf(jumpTransition, 'JUMP')
    const backId = idOf(backTransition, 'BACK')

    recordPropertyTransitions(coverage, { type: 'GO' }, [goTransition])
    recordPropertyTransitions(coverage, { type: 'JUMP' }, [jumpTransition])
    const observed = getPairUniverse(coverage)

    yield* expect({
      jump,
      declaredCount: declared.length,
      declaresJump: declared.some((id) => id.includes(jump)),
      declared: [...declared].sort(),
      pairsUnknown: pairs.unknown,
      pairsTruncated: pairs.truncated,
      observedCoveredCount: observed.covered.length,
      observedCovered: observed.covered,
      observedUnknown: observed.unknown,
    }).toEqual({
      jump: jumpId,
      declaredCount: 2,
      declaresJump: false,
      declared: [`${goId} -> ${backId}`, `${backId} -> ${goId}`].sort(),
      pairsUnknown: [],
      pairsTruncated: false,
      observedCoveredCount: 1,
      observedCovered: [`${goId} -> ${jumpId}`],
      observedUnknown: [],
    })
  })

  it('caps the declared universe and reports truncation', function*({ expect }) {
    const size = 60
    const states: Record<string, { on: Record<string, { target: string }> }> = {}
    for (let i = 0; i < size; i++) {
      const on: Record<string, { target: string }> = {}
      for (let j = 0; j < 6; j++) {
        on[`E${j}`] = { target: `s${(i + j + 1) % size}` }
      }
      states[`s${i}`] = { on }
    }
    const machine = createMachine({ id: 'big', initial: 's0', states })

    const coverage = createTestCoverage(machine)
    const pairs = getPairUniverse(coverage)

    yield* expect({
      truncated: pairs.truncated,
      declaredSize: coverage.transitionPairs.declarations.size,
      declaredSizePositive: coverage.transitionPairs.declarations.size > 0,
      declaredSizeWithinLimit: coverage.transitionPairs.declarations.size <= 2000,
    }).toEqual({
      truncated: true,
      declaredSize: 2000,
      declaredSizePositive: true,
      declaredSizeWithinLimit: true,
    })
  })
})

describe('deduplicatePaths', () => {
  it('matches the previous implementation on random path sets', function*({ expect }) {
    const random = createRandom(42)
    const actuals: AnyPath[][] = []
    const expecteds: AnyPath[][] = []
    for (let round = 0; round < 200; round++) {
      const paths = randomPaths(
        random,
        1 + Math.floor(random() * 40),
        Math.floor(random() * 6),
        1 + Math.floor(random() * 3),
      )
      actuals.push(deduplicatePaths(paths))
      expecteds.push(deduplicatePathsOracle(paths))
    }

    yield* expect({
      actuals,
      actualRounds: actuals.length,
      sameReferences: actuals.every((actual, round) => {
        const expected = expecteds[round]
        if (expected === undefined) {
          return false
        }
        return (
          actual.length === expected.length &&
          actual.every((path, index) => path === expected[index])
        )
      }),
    }).toEqual({
      actuals: expecteds,
      actualRounds: expecteds.length,
      sameReferences: true,
    })
  })

  it('honors a custom event serializer', function*({ expect }) {
    const random = createRandom(7)
    const paths = randomPaths(random, 100, 5, 4)
    const serialize = (event: EventObject) => event.type.slice(0, 1)
    const actual = deduplicatePaths(paths, serialize)
    const expected = deduplicatePathsOracle(paths, serialize)

    yield* expect({
      actualCount: actual.length,
      sameReferences: actual.length === expected.length &&
        actual.every((path, index) => path === expected[index]),
    }).toEqual({ actualCount: 1, sameReferences: true })
  })

  it('handles empty inputs and empty paths', function*({ expect }) {
    const emptyInput = deduplicatePaths([])
    const empty: AnyPath[] = [
      { state: dummyState, weight: 0, steps: [] },
      { state: dummyState, weight: 0, steps: [] },
    ]
    const result = deduplicatePaths(empty)

    yield* expect({
      emptyInput,
      resultCount: result.length,
      keepsFirstReference: result[0] === empty[0],
    }).toEqual({ emptyInput: [], resultCount: 1, keepsFirstReference: true })
  })

  it('deduplicates thousands of paths quickly', function*({ expect }) {
    const paths = randomPaths(createRandom(1), 5000, 20, 3)
    const start = performance.now()
    const result = deduplicatePaths(paths)
    const elapsed = performance.now() - start

    yield* expect({
      hasPaths: result.length > 0,
      withinBudget: elapsed < 1000,
    }).toEqual({ hasPaths: true, withinBudget: true })
  })
})
