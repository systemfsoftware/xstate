import isDevelopment from '#is-development'
import { TARGETLESS_KEY, WILDCARD } from './constants.js'
import type { StateNode } from './StateNode.js'
import { isStateId } from './stateUtils.js'
import type {
  AnyActor,
  AnyEventObject,
  AnyMachineSnapshot,
  AnyStateMachine,
  AnyTransitionConfig,
  AnyTransitionConfigFunction,
  ErrorEvent,
  EventObject,
  MachineContext,
  Mapper,
  NonReducibleUnknown,
  Observer,
  OutputArg,
  SingleOrArray,
  StateValue,
  TransitionConfigTarget,
} from './types.js'
import { defaultWarn } from './warnSink.js'

/** @public */
export function checkStateIn(
  snapshot: AnyMachineSnapshot,
  stateValue: StateValue,
) {
  if (typeof stateValue === 'string' && isStateId(stateValue)) {
    const target = snapshot.machine.getStateNodeById(stateValue)
    return snapshot.nodes.some((sn) => sn === target)
  }

  return snapshot.matches(stateValue)
}

export function mapValues<P, O extends Record<string, unknown>>(
  collection: O,
  iteratee: (item: O[keyof O], key: keyof O, collection: O, i: number) => P,
): { [key in keyof O]: P }
export function mapValues(
  collection: Record<string, unknown>,
  iteratee: (
    item: unknown,
    key: string,
    collection: Record<string, unknown>,
    i: number,
  ) => unknown,
) {
  const result: Record<string, unknown> = {}

  const collectionKeys = Object.keys(collection)
  for (let i = 0; i < collectionKeys.length; i++) {
    const key = collectionKeys[i]
    if (key === undefined) {
      continue
    }
    const value = iteratee(collection[key], key, collection, i)
    if (key === '__proto__') {
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    } else {
      result[key] = value
    }
  }

  return result
}

function toArrayStrict<T>(value: readonly T[] | T): readonly T[] {
  if (isArray(value)) {
    return value
  }
  return [value]
}

export function toArray<T>(value: readonly T[] | T | undefined): readonly T[] {
  if (value === undefined) {
    return []
  }
  return toArrayStrict(value)
}

export function resolveOutput<
  TContext extends MachineContext,
  TExpressionEvent extends EventObject,
>(
  mapper:
    | Mapper<TContext, TExpressionEvent, unknown, EventObject>
    | NonReducibleUnknown,
  context: TContext,
  event: TExpressionEvent,
  self: AnyActor,
  warn: (message: string) => void,
  input?: Record<string, unknown>,
): unknown {
  if (typeof mapper === 'function') {
    const outputMapper = mapper as Mapper<
      TContext,
      TExpressionEvent,
      unknown,
      EventObject
    >
    const args = {
      context,
      event,
      output: getEventOutput(event),
      self,
      input,
    } as unknown as Parameters<typeof outputMapper>[0]

    return outputMapper(args)
  }

  if (
    isDevelopment &&
    !!mapper &&
    typeof mapper === 'object' &&
    Object.values(mapper).some((val) => typeof val === 'function')
  ) {
    warn(
      `Dynamically mapping values to individual properties is deprecated. Use a single function that returns the mapped object instead.\nFound object containing properties whose values are possibly mapping functions: ${
        Object.entries(
          mapper,
        )
          .filter(([, value]) => typeof value === 'function')
          .map(
            ([key, value]) =>
              `\n - ${key}: ${
                (value as () => any)
                  .toString()
                  .replace(/\n\s*/g, '')
              }`,
          )
          .join('')
      }`,
    )
  }

  return mapper
}

export function getEventOutput<TEvent extends EventObject>(
  event: TEvent,
): OutputArg<TEvent>['output'] {
  if (isDoneEvent(event)) {
    const doneEvent = event as unknown as EventObject & { output: unknown }
    return doneEvent.output as OutputArg<TEvent>['output']
  }

  return undefined as OutputArg<TEvent>['output']
}

function isDoneEvent(event: EventObject): boolean {
  return (
    event.type === 'xstate.done.actor' || event.type === 'xstate.done.state'
  )
}

function isArray(value: any): value is readonly any[] {
  return Array.isArray(value)
}

export function isErrorEvent(event: AnyEventObject): event is ErrorEvent {
  return event.type.startsWith('xstate.error.')
}

export function toTransitionConfigArray(
  configLike: SingleOrArray<
    AnyTransitionConfig | TransitionConfigTarget | AnyTransitionConfigFunction
  >,
): Array<AnyTransitionConfig> {
  return toArrayStrict(configLike).map((transitionLike) => {
    if (
      typeof transitionLike === 'undefined' ||
      typeof transitionLike === 'string'
    ) {
      return { target: transitionLike }
    }

    if (typeof transitionLike === 'function') {
      return { to: transitionLike }
    }

    return transitionLike
  })
}

export function normalizeTarget<
  TContext extends MachineContext,
  TEvent extends EventObject,
