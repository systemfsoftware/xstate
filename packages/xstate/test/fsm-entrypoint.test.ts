import { describe, it } from '@systemfsoftware/vitest'
import * as fsm from '../src/fsm/index.js'

describe('xstate/fsm', () => {
  it('exports only the pure FSM API', function*({ expect }) {
    yield* expect(Object.keys(fsm).sort()).toEqual([
      'createFSM',
      'setup',
      'types',
    ])
  })

  it('creates and transitions a machine', function*({ expect }) {
    const machine = fsm.createFSM({
      initial: 'inactive',
      states: {
        inactive: { on: { toggle: 'active' } },
        active: { on: { toggle: 'inactive' } },
      },
    })

    yield* expect(
      machine.transition(machine.initialState, { type: 'toggle' }),
    ).toEqual([{ status: 'active', value: 'active', context: {} }, []])
  })
})
