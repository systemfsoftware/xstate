import { it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { initialTransition, transition } from '../src/index.js'
import { createMachine } from '../src/index.js'

it('should work with fn targets', function*({ expect }) {
  const machine = createMachine({
    initial: 'active',
    states: {
      active: {
        on: {
          toggle: () => ({ target: 'inactive' }),
        },
      },
      inactive: {},
    },
  })

  const [initialState] = initialTransition(machine)

  const [nextState] = transition(machine, initialState, { type: 'toggle' })

  yield* expect(nextState.value).toEqual('inactive')
})

it('should work with fn actions', function*({ expect }) {
  const machine = createMachine({
    initial: 'active',
    states: {
      active: {
        on: {
          toggle: (_args, enq) => {
            enq.emit({ type: 'something' })
          },
        },
      },
      inactive: {},
    },
  })

  const [initialState] = initialTransition(machine)

  const [, actions] = transition(machine, initialState, { type: 'toggle' })

  yield* expect(actions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'something',
      }),
    ]),
  )
})

it('should work with both fn actions and target', function*({ expect }) {
  const machine = createMachine({
    initial: 'active',
    states: {
      active: {
        on: {
          toggle: (_args, enq) => {
            enq.emit({ type: 'something' })

            return {
              target: 'inactive',
            }
          },
        },
      },
      inactive: {},
    },
  })

  const [initialState] = initialTransition(machine)

  const [nextState, actions] = transition(machine, initialState, {
    type: 'toggle',
  })

  yield* expect({
    actions,
    value: nextState.value,
  }).toEqual({
    actions: expect.arrayContaining([
      expect.objectContaining({
        type: 'something',
      }),
    ]),
    value: 'inactive',
  })
})

it('should work with conditions', function*({ expect }) {
  const machine = createMachine({
    schemas: {
      context: z.object({
        count: z.number(),
      }),
    },
    initial: 'active',
    context: {
      count: 0,
    },
    states: {
      active: {
        on: {
          increment: ({ context }) => ({
            context: {
              count: context.count + 1,
            },
          }),
          toggle: ({ context }, enq) => {
            enq.emit({ type: 'something' })

            if (context.count > 0) {
              return { target: 'inactive' }
            }

            enq.emit({ type: 'invalid' })

            return undefined
          },
        },
      },
      inactive: {},
    },
  })

  const [initialState] = initialTransition(machine)

  const [nextState, actions] = transition(machine, initialState, {
    type: 'toggle',
  })

  const [nextState2] = transition(machine, nextState, {
    type: 'increment',
  })

  const [nextState3, actions3] = transition(machine, nextState2, {
    type: 'toggle',
  })

  yield* expect({
    atActive: { actions, value: nextState.value },
    atInactive: { actions: actions3, value: nextState3.value },
  }).toEqual({
    atActive: {
      actions: expect.arrayContaining([
        expect.objectContaining({
          type: 'something',
        }),
        expect.objectContaining({
          type: 'invalid',
        }),
      ]),
      value: 'active',
    },
    atInactive: {
      actions: expect.arrayContaining([
        expect.objectContaining({
          type: 'something',
        }),
      ]),
      value: 'inactive',
    },
  })
})
