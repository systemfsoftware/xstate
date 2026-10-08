import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { createActor, createAsyncLogic, createMachine, waitFor } from '../src/index.js'

describe('first ten minutes (v6)', () => {
  it('toggle', function*({ expect }) {
    const toggleMachine = createMachine({
      initial: 'inactive',
      states: {
        inactive: { on: { toggle: { target: 'active' } } },
        active: { on: { toggle: { target: 'inactive' } } },
      },
    })

    const actor = createActor(toggleMachine).start()
    actor.send({ type: 'toggle' })

    yield* expect(actor.getSnapshot().value).toBe('active')
  })

  it('fetch with loading/error states', function*({ expect }) {
    const fetchUser = createAsyncLogic({
      run: ({ input }: { input: { id: number } }) => {
        if (input.id < 0) {
          return Promise.reject(new Error('bad id'))
        }
        return Promise.resolve({ id: input.id, name: 'Ada' })
      },
    })

    const userMachine = createMachine({
      context: { user: null as { id: number; name: string } | null },
      initial: 'idle',
      states: {
        idle: { on: { load: { target: 'loading' } } },
        loading: {
          invoke: {
            src: fetchUser,
            input: { id: 1 },
            onDone: ({ event }) => ({
              target: 'loaded',
              context: { user: event.output },
            }),
            onError: { target: 'failed' },
          },
        },
        loaded: {},
        failed: {},
      },
    })

    const actor = createActor(userMachine).start()
    actor.send({ type: 'load' })
    const final = yield* Effect.promise(() => waitFor(actor, (s) => s.matches('loaded')))

    yield* expect(final.context.user).toEqual({ id: 1, name: 'Ada' })
  })

  it('multi-step form', function*({ expect }) {
    const formMachine = createMachine({
      schemas: {
        events: {
          next: z.object({ value: z.string() }),
          back: z.object({}),
        },
      },
      context: { name: '', email: '' },
      initial: 'name',
      states: {
        name: {
          on: {
            next: ({ event }) => ({
              target: 'email',
              context: { name: event.value },
            }),
          },
        },
        email: {
          on: {
            back: { target: 'name' },
            next: ({ event }) => ({
              target: 'done',
              context: { email: event.value },
            }),
          },
        },
        done: { type: 'final' },
      },
    })

    const actor = createActor(formMachine).start()
    actor.trigger.next({ value: 'Ada' })
    actor.trigger.next({ value: 'ada@example.com' })

    yield* expect({
      value: actor.getSnapshot().value,
      context: actor.getSnapshot().context,
    }).toEqual({
      value: 'done',
      context: {
        name: 'Ada',
        email: 'ada@example.com',
      },
    })
  })

  it('debounced input', function*({ expect }) {
    const searches: string[] = []

    const searchMachine = createMachine({
      schemas: {
        events: {
          type: z.object({ value: z.string() }),
          search: z.object({}),
        },
      },
      context: { query: '' },
      on: {
        type: ({ event }, enq) => {
          enq.cancel('debounce')
          enq.raise({ type: 'search' }, { delay: 10, id: 'debounce' })
          return { context: { query: event.value } }
        },
        search: ({ context }, enq) => {
          enq(() => searches.push(context.query))
        },
      },
    })

    let pendingDebounce: (() => void) | undefined
    let nextTimerId = 0
    let currentTimerId = -1
    const clock = {
      setTimeout: (fn: () => void) => {
        const id = nextTimerId++
        currentTimerId = id
        pendingDebounce = fn
        return id
      },
      clearTimeout: (id: number) => {
        if (id === currentTimerId) {
          pendingDebounce = undefined
        }
      },
    }

    const actor = createActor(searchMachine, { clock }).start()
    actor.trigger.type({ value: 'a' })
    actor.trigger.type({ value: 'ab' })
    actor.trigger.type({ value: 'abc' })
    const fireDebounce = pendingDebounce
    if (fireDebounce === undefined) {
      throw new Error('expected a pending debounce timer')
    }
    fireDebounce()

    yield* expect(searches).toEqual(['abc'])
  })

  it('parent-child actors', function*({ expect }) {
    const counterMachine = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context, parent }, enq) => {
          const count = context.count + 1
          if (count === 2) {
            enq.sendTo(parent, { type: 'childDone' })
          }
          return { context: { count } }
        },
      },
    })

    const parentMachine = createMachine({
      initial: 'working',
      entry: (_, enq) => {
        enq.spawn(counterMachine, { id: 'counter' })
      },
      states: {
        working: {
          on: {
            ping: ({ children }, enq) => {
              enq.sendTo(children['counter'], { type: 'inc' })
            },
            childDone: { target: 'finished' },
          },
        },
        finished: { type: 'final' },
      },
    })

    const actor = createActor(parentMachine).start()
    actor.send({ type: 'ping' })
    actor.send({ type: 'ping' })

    yield* expect(actor.getSnapshot().value).toBe('finished')
  })
})
