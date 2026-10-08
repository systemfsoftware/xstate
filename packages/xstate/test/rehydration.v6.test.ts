import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { BehaviorSubject } from 'rxjs'
import { createActor, createAsyncLogic, createMachine, createObservableLogic } from '../src/index.js'
import { toSubscribable } from './utils.js'

describe('rehydration', () => {
  describe('using persisted state', () => {
    it('should be able to use `hasTag` immediately', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            tags: ['foo'],
          },
        },
      })

      const actorRef = createActor(machine).start()
      const persistedState = JSON.stringify(actorRef.getPersistedSnapshot())
      actorRef.stop()

      const service = createActor(machine, {
        snapshot: JSON.parse(persistedState),
      }).start()

      yield* expect({ hasTagFoo: service.getSnapshot().hasTag('foo') }).toEqual({
        hasTagFoo: true,
      })
    })

    it('should not call exit actions when machine gets stopped immediately', function*({ expect }) {
      const actual: string[] = []
      const machine = createMachine({
        exit: (_, enq) => {
          enq(() => actual.push('root'))
        },
        initial: 'a',
        states: {
          a: {
            exit: (_, enq) => {
              enq(() => actual.push('a'))
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      const persistedState = JSON.stringify(actorRef.getPersistedSnapshot())
      actorRef.stop()

      createActor(machine, { snapshot: JSON.parse(persistedState) })
        .start()
        .stop()

      yield* expect(actual).toEqual([])
    })

    it('should get correct result back from `can` immediately', function*({ expect }) {
      const machine = createMachine({
        on: {
          FOO: (_, enq) => {
            enq(() => {})
          },
        },
      })

      const persistedState = JSON.stringify(
        createActor(machine).start().getSnapshot(),
      )
      const restoredState = JSON.parse(persistedState)
      const service = createActor(machine, {
        snapshot: restoredState,
      }).start()

      yield* expect({ canFoo: service.getSnapshot().can({ type: 'FOO' }) }).toEqual({ canFoo: true })
    })
  })

  describe('using state value', () => {
    it('should be able to use `hasTag` immediately', function*({ expect }) {
      const machine = createMachine({
        initial: 'inactive',
        states: {
          inactive: {
            on: { NEXT: { target: 'active' } },
          },
          active: {
            tags: ['foo'],
          },
        },
      })

      const activeState = machine.resolveState({ value: 'active' })
      const service = createActor(machine, {
        snapshot: activeState,
      })

      service.start()

      yield* expect({ hasTagFoo: service.getSnapshot().hasTag('foo') }).toEqual({
        hasTagFoo: true,
      })
    })

    it('should not call exit actions when machine gets stopped immediately', function*({ expect }) {
      const actual: string[] = []
      const machine = createMachine({
        exit: (_, enq) => {
          enq(() => actual.push('root'))
        },
        initial: 'inactive',
        states: {
          inactive: {
            on: { NEXT: { target: 'active' } },
          },
          active: {
            exit: (_, enq) => {
              enq(() => actual.push('active'))
            },
          },
        },
      })

      createActor(machine, {
        snapshot: machine.resolveState({ value: 'active' }),
      })
        .start()
        .stop()

      yield* expect(actual).toEqual([])
    })

    it('should error on incompatible state value (shallow)', function*({ expect }) {
      const machine = createMachine({
        initial: 'valid',
        states: {
          valid: {},
        },
      })

      yield* expect(() => {
        machine.resolveState({ value: 'invalid' })
      }).toThrow(/invalid/)
    })

    it('should error on incompatible state value (deep)', function*({ expect }) {
      const machine = createMachine({
        initial: 'parent',
        states: {
          parent: {
            initial: 'valid',
            states: {
              valid: {},
            },
          },
        },
      })

      yield* expect(() => {
        machine.resolveState({ value: { parent: 'invalid' } })
      }).toThrow(/invalid/)
    })
  })

  it('should not replay actions when starting from a persisted state', function*({ expect }) {
    const entryCalls: string[] = []
    const machine = createMachine({
      entry: (_, enq) => {
        enq(() => {
          entryCalls.push('entry')
        })
      },
    })

    const actor = createActor(machine).start()

    const callsAfterFirstStart = [...entryCalls]

    const persistedState = actor.getPersistedSnapshot()

    actor.stop()

    createActor(machine, { snapshot: persistedState }).start()

    const callsAfterRehydrate = [...entryCalls]

    yield* expect({ callsAfterFirstStart, callsAfterRehydrate }).toEqual({
      callsAfterFirstStart: ['entry'],
      callsAfterRehydrate: ['entry'],
    })
  })

  it('should be able to stop a rehydrated child', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve(11) }),
            onDone: { target: 'b' },
          },
          on: {
            NEXT: { target: 'c' },
          },
        },
        b: {},
        c: {},
      },
    })

    const actor = createActor(machine).start()
    const persistedState = actor.getPersistedSnapshot()
    actor.stop()

    const rehydratedActor = createActor(machine, {
      snapshot: persistedState,
    }).start()

    const before = rehydratedActor.getSnapshot().value

    rehydratedActor.send({
      type: 'NEXT',
    })

    const after = rehydratedActor.getSnapshot().value

    yield* expect({ before, after }).toEqual({ before: 'a', after: 'c' })
  })

  it('a rehydrated active child should be registered in the system', function*({ expect }) {
    const machine = createMachine({
      actors: {
        foo: createMachine({}),
      },
      context: ({ spawn, actors }) => {
        spawn(actors.foo, {
          registryKey: 'mySystemId',
        })
        return {}
      },
    })

    const actor = createActor(machine).start()
    const persistedState = actor.getPersistedSnapshot()
    actor.stop()

    const rehydratedActor = createActor(machine, {
      snapshot: persistedState,
    }).start()

    yield* expect(rehydratedActor.system.get('mySystemId')?.getSnapshot()).toMatchObject({ status: 'active' })
  })

  it('a rehydrated done child should not be registered in the system', function*({ expect }) {
    const machine = createMachine({
      actors: {
        foo: createMachine({ type: 'final' }),
      },
      context: ({ spawn, actors }) => {
        spawn(actors.foo, {
          registryKey: 'mySystemId',
        })
        return {}
      },
    })

    const actor = createActor(machine).start()
    const persistedState = actor.getPersistedSnapshot()
    actor.stop()

    const rehydratedActor = createActor(machine, {
      snapshot: persistedState,
    }).start()

    yield* expect(rehydratedActor.system.get('mySystemId')).toBe(undefined)
  })

  it('a rehydrated done child should not re-notify the parent about its completion', function*({ expect }) {
    const notifications: string[] = []

    const machine = createMachine({
      actors: {
        foo: createMachine({ type: 'final' }),
      },
      context: ({ spawn, actors }) => {
        spawn(actors.foo, {
          registryKey: 'mySystemId',
        })
        return {}
      },
      on: {
        '*': (_, enq) => {
          enq(() => notifications.push('notified'))
        },
      },
    })

    const actor = createActor(machine).start()
    const persistedState = actor.getPersistedSnapshot()
    actor.stop()

    notifications.length = 0

    createActor(machine, {
      snapshot: persistedState,
    }).start()

    yield* expect(notifications).toEqual([])
  })

  it('should be possible to persist a rehydrated actor that got its children rehydrated', function*({ expect }) {
    const machine = createMachine({
      actors: {
        foo: createAsyncLogic({ run: () => Promise.resolve(42) }),
      },
      invoke: {
        src: 'foo',
      },
    })

    const actor = createActor(machine).start()

    const rehydratedActor = createActor(machine, {
      snapshot: actor.getPersistedSnapshot(),
    }).start()

    const persistedChildren = rehydratedActor.getPersistedSnapshot().children
    yield* expect({
      childCount: Object.keys(persistedChildren).length,
      src: Object.values(persistedChildren)[0]?.src,
    }).toEqual({ childCount: 1, src: 'foo' })
  })

  it('should complete on a rehydrated final state', function*({ expect }) {
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          on: { NEXT: { target: 'bar' } },
        },
        bar: {
          type: 'final',
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })
    const persistedState = actorRef.getPersistedSnapshot()

    const completions: string[] = []
    const actorRef2 = createActor(machine, { snapshot: persistedState })
    actorRef2.subscribe({
      complete: () => {
        completions.push('complete')
      },
    })

    actorRef2.start()
    yield* expect(completions).toEqual(['complete'])
  })

  it('should error on a rehydrated error state', function*({ expect }) {
    const failure = createAsyncLogic({
      run: () => Promise.reject(new Error('failure')),
    })
    const machine = createMachine(
      {
        invoke: {
          src: failure,
        },
      },
      // {
      //   actors: {
      //     failure: createAsyncLogic(() => Promise.reject(new Error('failure')))
      //   }
      // }
    )

    const actorRef = createActor(machine)
    const errorObserved = new Promise<void>((resolve) => {
      actorRef.subscribe({ error: () => resolve() })
    })
    actorRef.start()

    yield* Effect.promise(() => errorObserved)

    const persistedState = actorRef.getPersistedSnapshot()

    const errors: string[] = []
    const actorRef2 = createActor(machine, { snapshot: persistedState })
    actorRef2.subscribe({
      error: (error) => {
        errors.push(error instanceof Error ? error.message : String(error))
      },
    })
    actorRef2.start()

    yield* expect(errors).toEqual(['failure'])
  })

  it(`shouldn't re-notify the parent about the error when rehydrating`, function*({ expect }) {
    const errorNotifications: string[] = []
    let signalError: () => void = () => {}
    const errorObserved = new Promise<void>((resolve) => {
      signalError = resolve
    })
    const failure = createAsyncLogic({
      run: () => Promise.reject(new Error('failure')),
    })
    const machine = createMachine(
      {
        invoke: {
          src: failure,
          onError: (_, enq) => {
            enq(() => {
              errorNotifications.push('error')
              signalError()
            })
          },
        },
      },
      // {
      //   actors: {
      //     failure: createAsyncLogic(() => Promise.reject(new Error('failure')))
      //   }
      // }
    )

    const actorRef = createActor(machine)
    actorRef.start()

    yield* Effect.promise(() => errorObserved)

    const persistedState = actorRef.getPersistedSnapshot()
    errorNotifications.length = 0

    const actorRef2 = createActor(machine, { snapshot: persistedState })
    actorRef2.start()

    yield* expect(errorNotifications).toEqual([])
  })

  it('should continue syncing snapshots', function*({ expect }) {
    const subject = new BehaviorSubject(0)
    const subjectLogic = createObservableLogic<number, undefined>(
      () => toSubscribable(subject),
    )

    const snapshots: number[] = []

    const machine = createMachine({
      actors: {
        service: subjectLogic,
      },
      invoke: {
        src: 'service',
        onSnapshot: ({ event }, enq) => {
          enq(() => snapshots.push(event.snapshot.context))
        },
      },
    })

    createActor(machine, {
      snapshot: createActor(machine).getPersistedSnapshot(),
    }).start()

    snapshots.length = 0

    subject.next(42)
    subject.next(100)

    yield* expect(snapshots).toEqual([42, 100])
  })

  it('should be able to rehydrate an actor deep in the tree', function*({ expect }) {
    const grandchild = createMachine({
      context: {
        count: 0,
      },
      on: {
        INC: ({ context }) => ({
          context: {
            count: context.count + 1,
          },
        }),
      },
    })
    const child = createMachine(
      {
        invoke: {
          src: grandchild,
          id: 'grandchild',
        },
        on: {
          INC: ({ children }) => {
            children['grandchild']?.send({ type: 'INC' })
          },
        },
      },
      // {
      //   actors: {
      //     grandchild
      //   }
      // }
    )
    const machine = createMachine(
      {
        invoke: {
          src: child,
          id: 'child',
        },
        on: {
          INC: ({ children }) => {
            children['child']?.send({ type: 'INC' })
          },
        },
      },
      // {
      //   actors: {
      //     child
      //   }
      // }
    )

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'INC' })

    const persistedState = actorRef.getPersistedSnapshot()
    const actorRef2 = createActor(machine, { snapshot: persistedState })

    const childRef = actorRef2.getSnapshot().children['child']
    if (childRef === undefined) {
      throw new Error('expected a child actor')
    }
    const grandchildRef = childRef.getSnapshot().children.grandchild
    if (grandchildRef === undefined) {
      throw new Error('expected a grandchild actor')
    }

    yield* expect(grandchildRef.getSnapshot().context.count).toBe(1)
  })
})
