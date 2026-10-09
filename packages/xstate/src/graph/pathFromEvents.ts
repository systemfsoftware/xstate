import type {
  ActorLogic,
  ActorScope,
  AnyActorScope,
  AnyActorSystem,
  EventObject,
  NonReducibleUnknown,
} from '../index.js'
import { createMockActorScope } from './actorScope.js'
import { alterPath } from './alterPath.js'
import { resolveTraversalOptions, toSerializedEvent, toSerializedSnapshot } from './graph.js'
import type {
  AnySnapshot,
  SerializedEvent,
  SerializedSnapshot,
  StatePath,
  Steps,
  TraversalConfig,
  TraversalOptions,
} from './types.js'

interface ReplayState<TSnapshot> {
  state: TSnapshot
  stateSerial: SerializedSnapshot
}

interface ReplayContext<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
> {
  config: TraversalConfig<TSnapshot, TEvent>
  options: TraversalOptions<TSnapshot, TEvent, TInput> | undefined
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>
  actorScope: AnyActorScope
  steps: Steps<TSnapshot, TEvent>
}

const inputOf = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
>(
  options: TraversalOptions<TSnapshot, TEvent, TInput> | undefined,
): TInput | undefined => (options === undefined ? undefined : options.input)

const initialSnapshotOf = <TSnapshot>(
  logic: { getInitialSnapshot(actorScope: AnyActorScope, input: NonReducibleUnknown): TSnapshot },
  input: NonReducibleUnknown,
  actorScope: AnyActorScope,
): TSnapshot => logic.getInitialSnapshot(actorScope, input)

function actorScopeOf<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TSystem extends AnyActorSystem,
>(scope: AnyActorScope): ActorScope<TSnapshot, TEvent, TSystem>
function actorScopeOf(scope: AnyActorScope): AnyActorScope {
  return scope
}

const passesFilterEvents = <TSnapshot, TEvent>(
  filterEvents: ((snapshot: TSnapshot, event: TEvent) => boolean) | undefined,
  state: TSnapshot,
  event: TEvent,
): boolean => (filterEvents === undefined ? true : filterEvents(state, event))

const matchesCandidate = <TSnapshot, TEvent>(
  filterEvents: ((snapshot: TSnapshot, event: TEvent) => boolean) | undefined,
  serializeEvent: (event: TEvent) => string,
  state: TSnapshot,
  candidate: TEvent,
  eventSerial: SerializedEvent,
): boolean => passesFilterEvents(filterEvents, state, candidate) && serializeEvent(candidate) === eventSerial

const lastMatchingCandidate = <TSnapshot, TEvent>(
  candidates: readonly TEvent[],
  filterEvents: ((snapshot: TSnapshot, event: TEvent) => boolean) | undefined,
  serializeEvent: (event: TEvent) => string,
  state: TSnapshot,
  eventSerial: SerializedEvent,
): TEvent | undefined =>
  [...candidates].reverse().find((candidate) =>
    matchesCandidate(filterEvents, serializeEvent, state, candidate, eventSerial)
  )

const eventsFrom = <TSnapshot, TEvent>(
  events: readonly TEvent[] | ((state: TSnapshot) => readonly TEvent[]) | undefined,
  state: TSnapshot,
): readonly TEvent[] | undefined => (typeof events === 'function' ? events(state) : events)

const overrideEvents = <TSnapshot, TEvent>(
  options: { events?: readonly TEvent[] | ((state: TSnapshot) => readonly TEvent[]) } | undefined,
  state: TSnapshot,
): readonly TEvent[] | undefined => (options === undefined ? undefined : eventsFrom(options.events, state))

const replayEvent = <TSnapshot, TEvent>(
  filterEvents: ((snapshot: TSnapshot, event: TEvent) => boolean) | undefined,
  state: TSnapshot,
  event: TEvent,
): TEvent | undefined => (passesFilterEvents(filterEvents, state, event) ? event : undefined)

const nextEventFor = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  context: ReplayContext<TSnapshot, TEvent, TInput, TSystem>,
  state: TSnapshot,
  event: TEvent,
  eventSerial: SerializedEvent,
): TEvent | undefined => {
  const override = overrideEvents(context.options, state)
  if (override !== undefined) {
    return lastMatchingCandidate(
      override,
      context.config.filterEvents,
      context.config.serializeEvent,
      state,
      eventSerial,
    )
  }
  return replayEvent(context.config.filterEvents, state, event)
}

const assertWithinLimit = (stepCount: number, limit: number): void => {
  if (stepCount >= limit) {
    throw new Error('Traversal limit exceeded')
  }
}

const stopsBefore = <TSnapshot>(stopWhen: ((state: TSnapshot) => boolean) | undefined, state: TSnapshot): boolean =>
  stopWhen === undefined ? false : stopWhen(state)

const isReplayable = <TSnapshot, TEvent>(
  nextEvent: TEvent | undefined,
  stopWhen: ((state: TSnapshot) => boolean) | undefined,
  state: TSnapshot,
): nextEvent is TEvent => nextEvent !== undefined && !stopsBefore(stopWhen, state)

const invalidTransition = (stateSerial: SerializedSnapshot, eventSerial: SerializedEvent): Error =>
  new Error(`Invalid transition from ${stateSerial} with ${eventSerial}`)

