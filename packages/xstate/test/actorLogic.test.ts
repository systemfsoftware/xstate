import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { EMPTY, interval, type Observable, of, throwError } from 'rxjs'
import { take } from 'rxjs/operators'
import z from 'zod'
import {
  createAsyncLogic,
  createCallbackLogic,
  createEventObservableLogic,
  createLogic,
  createObservableLogic,
} from '../src/actors/index.js'
import {
  type ActorLogic,
  type ActorRefFrom,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyActorSystem,
  type AnyStateMachine,
  createActor,
  createMachine,
  type EventObject,
  initialTransition,
  type Snapshot,
  transition,
} from '../src/index.js'
import { createInertActorScope } from '../src/inertActorScope.js'
import { waitFor } from '../src/waitFor.js'
import { toSubscribable } from './utils.js'

describe('logic (createLogic)', () => {
  it('returns actor termination as an ordered transition effect', function*({ expect }) {
    const logic = createLogic({
      context: undefined,
      run: ({ event }) =>
        event.type === 'finish'
          ? { status: 'done' as const, output: 42 }
          : undefined,
    })
    const [active] = initialTransition(logic)

    const [done, effects] = transition(logic, active, { type: 'finish' })
    const terminalEffects = transition(logic, done, { type: 'finish' })[1]

    yield* expect({ done, effects, terminalEffects }).toMatchObject({
      done: { status: 'done', output: 42 },
      effects: [
        {
          kind: 'builtin',
          type: '@xstate.terminate',
          status: 'done',
          output: 42,
        },
      ],
      terminalEffects: [],
    })
  })

  it('returns async actor termination from the pure transition', function*({ expect }) {
    const logic = createAsyncLogic({ run: () => Promise.resolve(42) })
    const [active] = initialTransition(logic)

    const [done, effects] = transition(logic, active, {
      type: 'xstate.async.resolve',
      data: 42,
    } as any)

    yield* expect({ done, last: effects.at(-1) }).toMatchObject({
      done: { status: 'done', output: 42 },
      last: {
        type: '@xstate.terminate',
        status: 'done',
        output: 42,
      },
    })
  })

  it('returns observable completion and failure as termination effects', function*({ expect }) {
    const logic = createObservableLogic<never, undefined>(
      () => toSubscribable(EMPTY),
    )
    const [active] = initialTransition(logic)
    const [done, doneEffects] = transition(logic, active, {
      type: 'xstate.observable.complete',
    } as any)
    const error = new Error('failed')
    const [failed, errorEffects] = transition(logic, active, {
      type: 'xstate.observable.error',
      data: error,
    } as any)

    yield* expect({
      doneStatus: done.status,
      doneLast: doneEffects.at(-1),
      failed,
      errorLast: errorEffects.at(-1),
    }).toMatchObject({
      doneStatus: 'done',
      doneLast: {
        type: '@xstate.terminate',
        status: 'done',
      },
      failed: { status: 'error', error },
      errorLast: {
        type: '@xstate.terminate',
        status: 'error',
        error,
      },
    })
  })

  it('returns termination when createLogic completes during initialization', function*({ expect }) {
    const logic = createLogic({
      context: undefined,
      run: ({ event }) =>
        event.type === '@xstate.init'
          ? { status: 'done' as const, output: 42 }
          : undefined,
    })

    const [done, effects] = initialTransition(logic)

    yield* expect({ done, last: effects.at(-1) }).toMatchObject({
      done: { status: 'done', output: 42 },
      last: {
        type: '@xstate.terminate',
        status: 'done',
        output: 42,
      },
    })
  })

  it('returns a snapshot and effects from transition', function*({ expect }) {
    const logic = createLogic({
      context: { count: 0 },
      run: ({ context, event }, enq) => {
        if (event.type !== 'inc') {
          return
        }
        enq.emit({ type: 'counted' })
        return {
          context: {
            count: context.count + 1,
          },
        }
      },
    })
    const scope = createInertActorScope(logic)
    const snapshot = logic.getInitialSnapshot(scope, undefined)
    const [nextSnapshot, effects] = logic.transition(
      snapshot,
      { type: 'inc' },
      scope,
    )

    yield* expect({ context: nextSnapshot.context, effects }).toEqual({
      context: { count: 1 },
      effects: [
        expect.objectContaining({
          kind: 'emit',
          type: 'counted',
          event: { type: 'counted' },
        }),
      ],
    })
  })

  it('tracks enqueued effects in the next snapshot', function*({ expect }) {
    const logic = createLogic({
      context: {},
      run: (_, enq) => {
        enq.effect('subscription', () => {})
      },
    })
    const [nextSnapshot, effects] = initialTransition(logic)
    const [snapshotAfterSecondTransition, repeatedEffects] = transition(
      logic,
      nextSnapshot,
      { type: 'next' },
    )

    yield* expect({
      effects,
      nextEffects: nextSnapshot.effects,
      repeatedEffects,
      repeatedNextEffects: snapshotAfterSecondTransition.effects,
    }).toEqual({
      effects: [
        expect.objectContaining({
          kind: 'action',
          type: 'xstate.logic.effect',
          params: { key: 'subscription' },
          args: [],
        }),
      ],
      nextEffects: {
        subscription: { status: 'active' },
      },
      repeatedEffects: [],
      repeatedNextEffects: {
        subscription: { status: 'active' },
      },
    })
  })

  it('does not track unnamed effects in the next snapshot', function*({ expect }) {
    const logic = createLogic({
      context: {},
      run: (_, enq) => {
        enq.effect(() => {})
      },
    })
    const scope = createInertActorScope(logic)
    const snapshot = logic.getInitialSnapshot(scope, undefined)
    const [nextSnapshot, effects] = logic.transition(
      snapshot,
      { type: 'next' },
      scope,
    )
    const [, repeatedEffects] = logic.transition(
      nextSnapshot,
      { type: 'next' },
      scope,
    )

    yield* expect({
      nextEffects: nextSnapshot.effects,
      effects,
      repeatedEffects,
    }).toEqual({
      nextEffects: undefined,
      effects: [
        expect.objectContaining({
          kind: 'action',
          type: 'xstate.logic.effect',
          args: [],
        }),
      ],
      repeatedEffects: [
        expect.objectContaining({
          kind: 'action',
          type: 'xstate.logic.effect',
          args: [],
        }),
      ],
    })
  })

  it('executes enqueued effects once and cleans them up when stopped', function*({ expect }) {
    let starts = 0
    let stops = 0
    const logic = createLogic({
      context: { count: 0 },
      run: ({ context, event }, enq) => {
        enq.effect('subscription', () => {
          starts++
          return () => {
            stops++
          }
        })

        if (event.type === 'inc') {
          return {
            context: { count: context.count + 1 },
          }
        }
        return undefined
      },
    })
    const actor = createActor(logic).start()

    actor.send({ type: 'inc' })
    actor.send({ type: 'inc' })
    actor.stop()

    yield* expect({
      context: actor.getSnapshot().context,
      starts,
      stops,
    }).toEqual({ context: { count: 2 }, starts: 1, stops: 1 })
  })
})

