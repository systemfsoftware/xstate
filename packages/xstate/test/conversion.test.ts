import { describe, it } from '@systemfsoftware/vitest'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import { initialTransition, transition } from '../src/transition.js'

describe('createMachineFromConfig', () => {
  it('should create a machine from a JSON config', function*({ expect }) {
    const machine = createMachineFromConfig(
      {
        context: { count: 42 },
        initial: 'a',
        states: {
          a: {
            entry: [{ type: '@xstate.assign', context: { count: 42 } }],
            on: {
              INC: {
                actions: [{ type: '@xstate.assign', context: { count: 43 } }],
              },
              DEC: {
                actions: [{ type: '@xstate.assign', context: { count: 41 } }],
              },
              NEXT: {
                actions: [{ type: '@xstate.assign', context: { count: 0 } }],
                target: 'b',
              },
              COND_NEXT: {
                guard: { type: 'customGuard' },
                target: 'c',
              },
            },
          },
          b: {
            on: {
              BACK: { target: 'a' },
            },
          },
          c: {},
        },
      },
      {
        guards: {
          customGuard: () => true,
        },
      },
    )

    const stateA = machine.root.states['a']

    const [initialState] = initialTransition(machine)
    const initial = [initialState.value, { ...initialState.context }]
    const [nextState] = transition(machine, initialState, { type: 'NEXT' })
    const next = [nextState.value, { ...nextState.context }]
    const [nextState2] = transition(machine, nextState, { type: 'BACK' })
    const back = [nextState2.value, { ...nextState2.context }]
    const [nextState3] = transition(machine, nextState2, { type: 'COND_NEXT' })
    const cond = [nextState3.value, { ...nextState3.context }]

    yield* expect({
      stateKeys: Object.keys(machine.root.states),
      stateAEvents: Object.keys(stateA?.on ?? {}),
      initial,
      next,
      back,
      cond,
    }).toEqual({
      stateKeys: ['a', 'b', 'c'],
      stateAEvents: ['INC', 'DEC', 'NEXT', 'COND_NEXT'],
      initial: ['a', { count: 42 }],
      next: ['b', { count: 0 }],
      back: ['a', { count: 42 }],
      cond: ['c', { count: 42 }],
    })
  })
})
