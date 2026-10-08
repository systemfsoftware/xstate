import { describe, it } from '@systemfsoftware/vitest'
import { createMachine } from '@systemfsoftware/xstate'
import { types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as DateTime from 'effect/DateTime'
import {
  checkLinearizable,
  type LinearizabilityEntry,
  runParallelPropertyCommands,
} from '../../src/engine/propertyLinearizability.js'

type RegisterEvent =
  | { type: 'write'; value: number }
  | { type: 'read' }
  | { type: 'inc' }

const registerModel = {
  initial: 0,
  apply: (state: number, event: RegisterEvent) => {
    switch (event.type) {
      case 'write':
        return { state: event.value, response: undefined }
      case 'inc':
        return { state: state + 1, response: state + 1 }
      default:
        return { state, response: state }
    }
  },
}

describe('checkLinearizable', () => {
  it('accepts a history that has a valid sequential order', function*({ expect }) {
    const history: LinearizabilityEntry<RegisterEvent>[] = [
      {
        id: 'a',
        invocation: { type: 'write', value: 1 },
        response: undefined,
        start: 0,
        end: 4,
      },
      { id: 'b', invocation: { type: 'read' }, response: 1, start: 1, end: 5 },
      { id: 'c', invocation: { type: 'read' }, response: 1, start: 6, end: 7 },
    ]

    const result = checkLinearizable(history, registerModel)

    yield* expect({
      linearizable: result.linearizable,
      truncated: result.truncated,
      witness: result.witness?.map((entry) => entry.id),
    }).toEqual({
      linearizable: true,
      truncated: false,
      witness: ['a', 'b', 'c'],
    })
  })

  it('rejects a stale read that no sequential order explains', function*({ expect }) {
    const history: LinearizabilityEntry<RegisterEvent>[] = [
      {
        id: 'a',
        invocation: { type: 'write', value: 1 },
        response: undefined,
        start: 0,
        end: 1,
      },
      { id: 'b', invocation: { type: 'read' }, response: 0, start: 2, end: 3 },
    ]

    const result = checkLinearizable(history, registerModel)

    yield* expect({
      linearizable: result.linearizable,
      witness: result.witness,
      truncated: result.truncated,
    }).toEqual({
      linearizable: false,
      witness: undefined,
      truncated: false,
    })
  })

  it('reorders concurrent operations to find a witness', function*({ expect }) {
    const history: LinearizabilityEntry<RegisterEvent>[] = [
      {
        id: 'a',
        invocation: { type: 'write', value: 1 },
        response: undefined,
        start: 0,
        end: 10,
      },
      { id: 'b', invocation: { type: 'read' }, response: 0, start: 1, end: 9 },
    ]

    const result = checkLinearizable(history, registerModel)

    yield* expect({
      linearizable: result.linearizable,
      witness: result.witness?.map((entry) => entry.id),
    }).toEqual({
      linearizable: true,
      witness: ['b', 'a'],
    })
  })

  it('compares responses by Date, Map and Set contents', function*({ expect }) {
    const dateModel = {
      initial: 0,
      apply: (state: number) => ({
        state,
        response: {
          at: DateTime.toDate(DateTime.makeUnsafe(0)),
          tags: new Map([['a', 1]]),
          ids: new Set([1]),
        },
      }),
    }
    const entry = (
      response: unknown,
    ): LinearizabilityEntry<{ type: 'read' }> => ({
      id: 'a',
      invocation: { type: 'read' },
      response,
      start: 0,
      end: 1,
    })
    const expected = {
      at: DateTime.toDate(DateTime.makeUnsafe(0)),
      tags: new Map([['a', 1]]),
      ids: new Set([1]),
    }

    yield* expect([
      checkLinearizable([entry(expected)], dateModel).linearizable,
      checkLinearizable(
        [entry({ ...expected, at: DateTime.toDate(DateTime.makeUnsafe(1)) })],
        dateModel,
      ).linearizable,
      checkLinearizable(
        [entry({ ...expected, tags: new Map([['a', 2]]) })],
        dateModel,
      ).linearizable,
      checkLinearizable([entry({ ...expected, ids: new Set([2]) })], dateModel)
        .linearizable,
    ]).toEqual([true, false, false, false])
  })

  it('reports truncation when the exploration bound is hit', function*({ expect }) {
    const history: LinearizabilityEntry<RegisterEvent>[] = Array.from(
      { length: 6 },
      (_, index) => ({
        id: index,
        invocation: { type: 'inc' } as RegisterEvent,
        response: index + 1,
        start: 0,
        end: 100,
      }),
    )

    const result = checkLinearizable(history, registerModel, {
      maxExplored: 3,
    })

    yield* expect({
      linearizable: result.linearizable,
      truncated: result.truncated,
      exploredWithinBound: result.explored <= 3,
      unboundedLinearizable: checkLinearizable(history, registerModel)
        .linearizable,
    }).toEqual({
      linearizable: false,
      truncated: true,
      exploredWithinBound: true,
      unboundedLinearizable: true,
    })
  })
})

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

const tick = (ticks: number): Promise<void> => {
  let chain = Promise.resolve()
  for (let index = 0; index < ticks; index++) {
    chain = chain.then(() => undefined)
  }
  return chain
}

describe('runParallelPropertyCommands', () => {
  it('passes for an atomic counter', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      runParallelPropertyCommands(counterMachine, {
        prefix: [{ type: 'INC' }],
        branches: [[{ type: 'INC' }, { type: 'INC' }], [{ type: 'INC' }]],
        sut: {
          create: () => {
            let count = 0
            return {
              send: () => {
                const observed = ++count
                return tick(1).then(() => observed)
              },
            }
          },
          projectModel: (snapshot) => snapshot.context.count,
        },
      })
    )

    yield* expect({
      historyLength: result.history.length,
      linearizable: result.linearizable,
      truncated: result.truncated,
    }).toEqual({
      historyLength: 3,
      linearizable: true,
      truncated: false,
    })
  })

  it('fails for a counter with a non-atomic read-modify-write', function*({ expect }) {
    const result = yield* Effect.promise(() =>
      runParallelPropertyCommands(counterMachine, {
        prefix: [{ type: 'INC' }],
        branches: [
          [{ type: 'INC' }, { type: 'INC' }],
          [{ type: 'INC' }, { type: 'INC' }],
        ],
        sut: {
          create: () => {
            let count = 0
            return {
              send: () => {
                const read = count
                return tick(2).then(() => {
                  count = read + 1
                  return count
                })
              },
            }
          },
          projectModel: (snapshot) => snapshot.context.count,
        },
      })
    )

    yield* expect({
      linearizable: result.linearizable,
      truncated: result.truncated,
    }).toEqual({
      linearizable: false,
      truncated: false,
    })
  })
})