describe('hand-written actor logic', () => {
  it('completes when a transition returns a terminal snapshot without a terminate effect', function*({ expect }) {
    const logic: ActorLogic<
      Snapshot<number>,
      { type: 'finish' },
      unknown,
      AnyActorSystem,
      EventObject
    > = {
      initialTransition: () => [
        { status: 'active', output: undefined, error: undefined },
        [],
      ],
      transition: (snapshot, event) =>
        event.type === 'finish'
          ? [{ status: 'done', output: 42, error: undefined }, []]
          : [snapshot, []],
      getInitialSnapshot: () => ({
        status: 'active',
        output: undefined,
        error: undefined,
      }),
      getPersistedSnapshot: (snapshot) => snapshot,
    }
    const observed: string[] = []
    const actor = createActor(logic)
    actor.subscribe({
      next: (snapshot) => observed.push(`next:${snapshot.status}`),
      complete: () => observed.push('complete'),
    })
    actor.start()

    actor.send({ type: 'finish' })

    yield* expect(observed).toEqual(['next:active', 'next:done', 'complete'])
  })
})

describe('logic helpers', () => {
  it('creates callback logic', function*({ expect }) {
    const received: string[] = []
    const actor = createActor(
      createCallbackLogic(({ receive }) => {
        receive((event) => {
          received.push(event.type)
        })
      }),
    ).start()

    actor.send({ type: 'ping' })
    actor.stop()

    yield* expect(received).toEqual(['ping'])
  })

  it('creates observable logic', function*({ expect }) {
    const actor = createActor(
      createObservableLogic<number, undefined>(() => toSubscribable(of(1, 2))),
    ).start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s) => s.status === 'done'))

    yield* expect(snapshot.context).toBe(2)
  })
})

