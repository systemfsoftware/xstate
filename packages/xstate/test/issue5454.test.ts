import { describe, it } from '@systemfsoftware/vitest'
import { createAsyncLogic, createMachine, initialTransition, transition } from '../src/index.js'

/**
 * Regression tests for: Bug #5454 `initialTransition` fails when invoke has a
 * registry key.
 *
 * Root cause: `createInertActorScope` called `createActor(logic)` which eagerly
 * ran `getInitialSnapshot` and registered child actors with `registryKey` in
 * the system. Then `initialTransition` called `getInitialSnapshot` again on the
 * same system, causing "Actor with registry key '...' already exists".
 */
describe('initialTransition / transition with invoke registryKey (issue #5454)', () => {
  it('does not throw when the initial state has an invoke with registryKey', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve(42) }),
            registryKey: 'myActor',
          },
        },
      },
    })

    yield* expect(initialTransition(machine)[0].value).toBe('idle')
  })

  it('returns the correct initial snapshot when invoke has registryKey', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve(42) }),
            registryKey: 'myActor',
          },
        },
      },
    })

    const [snapshot, actions] = initialTransition(machine)
    yield* expect({ value: snapshot.value, actionCount: actions.length }).toEqual({
      value: 'idle',
      actionCount: 2,
    })
  })

  it('is idempotent: repeated calls do not throw', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve(42) }),
            registryKey: 'myActor',
          },
        },
      },
    })

    initialTransition(machine)
    initialTransition(machine)
    yield* expect(initialTransition(machine)[0].value).toBe('idle')
  })

  it('transition() does not throw when the target state has an invoke with registryKey', function*({ expect }) {
    const countMachine = createMachine({})

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: { START: { target: 'running' } },
        },
        running: {
          invoke: {
            src: countMachine,
            registryKey: 'counter',
          },
        },
      },
    })

    const [initial] = initialTransition(machine)
    const [next] = transition(machine, initial, { type: 'START' })

    yield* expect(next.value).toBe('running')
  })

  it('works with multiple invokes each having a distinct registryKey', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          invoke: [
            {
              src: createAsyncLogic({ run: () => Promise.resolve(1) }),
              registryKey: 'actorOne',
            },
            {
              src: createAsyncLogic({ run: () => Promise.resolve(2) }),
              registryKey: 'actorTwo',
            },
          ],
        },
      },
    })

    const [firstSnapshot] = initialTransition(machine)
    const [snapshot] = initialTransition(machine)
    yield* expect({ firstValue: firstSnapshot.value, value: snapshot.value }).toEqual({
      firstValue: 'idle',
      value: 'idle',
    })
  })
})
