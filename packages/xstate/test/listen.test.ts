import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createLogic,
  createMachine,
  toPromise,
  types,
} from '../src/index.js'
import type { AnyActor } from '../src/index.js'

const readField = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }
  return Reflect.get(value, key)
}

const afterDelay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

const pollUntil = (done: () => boolean) =>
  Effect.promise(() => {
    const { promise, resolve } = Promise.withResolvers<void>()
    let attempts = 0
    const poll = () => {
      if (done() || attempts >= 500) {
        resolve()
        return
      }
      attempts += 1
      setTimeout(poll, 1)
    }
    poll()
    return promise
  })

describe('enq.listen()', () => {
  it.live('listens to emitted events from a spawned actor', function*({ expect }) {
    const childLogic = createLogic<
      { triggered: boolean },
      undefined,
      { type: 'TRIGGER' },
      unknown,
      { type: 'childEvent'; value: number }
    >({
      context: { triggered: false },
      run: ({ context, event }, enq) => {
        if (event.type === 'TRIGGER') {
          enq.emit({ type: 'childEvent', value: 42 })
          return { context: { triggered: true } }
        }
        return
      },
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            enq.listen(childRef, 'childEvent', (ev) => ({
              type: 'CHILD_EMITTED',
              payload: readField(ev, 'value'),
            }))
            setTimeout(() => {
              childRef.send({ type: 'TRIGGER' })
            }, 10)
          },
          on: {
            CHILD_EMITTED: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
              return {
                target: 'done',
              }
            },
          },
        },
        done: {
          type: 'final',
        },
      },
    })

    const actor = createActor(parentMachine)
    const completion = toPromise(actor)
    actor.start()
    yield* Effect.promise(() => completion)

    yield* expect(
      receivedEvents.map((event) => ({ type: readField(event, 'type'), payload: readField(event, 'payload') })),
    )
      .toEqual([{ type: 'CHILD_EMITTED', payload: 42 }])
  })

  it('listens to emitted events from a spawned actor during startup', function*({ expect }) {
    const childLogic = createCallbackLogic(({ emit }) => {
      emit({ type: 'childEvent' })
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      entry: (_, enq) => {
        const childRef = enq.spawn(childLogic, { id: 'child' })
        enq.listen(childRef, 'childEvent', () => ({ type: 'CHILD_EMITTED' }))
      },
      on: {
        CHILD_EMITTED: ({ event }, enq) => {
          enq(() => receivedEvents.push(event))
        },
      },
    })

    createActor(parentMachine).start()

    yield* expect(receivedEvents.map((event) => readField(event, 'type'))).toEqual(['CHILD_EMITTED'])
  })

  it('listens to emitted events from an invoked actor during startup', function*({ expect }) {
    const childLogic = createCallbackLogic(({ emit }) => {
      emit({ type: 'childEvent' })
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            id: 'child',
            src: childLogic,
          },
          entry: ({ children }, enq) => {
            enq.listen(children['child']!, 'childEvent', () => ({
              type: 'CHILD_EMITTED',
            }))
          },
          on: {
            CHILD_EMITTED: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
            },
          },
        },
      },
    })

    createActor(parentMachine).start()

    yield* expect(receivedEvents.map((event) => readField(event, 'type'))).toEqual(['CHILD_EMITTED'])
  })

  it('listens to emitted events from an actor passed through input', function*({ expect }) {
    const childLogic = createCallbackLogic(({ emit }) => {
      emit({ type: 'childEvent' })
    })

    const childRef = createActor(childLogic)
    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      schemas: {
        context: types<{ childRef: AnyActor }>(),
        input: types<{ childRef: AnyActor }>(),
      },
      context: ({ input }) => ({
        childRef: input.childRef,
      }),
      entry: ({ context }, enq) => {
        enq.listen(context.childRef, 'childEvent', () => ({
          type: 'CHILD_EMITTED',
        }))
      },
      on: {
        CHILD_EMITTED: ({ event }, enq) => {
          enq(() => receivedEvents.push(event))
        },
      },
    })

    createActor(parentMachine, { input: { childRef } }).start()
    childRef.start()

    yield* expect(receivedEvents.map((event) => readField(event, 'type'))).toEqual(['CHILD_EMITTED'])
  })

  it.live('supports wildcard event matching', function*({ expect }) {
    const childLogic = createCallbackLogic<
      { type: string },
      unknown,
      { type: string; value: number }
    >(({ emit }) => {
      setTimeout(() => {
        emit({ type: 'data.update', value: 1 })
        emit({ type: 'data.delete', value: 2 })
      }, 10)
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            enq.listen(childRef, 'data.*', (ev) => ({
              type: 'DATA_EVENT',
              eventType: readField(ev, 'type'),
              value: readField(ev, 'value'),
            }))
          },
          on: {
            DATA_EVENT: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
            },
          },
        },
      },
    })

    createActor(parentMachine).start()
    yield* pollUntil(() => receivedEvents.length >= 2)

    yield* expect(receivedEvents.map((event) => readField(event, 'eventType'))).toEqual(['data.update', 'data.delete'])
  })

  it.live('stops listening when listener is stopped', function*({ expect }) {
    const childLogic = createCallbackLogic<
      { type: string },
      unknown,
      { type: 'tick'; count: number }
    >(({ emit }) => {
      let count = 0
      const interval = setInterval(() => {
        emit({ type: 'tick', count: ++count })
      }, 10)
      return () => clearInterval(interval)
    })

    const receivedEvents: unknown[] = []
    let listenerRef: AnyActor | undefined

    const parentMachine = createMachine({
      initial: 'listening',
      states: {
        listening: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            listenerRef = enq.listen(childRef, 'tick', (ev) => ({
              type: 'TICK',
              count: readField(ev, 'count'),
            }))
          },
          on: {
            TICK: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
            },
            STOP_LISTENING: {
              target: 'notListening',
            },
          },
        },
        notListening: {
          entry: (_, enq) => {
            if (listenerRef) {
              enq.stop(listenerRef)
            }
          },
        },
      },
    })

    const actor = createActor(parentMachine).start()

    yield* pollUntil(() => receivedEvents.length > 0)

    const countBeforeStop = receivedEvents.length
    yield* expect(countBeforeStop).toBeGreaterThan(0)

    actor.send({ type: 'STOP_LISTENING' })

    yield* Effect.promise(() => afterDelay(35))

    yield* expect(receivedEvents.length).toBe(countBeforeStop)
  })
})

