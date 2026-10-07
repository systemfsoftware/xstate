import { describe, it } from '@systemfsoftware/vitest'
import { createStore } from '../src/index.js'
import { validateSchemas } from '../src/validate.js'

describe('validateSchemas warn sink', (it) => {
  it('warns and no-ops in dev when there are no schemas', function*({ expect }) {
    const warned: string[] = []
    const store = createStore({
      context: { count: 0 },
      on: {
        inc: (ctx) => ({ count: ctx.count + 1 }),
      },
      warn: (message) => {
        warned.push(message)
      },
    }).with(validateSchemas())

    const initialContext = store.getSnapshot().context
    store.trigger.inc()
    const contextAfterIncrement = store.getSnapshot().context

    yield* expect({ warned, initialContext, contextAfterIncrement }).toEqual({
      warned: [
        'The "validateSchemas" store extension was used, but the store has no schemas to validate.',
      ],
      initialContext: { count: 0 },
      contextAfterIncrement: { count: 1 },
    })
  })
})
