import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createCallbackLogic, createMachine, initialTransition, transition } from '../src/index.js'

const thrownSummary = (
  run: () => unknown,
): { readonly name: string; readonly message: string } | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: typeof error, message: String(error) }
  }
}

describe('deterministic machine', () => {
  const lightMachine = createMachine({
    initial: 'green',
    states: {
      green: {
        on: {
          TIMER: { target: 'yellow' },
          POWER_OUTAGE: { target: 'red' },
        },
      },
      yellow: {
        on: {
          TIMER: { target: 'red' },
          POWER_OUTAGE: { target: 'red' },
        },
      },
      red: {
        on: {
          TIMER: { target: 'green' },
          POWER_OUTAGE: { target: 'red' },
        },
        initial: 'walk',
        states: {
          walk: {
            on: {
              PED_COUNTDOWN: { target: 'wait' },
              TIMER: undefined,
            },
          },
          wait: {
            on: {
              PED_COUNTDOWN: { target: 'stop' },
              TIMER: undefined,
            },
          },
          stop: {},
        },
      },
    },
  })

  const testMachine = createMachine({
    initial: 'a',
    states: {
      a: {
        on: {
          T: { target: 'b.b1' },
          F: { target: 'c' },
        },
      },
      b: {
        initial: 'b1',
        states: {
          b1: {},
        },
      },
      c: {},
    },
  })

  describe('machine transitions', () => {
    it('should properly transition states based on event-like object', function*({ expect }) {
      yield* expect(
        transition(
          lightMachine,
          lightMachine.resolveState({ value: 'green' }),
          {
            type: 'TIMER',
          },
        )[0].value,
      ).toEqual('yellow')
    })

    it('should not transition states for illegal transitions', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: 'b' } },
          },
          b: {},
        },
      })

      const actor = createActor(machine).start()

      const previousSnapshot = actor.getSnapshot()

      actor.send({
        type: 'FAKE',
      })

      yield* expect({
        value: actor.getSnapshot().value,
        sameSnapshot: actor.getSnapshot() === previousSnapshot,
      }).toEqual({ value: 'a', sameSnapshot: true })
    })

    it('should throw an error if not given an event', function*({ expect }) {
      const missingEvent = undefined as never
      yield* expect(
        thrownSummary(() =>
          transition(
            lightMachine,
            testMachine.resolveState({ value: 'red' }) as never,
            missingEvent,
          )
        ),
      ).toEqual({
        name: 'Error',
        message: `State 'red' does not exist on '(machine)'`,
      })
    })

    it('should transition to nested states as target', function*({ expect }) {
      yield* expect(
        transition(testMachine, testMachine.resolveState({ value: 'a' }), {
          type: 'T',
        })[0].value,
      ).toEqual({
        b: 'b1',
      })
    })

    it('should throw an error for transitions from invalid states', function*({ expect }) {
      yield* expect(
        thrownSummary(() =>
          transition(testMachine, testMachine.resolveState({ value: 'fake' }), {
            type: 'T',
          })
        ),
      ).toEqual({
        name: 'Error',
        message: `State 'fake' does not exist on '(machine)'`,
      })
    })

    it('should throw an error for transitions from invalid substates', function*({ expect }) {
      yield* expect(
        thrownSummary(() =>
          transition(testMachine, testMachine.resolveState({ value: 'a.fake' }), {
            type: 'T',
          })
        ),
      ).toEqual({
        name: 'Error',
        message: `State 'a.fake' does not exist on '(machine)'`,
      })
    })

    it('should use the machine.initialState when an undefined state is given', function*({ expect }) {
      const [init] = initialTransition(lightMachine, undefined)
      yield* expect(
        transition(lightMachine, init, { type: 'TIMER' })[0].value,
      ).toEqual('yellow')
    })

    it('should use the machine.initialState when an undefined state is given (unhandled event)', function*({ expect }) {
      const [init] = initialTransition(lightMachine, undefined)
      yield* expect(
        transition(lightMachine, init, { type: 'TIMER' })[0].value,
      ).toEqual('yellow')
    })
  })

  describe('machine transition with nested states', () => {
    it('should properly transition a nested state', function*({ expect }) {
      yield* expect(
        transition(
          lightMachine,
          lightMachine.resolveState({ value: { red: 'walk' } }),
          { type: 'PED_COUNTDOWN' },
        )[0].value,
      ).toEqual({ red: 'wait' })
    })

    it('should transition from initial nested states', function*({ expect }) {
      yield* expect(
        transition(lightMachine, lightMachine.resolveState({ value: 'red' }), {
          type: 'PED_COUNTDOWN',
        })[0].value,
      ).toEqual({
        red: 'wait',
      })
    })

    it('should transition from deep initial nested states', function*({ expect }) {
      yield* expect(
        transition(lightMachine, lightMachine.resolveState({ value: 'red' }), {
          type: 'PED_COUNTDOWN',
        })[0].value,
      ).toEqual({
        red: 'wait',
      })
    })

    it('should bubble up events that nested states cannot handle', function*({ expect }) {
      yield* expect(
        transition(
          lightMachine,
          lightMachine.resolveState({ value: { red: 'stop' } }),
          { type: 'TIMER' },
        )[0].value,
      ).toEqual('green')
    })

    it('should not transition from illegal events', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            initial: 'b',
            states: {
              b: {
                on: { NEXT: { target: 'c' } },
              },
              c: {},
            },
          },
        },
      })

      const actor = createActor(machine).start()

      const previousSnapshot = actor.getSnapshot()

      actor.send({
        type: 'FAKE',
      })

      yield* expect({
        value: actor.getSnapshot().value,
        sameSnapshot: actor.getSnapshot() === previousSnapshot,
      }).toEqual({ value: { a: 'b' }, sameSnapshot: true })
    })

    it('should transition to the deepest initial state', function*({ expect }) {
      yield* expect(
        transition(
          lightMachine,
          lightMachine.resolveState({ value: 'yellow' }),
          {
            type: 'TIMER',
          },
        )[0].value,
      ).toEqual({
        red: 'walk',
      })
    })

    it('should return the same state if no transition occurs', function*({ expect }) {
      const [init] = initialTransition(lightMachine, undefined)
      const [initialState] = transition(lightMachine, init, {
        type: 'NOTHING',
      })
      const [nextState] = transition(lightMachine, initialState, {
        type: 'NOTHING',
      })

      yield* expect({
        initialValue: initialState.value,
        nextValue: nextState.value,
        sameState: nextState === initialState,
      }).toEqual({
        initialValue: 'green',
        nextValue: 'green',
        sameState: true,
      })
    })
  })

  describe('state key names', () => {
    const activity = createCallbackLogic(() => () => {})
    const machine = createMachine(
      {
        initial: 'test',
        states: {
          test: {
            invoke: { src: activity },
            entry: () => {},
            on: {
              NEXT: { target: 'test' },
            },
            exit: () => {},
          },
        },
      },
    )

    it('should work with substate nodes that have the same key', function*({ expect }) {
      const [init] = initialTransition(machine, undefined)
      yield* expect(transition(machine, init, { type: 'NEXT' })[0].value).toEqual(
        'test',
      )
    })
  })

  describe('forbidden events', () => {
    it('undefined transitions should forbid events', function*({ expect }) {
      const [walkState] = transition(
        lightMachine,
        lightMachine.resolveState({ value: { red: 'walk' } }),
        { type: 'TIMER' },
      )

      yield* expect(walkState.value).toEqual({ red: 'walk' })
    })
  })
})