describe('promise logic (createAsyncLogic)', () => {
  it('should interpret a promise', function*({ expect }) {
    const promiseLogic = createAsyncLogic({
      run: () =>
        new Promise<string>((res) => {
          setTimeout(() => res('hello'), 10)
        }),
    })
    const actor = createActor(promiseLogic)
    actor.start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s) => s.output === 'hello'))
    yield* expect(snapshot.output).toBe('hello')
  })
  it('should resolve', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const actor = createActor(
      createAsyncLogic({ run: () => Promise.resolve(42) }),
    )
    actor.subscribe((state) => {
      if (state.output === 42) {
        resolve()
      }
    })
    actor.start()
    yield* Effect.promise(() => promise)
    yield* expect(actor.getSnapshot().output).toBe(42)
  })
  it('should resolve (observer .next)', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const actor = createActor(
      createAsyncLogic({ run: () => Promise.resolve(42) }),
    )
    actor.subscribe({
      next: (state) => {
        if (state.output === 42) {
          resolve()
        }
      },
    })
    actor.start()
    yield* Effect.promise(() => promise)
    yield* expect(actor.getSnapshot().output).toBe(42)
  })
  it('should reject (observer .error)', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let received: unknown
    const actor = createActor(
      createAsyncLogic({ run: () => Promise.reject('Error') }),
    )
    actor.subscribe({
      error: (data) => {
        received = data
        resolve()
      },
    })
    actor.start()
    yield* Effect.promise(() => promise)
    yield* expect(received).toBe('Error')
  })
  it('should complete (observer .complete)', function*({ expect }) {
    const actor = createActor(
      createAsyncLogic({ run: () => Promise.resolve(42) }),
    )
    actor.start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s) => s.output === 42))
    yield* expect(snapshot.output).toBe(42)
  })
  it('should not execute when reading initial state', function*({ expect }) {
    let called = false
    const logic = createAsyncLogic({
      run: () => {
        called = true
        return Promise.resolve(42)
      },
    })
    const actor = createActor(logic)
    actor.getSnapshot()
    yield* expect({ called }).toEqual({ called: false })
  })
  it('should await steps and persist their results as effects', function*({ expect }) {
    let stepExecutions = 0
    const logic = createAsyncLogic({
      run: (_, enq) =>
        enq
          .step('fetchUser', () => {
            stepExecutions++
            return Promise.resolve({ id: 1 })
          })
          .then((user) => user.id),
    })
    const actor = createActor(logic).start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s) => s.status === 'done'))

    const stepExecutionsBeforeRestore = stepExecutions
    const restoredActor = createActor(logic, {
      snapshot: actor.getPersistedSnapshot(),
    }).start()
    const stepExecutionsAfterRestore = stepExecutions

    yield* expect({
      output: snapshot.output,
      effects: snapshot.effects,
      stepExecutionsBeforeRestore,
      restoredOutput: restoredActor.getSnapshot().output,
      stepExecutionsAfterRestore,
    }).toEqual({
      output: 1,
      effects: {
        async: { status: 'done', output: 1 },
        fetchUser: { status: 'done', output: { id: 1 } },
      },
      stepExecutionsBeforeRestore: 1,
      restoredOutput: 1,
      stepExecutionsAfterRestore: 1,
    })
  })
  it('should replay active async logic while skipping completed steps', function*({ expect }) {
    let runExecutions = 0
    let firstStepExecutions = 0
    let secondStepExecutions = 0
    const logic = createAsyncLogic({
      run: (_, enq) => {
        runExecutions++
        return enq
          .step('first', () => {
            firstStepExecutions++
            return Promise.resolve(1)
          })
          .then((first) =>
            enq
              .step('second', () => {
                secondStepExecutions++
                return secondStepExecutions === 1
                  ? new Promise<number>(() => {})
                  : Promise.resolve(2)
              })
              .then((second) => first + second)
          )
      },
    })
    const actor = createActor(logic).start()

    const activeSnapshot = yield* Effect.promise(() =>
      waitFor(actor, (snapshot) => {
        return (
          snapshot.effects?.['first']?.status === 'done' &&
          snapshot.effects?.['second']?.status === 'active'
        )
      })
    )

    const activeEffects = activeSnapshot.effects
    const runExecutionsFirst = runExecutions
    const firstStepExecutionsFirst = firstStepExecutions
    const secondStepExecutionsFirst = secondStepExecutions

    const persistedSnapshot = JSON.parse(
      JSON.stringify(actor.getPersistedSnapshot()),
    )
    actor.stop()

    const restoredActor = createActor(logic, {
      snapshot: persistedSnapshot,
    }).start()

    yield* expect({
      activeEffects,
      runExecutionsFirst,
      firstStepExecutionsFirst,
      secondStepExecutionsFirst,
    }).toEqual({
      activeEffects: {
        async: { status: 'active' },
        first: { status: 'done', output: 1 },
        second: { status: 'active' },
      },
      runExecutionsFirst: 1,
      firstStepExecutionsFirst: 1,
      secondStepExecutionsFirst: 1,
    })

    yield* Effect.promise(() => waitFor(restoredActor, () => runExecutions === 2))

    const doneSnapshot = yield* Effect.promise(() => waitFor(restoredActor, (snapshot) => snapshot.status === 'done'))

    yield* expect({
      output: doneSnapshot.output,
      effects: doneSnapshot.effects,
      runExecutions,
      firstStepExecutions,
      secondStepExecutions,
    }).toEqual({
      output: 3,
      effects: {
        async: { status: 'done', output: 3 },
        first: { status: 'done', output: 1 },
        second: { status: 'done', output: 2 },
      },
      runExecutions: 2,
      firstStepExecutions: 1,
      secondStepExecutions: 2,
    })
  })
  it('should rerun an unresolved promise from an active persisted snapshot', function*({ expect }) {
    let createdPromises = 0
    const promiseLogic = createAsyncLogic({
      run: () => {
        createdPromises++
        return new Promise<number>((res) => {
          setTimeout(() => res(42), 10)
        })
      },
    })
    const actor = createActor(promiseLogic)
    actor.start()
    const activePersistedState = actor.getPersistedSnapshot()
    const createdPromisesFirst = createdPromises
    actor.stop()
    const restoredActor = createActor(promiseLogic, {
      snapshot: activePersistedState,
    })
    restoredActor.start()
    const createdPromisesSecond = createdPromises

    yield* expect({ createdPromisesFirst, createdPromisesSecond }).toEqual({
      createdPromisesFirst: 1,
      createdPromisesSecond: 2,
    })

    const snapshot = yield* Effect.promise(() =>
      waitFor(
        restoredActor,
        (snapshot) => snapshot.status === 'done',
      )
    )

    yield* expect({ output: snapshot.output, effects: snapshot.effects }).toEqual({
      output: 42,
      effects: {
        async: { status: 'done', output: 42 },
      },
    })
  })
  it('should persist a resolved promise', function*({ expect }) {
    const promiseLogic = createAsyncLogic({
      run: () =>
        new Promise<number>((res) => {
          res(42)
        }),
    })
    const actor = createActor(promiseLogic)
    actor.start()
    yield* Effect.promise(() =>
      new Promise<void>((res) => {
        setTimeout(res, 5)
      })
    )
    const resolvedPersistedState = actor.getPersistedSnapshot()
    const restoredActor = createActor(promiseLogic, {
      snapshot: resolvedPersistedState,
    })
    restoredActor.start()

    yield* expect({
      resolvedPersistedState,
      restoredOutput: restoredActor.getSnapshot().output,
    }).toEqual({
      resolvedPersistedState: {
        effects: {
          async: {
            output: 42,
            status: 'done',
          },
        },
        error: undefined,
        input: undefined,
        output: 42,
        status: 'done',
      },
      restoredOutput: 42,
    })
  })
  it('should not invoke a resolved promise again', function*({ expect }) {
    let createdPromises = 0
    const promiseLogic = createAsyncLogic({
      run: () => {
        createdPromises++
        return Promise.resolve(createdPromises)
      },
    })
    const actor = createActor(promiseLogic)
    actor.start()
    yield* Effect.promise(() =>
      new Promise<void>((res) => {
        setTimeout(res, 5)
      })
    )
    const resolvedPersistedState = actor.getPersistedSnapshot()
    const createdPromisesBeforeRestore = createdPromises
    const restoredActor = createActor(promiseLogic, {
      snapshot: resolvedPersistedState,
    })
    restoredActor.start()

    yield* expect({
      resolvedPersistedState,
      createdPromisesBeforeRestore,
      restoredOutput: restoredActor.getSnapshot().output,
      createdPromisesAfterRestore: createdPromises,
    }).toEqual({
      resolvedPersistedState: {
        effects: {
          async: {
            output: 1,
            status: 'done',
          },
        },
        error: undefined,
        input: undefined,
        output: 1,
        status: 'done',
      },
      createdPromisesBeforeRestore: 1,
      restoredOutput: 1,
      createdPromisesAfterRestore: 1,
    })
  })
  it('should not invoke a rejected promise again', function*({ expect }) {
    let createdPromises = 0
    const promiseLogic = createAsyncLogic({
      run: () => {
        createdPromises++
        return Promise.reject(createdPromises)
      },
    })
    const actorRef = createActor(promiseLogic)
    actorRef.subscribe({ error: function preventUnhandledErrorListener() {} })
    actorRef.start()
    yield* Effect.promise(() =>
      new Promise<void>((res) => {
        setTimeout(res, 5)
      })
    )
    const rejectedPersistedState = actorRef.getPersistedSnapshot()
    const createdPromisesBeforeRestore = createdPromises
    const actorRef2 = createActor(promiseLogic, {
      snapshot: rejectedPersistedState,
    })
    actorRef2.subscribe({ error: function preventUnhandledErrorListener() {} })
    actorRef2.start()

    yield* expect({
      rejectedPersistedState,
      createdPromisesBeforeRestore,
      createdPromisesAfterRestore: createdPromises,
    }).toEqual({
      rejectedPersistedState: {
        effects: {
          async: {
            error: 1,
            status: 'error',
          },
        },
        error: 1,
        input: undefined,
        output: undefined,
        status: 'error',
      },
      createdPromisesBeforeRestore: 1,
      createdPromisesAfterRestore: 1,
    })
  })
  it('should have access to the system', function*({ expect }) {
    let receivedSystem: AnyActorSystem | undefined
    const promiseLogic = createAsyncLogic({
      run: ({ system }) => {
        receivedSystem = system
        return Promise.resolve(42)
      },
    })
    const actor = createActor(promiseLogic).start()
    yield* expect(receivedSystem).toBe(actor.system)
  })
  it('should have reference to self', function*({ expect }) {
    let receivedSelf: AnyActorRef | undefined
    const promiseLogic = createAsyncLogic({
      run: ({ self }) => {
        receivedSelf = self
        return Promise.resolve(42)
      },
    })
    const actor = createActor(promiseLogic).start()
    yield* expect(receivedSelf).toBe(actor)
  })
  it('should abort when stopping', function*({ expect }) {
    const deferred = Promise.withResolvers<number>()
    const abortCalls: unknown[] = []
    const onAbort = (event: unknown) => {
      abortCalls.push(event)
    }
    const promiseLogic = createAsyncLogic({
      run: (ctx) => {
        return new Promise((res) => {
          ctx.signal.addEventListener('abort', onAbort)
        })
      },
    })
    const actor = createActor(promiseLogic)
    actor.start()
    actor.stop()
    deferred.resolve(42)
    yield* Effect.promise(() => deferred.promise)
    yield* expect({ abortListenerCalls: abortCalls.length }).toEqual({
      abortListenerCalls: 1,
    })
  })
  it('should not abort when stopped if promise is resolved/rejected', function*({ expect }) {
    const resolvedDeferred = Promise.withResolvers<number>()
    const resolvedAbortCalls: unknown[] = []
    const resolvedSignalListener = (event: unknown) => {
      resolvedAbortCalls.push(event)
    }
    const resolvedPromiseLogic = createAsyncLogic({
      run: (ctx) => {
        ctx.signal.addEventListener('abort', resolvedSignalListener)
        return resolvedDeferred.promise
      },
    })
    const rejectedDeferred = Promise.withResolvers<number>()
    const rejectedAbortCalls: unknown[] = []
    const rejectedSignalListener = (event: unknown) => {
      rejectedAbortCalls.push(event)
    }
    const rejectedPromiseLogic = createAsyncLogic({
      run: (ctx) => {
        ctx.signal.addEventListener('abort', rejectedSignalListener)
        return rejectedDeferred.promise.catch(() => {})
      },
    })
    const actor = createActor(resolvedPromiseLogic)
    actor.start()
    resolvedDeferred.resolve(42)
    yield* Effect.promise(() => waitFor(actor, (s) => s.status === 'done'))
    actor.stop()
    yield* expect({
      resolvedAbortListenerCalls: resolvedAbortCalls.length,
    }).toEqual({ resolvedAbortListenerCalls: 0 })
    const actor2 = createActor(rejectedPromiseLogic)
    actor2.start()
    rejectedDeferred.reject(50)
    yield* Effect.promise(() => rejectedDeferred.promise.catch(() => {}))
    yield* Effect.promise(() => waitFor(actor2, (s) => s.status === 'done'))
    actor2.stop()
    yield* expect({
      rejectedAbortListenerCalls: rejectedAbortCalls.length,
    }).toEqual({ rejectedAbortListenerCalls: 0 })
  })
  it('should not reuse the same signal for different actors with same logic', function*({ expect }) {
    let deferredMap: Map<string, PromiseWithResolvers<number>> = new Map()
    let signalListenerMap: Map<string, unknown[]> = new Map()
    const p = createAsyncLogic({
      run: ({ self, signal }) => {
        const deferred = Promise.withResolvers<number>()
        const signalListenerCalls: unknown[] = []
        deferredMap.set(self.id, deferred)
        signalListenerMap.set(self.id, signalListenerCalls)
        signal.addEventListener('abort', (event) => {
          signalListenerCalls.push(event)
        })
        return deferred.promise
      },
    })
    const machine = createMachine({
      type: 'parallel',
      states: {
        p1: {
          initial: 'running',
          states: {
            running: {
              invoke: {
                src: p,
                id: 'p1',
              },
              on: {
                CANCEL_1: { target: 'canceled' },
              },
            },
            canceled: {},
          },
        },
        p2: {
          initial: 'running',
          states: {
            running: {
              invoke: {
                src: p,
                id: 'p2',
                onDone: { target: 'done' },
              },
            },
            done: {},
          },
        },
      },
    })
    const actor = createActor(machine).start()
    const p1Deferred = deferredMap.get('p1')!
    const p2Deferred = deferredMap.get('p2')!
    actor.send({ type: 'CANCEL_1' })
    p1Deferred.resolve(42)
    p2Deferred.resolve(42)
    yield* Effect.promise(() =>
      Promise.all([
        waitFor(actor, (s) => s.matches('p1.canceled')),
        waitFor(actor, (s) => s.matches('p2.done')),
      ])
    )
    yield* expect({
      p1AbortListenerCalls: signalListenerMap.get('p1')!.length,
      p2AbortListenerCalls: signalListenerMap.get('p2')!.length,
    }).toEqual({ p1AbortListenerCalls: 1, p2AbortListenerCalls: 0 })
  })
  it.skip('should not reuse the same signal for different actors with same logic and id', function*({ expect }) {
    let deferredList: PromiseWithResolvers<number>[] = []
    let signalListenerList: Array<unknown[]> = []
    const p = createAsyncLogic({
      run: ({ signal }) => {
        const deferred = Promise.withResolvers<number>()
        const fn: unknown[] = []
        deferredList.push(deferred)
        signalListenerList.push(fn)
        signal.addEventListener('abort', (event) => {
          fn.push(event)
        })
        return deferred.promise
      },
    })
    const machine = createMachine({
      type: 'parallel',
      states: {
        p1: {
          initial: 'running',
          states: {
            running: {
              invoke: {
                src: p,
                id: 'p',
              },
              on: {
                CANCEL_1: { target: 'canceled' },
              },
            },
            canceled: {},
          },
        },
        p2: {
          initial: 'running',
          states: {
            running: {
              invoke: {
                src: p,
                id: 'p',
                onDone: { target: 'done' },
              },
            },
            done: {},
          },
        },
      },
    })
    const actor = createActor(machine).start()
    const p1Deferred = deferredList[0]
    if (p1Deferred === undefined) throw new Error('expected a first deferred')
    const p2Deferred = deferredList[1]
    if (p2Deferred === undefined) throw new Error('expected a second deferred')
    const p1Fn = signalListenerList[0]!
    const p2Fn = signalListenerList[1]!
    actor.send({ type: 'CANCEL_1' })
    p1Deferred.resolve(42)
    p2Deferred.resolve(42)
    yield* Effect.promise(() =>
      Promise.all([
        waitFor(actor, (s) => s.matches('p1.canceled')),
        waitFor(actor, (s) => s.matches('p2.done')),
      ])
    )
    yield* expect({
      p1AbortListenerCalls: p1Fn.length,
      p2AbortListenerCalls: p2Fn.length,
    }).toEqual({ p1AbortListenerCalls: 1, p2AbortListenerCalls: 0 })
  })
  it('should not reuse the same signal for the same actor when restarted', function*({ expect }) {
    let deferredList: PromiseWithResolvers<number>[] = []
    let signalListenerList: Array<unknown[]> = []
    const p = createAsyncLogic({
      run: ({ signal }) => {
        const deferred = Promise.withResolvers<number>()
        const fn: unknown[] = []
        deferredList.push(deferred)
        signalListenerList.push(fn)
        signal.addEventListener('abort', (event) => {
          fn.push(event)
        })
        return deferred.promise
      },
    })
    const machine = createMachine({
      initial: 'running',
      states: {
        running: {
          invoke: {
            src: p,
            id: 'p',
            onDone: { target: 'done' },
          },
          on: {
            cancel: { target: 'canceled' },
          },
        },
        done: {
          on: {
            restart: { target: 'running' },
          },
        },
        canceled: {
          on: {
            restart: { target: 'running' },
          },
        },
      },
    })
    const actor = createActor(machine).start()
    yield* Effect.promise(() => waitFor(actor, (s) => s.matches('running')))
    const deferred1 = deferredList[0]
    if (deferred1 === undefined) throw new Error('expected a first deferred')
    const fn1 = signalListenerList[0]!
    deferred1.resolve(42)
    yield* Effect.promise(() => waitFor(actor, (s) => s.matches('done')))
    yield* expect({ fn1AbortListenerCalls: fn1.length }).toEqual({
      fn1AbortListenerCalls: 0,
    })
    actor.send({ type: 'restart' })
    yield* Effect.promise(() => waitFor(actor, (s) => s.matches('running')))
    actor.send({ type: 'cancel' })
    yield* Effect.promise(() => waitFor(actor, (s) => s.matches('canceled')))
    const deferred2 = deferredList[1]
    if (deferred2 === undefined) throw new Error('expected a second deferred')
    deferred2.resolve(42)
    yield* Effect.promise(() => deferred2.promise)
    const fn2 = signalListenerList[1]!
    yield* expect({ fn2AbortListenerCalls: fn2.length }).toEqual({
      fn2AbortListenerCalls: 1,
    })
  })
})
describe('logic as reducer', () => {
  it('should interpret a reducer-like logic', function*({ expect }) {
    const transitionLogic = createLogic({
      context: { enabled: 'on' as 'off' | 'on' },
      run: ({ context, event }) => {
        if (event.type === 'toggle') {
          return {
            context: {
              enabled: context.enabled === 'on'
                ? ('off' as const)
                : ('on' as const),
            },
          }
        }
        return
      },
    })
    const actor = createActor(transitionLogic)
    actor.start()
    const enabledBefore = actor.getSnapshot().context.enabled
    actor.send({ type: 'toggle' })
    yield* expect({
      enabledBefore,
      enabledAfter: actor.getSnapshot().context.enabled,
    }).toEqual({ enabledBefore: 'on', enabledAfter: 'off' })
  })
  it('should persist reducer-like logic', function*({ expect }) {
    const logic = createLogic({
      context: {
        enabled: 'off' as 'off' | 'on',
      },
      run: ({ event }) => {
        if (event.type === 'activate') {
          return { context: { enabled: 'on' as const } }
        }
        return
      },
    })
    const actor = createActor(logic)
    actor.start()
    actor.send({ type: 'activate' })
    const persistedSnapshot = actor.getPersistedSnapshot()
    const restoredActor = createActor(logic, {
      snapshot: persistedSnapshot,
    })
    restoredActor.start()
    yield* expect({
      persistedSnapshot,
      restoredEnabled: restoredActor.getSnapshot().context.enabled,
    }).toEqual({
      persistedSnapshot: {
        status: 'active',
        output: undefined,
        error: undefined,
        context: {
          enabled: 'on',
        },
      },
      restoredEnabled: 'on',
    })
  })
  it('should have access to the system', function*({ expect }) {
    let receivedSystem: AnyActorSystem | undefined
    const transitionLogic = createLogic({
      context: 0,
      run: ({ event, system }) => {
        if (event.type === '@xstate.init') {
          return
        }
        receivedSystem = system
        return { context: 42 }
      },
    })
    const actor = createActor(transitionLogic)
    actor.start()
    actor.send({ type: 'a' })
    yield* expect(receivedSystem).toBe(actor.system)
  })
  it('should have reference to self', function*({ expect }) {
    let receivedSelf: AnyActorRef | undefined
    const transitionLogic = createLogic({
      context: 0,
      run: ({ event, self }) => {
        if (event.type === '@xstate.init') {
          return
        }
        receivedSelf = self
        return { context: 42 }
      },
    })
    const actor = createActor(transitionLogic)
    actor.start()
    actor.send({ type: 'a' })
    yield* expect(receivedSelf).toBe(actor)
  })
})
describe('observable logic (createObservableLogic)', () => {
  it('should interpret an observable', function*({ expect }) {
    const observableLogic = createObservableLogic<number, undefined>(() => toSubscribable(interval(10).pipe(take(4))))
    const actor = createActor(observableLogic).start()
    const snapshot = yield* Effect.promise(() => waitFor(actor, (s) => s.status === 'done'))
    yield* expect(snapshot.context).toEqual(3)
  })
  it('should resolve', function*({ expect }) {
    const actor = createActor(
      createObservableLogic<number, undefined>(() => toSubscribable(of(42))),
    )
    const observedContexts: Array<number | undefined> = []
    actor.subscribe((snapshot) => {
      observedContexts.push(snapshot.context)
    })
    actor.start()
    yield* expect({ sawContext42: observedContexts.includes(42) }).toEqual({
      sawContext42: true,
    })
  })
  it('should resolve (observer .next)', function*({ expect }) {
    const actor = createActor(
      createObservableLogic<number, undefined>(() => toSubscribable(of(42))),
    )
    const observedContexts: Array<number | undefined> = []
    actor.subscribe({
      next: (snapshot) => {
        observedContexts.push(snapshot.context)
      },
    })
    actor.start()
    yield* expect({ sawContext42: observedContexts.includes(42) }).toEqual({
      sawContext42: true,
    })
  })
  it('should reject (observer .error)', function*({ expect }) {
    const actor = createActor(
      createObservableLogic<never, undefined>(
        () => toSubscribable(throwError(() => 'Observable error.')),
      ),
    )
    const errors: unknown[] = []
    actor.subscribe({
      error: (error) => {
        errors.push(error)
      },
    })
    actor.start()
    yield* expect({ errors }).toEqual({ errors: ['Observable error.'] })
  })
  it('should complete (observer .complete)', function*({ expect }) {
    const actor = createActor(
      createObservableLogic<never, undefined>(() => toSubscribable(EMPTY)),
    )
    const completions: string[] = []
    actor.subscribe({
      complete: () => {
        completions.push('complete')
      },
    })
    actor.start()
    yield* expect({ completions }).toEqual({ completions: ['complete'] })
  })
  it('should not execute when reading initial state', function*({ expect }) {
    let called = false
    const logic = createObservableLogic<never, undefined>(() => {
      called = true
      return toSubscribable(EMPTY)
    })
    const actor = createActor(logic)
    actor.getSnapshot()
    yield* expect({ called }).toEqual({ called: false })
  })
  it('should have access to the system', function*({ expect }) {
    let receivedSystem: AnyActorSystem | undefined
    const observableLogic = createObservableLogic<number, undefined>(
      ({ system }) => {
        receivedSystem = system
        return toSubscribable(of(42))
      },
    )
    const actor = createActor(observableLogic).start()
    yield* expect(receivedSystem).toBe(actor.system)
  })
  it('should have reference to self', function*({ expect }) {
    let receivedSelf: AnyActorRef | undefined
    const observableLogic = createObservableLogic<number, undefined>(
      ({ self }) => {
        receivedSelf = self
        return toSubscribable(of(42))
      },
    )
    const actor = createActor(observableLogic).start()
    yield* expect(receivedSelf).toBe(actor)
  })
})
describe('eventObservable logic (createEventObservableLogic)', () => {
  it('should have access to the system', function*({ expect }) {
    let receivedSystem: AnyActorSystem | undefined
    const observableLogic = createEventObservableLogic<
      { type: string },
      undefined
    >(({ system }) => {
      receivedSystem = system
      return toSubscribable(of({ type: 'a' }))
    })
    const actor = createActor(observableLogic).start()
    yield* expect(receivedSystem).toBe(actor.system)
  })
  it('should have reference to self', function*({ expect }) {
    let receivedSelf: AnyActorRef | undefined
    const observableLogic = createEventObservableLogic<
      { type: string },
      undefined
    >(({ self }) => {
      receivedSelf = self
      return toSubscribable(of({ type: 'a' }))
    })
    const actor = createActor(observableLogic).start()
    yield* expect(receivedSelf).toBe(actor)
  })
})
describe('callback logic (createCallbackLogic)', () => {
  it('should interpret a callback', function*({ expect }) {
    const received: unknown[] = []
    const callbackLogic = createCallbackLogic(({ receive }) => {
      receive((event) => {
        received.push(event)
      })
    })
    const actor = createActor(callbackLogic).start()
    actor.send({ type: 'a' })
    yield* expect(received).toEqual([{ type: 'a' }])
  })
  it('should have access to the system', function*({ expect }) {
    let receivedSystem: AnyActorSystem | undefined
    const callbackLogic = createCallbackLogic(({ system }) => {
      receivedSystem = system
    })
    const actor = createActor(callbackLogic).start()
    yield* expect(receivedSystem).toBe(actor.system)
  })
  it('should have reference to self', function*({ expect }) {
    let receivedSelf: AnyActorRef | undefined
    const callbackLogic = createCallbackLogic(({ self }) => {
      receivedSelf = self
    })
    const actor = createActor(callbackLogic).start()
    yield* expect(receivedSelf).toBe(actor)
  })
  it('can send self reference in an event to parent', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const received: string[] = []
    const machine = createMachine({
      schemas: {
        events: {
          PING: z.object({ ref: z.any() }),
        },
      },
      invoke: {
        src: createCallbackLogic(({ self, sendBack, receive }) => {
          receive((event) => {
            switch (event.type) {
              case 'PONG': {
                received.push(event.type)
                resolve()
              }
            }
          })
          sendBack({
            type: 'PING',
            ref: self,
          })
        }),
      },
      on: {
        PING: ({ event }, enq) => {
          enq.sendTo(event.ref, { type: 'PONG' })
        },
      },
    })
    createActor(machine).start()
    yield* Effect.promise(() => promise)
    yield* expect(received).toEqual(['PONG'])
  })
  it.skip('should persist the input of a callback', function*({ expect }) {
    const receivedInputs: unknown[] = []
    const cb = createCallbackLogic(({ input }) => {
      receivedInputs.push(input)
    })
    const machine = createMachine({
      schemas: {
        events: {
          EV: z.object({ data: z.number() }),
        },
      },
      initial: 'a',
      states: {
        a: {
          on: {
            EV: { target: 'b' },
          },
        },
        b: {
          invoke: {
            src: cb,
            input: ({ event }) => event.data,
          },
        },
      },
    })
    const actor = createActor(machine)
    actor.start()
    actor.send({
      type: 'EV',
      data: 13,
    })
    const snapshot = actor.getPersistedSnapshot()
    actor.stop()
    receivedInputs.length = 0
    const restoredActor = createActor(machine, { snapshot })
    restoredActor.start()
    yield* expect(receivedInputs).toEqual([13])
  })
})
describe('machine logic', () => {
  it('should persist a machine', function*({ expect }) {
    const childMachine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 55,
      },
      initial: 'start',
      states: {
        start: {
          invoke: {
            id: 'reducer',
            src: createLogic({
              context: undefined,
              run: () => undefined,
            }),
          },
        },
      },
    })
    const machine = createMachine({
      initial: 'waiting',
      invoke: [
        {
          id: 'a',
          src: createAsyncLogic({ run: () => Promise.resolve(42) }),
          onDone: (_, enq) => enq.raise({ type: 'done' }),
        },
        {
          id: 'b',
          src: childMachine,
        },
      ],
      states: {
        waiting: {
          on: {
            done: { target: 'success' },
          },
        },
        success: {},
      },
    })
    const actor = createActor(machine).start()
    yield* Effect.promise(() => waitFor(actor, (s) => s.matches('success')))
    const persistedState = actor.getPersistedSnapshot()!
    yield* expect({
      childA: (persistedState as any).children.a,
      childB: (persistedState as any).children.b.snapshot,
    }).toEqual({
      childA: undefined,
      childB: expect.objectContaining({
        context: {
          count: 55,
        },
        value: 'start',
        children: {
          reducer: expect.objectContaining({
            snapshot: {
              status: 'active',
            },
          }),
        },
      }),
    })
  })
  it('should persist and restore a nested machine', function*({ expect }) {
    const childMachine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            LAST: { target: 'c' },
          },
        },
        c: {},
      },
    })
    const parentMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            START: { target: 'invoked' },
          },
        },
        invoked: {
          invoke: {
            id: 'child',
            src: childMachine,
          },
          on: {
            NEXT: ({ children }, enq) => {
              enq.sendTo(children['child'], { type: 'NEXT' })
            },
            LAST: ({ children }, enq) => {
              enq.sendTo(children['child'], { type: 'LAST' })
            },
          },
        },
      },
    })
    const actor = createActor(parentMachine).start()
    actor.send({ type: 'START' })
    actor.send({ type: 'NEXT' })
    const persistedSnapshot = actor.getPersistedSnapshot()!
    const newActor = createActor(parentMachine, {
      snapshot: persistedSnapshot,
    }).start()
    const newSnapshot = newActor.getSnapshot()
    const newChild = newSnapshot.children['child']
    if (newChild === undefined) throw new Error('expected child actor')
    const childValueAfterRestore = newChild.getSnapshot().value
    newActor.send({ type: 'LAST' })
    const newActorChild = newActor.getSnapshot().children['child']
    if (newActorChild === undefined) throw new Error('expected child actor')
    yield* expect({
      childValueAfterRestore,
      childValueAfterLast: newActorChild.getSnapshot().value,
    }).toEqual({ childValueAfterRestore: 'b', childValueAfterLast: 'c' })
  })
  it('should return the initial persisted state of a non-started actor', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {},
      },
    })
    const actor = createActor(machine)
    yield* expect(actor.getPersistedSnapshot()).toEqual(
      expect.objectContaining({
        value: 'idle',
      }),
    )
  })
  it('the initial state of a child is available before starting the parent', function*({ expect }) {
    const machine = createMachine({
      invoke: {
        id: 'child',
        src: createMachine({
          initial: 'inner',
          states: { inner: {} },
        }),
      },
    })
    const actor = createActor(machine)
    yield* expect(
      (actor.getPersistedSnapshot() as any).children['child'].snapshot,
    ).toEqual(
      expect.objectContaining({
        value: 'inner',
      }),
    )
  })
  it('should not invoke an actor if it is missing in persisted state', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          NEXT: z.object({
            data: z.object({
              deep: z.object({
                prop: z.string(),
              }),
            }),
          }),
        },
      },
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          invoke: {
            id: 'child',
            src: createMachine({
              schemas: {
                input: z.object({
                  deep: z.object({
                    prop: z.string(),
                  }),
                }),
                context: z.object({
                  value: z.string(),
                }),
              },
              context: ({ input }) => ({
                // this is only meant to showcase why we can't invoke this actor when it's missing in the persisted state
                // because we don't have access to the right input as it depends on the event that was used to enter state `b`
                value: input.deep.prop,
              }),
            }),
            input: ({ event }) => event.data,
          },
        },
      },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'NEXT',
      data: {
        deep: {
          prop: 'value',
        },
      },
    })
    const childBeforeDelete = actor.getSnapshot().children['child']
    if (childBeforeDelete === undefined) {
      throw new Error('expected child actor')
    }
    const childContext = childBeforeDelete.getSnapshot().context
    const persisted: any = actor.getPersistedSnapshot()
    delete persisted.children['child']
    const rehydratedActor = createActor(machine, {
      snapshot: persisted,
    }).start()
    yield* expect({
      childPresent: childBeforeDelete !== undefined,
      childContext,
      rehydratedChild: rehydratedActor.getSnapshot().children['child'],
    }).toEqual({
      childPresent: true,
      childContext: { value: 'value' },
      rehydratedChild: undefined,
    })
  })
  it.skip('should persist a spawned actor with referenced src', function*({ expect }) {
    const reducer = createLogic({
      context: { count: 42 },
      run: () => undefined,
    })
    const machine = createMachine({
      schemas: {
        context: z.object({
          ref: z.custom<AnyActorRef>(),
        }),
      },
      actors: {
        reducer,
      },
      context: ({ spawn, actors }) => ({
        ref: spawn(actors.reducer, { id: 'child' }),
      }),
    }).provide({
      actors: {
        reducer,
      },
    })
    const actor = createActor(machine).start()
    const persistedSnapshot = actor.getPersistedSnapshot()!
    const newActor = createActor(machine, {
      snapshot: persistedSnapshot,
    }).start()
    const snapshot = newActor.getSnapshot()
    yield* expect({
      persistedChildContext: (persistedSnapshot as any).children.child.snapshot
        .context,
      refIsChild: snapshot.context.ref === snapshot.children['child'],
      childCount: snapshot.context.ref.getSnapshot().context.count,
    }).toEqual({
      persistedChildContext: { count: 42 },
      refIsChild: true,
      childCount: 42,
    })
  })
  it('should not persist a spawned actor with inline src', function*({ expect }) {
    const childMachine = createMachine({})
    const machine = createMachine({
      schemas: {
        context: z.object({
          childRef: z.custom<ActorRefFrom<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => {
        return {
          childRef: spawn(childMachine),
        }
      },
    })
    const actorRef = createActor(machine).start()
    yield* expect(() => actorRef.getPersistedSnapshot()).toThrow(
      new Error('An inline child actor cannot be persisted.'),
    )
  })
  it('should have access to the system', function*({ expect }) {
    let receivedSystem: AnyActorSystem | undefined
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      entry: ({ system }) => {
        receivedSystem = system
        resolve()
      },
    })
    const actor = createActor(machine).start()
    yield* Effect.promise(() => promise)
    yield* expect(receivedSystem).toBe(actor.system)
  })
})
describe('composable actor logic', () => {
  it('should work with machines', function*({ expect }) {
    const logs: string[] = []
    function withLogs<T extends AnyActorLogic>(actorLogic: T): T {
      return {
        ...actorLogic,
        transition: (state, event, actorScope) => {
          logs.push(event.type)
          return actorLogic.transition(state, event, actorScope)
        },
      }
    }
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { to_b: { target: 'b' } },
        },
        b: {
          on: { to_c: { target: 'c' } },
        },
        c: {
          on: { to_a: { target: 'a' } },
        },
      },
    })
    const actor = createActor(withLogs(machine)).start()
    actor.send({ type: 'to_b' })
    actor.send({ type: 'to_c' })
    actor.send({ type: 'to_a' })
    yield* expect(logs).toEqual(['to_b', 'to_c', 'to_a'])
  })
  it('should work with promises', function*({ expect }) {
    const logs: any[] = []
    function withLogs<T extends AnyActorLogic>(actorLogic: T): T {
      return {
        ...actorLogic,
        transition: (state: Snapshot<unknown>, event, actorScope) => {
          const result = actorLogic.transition(state, event, actorScope)
          const s = Array.isArray(result) ? result[0] : result
          logs.push(s.output)
          return result
        },
      }
    }
    const promiseLogic = createAsyncLogic({ run: () => Promise.resolve(42) })
    const actor = createActor(withLogs(promiseLogic)).start()
    yield* Effect.promise(() => waitFor(actor, (s) => s.status === 'done'))
    yield* expect(logs).toEqual([42])
  })
  it('should work with functions', function*({ expect }) {
    const logs: any[] = []
    function withLogs<T extends AnyActorLogic>(actorLogic: T): T {
      return {
        ...actorLogic,
        transition: (state: Snapshot<unknown>, event, actorScope) => {
          const result = actorLogic.transition(state, event, actorScope)
          const s = Array.isArray(result) ? result[0] : result
          logs.push(s.context)
          return result
        },
      }
    }
    const transitionLogic = createLogic({
      context: 0,
      run: ({ event }: { event: { type: string; value: number } }) => ({
        context: event.value,
      }),
    })
    const actor = createActor(withLogs(transitionLogic)).start()
    actor.send({ type: 'a', value: 42 })
    yield* expect(logs).toEqual([42])
  })
  it('should work with observables', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const logs: any[] = []
    function withLogs<T extends AnyActorLogic>(actorLogic: T): T {
      return {
        ...actorLogic,
        transition: (state: Snapshot<unknown>, event, actorScope) => {
          const result = actorLogic.transition(state, event, actorScope)
          const s = Array.isArray(result) ? result[0] : result
          if (s.status === 'active') {
            logs.push(s.context)
          }
          return result
        },
      }
    }
    const observableLogic = createObservableLogic<number, undefined>(() => toSubscribable(interval(10).pipe(take(4))))
    const actor = createActor(withLogs(observableLogic)).start()
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    yield* Effect.promise(() => promise)
    yield* expect(logs).toEqual([0, 1, 2, 3])
  })
  it('higher-level logic wrapping a machine should be able to persist a snapshot', function*({ expect }) {
    const logged: any[] = []
    function withLogging<T extends ActorLogic<any, any>>(actorLogic: T) {
      const enhancedLogic: T = {
        ...actorLogic,
        transition: (state, event, actorCtx) => {
          logged.push(event.type)
          return actorLogic.transition(state, event, actorCtx)
        },
      }
      return enhancedLogic
    }
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: { next: { target: 'working' } },
        },
        working: {
          on: { more: { target: 'done' } },
        },
        done: {},
      },
    })
    const actor = createActor(withLogging(machine)).start()
    actor.send({ type: 'next' })
    actor.send({ type: 'more' })
    const persistedSnapshot = actor.getPersistedSnapshot()
    yield* expect({
      logged,
      value: actor.getSnapshot().value,
      persistedSnapshot,
    }).toEqual({
      logged: ['next', 'more'],
      value: 'done',
      persistedSnapshot: expect.objectContaining({
        status: 'active',
        value: 'done',
      }),
    })
  })
})