describe('enq.subscribeTo()', () => {
  it.live('subscribes to done events from a spawned actor', function*({ expect }) {
    const childLogic = createAsyncLogic({
      run: () => afterDelay(10).then(() => ({ result: 'success' })),
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            enq.subscribeTo(childRef, {
              done: (output) => ({
                type: 'CHILD_DONE',
                output,
              }),
            })
          },
          on: {
            CHILD_DONE: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
              return {
                target: 'done',
              }
            },
          },
        },
        done: {
          type: 'final',
        },
      },
    })

    const actor = createActor(parentMachine)
    const completion = toPromise(actor)
    actor.start()
    yield* Effect.promise(() => completion)

    yield* expect({
      value: actor.getSnapshot().value,
      outputs: receivedEvents.map((event) => readField(event, 'output')),
    }).toEqual({ value: 'done', outputs: [{ result: 'success' }] })
  })

  it.live('subscribes to error events from a spawned actor', function*({ expect }) {
    const childLogic = createAsyncLogic({
      run: () =>
        afterDelay(10).then(() => {
          throw new Error('child error')
        }),
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            enq.subscribeTo(childRef, {
              error: (err) => ({
                type: 'CHILD_ERROR',
                error: err,
              }),
            })
          },
          on: {
            CHILD_ERROR: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
              return {
                target: 'errored',
              }
            },
          },
        },
        errored: {
          type: 'final',
        },
      },
    })

    const actor = createActor(parentMachine)
    const completion = toPromise(actor)
    actor.start()
    yield* Effect.promise(() => completion)

    const errorEvents = receivedEvents.map((event) => {
      const error = readField(event, 'error')
      return {
        type: readField(event, 'type'),
        isError: error instanceof Error,
        message: error instanceof Error ? error.message : undefined,
      }
    })

    yield* expect({ value: actor.getSnapshot().value, errorEvents }).toEqual({
      value: 'errored',
      errorEvents: [{ type: 'CHILD_ERROR', isError: true, message: 'child error' }],
    })
  })

  it('subscribes to snapshot changes using shorthand', function*({ expect }) {
    const childLogic = createLogic({
      context: {
        count: 0,
      },
      run: ({ context, event }) => {
        if (event.type === '@xstate.init') {
          return
        }
        return {
          context: {
            count: context.count + 1,
          },
        }
      },
    })

    const snapshotChanges: unknown[] = []

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            enq.subscribeTo(childRef, (snapshot) => ({
              type: 'CHILD_SNAPSHOT',
              status: snapshot.status,
            }))

            enq.sendTo(childRef, { type: 'increment' })
          },
          on: {
            CHILD_SNAPSHOT: ({ event }, enq) => {
              enq(() => snapshotChanges.push(event))
            },
          },
        },
      },
    })

    createActor(parentMachine).start()

    yield* expect(snapshotChanges.length).toBeGreaterThan(0)
  })

  it('subscribes to done events from a spawned actor during startup', function*({ expect }) {
    const childLogic = createLogic({
      context: undefined,
      run: () => {
        return {
          status: 'done',
          output: { result: 'success' },
        }
      },
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      entry: (_, enq) => {
        const childRef = enq.spawn(childLogic, { id: 'child' })
        enq.subscribeTo(childRef, {
          done: (output) => ({
            type: 'CHILD_DONE',
            output,
          }),
        })
      },
      on: {
        CHILD_DONE: ({ event }, enq) => {
          enq(() => receivedEvents.push(event))
        },
      },
    })

    createActor(parentMachine).start()

    yield* expect(receivedEvents).toEqual([
      {
        type: 'CHILD_DONE',
        output: { result: 'success' },
      },
    ])
  })

  it('subscribes to the initial active snapshot from a spawned actor during startup', function*({ expect }) {
    const childLogic = createLogic({
      context: { count: 0 },
      run: ({ context, event }) => {
        if (event.type === '@xstate.init') {
          return
        }
        return {
          context: { count: context.count + 1 },
        }
      },
    })

    const snapshotChanges: unknown[] = []

    const parentMachine = createMachine({
      entry: (_, enq) => {
        const childRef = enq.spawn(childLogic, { id: 'child' })
        enq.subscribeTo(childRef, (snapshot) => ({
          type: 'CHILD_SNAPSHOT',
          status: snapshot.status,
          context: snapshot.context,
        }))
      },
      on: {
        CHILD_SNAPSHOT: ({ event }, enq) => {
          enq(() => snapshotChanges.push(event))
        },
      },
    })

    createActor(parentMachine).start()

    yield* expect(snapshotChanges).toEqual([
      {
        type: 'CHILD_SNAPSHOT',
        status: 'active',
        context: { count: 0 },
      },
    ])
  })

  it('does not subscribe to a spawned actor stopped before subscribing', function*({ expect }) {
    const childLogic = createLogic({
      context: undefined,
      run: () => {},
    })

    const snapshotChanges: unknown[] = []

    const parentMachine = createMachine({
      entry: (_, enq) => {
        const childRef = enq.spawn(childLogic, { id: 'child' })
        enq.stop(childRef)
        enq.subscribeTo(childRef, (snapshot) => ({
          type: 'CHILD_SNAPSHOT',
          status: snapshot.status,
        }))
      },
      on: {
        CHILD_SNAPSHOT: ({ event }, enq) => {
          enq(() => snapshotChanges.push(event))
        },
      },
    })

    createActor(parentMachine).start()

    yield* expect(snapshotChanges).toEqual([])
  })

  it.live('stops subscribing when subscription is stopped', function*({ expect }) {
    const childLogic = createAsyncLogic({
      run: () => afterDelay(100).then(() => ({ result: 'success' })),
    })

    let receivedDone = false
    let subscriptionRef: AnyActor | undefined

    const parentMachine = createMachine({
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => {
            const childRef = enq.spawn(childLogic, { id: 'child' })
            subscriptionRef = enq.subscribeTo(childRef, {
              done: () => ({ type: 'CHILD_DONE' }),
            })
          },
          on: {
            CHILD_DONE: (_, enq) => {
              enq(() => (receivedDone = true))
              return {
                target: 'unsubscribed',
              }
            },
            UNSUBSCRIBE: {
              target: 'unsubscribed',
            },
          },
        },
        unsubscribed: {
          entry: (_, enq) => {
            if (subscriptionRef) {
              enq.stop(subscriptionRef)
            }
          },
        },
      },
    })

    const actor = createActor(parentMachine).start()

    yield* Effect.promise(() => afterDelay(20))
    actor.send({ type: 'UNSUBSCRIBE' })

    yield* Effect.promise(() => afterDelay(150))

    yield* expect({ receivedDone }).toEqual({ receivedDone: false })
  })

  it.live('subscribes to done events from an actor spawned in a transition', function*({ expect }) {
    const childLogic = createAsyncLogic({
      run: () => afterDelay(10).then(() => ({ result: 'success' })),
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            SPAWN: (_, enq) => {
              const childRef = enq.spawn(childLogic, { id: 'child' })
              enq.subscribeTo(childRef, {
                done: (output) => ({
                  type: 'CHILD_DONE',
                  output,
                }),
              })
            },
            CHILD_DONE: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
              return { target: 'done' }
            },
          },
        },
        done: {
          type: 'final',
        },
      },
    })

    const actor = createActor(parentMachine)
    const completion = toPromise(actor)
    actor.start()
    actor.send({ type: 'SPAWN' })
    yield* Effect.promise(() => completion)

    yield* expect({
      value: actor.getSnapshot().value,
      outputs: receivedEvents.map((event) => readField(event, 'output')),
    }).toEqual({ value: 'done', outputs: [{ result: 'success' }] })
  })

  it.live('subscribes to an existing child when the transition has no other effects', function*({ expect }) {
    const childLogic = createAsyncLogic({
      run: () => afterDelay(10).then(() => ({ result: 'success' })),
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      entry: (_, enq) => {
        enq.spawn(childLogic, { id: 'child' })
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            SUBSCRIBE: ({ children }, enq) => {
              enq.subscribeTo(children['child'] as AnyActor, {
                done: (output) => ({
                  type: 'CHILD_DONE',
                  output,
                }),
              })
            },
            CHILD_DONE: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
              return { target: 'done' }
            },
          },
        },
        done: {
          type: 'final',
        },
      },
    })

    const actor = createActor(parentMachine)
    const completion = toPromise(actor)
    actor.start()
    actor.send({ type: 'SUBSCRIBE' })
    yield* Effect.promise(() => completion)

    yield* expect({
      value: actor.getSnapshot().value,
      outputs: receivedEvents.map((event) => readField(event, 'output')),
    }).toEqual({ value: 'done', outputs: [{ result: 'success' }] })
  })

  it.live('listens to emitted events from an actor spawned in a transition', function*({ expect }) {
    const childLogic = createCallbackLogic<
      { type: string },
      unknown,
      { type: 'childEvent'; value: number }
    >(({ emit }) => {
      emit({ type: 'childEvent', value: 42 })
    })

    const receivedEvents: unknown[] = []

    const parentMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            SPAWN: (_, enq) => {
              const childRef = enq.spawn(childLogic, { id: 'child' })
              enq.listen(childRef, 'childEvent', (emitted) => ({
                type: 'FROM_CHILD',
                value: readField(emitted, 'value'),
              }))
            },
            FROM_CHILD: ({ event }, enq) => {
              enq(() => receivedEvents.push(event))
            },
          },
        },
      },
    })

    const actor = createActor(parentMachine)
    actor.start()
    actor.send({ type: 'SPAWN' })
    yield* pollUntil(() => receivedEvents.length >= 1)

    yield* expect(receivedEvents.map((event) => readField(event, 'value'))).toEqual([42])
  })
})
