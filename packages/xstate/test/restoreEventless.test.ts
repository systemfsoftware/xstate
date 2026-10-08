import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine } from '../src/index.js'

const machine = createMachine({
  schemas: {
    context: z.object({ go: z.boolean() }),
  },
  context: { go: false },
  initial: 'waiting',
  states: {
    waiting: {
      always: ({ context }) => (context.go ? { target: 'done' } : undefined),
    },
    done: {},
  },
})

describe('restoring into eventless transitions', () => {
  it('does not re-evaluate always transitions on restore', function*({ expect }) {
    const persisted = createActor(machine).start().getPersistedSnapshot()
    const tampered = {
      ...persisted,
      context: { go: true },
    } as typeof persisted

    const actor = createActor(machine, {
      snapshot: tampered,
      warn: () => {},
    }).start()

    yield* expect(actor.getSnapshot().value).toBe('waiting')
  })

  it('warns in development when the restored configuration has eventless transitions', function*({ expect }) {
    const persisted = createActor(machine).start().getPersistedSnapshot()
    const guardCalls: string[] = []
    const guard = () => {
      guardCalls.push('called')
      return undefined
    }
    const guarded = createMachine({
      initial: 'waiting',
      states: {
        waiting: { always: guard },
        done: {},
      },
    })
    const warnings: string[] = []
    const warn = (message: string) => {
      warnings.push(message)
    }

    createActor(machine, { snapshot: persisted, warn }).start()
    const guardedSnapshot = createActor(guarded, { warn }).getPersistedSnapshot()
    guardCalls.length = 0
    createActor(guarded, { snapshot: guardedSnapshot, warn })

    yield* expect({ warnings, guardCalls }).toEqual({
      warnings: [
        'Restored snapshot is in state "(machine).waiting" which has eventless transitions; they are not re-evaluated until the next event',
        'Restored snapshot is in state "(machine).waiting" which has eventless transitions; they are not re-evaluated until the next event',
      ],
      guardCalls: [],
    })
  })

  it('does not warn when the restored configuration has no eventless transitions', function*({ expect }) {
    const plain = createMachine({ initial: 'a', states: { a: {} } })
    const warnings: string[] = []
    const warn = (message: string) => {
      warnings.push(message)
    }
    createActor(plain, {
      snapshot: createActor(plain, { warn }).getPersistedSnapshot(),
      warn,
    }).start()

    yield* expect(warnings).toEqual([])
  })
})
