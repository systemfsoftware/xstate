import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import {
  type AnyEventObject,
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createEventObservableLogic,
  createLogic,
  createMachine,
  createObservableLogic,
} from '../src/index.js'

describe('event emitter', () => {
  it('only emits expected events if specified in schemas', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        emitted: {
          greet: z.object({
            message: z.string(),
          }),
        },
      },
      entry: (_, enq) => {
        enq.emit({
          // @ts-expect-error
          type: 'nonsense',
        })
      },
      exit: (_, enq) => {
        enq.emit({
          type: 'greet',
          // @ts-expect-error
          message: 1234,
        })
      },
      on: {
        someEvent: (_, enq) => {
          enq.emit({
            type: 'greet',
            message: 'hello',
          })
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().status).toBe('active')
  })

  it('emits any events if not specified in schemas (unsafe)', function*({ expect }) {
    const machine = createMachine({
      entry: (_, enq) => {
        enq.emit({
          type: 'nonsense',
        })
      },
      exit: (_, enq) => {
        enq.emit({
          type: 'greet',
          // @ts-expect-error
          message: 1234,
        })
      },
      on: {
        someEvent: (_, enq) => {
          enq.emit({
            type: 'greet',
            // @ts-expect-error
            message: 'hello',
          })
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().status).toBe('active')
  })

  it('emits events that can be listened to on actorRef.on(…)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        emitted: {
          emitted: z.object({
            foo: z.string(),
          }),
        },
      },
      on: {
        someEvent: (_, enq) => {
          enq(() => {})
          enq.emit({
            type: 'emitted',
            foo: 'bar',
          })
        },
      },
    })

    const actor = createActor(machine).start()
    setTimeout(() => {
      actor.send({
        type: 'someEvent',
      })
    })
    const event = yield* Effect.promise(() =>
      new Promise<AnyEventObject>((res) => {
        actor.on('emitted', res)
      })
    )

    yield* expect(event['foo']).toBe('bar')
  })

  it('enqueue.emit(…) emits events that can be listened to on actorRef.on(…)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        emitted: {
          emitted: z.object({
            foo: z.string(),
          }),
        },
      },
      on: {
        someEvent: (_, enq) => {
          enq.emit({
            type: 'emitted',
            foo: 'bar',
          })

          enq.emit({
            // @ts-expect-error
            type: 'unknown',
          })
        },
      },
    })

    const actor = createActor(machine).start()
    setTimeout(() => {
      actor.send({
        type: 'someEvent',
      })
    })
    const event = yield* Effect.promise(() =>
      new Promise<AnyEventObject>((res) => {
        actor.on('emitted', res)
      })
    )

    yield* expect(event['foo']).toBe('bar')
  })

  it('handles errors', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        emitted: {
          emitted: z.object({
            foo: z.string(),
          }),
        },
      },
      on: {
        someEvent: (_, enq) => {
          enq.emit({
            type: 'emitted',
            foo: 'bar',
          })
        },
      },
    })

    const listenerError = new Error('oops')
    const reported: unknown[] = []
    const actor = createActor(machine, {
      reportUnhandledError: (error) => {
        reported.push(error)
      },
    }).start()
    actor.on('emitted', () => {
      throw listenerError
    })
    setTimeout(() => {
      actor.send({
        type: 'someEvent',
      })
    })

    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

    yield* expect({
      status: actor.getSnapshot().status,
      reported,
    }).toEqual({
      status: 'active',
      reported: [listenerError],
    })
  })

  it('dynamically emits events that can be listened to on actorRef.on(…)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: { count: 10 },
      on: {
        someEvent: ({ context }, enq) => {
          enq.emit({
            type: 'emitted',
            // @ts-ignore
            count: context.count,
          })
        },
      },
    })

    const actor = createActor(machine).start()
    setTimeout(() => {
      actor.send({
        type: 'someEvent',
      })
    })
    const event = yield* Effect.promise(() =>
      new Promise<AnyEventObject>((res) => {
        actor.on('emitted', res)
      })
    )

    yield* expect(event).toEqual({
      type: 'emitted',
      count: 10,
    })
  })

  it('listener should be able to read the updated snapshot of the emitting actor', function*({ expect }) {
    const values: unknown[] = []

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            ev: (_, enq) => {
              enq.emit({
                type: 'someEvent',
              })

              return {
                target: 'b',
              }
            },
          },
        },
        b: {},
      },
    })

    const actor = createActor(machine)
    actor.on('someEvent', () => {
      values.push(actor.getSnapshot().value)
    })

    actor.start()
    actor.send({ type: 'ev' })

    yield* expect(values).toEqual(['b'])
  })

  it('wildcard listeners should be able to receive all emitted events', function*({ expect }) {
    const events: unknown[] = []

    const machine = createMachine({
      schemas: {
        emitted: {
          emitted: z.object({
            type: z.literal('emitted'),
          }),
          anotherEmitted: z.object({
            type: z.literal('anotherEmitted'),
          }),
        },
      },
      on: {
        event: (_, enq) => {
          enq.emit({
            type: 'emitted',
          })
        },
      },
    })

    const actor = createActor(machine)

    actor.on('*', (ev) => {
      ev.type satisfies 'emitted' | 'anotherEmitted'

      // @ts-expect-error
      ev.type satisfies 'whatever'
      events.push(ev)
    })

    actor.start()

    actor.send({ type: 'event' })

    yield* expect(events).toEqual([{ type: 'emitted' }])
  })

  it('events can be emitted from async logic', function*({ expect }) {
    const events: unknown[] = []

    const logic = createAsyncLogic<any, any, { type: 'emitted'; msg: string }>({
      run: (_, enq) => {
        enq.emit({
          type: 'emitted',
          msg: 'hello',
        })
        return Promise.resolve()
      },
    })

    const actor = createActor(logic)

    actor.on('emitted', (ev) => {
      ev.type satisfies 'emitted'

      // @ts-expect-error
      ev.type satisfies 'whatever'

      ev satisfies { msg: string }

      events.push(ev)
    })

    actor.start()

    yield* expect(events).toEqual([{ type: 'emitted', msg: 'hello' }])
  })

  it('events can be emitted from custom logic', function*({ expect }) {
    const events: unknown[] = []

    const logic = createLogic<
      {},
      undefined,
      AnyEventObject,
      undefined,
      { type: 'emitted'; msg: string }
    >({
      context: {},
      run: ({ event }, enq) => {
        if (event.type === 'emit') {
          enq.emit({
            type: 'emitted',
            msg: 'hello',
          })
        }
      },
    })

    const actor = createActor(logic)

    actor.on('emitted', (ev) => {
      ev.type satisfies 'emitted'

      // @ts-expect-error
      ev.type satisfies 'whatever'

      ev satisfies { msg: string }

      events.push(ev)
    })

    actor.start()

    actor.send({ type: 'emit' })

    yield* expect(events).toEqual([{ type: 'emitted', msg: 'hello' }])
  })

  it('events can be emitted from observable logic', function*({ expect }) {
    const events: unknown[] = []

    const logic = createObservableLogic<
      any,
      any,
      { type: 'emitted'; msg: string }
    >(({ emit }) => {
      emit({
        type: 'emitted',
        msg: 'hello',
      })

      return {
        subscribe: () => {
          return {
            unsubscribe: () => {},
          }
        },
      }
    })

    const actor = createActor(logic)

    actor.on('emitted', (ev) => {
      ev.type satisfies 'emitted'

      // @ts-expect-error
      ev.type satisfies 'whatever'

      ev satisfies { msg: string }

      events.push(ev)
    })

    actor.start()

    yield* expect(events).toEqual([{ type: 'emitted', msg: 'hello' }])
  })

  it('events can be emitted from event observable logic', function*({ expect }) {
    const events: unknown[] = []

    const logic = createEventObservableLogic<
      any,
      any,
      { type: 'emitted'; msg: string }
    >(({ emit }) => {
      emit({
        type: 'emitted',
        msg: 'hello',
      })

      return {
        subscribe: () => {
          return {
            unsubscribe: () => {},
          }
        },
      }
    })

    const actor = createActor(logic)

    actor.on('emitted', (ev) => {
      ev.type satisfies 'emitted'

      // @ts-expect-error
      ev.type satisfies 'whatever'

      ev satisfies { msg: string }

      events.push(ev)
    })

    actor.start()

    yield* expect(events).toEqual([{ type: 'emitted', msg: 'hello' }])
  })

  it('events can be emitted from callback logic', function*({ expect }) {
    const events: unknown[] = []

    const logic = createCallbackLogic<
      any,
      any,
      { type: 'emitted'; msg: string }
    >(({ emit }) => {
      emit({
        type: 'emitted',
        msg: 'hello',
      })
    })

    const actor = createActor(logic)

    actor.on('emitted', (ev) => {
      ev.type satisfies 'emitted'

      // @ts-expect-error
      ev.type satisfies 'whatever'

      ev satisfies { msg: string }

      events.push(ev)
    })

    actor.start()

    yield* expect(events).toEqual([{ type: 'emitted', msg: 'hello' }])
  })

  // TODO: event sourcing
  it.skip('events can be emitted from callback logic (restored root)', function*({ expect }) {
    const events: unknown[] = []

    const logic = createCallbackLogic<
      any,
      any,
      { type: 'emitted'; msg: string }
    >(({ emit }) => {
      emit({
        type: 'emitted',
        msg: 'hello',
      })
    })

    const machine = createMachine({
      actors: { logic },
      invoke: {
        id: 'cb',
        src: ({ actors }) => actors.logic,
      },
    })

    const actor = createActor(machine)

    // Persist the root actor
    const persistedSnapshot = actor.getPersistedSnapshot()

    // Rehydrate a new instance of the root actor using the persisted snapshot
    const restoredActor = createActor(machine, {
      snapshot: persistedSnapshot,
    })

    restoredActor.getSnapshot().children['cb']!.on('emitted', (ev) => {
      events.push(ev)
    })

    restoredActor.start()

    yield* expect(events).toEqual([{ type: 'emitted', msg: 'hello' }])
  })
})
