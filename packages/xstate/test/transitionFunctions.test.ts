import { describe, it } from '@systemfsoftware/vitest'
import {
  type ActorLogic,
  type AnyActor,
  createLogic,
  createMachine,
  initialTransition,
  transition,
} from '../src/index.js'

describe('transition', () => {
  it('should calculate the next snapshot for custom logic', function*({ expect }) {
    const logic = createLogic({
      context: { count: 0 },
      run: ({ context, event }) => {
        if (event.type === 'next') {
          return { context: { count: context.count + 1 } }
        }
        return
      },
    })

    const [init] = initialTransition(logic, undefined)
    const [s1] = transition(logic, init, { type: 'next' })
    const [s2] = transition(logic, s1, { type: 'next' })
    yield* expect({ first: s1.context.count, second: s2.context.count })
      .toEqual({ first: 1, second: 2 })
  })
  it('stops children from custom logic during a pure transition', function*({ expect }) {
    const stopCalls: Array<ReadonlyArray<unknown>> = []
    const stop = (...args: ReadonlyArray<unknown>) => {
      stopCalls.push(args)
    }
    const child = {
      id: 'child',
      _parent: {},
      _stop: stop,
    } as unknown as AnyActor
    const snapshot = {
      status: 'active' as const,
      output: undefined,
      error: undefined,
      child,
    }
    const logic: ActorLogic<typeof snapshot, { type: 'stop' }> = {
      initialTransition: () => [snapshot, []],
      transition: (currentSnapshot, _, actorScope) => {
        actorScope.stopChild(currentSnapshot.child)
        return [currentSnapshot, []]
      },
      getInitialSnapshot: () => snapshot,
      getPersistedSnapshot: (currentSnapshot) => currentSnapshot,
    }

    transition(logic, snapshot, { type: 'stop' })

    yield* expect(stopCalls).toEqual([[]])
  })
  it('should calculate the next snapshot for machine logic', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          on: {
            NEXT: { target: 'c' },
          },
        },
        c: {},
      },
    })

    const [init] = initialTransition(machine, undefined)
    const [s1] = transition(machine, init, { type: 'NEXT' })
    const [s2] = transition(machine, s1, { type: 'NEXT' })

    yield* expect({ first: s1.value, second: s2.value }).toEqual({
      first: 'b',
      second: 'c',
    })
  })
  it('should not execute actions', function*({ expect }) {
    const executed: Array<void> = []
    const fn = () => {
      executed.push()
    }

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            event: (_, enq) => {
              enq(fn)
              return { target: 'b' }
            },
          },
        },
        b: {},
      },
    })

    const [init] = initialTransition(machine, undefined)
    const [nextSnapshot] = transition(machine, init, { type: 'event' })

    yield* expect({ executed, value: nextSnapshot.value }).toEqual({
      executed: [],
      value: 'b',
    })
  })
})
