import { it } from '@systemfsoftware/vitest'
import type { Observable } from 'rxjs'
import {
  type AnyMachineSnapshot,
  type AnyStateMachine,
  pathToStateValue,
  type StateValue,
  transition,
} from '../src/index.js'
import type { Observer, Subscribable, Subscription } from '../src/types.js'

const resolveSerializedStateValue = (
  machine: AnyStateMachine,
  serialized: string,
) =>
  serialized[0] === '{'
    ? machine.resolveState({ value: JSON.parse(serialized), context: {} })
    : machine.resolveState({ value: serialized, context: {} })

export function testMultiTransition(
  machine: AnyStateMachine,
  fromState: string,
  eventTypes: string,
): AnyMachineSnapshot {
  const computeNext = (
    state: AnyMachineSnapshot | string,
    eventType: string,
  ) => {
    if (typeof state === 'string') {
      state = resolveSerializedStateValue(machine, state)
    }
    const [nextState] = transition(machine, state, {
      type: eventType,
    })
    return nextState
  }

  const [firstEventType, ...restEvents] = eventTypes.split(/,\s?/)

  if (firstEventType === undefined) {
    throw new Error('expected a first event type')
  }

  const resultState = restEvents.reduce<AnyMachineSnapshot>(
    computeNext,
    computeNext(fromState, firstEventType),
  )

  return resultState
}

export function testAll(
  machine: AnyStateMachine,
  expected: Record<string, Record<string, StateValue | undefined>>,
): void {
  Object.keys(expected).forEach((fromState) => {
    const fromStateExpected = expected[fromState]
    if (fromStateExpected === undefined) {
      throw new Error(`expected a record for "${fromState}"`)
    }
    Object.keys(fromStateExpected).forEach((eventTypes) => {
      const toState = fromStateExpected[eventTypes]

      it(
        `should go from ${fromState} to ${
          JSON.stringify(
            toState,
          )
        } on ${eventTypes}`,
        function*({ expect }) {
          const resultState = testMultiTransition(machine, fromState, eventTypes)

          if (toState === undefined) {
            yield* expect(resultState.value).toEqual(
              resolveSerializedStateValue(machine, fromState).value,
            )
          } else if (typeof toState === 'string') {
            yield* expect(resultState.value).toEqual(
              pathToStateValue(toState.split('.')),
            )
          } else {
            yield* expect(resultState.value).toEqual(toState)
          }
        },
      )
    })
  })
}

type StateNodeLike = {
  states: Record<string, StateNodeLike>
  path?: string[]
  entry?: any
  exit?: any
}
const seen = new WeakSet<StateNodeLike>()

export function trackEntries(machine: StateNodeLike & { root: StateNodeLike }) {
  if (seen.has(machine)) {
    throw new Error(`This helper can't accept the same machine more than once`)
  }
  seen.add(machine)

  let logs: string[] = []

  function addTrackingActions(state: StateNodeLike, stateDescription: string) {
    const originalEntry2 = state.entry
    const originalExit2 = state.exit
    state.entry = (_: any, enq: any) => {
      enq(() => logs.push(`enter: ${stateDescription}`))
      return originalEntry2?.(_, enq)
    }
    state.exit = (_: any, enq: any) => {
      enq(() => logs.push(`exit: ${stateDescription}`))
      return originalExit2?.(_, enq)
    }
  }

  function addTrackingActionsRecursively(state: StateNodeLike) {
    for (const child of Object.values(state.states)) {
      addTrackingActions(child, child.path!.join('.'))
      addTrackingActionsRecursively(child)
    }
  }

  addTrackingActions(machine.root, `__root__`)
  addTrackingActionsRecursively(machine.root)

  return () => {
    const flushed = logs
    logs = []
    return flushed
  }
}

export function toSubscribable<T>(source: Observable<T>): Subscribable<T> {
  return {
    subscribe(
      observerOrNext: Observer<T> | ((value: T) => void),
      error?: (error: unknown) => void,
      complete?: () => void,
    ): Subscription {
      if (typeof observerOrNext === 'function') {
        return source.subscribe(observerOrNext, error, complete)
      }
      return source.subscribe(
        (value) => observerOrNext.next?.(value),
        (err) => observerOrNext.error?.(err),
        () => observerOrNext.complete?.(),
      )
    },
  }
}
