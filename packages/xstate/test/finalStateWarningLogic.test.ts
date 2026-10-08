import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createCallbackLogic } from '../src/index.js'

describe('final-state warnings at actor creation', () => {
  it('starts non-machine logic that carries a root key without reading machine warnings', function*({ expect }) {
    const warned: string[] = []
    const logic = { ...createCallbackLogic(() => {}), root: 'not a state node' }
    const actor = createActor(logic, { warn: (message) => warned.push(message) }).start()
    yield* expect({ warned, status: actor.getSnapshot().status }).toEqual({ warned: [], status: 'active' })
  })
})
