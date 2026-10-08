import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { of } from 'rxjs'
import { z } from 'zod'
import { createCallbackLogic } from '../src/actors/callback.js'
import {
  type ActorRef,
  type AnyActor,
  createActor,
  createAsyncLogic,
  createEventObservableLogic,
  createLogic,
  createMachine,
  createObservableLogic,
  createSystem,
  type Snapshot,
  transition,
} from '../src/index.js'
import { type ActorSystem } from '../src/system.js'
import { toSubscribable } from './utils.js'

function defined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(`expected ${message}`)
  }
  return value
}

function captureError(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('system', () => {
  it('should register an invoked actor', function*({ expect }) {
    const received: string[] = []
    const { resolve, promise } = Promise.withResolvers<void>()
    type MySystem = ActorSystem<{
      actors: {
        receiver: ActorRef<Snapshot<unknown>, { type: 'HELLO' }>
      }
    }>

    const machine = createMachine({
      id: 'parent',
      initial: 'a',
      states: {
        a: {
          invoke: [
            {
              src: createCallbackLogic(({ receive }) => {
                receive((event) => {
                  received.push(event.type)
                  resolve()
                })
              }),
              registryKey: 'receiver',
            },
            {
              src: createMachine({
                id: 'childmachine',
                entry: ({ system }) => {
                  const receiver = (system as MySystem)?.get('receiver')

                  if (receiver) {
                    receiver.send({ type: 'HELLO' })
                  }
                },
              }),
            },
          ],
        },
      },
    })

    createActor(machine).start()

    yield* Effect.promise(() => promise)

    yield* expect(received).toEqual(['HELLO'])
  })

  it('should register an invoked actor with a registryKey', function*({ expect }) {
    const machine = createMachine({
      id: 'parent',
      invoke: {
        src: createMachine({}),
        registryKey: 'receiver',
      },
    })

    const actor = createActor(machine)

    yield* expect(actor.system.get('receiver')).toSatisfy(
      (value) => value !== undefined,
      'the invoked receiver is registered',
    )
  })

  it('projects nested registry keys before the root actor starts', function*({ expect }) {
    const child = createMachine({
      invoke: {
        id: 'grandchild',
        src: createMachine({}),
        registryKey: 'grandchild',
      },
    })
    const machine = createMachine({
      invoke: { id: 'child', src: child },
    })

    const actor = createActor(machine)
    const childActor = actor.getSnapshot().children['child']
    if (childActor === undefined) {
      throw new Error('expected child actor')
    }
    const grandchild = childActor.getSnapshot()
      .children.grandchild

    yield* expect(actor.system.get('grandchild')).toBe(grandchild)
  })

  it('refreshes registry changes made before the root actor starts', function*({ expect }) {
    let registeredActor: AnyActor | undefined
    const machine = createMachine({
      on: {
        CHECK: ({ system }) => {
          registeredActor = system.get('child')
        },
      },
    })
    const actor = createActor(machine)
    const child = createActor(createMachine({}), {
      parent: actor,
      registryKey: 'child',
    })

    actor.start()
    transition(machine, actor.getSnapshot(), { type: 'CHECK' })

    yield* expect(registeredActor).toBe(child)
  })

  it('createSystem should own the runtime actor system', function*({ expect }) {
    const child = createMachine({})
    const machine = createMachine({
      invoke: {
        src: child,
        registryKey: 'receiver',
      },
    })
    const system = createSystem({
      registry: {
        root: machine,
        receiver: child,
      },
    })
    const beforeCreate = system.get('root')

    const actor = system.createActor(machine, { registryKey: 'root' })
    const actorSystemAll = actor.system.getAll()

    yield* expect({
      beforeCreate,
      rootIsActor: system.get('root') === actor,
      receiverIsActorSystemReceiver: system.get('receiver') === actor.system.get('receiver'),
      systemAll: system.getAll(),
    }).toEqual({
      beforeCreate: undefined,
      rootIsActor: true,
      receiverIsActorSystemReceiver: true,
      systemAll: actorSystemAll,
    })
  })

  it('transition functions can access the actor system', function*({ expect }) {
    const received: string[] = []
    const { resolve, promise } = Promise.withResolvers<void>()
    const receiver = createCallbackLogic<{ type: 'HELLO' }>(({ receive }) => {
      receive((event) => {
        if (event.type === 'HELLO') {
          received.push(event.type)
          resolve()
        }
      })
    })

    const system = createSystem({
      registry: {
        receiver,
      },
    })
    const machine = system.setup().createMachine({
      context: ({ spawn }) => {
        spawn(receiver, { registryKey: 'receiver' })
        return {}
      },
      on: {
        PING: ({ system }, enq) => {
          enq.sendTo(system.get('receiver'), { type: 'HELLO' })
        },
      },
    })

    system.createActor(machine).start().send({ type: 'PING' })

    yield* Effect.promise(() => promise)

    yield* expect(received).toEqual(['HELLO'])
  })

  it('should register a spawned actor', function*({ expect }) {
    const received: string[] = []
    const { resolve, promise } = Promise.withResolvers<void>()
    type MySystem = ActorSystem<{
      actors: {
        receiver: ActorRef<Snapshot<unknown>, { type: 'HELLO' }>
      }
    }>

    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.any(),
          machineRef: z.any(),
        }),
      },
      id: 'parent',
      context: ({ spawn }) => ({
        ref: spawn(
          createCallbackLogic(({ receive }) => {
            receive((event) => {
              received.push(event.type)
              resolve()
            })
          }),
          { registryKey: 'receiver' },
        ),
      }),
      on: {
        toggle: (_, enq) => ({
          context: {
            machineRef: enq.spawn(
              createMachine({
                id: 'childmachine',
                entry: ({ system }) => {
                  const receiver = (system as MySystem)?.get('receiver')

                  if (receiver) {
                    receiver.send({ type: 'HELLO' })
                  } else {
                    throw new Error('no')
                  }
                },
              }),
            ),
          },
        }),
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'toggle' })

    yield* Effect.promise(() => promise)

    yield* expect(received).toEqual(['HELLO'])
  })

  it('system can be immediately accessed outside the actor', function*({ expect }) {
    const machine = createMachine({
      invoke: {
        registryKey: 'someChild',
        src: createMachine({}),
      },
    })

    const actor = createActor(machine)

    yield* expect(actor.system.get('someChild')).toSatisfy(
      (value) => value !== undefined,
      'the invoked child is registered before start',
    )
  })

  it('root actor can be given the registryKey', function*({ expect }) {
    const machine = createMachine({})
    const actor = createActor(machine, { registryKey: 'test0' })
    yield* expect(actor.system.get('test0')).toBe(actor)
  })

  it('should remove invoked actor from receptionist if stopped', function*({ expect }) {
    const machine = createMachine({
      initial: 'active',
      states: {
        active: {
          invoke: {
            src: createMachine({}),
            registryKey: 'test1',
          },
          on: {
            toggle: { target: 'inactive' },
          },
        },
        inactive: {},
      },
    })

    const actor = createActor(machine).start()
    const beforeToggle = actor.system.get('test1')

    actor.send({ type: 'toggle' })

    yield* expect({
      registeredBeforeStop: beforeToggle !== undefined,
      afterToggle: actor.system.get('test1'),
    }).toEqual({ registeredBeforeStop: true, afterToggle: undefined })
  })

  it('should remove spawned actor from receptionist if stopped', function*({ expect }) {
    const childMachine = createMachine({})
    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.any(),
        }),
      },
      context: ({ spawn }) => ({
        ref: spawn(childMachine, {
          registryKey: 'test2',
        }),
      }),
      on: {
        toggle: ({ context }, enq) => ({
          context: {
            ref: enq.stop(context.ref),
          },
        }),
      },
    })

    const actor = createActor(machine).start()
    const beforeToggle = actor.system.get('test2')

    actor.send({ type: 'toggle' })

    yield* expect({
      registeredBeforeStop: beforeToggle !== undefined,
      afterToggle: actor.system.get('test2'),
    }).toEqual({ registeredBeforeStop: true, afterToggle: undefined })
  })

  it('should throw an error if an actor with the registry key already exists', function*({ expect }) {
    const machine = createMachine({
      initial: 'inactive',
      states: {
        inactive: {
          on: {
            toggle: { target: 'active' },
          },
        },
        active: {
          invoke: [
            {
              src: createMachine({}),
              registryKey: 'test1',
            },
            {
              src: createMachine({}),
              registryKey: 'test1',
            },
          ],
        },
      },
    })

    const errors: unknown[] = []

    const actorRef = createActor(machine, { registryKey: 'test1' })
    actorRef.subscribe({
      error: (error) => {
        errors.push(error)
      },
    })
    actorRef.start()
    actorRef.send({ type: 'toggle' })

    yield* expect(
      errors.map((error) => error instanceof Error ? error.message : String(error)),
    ).toEqual(["Actor with registry key 'test1' already exists."])
  })

  it.skip('should cleanup stopped actors', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.any(),
        }),
      },
      context: ({ spawn }) => ({
        ref: spawn(createAsyncLogic({ run: () => Promise.resolve() }), {
          registryKey: 'test11',
        }),
      }),
      on: {
        stop: ({ context }, enq) => {
          enq.stop(context.ref)
        },
        start: (_, enq) => {
          enq.spawn(createAsyncLogic({ run: () => Promise.resolve() }), {
            registryKey: 'test11',
          })
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'stop' })

    yield* expect({
      startError: captureError(() => {
        actor.send({ type: 'start' })
      }),
    }).toEqual({ startError: undefined })
  })

  it('should be accessible in inline custom actions', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: {
        src: createMachine({}),
        registryKey: 'test3',
      },
      entry: ({ system }) => {
        observed.push(system?.get('test3') !== undefined)
      },
    })

    createActor(machine).start()

    yield* expect({ observed }).toEqual({ observed: [true] })
  })

  it('should be accessible in referenced custom actions', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      actions: {
        myAction: (system) => {
          observed.push(system.get('test4') !== undefined)
        },
      },
      invoke: {
        src: createMachine({}),
        registryKey: 'test4',
      },
      entry: ({ system, actions }, enq) => {
        enq(actions.myAction, system)
      },
    })

    createActor(machine).start()

    yield* expect({ observed }).toEqual({ observed: [true] })
  })

  it('should be accessible in sendTo actions', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: {
        src: createMachine({}),
        registryKey: 'test5',
      },
      initial: 'a',
      states: {
        a: {
          entry: ({ system }, enq) => {
            observed.push(system?.get('test5') !== undefined)
            enq.sendTo(system?.get('test5'), { type: 'FOO' })
          },
        },
      },
    })

    createActor(machine).start()

    yield* expect({ observed }).toEqual({ observed: [true] })
  })

  it('should be accessible in promise logic', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: [
        {
          src: createMachine({}),
          registryKey: 'test6',
        },
        {
          src: createAsyncLogic({
            run: ({ system }) => {
              observed.push(system.get('test6') !== undefined)
              return Promise.resolve()
            },
          }),
        },
      ],
    })

    const actor = createActor(machine).start()

    yield* expect({
      registered: actor.system.get('test6') !== undefined,
      observed,
    }).toEqual({ registered: true, observed: [true] })
  })

  it('should be accessible in custom logic', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: [
        {
          src: createMachine({}),
          registryKey: 'test7',
        },

        {
          src: createLogic({
            context: 0,
            run: ({ event, system }) => {
              if (event.type === '@xstate.init') {
                return undefined
              }
              observed.push(system.get('test7') !== undefined)
              return { context: 0 }
            },
          }),
          registryKey: 'reducer',
        },
      ],
    })

    const actor = createActor(machine).start()
    const registered = actor.system.get('test7') !== undefined

    defined(actor.system.get('reducer'), 'reducer').send({ type: 'a' })

    yield* expect({ registered, observed }).toEqual({ registered: true, observed: [true] })
  })

  it('should be accessible in observable logic', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: [
        {
          src: createMachine({}),
          registryKey: 'test8',
        },

        {
          src: createObservableLogic<number, undefined>(({ system }) => {
            observed.push(system.get('test8') !== undefined)
            return toSubscribable(of(0))
          }),
        },
      ],
    })

    const actor = createActor(machine).start()

    yield* expect({
      registered: actor.system.get('test8') !== undefined,
      observed,
    }).toEqual({ registered: true, observed: [true] })
  })

  it('should be accessible in event observable logic', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: [
        {
          src: createMachine({}),
          registryKey: 'test9',
        },

        {
          src: createEventObservableLogic<{ type: 'a' }, undefined>(
            ({ system }) => {
              observed.push(system.get('test9') !== undefined)
              return toSubscribable(of({ type: 'a' }))
            },
          ),
        },
      ],
    })

    const actor = createActor(machine).start()

    yield* expect({
      registered: actor.system.get('test9') !== undefined,
      observed,
    }).toEqual({ registered: true, observed: [true] })
  })

  it('should be accessible in callback logic', function*({ expect }) {
    const observed: boolean[] = []
    const machine = createMachine({
      invoke: [
        {
          src: createMachine({}),
          registryKey: 'test10',
        },
        {
          src: createCallbackLogic(({ system }) => {
            observed.push(system.get('test10') !== undefined)
          }),
        },
      ],
    })

    const actor = createActor(machine).start()

    yield* expect({
      registered: actor.system.get('test10') !== undefined,
      observed,
    }).toEqual({ registered: true, observed: [true] })
  })

  it(
    'should gracefully handle re-registration of a `registryKey` during a reentering transition',
    function*({ expect }) {
      const calls: unknown[][] = []

      let counter = 0

      const machine = createMachine({
        initial: 'listening',
        states: {
          listening: {
            invoke: {
              registryKey: 'listener',
              src: createCallbackLogic(({ receive }) => {
                const localId = counter++

                receive((event) => {
                  calls.push([localId, event])
                })

                return () => {}
              }),
            },
          },
        },
        on: {
          RESTART: {
            target: '.listening',
          },
        },
      })

      const actorRef = createActor(machine).start()

      actorRef.send({ type: 'RESTART' })
      defined(actorRef.system.get('listener'), 'listener').send({ type: 'a' })

      yield* expect(calls).toEqual([
        [
          1,
          {
            type: 'a',
          },
        ],
      ])
    },
  )

  it(
    'should be able to send an event to an ancestor with a registered `registryKey` from an initial entry action',
    function*({ expect }) {
      const calls: unknown[][] = []
      const recorder = (...args: unknown[]) => {
        calls.push(args)
      }

      const child = createMachine({
        entry: ({ system }, enq) => {
          enq.sendTo(system?.get('myRoot'), { type: 'EV' })
        },
      })

      const machine = createMachine({
        invoke: {
          src: child,
        },
        on: {
          EV: (_, enq) => {
            enq(recorder)
          },
        },
      })
      createActor(machine, { registryKey: 'myRoot' }).start()

      yield* expect({ callCount: calls.length }).toEqual({ callCount: 1 })
    },
  )

  it('registry key should be accessible on the actor', function*({ expect }) {
    const machine = createMachine({})
    const actor = createActor(machine, { registryKey: 'test' })
    yield* expect(actor.registryKey).toBe('test')
  })

  it('should give a list of runnings actors', function*({ expect }) {
    const machine = createMachine({
      id: 'root',
      initial: 'happy path',
      states: {
        'happy path': {
          entry: (_, enq) => {
            enq.spawn(createMachine({}), { registryKey: 'child1' })
          },
          invoke: {
            src: createMachine({}),
            registryKey: 'child2',
          },
          on: {
            stopChild1: { target: 'sad path' },
          },
        },
        'sad path': {
          entry: ({ system }, enq) => {
            enq.stop(system?.get('child1'))
          },
        },
      },
    })

    const actor = createActor(machine).start()
    const child1 = actor.system.get('child1')
    const child2 = actor.system.get('child2')
    const beforeStop = actor.system.getAll()

    actor.send({ type: 'stopChild1' })

    yield* expect({
      beforeStop,
      afterStop: actor.system.getAll(),
    }).toEqual({
      beforeStop: {
        child1,
        child2,
      },
      afterStop: {},
    })
  })

  it.skip('should unregister nested child registryKeys when stopping a parent actor', function*({ expect }) {
    const subchild = createMachine({})

    const child = createMachine({
      actors: {
        subchild,
      },
      id: 'childSystem',
      invoke: {
        src: ({ actors }) => actors.subchild,
        registryKey: 'subchild',
      },
    })

    const parent = createMachine({
      actors: { child },

      entry: ({ actors }, enq) => {
        enq.spawn(actors.child, { id: 'childId' })
      },
      on: {
        restart: ({ children, actors }, enq) => {
          enq.stop(children['childId'])
          enq.spawn(actors.child, { id: 'childId' })
        },
      },
    })

    const root = createActor(parent).start()
    const registeredBeforeRestart = root.system.get('subchild') !== undefined

    const restartError = captureError(() => root.send({ type: 'restart' }))

    yield* expect({
      registeredBeforeRestart,
      restartError,
      registeredAfterRestart: root.system.get('subchild') !== undefined,
    }).toEqual({
      registeredBeforeRestart: true,
      restartError: undefined,
      registeredAfterRestart: true,
    })
  })
})
