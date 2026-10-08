import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { interval } from 'rxjs'
import { z } from 'zod'
import {
  type ActorRefFrom,
  type AnyActorRef,
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createMachine,
  createObservableLogic,
} from '../src/index.js'
import { toSubscribable } from './utils.js'

describe('spawnChild action', () => {
  it('can spawn', function*({ expect }) {
    const actor = createActor(
      createMachine({
        entry: (_, enq) => {
          enq.spawn(createAsyncLogic({ run: () => Promise.resolve(42) }), {
            id: 'child',
          })
        },
      }),
    )

    actor.start()

    yield* expect(Object.keys(actor.getSnapshot().children)).toEqual(['child'])
  })

  it('can spawn from named actor', function*({ expect }) {
    const fetchNum = createAsyncLogic({
      run: ({ input }: { input: number }) => Promise.resolve(input * 2),
    })
    const actor = createActor(
      createMachine({
        entry: (_, enq) => {
          enq.spawn(fetchNum, { id: 'child', input: 21 })
        },
      }).provide({
        actors: { fetchNum },
      }),
    )

    actor.start()

    yield* expect(Object.keys(actor.getSnapshot().children)).toEqual(['child'])
  })

  it('should accept `syncSnapshot` option', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    const observableLogic = createObservableLogic<number, undefined>(
      () => toSubscribable(interval(10)),
    )
    const unusedObservableRef = undefined as unknown as ActorRefFrom<typeof observableLogic>
    const observableMachine = createMachine({
      schemas: {
        context: z.object({
          observableRef: z.custom<ActorRefFrom<typeof observableLogic>>(),
        }),
      },
      id: 'observable',
      initial: 'idle',
      context: { observableRef: unusedObservableRef },
      states: {
        idle: {
          entry: (_, enq) => {
            enq.spawn(observableLogic, {
              id: 'int',
              syncSnapshot: true,
            })
          },
          on: {
            'xstate.snapshot.int': ({ event }) => {
              const snapshot = event as { snapshot?: { context?: number } }
              if (snapshot.snapshot?.context === 5) {
                return {
                  target: 'success',
                }
              }
              return undefined
            },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const observableService = createActor(observableMachine)
    observableService.subscribe({
      complete: () => {
        resolve()
      },
    })

    observableService.start()
    yield* Effect.promise(() => promise)
    yield* expect(observableService.getSnapshot().value).toEqual('success')
  })

  it('should handle a dynamic id', function*({ expect }) {
    const calls: Array<Array<unknown>> = []

    const childMachine = createMachine({
      on: {
        FOO: (_, enq) => {
          enq((...args: Array<unknown>) => {
            calls.push(args)
          })
        },
      },
    })

    const machine = createMachine({
      schemas: {
        context: z.object({
          childId: z.string(),
        }),
      },
      context: {
        childId: 'myChild',
      },
      entry: ({ context, self }, enq) => {
        const child = createActor(childMachine, {
          id: context.childId,
          parent: self,
        })
        enq(() => {
          child.start()
        })

        enq.sendTo(child, {
          type: 'FOO',
        })
      },
    })

    createActor(machine).start()

    yield* expect(calls).toEqual([[]])
  })

  it('does not start a child that is spawned and stopped in the same entry', function*({ expect }) {
    const starts: string[] = []
    const started = () => {
      starts.push('started')
    }

    const machine = createMachine({
      entry: (_, enq) => {
        const child = enq.spawn(
          createCallbackLogic(() => {
            started()
          }),
          { id: 'child' },
        )
        enq.stop(child)
      },
    })

    const actor = createActor(machine).start()

    yield* expect({
      starts,
      childKeys: Object.keys(actor.getSnapshot().children),
    }).toEqual({ starts: [], childKeys: [] })
  })

  it(
    'does not start a child that is spawned in one microstep and stopped in a later microstep of the same macrostep',
    function*({ expect }) {
      const starts: string[] = []
      const started = () => {
        starts.push('started')
      }

      const machine = createMachine({
        context: {} as { child: AnyActorRef },
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => {
              const child = enq.spawn(
                createCallbackLogic(() => {
                  started()
                }),
                { id: 'child' },
              )
              return { context: { child } }
            },
            always: { target: 'b' },
          },
          b: {
            entry: ({ context }, enq) => {
              enq.stop(context.child)
            },
          },
        },
      })

      const actor = createActor(machine).start()

      yield* expect({
        starts,
        value: actor.getSnapshot().value,
        childKeys: Object.keys(actor.getSnapshot().children),
      }).toEqual({ starts: [], value: 'b', childKeys: [] })
    },
  )
})