>(
  target: SingleOrArray<string | StateNode<TContext, TEvent>> | undefined,
): ReadonlyArray<string | StateNode<TContext, TEvent>> | undefined {
  if (target === undefined || target === TARGETLESS_KEY) {
    return undefined
  }
  return toArray(target)
}

/** @public */
export function toObserver<T>(
  nextHandler?: Observer<T> | ((value: T) => void),
  errorHandler?: (error: any) => void,
  completionHandler?: () => void,
): Observer<T> {
  const isObserver = typeof nextHandler === 'object'
  const self = isObserver ? nextHandler : undefined

  return {
    next: (isObserver ? nextHandler.next : nextHandler)?.bind(self),
    error: (isObserver ? nextHandler.error : errorHandler)?.bind(self),
    complete: (isObserver ? nextHandler.complete : completionHandler)?.bind(
      self,
    ),
    ...(isObserver && nextHandler.passive ? { passive: true } : {}),
  }
}

export function createInvokeId(stateNodeId: string, index: number): string {
  return `${index}.${stateNodeId}`
}

/** Whether `value` looks like an actor ref (as persisted context detects them). */
export function isActorRefLike(value: object): boolean {
  return 'sessionId' in value && 'send' in value && 'ref' in value
}

export function resolveReferencedActor(machine: AnyStateMachine, src: string) {
  const match = src.match(/^xstate\.invoke\.(\d+)\.(.*)/)!
  if (!match) {
    return machine.sources.actors[src]
  }
  const [, indexStr, nodeId] = match
  if (nodeId === undefined) {
    throw new Error(`Invalid invoke source '${src}'.`)
  }
  const node = machine.getStateNodeById(nodeId)
  const invokeConfig = node.config.invoke!
  const configSrc = (
    Array.isArray(invokeConfig)
      ? invokeConfig[indexStr as any]
      : invokeConfig
  ).src
  // A referenced actor may itself be registered by name.
  return typeof configSrc === 'string'
    ? machine.sources.actors[configSrc]
    : configSrc
}

/** @experimental */
export function getAllOwnEventDescriptors(snapshot: AnyMachineSnapshot) {
  return [...new Set([...snapshot.nodes.flatMap((sn) => sn.ownEvents)])]
}

/** @internal Events synthesized from active transition descriptors. */
export function getAllOwnEvents(snapshot: AnyMachineSnapshot) {
  const events = snapshot.nodes.flatMap((stateNode) =>
    [...stateNode.transitions.values()].flatMap((transitions) =>
      transitions.map((transition) => {
        const event: AnyEventObject = {
          type: transition.eventType,
          ...transition.matches,
        }
        if (
          'actorId' in event &&
          (event.type === 'xstate.done.actor' ||
            event.type === 'xstate.error.actor' ||
            event.type === 'xstate.snapshot.actor' ||
            event.type === 'xstate.timeout.actor')
        ) {
          event['sessionId'] = snapshot.children[event['actorId']]?.sessionId
        }
        return event
      })
    )
  )
  return events.filter(
    (event, index) =>
      events.findIndex((candidate) => {
        const keys = Object.keys(event)
        return (
          keys.length === Object.keys(candidate).length &&
          keys.every((key) => Object.is(event[key], candidate[key]))
        )
      }) === index,
  )
}

export function matchesEvent(
  event: EventObject,
  pattern: Record<string, unknown>,
): boolean {
  return Object.entries(pattern).every(([key, value]) => Object.is((event as AnyEventObject)[key], value))
}

/**
 * Checks if an event type matches an event descriptor, supporting wildcards.
 * Event descriptors can be:
 *
 * - Exact matches: "event.type"
 * - Wildcard: "*"
 * - Partial matches: "event.*"
 *
 * @param eventType - The actual event type string
 * @param descriptor - The event descriptor to match against
 * @returns True if the event type matches the descriptor
 */
export function matchesEventDescriptor(
  eventType: string,
  descriptor: string,
  warn: (message: string) => void = defaultWarn,
): boolean {
  if (descriptor === eventType) {
    return true
  }

  if (descriptor === WILDCARD) {
    return true
  }

  if (!descriptor.endsWith('.*')) {
    return false
  }

  if (isDevelopment && /.*\*.+/.test(descriptor)) {
    warn(
      `Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "${descriptor}" event.`,
    )
  }

  const partialEventTokens = descriptor.split('.')
  const eventTokens = eventType.split('.')

  for (
    let tokenIndex = 0;
    tokenIndex < partialEventTokens.length;
    tokenIndex++
  ) {
    const partialEventToken = partialEventTokens[tokenIndex]
    const eventToken = eventTokens[tokenIndex]

    if (partialEventToken === '*') {
      const isLastToken = tokenIndex === partialEventTokens.length - 1

      if (isDevelopment && !isLastToken) {
        warn(
          `Infix wildcards in transition events are not allowed. Check the "${descriptor}" transition.`,
        )
      }

      return isLastToken
    }

    if (partialEventToken !== eventToken) {
      return false
    }
  }

  return true
}
