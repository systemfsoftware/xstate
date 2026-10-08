import { describe, it } from '@systemfsoftware/vitest'
import { createFSM } from '../src/fsm.js'

describe('createFSM', () => {
  it('transitions through a flat event table', function*({ expect }) {
    const machine = createFSM({
      initial: 'off',
      states: {
        off: { on: { toggle: 'on' } },
        on: { on: { toggle: 'off' } },
      },
    })

    const [next, effects] = machine.transition(machine.initialState, {
      type: 'toggle',
    })

    yield* expect({ next, effects }).toEqual({
      next: { status: 'active', value: 'on', context: {} },
      effects: [],
    })
  })

  it('supports pure function transitions with context updates', function*({
    expect,
  }) {
    const machine = createFSM<
      { count: number },
      { type: 'increment'; by: number }
    >({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            increment: ({ context, event }) => ({
              ...(event.by > 0 ? { target: 'ready' } : {}),
              context: { count: context.count + event.by },
            }),
          },
        },
        ready: {},
      },
    })

    const [next] = machine.transition(machine.initialState, {
      type: 'increment',
      by: 2,
    })

    yield* expect(next).toEqual({
      status: 'active',
      value: 'ready',
      context: { count: 2 },
    })
  })

  it('preserves snapshot identity for no-op context patches', function*({
    expect,
  }) {
    const machine = createFSM<{ count: number }, { type: 'noop' }>({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: { on: { noop: { context: { count: 0 } } } },
      },
    })

    yield* expect(machine.transition(machine.initialState, { type: 'noop' })[0])
      .toBe(machine.initialState)
  })

  it('applies only own context patch keys', function*({ expect }) {
    const machine = createFSM<
      { count: number; inherited?: number },
      { type: 'inherited' } | { type: 'own' }
    >({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            inherited: () => ({ context: Object.create({ inherited: 1 }) }),
            own: () => ({ context: { count: 1 } }),
          },
        },
      },
    })

    const inheritedNext = machine.transition(machine.initialState, {
      type: 'inherited',
    })[0]

    const [next] = machine.transition(machine.initialState, { type: 'own' })

    yield* expect({
      inheritedKeepsIdentity: inheritedNext === machine.initialState,
      ownKeepsIdentity: next === machine.initialState,
      nextContext: next.context,
    }).toEqual({
      inheritedKeepsIdentity: true,
      ownKeepsIdentity: false,
      nextContext: { count: 1 },
    })
  })

  it('ignores inherited event names', function*({ expect }) {
    const machine = createFSM({
      initial: 'idle',
      states: { idle: { on: { ping: 'idle' } } },
    })

    yield* expect(
      machine.transition(machine.initialState, { type: 'constructor' })[0],
    ).toBe(machine.initialState)
  })

  it('materializes output and error as own snapshot properties', function*({
    expect,
  }) {
    const machine = createFSM({
      initial: 'inactive',
      context: { count: 0 },
      states: {
        inactive: { on: { toggle: 'active' } },
        active: {},
      },
    })
    const keys = ['status', 'value', 'context', 'output', 'error']
    const [next] = machine.transition(machine.initialState, {
      type: 'toggle',
    })

    const observations = [
      machine.initialState,
      machine.getInitialSnapshot(),
      next,
    ].map((snapshot) => {
      const roundTripped = JSON.parse(
        JSON.stringify(snapshot, (_, value) => value === undefined ? null : value),
      )
      return {
        keys: Object.keys(snapshot),
        roundTrippedKeys: Object.keys(roundTripped),
      }
    })

    yield* expect(observations).toEqual([
      { keys, roundTrippedKeys: keys },
      { keys, roundTrippedKeys: keys },
      { keys, roundTrippedKeys: keys },
    ])
  })
})
