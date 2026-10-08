import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import { createActor, initialTransition, transition } from '../src/index.js'

const thrownError = (run: () => unknown): { name: string; message: string } => {
  try {
    run()
  } catch (error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message }
    }
    return { name: typeof error, message: String(error) }
  }
  return { name: 'no error thrown', message: 'no error thrown' }
}

describe('createMachineFromConfig ', () => {
  it('rejects history states without a non-empty default target', function*({ expect }) {
    const withoutTarget = thrownError(() =>
      createMachineFromConfig({
        initial: 'on',
        states: {
          on: {
            initial: 'active',
            states: {
              active: {},
              history: { type: 'history' },
            },
          },
        },
      })
    )

    const withEmptyTarget = thrownError(() =>
      createMachineFromConfig({
        initial: 'on',
        states: {
          on: {
            initial: 'active',
            states: {
              active: {},
              history: {
                type: 'history',
                // @ts-expect-error - runtime JSON can still contain an empty array
                target: [],
              },
            },
          },
        },
      })
    )

    yield* expect({ withoutTarget, withEmptyTarget }).toEqual({
      withoutTarget: {
        name: 'Error',
        message: 'History state at $.states.on.states.history must declare a non-empty target.',
      },
      withEmptyTarget: {
        name: 'Error',
        message: 'History state at $.states.on.states.history must declare a non-empty target.',
      },
    })
  })

  it('rejects SCXML-illegal multi-target transitions at construction', function*({ expect }) {
    yield* expect(() =>
      createMachineFromConfig({
        initial: 'idle',
        states: {
          idle: {
            on: {
              GO: { target: ['parallel.left.a', 'parallel.left.b'] },
            },
          },
          parallel: {
            type: 'parallel',
            states: {
              left: { initial: 'a', states: { a: {}, b: {} } },
              right: { initial: 'c', states: { c: {}, d: {} } },
            },
          },
        },
      })
    ).toThrow(
      "Invalid transition definition for state node '(machine).idle': target set is not a legal SCXML configuration.",
    )
  })

  it('should create a machine from a config', function*({ expect }) {
    const machine = createMachineFromConfig({
      initial: 'a',
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
        c: {},
      },
    })
    const [initialState] = initialTransition(machine)
    const [nextState] = transition(machine, initialState, { type: 'NEXT' })
    const [nextState2] = transition(machine, nextState, { type: 'NEXT' })

    yield* expect({
      initial: initialState.value,
      next: nextState.value,
      next2: nextState2.value,
    }).toEqual({ initial: 'a', next: 'b', next2: 'c' })
  })

  it('does not merge actor input into native JSON machine context', function*({ expect }) {
    const machine = createMachineFromConfig({
      context: { count: 0 },
      initial: 'idle',
      states: { idle: {} },
    })
    const actor = createActor(machine, {
      input: { count: 5, extra: true },
    }).start()

    yield* expect(actor.getSnapshot().context).toEqual({ count: 0 })
  })

  it('should handle raise actions', function*({ expect }) {
    const machine = createMachineFromConfig({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: {
              actions: [{ type: '@xstate.raise', event: { type: 'TO_B' } }],
            },
            TO_B: { target: 'b' },
          },
        },
        b: {},
      },
    })
    const [initialState] = initialTransition(machine)
    const [nextState] = transition(machine, initialState, { type: 'NEXT' })

    yield* expect({
      initial: initialState.value,
      next: nextState.value,
    }).toEqual({ initial: 'a', next: 'b' })
  })

  it('should handle emit actions', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachineFromConfig({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: {
              actions: [
                {
                  type: '@xstate.emit',
                  event: { type: 'EMITTED', msg: 'hello' },
                },
              ],
            },
          },
        },
      },
    })

    const emitted: unknown[] = []
    const actor = createActor(machine)
    actor.on('EMITTED', (ev) => {
      emitted.push(ev['msg'])
      resolve()
    })
    actor.start()
    actor.send({ type: 'NEXT' })
    yield* Effect.promise(() => promise)

    yield* expect(emitted).toEqual(['hello'])
  })
})
