import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'

function sessionParts(sessionId: string) {
  const [prefix, system, session] = sessionId.split(':')
  return { prefix, system, session }
}

describe('crypto option', () => {
  it('draws the session-id prefix from the injected getRandomValues', function*({ expect }) {
    const actor = createActor(createMachine({}), {
      crypto: {
        getRandomValues: (array) => {
          array.set([1, 2, 3, 4])
          return array
        },
      },
    })
    const { prefix, session } = sessionParts(actor.sessionId)
    yield* expect({ prefix, session }).toEqual({ prefix: '0000001000000200000030000004', session: '0' })
  })

  it('draws the prefix from the array an injected getRandomValues returns', function*({ expect }) {
    const actor = createActor(createMachine({}), {
      crypto: { getRandomValues: () => new Uint32Array([5, 6, 7, 8]) },
    })
    const { prefix, session } = sessionParts(actor.sessionId)
    yield* expect({ prefix, session }).toEqual({ prefix: '0000005000000600000070000008', session: '0' })
  })

  it('uses the injected randomUUID when getRandomValues is unavailable', function*({ expect }) {
    const actor = createActor(createMachine({}), {
      crypto: { randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef' },
    })
    const { prefix, session } = sessionParts(actor.sessionId)
    yield* expect({ prefix, session }).toEqual({ prefix: '0123456789abcdef0123456789abcdef', session: '0' })
  })

  it('falls back without failing when the injected Web Crypto is unusable', function*({ expect }) {
    const unusable = {
      getRandomValues: (): never => {
        throw new Error('unavailable')
      },
      randomUUID: (): never => {
        throw new Error('unavailable')
      },
    }
    const sessionIds = [
      createActor(createMachine({}), { crypto: unusable }).sessionId,
      createActor(createMachine({}), { crypto: unusable }).sessionId,
    ]
    yield* expect({
      distinct: new Set(sessionIds).size,
      fallbackShape: sessionIds.map((id) => /^xstate-[0-9a-z]+-[0-9a-z]+:[0-9a-z]+:0$/.test(id)),
    }).toEqual({ distinct: 2, fallbackShape: [true, true] })
  })

  it('shares one process prefix across systems created without the option', function*({ expect }) {
    const first = sessionParts(createActor(createMachine({})).sessionId)
    createActor(createMachine({}), { crypto: { randomUUID: () => 'injected' } })
    const second = sessionParts(createActor(createMachine({})).sessionId)
    yield* expect({
      samePrefix: first.prefix === second.prefix,
      distinctSystems: first.system !== second.system,
      notInjected: second.prefix !== 'injected',
    }).toEqual({ samePrefix: true, distinctSystems: true, notInjected: true })
  })
})
