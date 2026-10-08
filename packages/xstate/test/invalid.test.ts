import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, transition } from '../src/index.js'

describe('invalid or resolved states', () => {
  it('should resolve a String state', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {},
            A2: {},
          },
        },
        B: {
          initial: 'B1',
          states: {
            B1: {},
            B2: {},
          },
        },
      },
    })
    yield* expect(
      transition(machine, machine.resolveState({ value: 'A' }), {
        type: 'E',
      })[0].value,
    ).toEqual({
      A: 'A1',
      B: 'B1',
    })
  })

  it('should resolve transitions from empty states', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {},
            A2: {},
          },
        },
        B: {
          initial: 'B1',
          states: {
            B1: {},
            B2: {},
          },
        },
      },
    })
    yield* expect(
      transition(machine, machine.resolveState({ value: { A: {}, B: {} } }), {
        type: 'E',
      })[0].value,
    ).toEqual({
      A: 'A1',
      B: 'B1',
    })
  })

  it('should allow transitioning from valid states', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {},
            A2: {},
          },
        },
        B: {
          initial: 'B1',
          states: {
            B1: {},
            B2: {},
          },
        },
      },
    })
    yield* expect(
      transition(machine, machine.resolveState({ value: { A: 'A1', B: 'B1' } }), {
        type: 'E',
      })[0].value,
    ).toEqual({
      A: 'A1',
      B: 'B1',
    })
  })

  it('should reject transitioning from bad state configs', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {},
            A2: {},
          },
        },
        B: {
          initial: 'B1',
          states: {
            B1: {},
            B2: {},
          },
        },
      },
    })
    let thrown: unknown
    try {
      transition(
        machine,
        machine.resolveState({ value: { A: 'A3', B: 'B3' } }),
        { type: 'E' },
      )
    } catch (error) {
      thrown = error
    }
    yield* expect(
      thrown instanceof Error
        ? { name: thrown.name, message: thrown.message }
        : thrown,
    ).toEqual({
      name: 'Error',
      message: "State 'A3' does not exist on '(machine).A'",
    })
  })

  it('should resolve transitioning from partially valid states', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {},
            A2: {},
          },
        },
        B: {
          initial: 'B1',
          states: {
            B1: {},
            B2: {},
          },
        },
      },
    })
    yield* expect(
      transition(machine, machine.resolveState({ value: { A: 'A1', B: {} } }), {
        type: 'E',
      })[0].value,
    ).toEqual({
      A: 'A1',
      B: 'B1',
    })
  })
})

describe('invalid transition', () => {
  it('should throw when attempting to create a machine with a sibling target on the root node', function*({ expect }) {
    let thrown: unknown
    try {
      createMachine({
        id: 'direction',
        initial: 'left',
        states: {
          left: {},
          right: {},
        },
        on: {
          LEFT_CLICK: { target: 'left' },
          RIGHT_CLICK: { target: 'right' },
        },
      })
    } catch (error) {
      thrown = error
    }
    yield* expect(
      thrown instanceof Error
        ? { name: thrown.name, message: thrown.message }
        : thrown,
    ).toEqual({
      name: 'Error',
      message: 'Invalid target: "left" is not a valid target from the root node. Did you mean ".left"?',
    })
  })
})