const assertReplayable = <TSnapshot, TEvent>(
  nextEvent: TEvent | undefined,
  stopWhen: ((state: TSnapshot) => boolean) | undefined,
  state: TSnapshot,
  stateSerial: SerializedSnapshot,
  eventSerial: SerializedEvent,
): TEvent => {
  if (isReplayable(nextEvent, stopWhen, state)) {
    return nextEvent
  }
  throw invalidTransition(stateSerial, eventSerial)
}

const advanceState = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  context: ReplayContext<TSnapshot, TEvent, TInput, TSystem>,
  replay: ReplayState<TSnapshot>,
  nextEvent: TEvent,
  event: TEvent,
): ReplayState<TSnapshot> => {
  const result = context.logic.transition(
    replay.state,
    nextEvent,
    actorScopeOf<TSnapshot, TEvent, TSystem>(context.actorScope),
  )
  const nextState = Array.isArray(result) ? result[0] : result
  return {
    state: nextState,
    stateSerial: toSerializedSnapshot(context.config.serializeState(nextState, event, replay.state)),
  }
}

const replayOne = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  context: ReplayContext<TSnapshot, TEvent, TInput, TSystem>,
  replay: ReplayState<TSnapshot>,
  event: TEvent,
): ReplayState<TSnapshot> => {
  assertWithinLimit(context.steps.length, context.config.limit)
  const eventSerial = toSerializedEvent(context.config.serializeEvent(event))
  const nextEvent = assertReplayable(
    nextEventFor(context, replay.state, event, eventSerial),
    context.config.stopWhen,
    replay.state,
    replay.stateSerial,
    eventSerial,
  )
  context.steps.push({ state: replay.state, event })
  return advanceState(context, replay, nextEvent, event)
}

const initialReplay = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  config: TraversalConfig<TSnapshot, TEvent>,
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
  options: TraversalOptions<TSnapshot, TEvent, TInput> | undefined,
  actorScope: AnyActorScope,
): ReplayState<TSnapshot> => {
  const state = config.fromState ?? initialSnapshotOf(logic, inputOf(options), actorScope)
  return {
    state,
    stateSerial: toSerializedSnapshot(config.serializeState(state, undefined, undefined)),
  }
}

const reachesTarget = <TSnapshot>(toState: ((state: TSnapshot) => boolean) | undefined, state: TSnapshot): boolean =>
  toState === undefined ? true : toState(state)

const buildPaths = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  context: ReplayContext<TSnapshot, TEvent, TInput, TSystem>,
  replay: ReplayState<TSnapshot>,
): Array<StatePath<TSnapshot, TEvent>> => {
  if (!reachesTarget(context.config.toState, replay.state)) {
    return []
  }
  return [
    alterPath({
      state: replay.state,
      steps: context.steps,
      weight: context.steps.length,
    }),
  ]
}

function computePathsFromEvents<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
  events: TEvent[],
  options?: TraversalOptions<TSnapshot, TEvent, TInput>,
): Array<StatePath<TSnapshot, TEvent>> {
  const config = resolveTraversalOptions({
    logic,
    options: {
      events,
      ...options,
    },
  })
  const actorScope = createMockActorScope()
  const context: ReplayContext<TSnapshot, TEvent, TInput, TSystem> = {
    config,
    options,
    logic,
    actorScope,
    steps: [],
  }
  let replay = initialReplay(config, logic, options, actorScope)
  for (const event of events) {
    replay = replayOne(context, replay, event)
  }
  return buildPaths(context, replay)
}

type ReplayArgs<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
> =
  | readonly [
    logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
    events: TEvent[],
    options?: TraversalOptions<TSnapshot, TEvent, TInput> | undefined,
  ]
  | readonly [events: TEvent[], options?: TraversalOptions<TSnapshot, TEvent, TInput> | undefined]

const isDataLastReplay = <
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem,
>(
  args: ReplayArgs<TSnapshot, TEvent, TInput, TSystem>,
): args is readonly [events: TEvent[], options?: TraversalOptions<TSnapshot, TEvent, TInput> | undefined] =>
  Array.isArray(args[0])

export function getPathsFromEvents<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>,
  events: TEvent[],
  options?: TraversalOptions<TSnapshot, TEvent, TInput>,
): Array<StatePath<TSnapshot, TEvent>>
export function getPathsFromEvents<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  events: TEvent[],
  options?: TraversalOptions<TSnapshot, TEvent, TInput>,
): (logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>) => Array<StatePath<TSnapshot, TEvent>>
export function getPathsFromEvents<
  TSnapshot extends AnySnapshot,
  TEvent extends EventObject,
  TInput,
  TSystem extends AnyActorSystem = AnyActorSystem,
>(
  ...args: ReplayArgs<TSnapshot, TEvent, TInput, TSystem>
):
  | Array<StatePath<TSnapshot, TEvent>>
  | ((logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>) => Array<StatePath<TSnapshot, TEvent>>)
{
  return isDataLastReplay(args)
    ? (logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>) => computePathsFromEvents(logic, args[0], args[1])
    : computePathsFromEvents(args[0], args[1], args[2])
}
