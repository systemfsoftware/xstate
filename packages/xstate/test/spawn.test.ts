import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine } from '../src/index.js'

describe('spawn inside machine', () => {
  it('input is required when defined in actor', function*({ expect }) {
    const childMachine = createMachine({})

    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.any(),
        }),
      },
      context: ({ spawn }) => ({
        ref: spawn(childMachine, { input: { value: 42 }, registryKey: 'test' }),
      }),
    })

    const actor = createActor(machine).start()
    yield* expect(Object.keys(actor.system.getAll())).toEqual(['test'])
  })
})
