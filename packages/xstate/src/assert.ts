import type { EventDescriptor, EventObject, ExtractEvent } from './types.js'
import { matchesEventDescriptor, toArray } from './utils.js'

const describeTypes = (types: readonly string[]): string =>
  types.length === 1
    ? `type matching "${types[0]}"`
    : `one of types matching "${types.join('", "')}"`

type AssertedTypes = string | readonly string[]

const assertEventOf = (event: EventObject, type: AssertedTypes): void => {
  const types = toArray(type)
  if (!types.some((descriptor) => matchesEventDescriptor(event.type, descriptor))) {
    throw new Error(
      `Expected event ${JSON.stringify(event)} to have ${describeTypes(types)}`,
    )
  }
}

/**
 * Asserts that an event is of the given type or types, narrowing it, and
 * throws when it is not. Given only the types, returns the assertion as a
 * function.
 * @public
 */
export function assertEvent<
  TEvent extends EventObject,
  TAssertedDescriptor extends EventDescriptor<TEvent>,
>(
  event: TEvent,
  type: TAssertedDescriptor | readonly TAssertedDescriptor[],
): asserts event is ExtractEvent<TEvent, TAssertedDescriptor>
export function assertEvent<
  TEvent extends EventObject,
  TAssertedDescriptor extends EventDescriptor<TEvent>,
>(
  type: TAssertedDescriptor | readonly TAssertedDescriptor[],
): (event: TEvent) => asserts event is ExtractEvent<TEvent, TAssertedDescriptor>
export function assertEvent(
  ...args: readonly [event: EventObject, type: AssertedTypes] | readonly [type: AssertedTypes]
): ((event: EventObject) => void) | void {
  if (args.length === 1) {
    const [type] = args
    return (event: EventObject) => assertEventOf(event, type)
  }
  assertEventOf(args[0], args[1])
}
