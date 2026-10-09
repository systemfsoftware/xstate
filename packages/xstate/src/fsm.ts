import type { EventObject, InferEvents, MachineContext, SetupSchemas, SetupStateSchema } from './base.types.js'
import type { StandardSchemaV1 } from './schema.types.js'

/** @public */
export type FSMArgs<
  TContext extends MachineContext,
  TEvent extends EventObject,
> = {
  context: TContext
  event: TEvent
}

/** @public */
export type FSMContextPatch<TContext extends MachineContext> = Partial<TContext>

/** @public */
export type FSMTransitionConfig<
  TContext extends MachineContext,
  TState extends string,
> = {
  target?: TState
  context?: FSMContextPatch<TContext>
}

/** @public */
export type FSMTransitionFunction<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
  TTransitionContext extends MachineContext = TContext,
> = (
  args: FSMArgs<TContext, TEvent>,
) => FSMTransitionConfig<TTransitionContext, TState> | undefined

type EventForType<TEvent extends EventObject, TType extends string> = [
  Extract<TEvent, { type: TType }>,
] extends [never] ? TEvent
  : Extract<TEvent, { type: TType }>

/** @public */
export type FSMTransition<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
  TTransitionContext extends MachineContext = TContext,
> =
  | TState
  | FSMTransitionConfig<TTransitionContext, TState>
  | FSMTransitionFunction<TContext, TEvent, TState, TTransitionContext>

type FSMOn<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
  TTransitionContext extends MachineContext = TContext,
> = {
  [TType in TEvent['type'] & string]?: FSMTransition<
    TContext,
    EventForType<TEvent, TType>,
    TState,
    TTransitionContext
  >
}

/** @public */
export type FSMStateConfig<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
  TTransitionContext extends MachineContext = TContext,
> = {
  on?: FSMOn<TContext, TEvent, TState, TTransitionContext>
}

type FSMContextConfig<TContext extends MachineContext> = string extends keyof TContext ? { context?: TContext }
  : keyof TContext extends never ? { context?: TContext }
  : { context: TContext }

/** @public */
export type FSMConfig<
  TContext extends MachineContext = {},
  TEvent extends EventObject = EventObject,
  TState extends string = string,
> = {
  id?: string
  initial: TState
  states: { [K in TState]: FSMStateConfig<TContext, TEvent, TState> }
} & FSMContextConfig<TContext>

type FSMConfigForStates<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
> =
  & Omit<
    FSMConfig<TContext, TEvent, TState>,
    'initial' | 'states'
  >
  & {
    initial: NoInfer<TState>
    states: {
      [K in TState]: FSMStateConfig<
        TContext,
        TEvent,
        TState
      >
    }
  }

/**
 * A snapshot of a compact FSM. `status`, `output`, and `error` match the
 * snapshot shape shared by all actor logic, so an FSM can run in
 * `createActor`. An FSM snapshot is always `'active'`.
 *
 * @public
 */
export type FSMSnapshot<
  TContext extends MachineContext,
  TState extends string,
> = {
  status: 'active'
  value: TState
  context: TContext
  output: undefined
  error: undefined
}

/**
 * The result of an FSM transition: `[nextSnapshot, effects]`. FSMs have no
 * effects, so `effects` is always empty. The tuple matches the
 * `(snapshot, event) => [snapshot, effects]` protocol shared with full XState
 * actor logic.
 *
 * @public
 */
export type FSMTransitionResult<TSnapshot> = [
  nextSnapshot: TSnapshot,
  effects: never[],
]

/**
 * Pure logic returned by `createFSM`. It structurally satisfies `ActorLogic`,
 * so it works with `createActor`, `transition`, and `initialTransition` from
 * `xstate`.
 *
 * @public
 */
export type FSM<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
  TSnapshot extends FSMSnapshot<MachineContext, TState> = FSMSnapshot<
    TContext,
    TState
  >,
  TConfig = FSMConfig<TContext, TEvent, TState>,
> = {
  readonly id: string | undefined
  readonly config: TConfig
  readonly initialState: TSnapshot
  transition(
    snapshot: TSnapshot,
    event: TEvent,
  ): FSMTransitionResult<TSnapshot>
  initialTransition(): FSMTransitionResult<TSnapshot>
  getInitialSnapshot(): TSnapshot
  getPersistedSnapshot(snapshot: TSnapshot): TSnapshot
}

type FSMSetupSchemas = Pick<SetupSchemas, 'context' | 'events'>
type FSMSetupStates = Record<string, SetupStateSchema>

type FSMSchemaContext<TSchema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<TSchema> extends MachineContext
  ? StandardSchemaV1.InferOutput<TSchema>
  : MachineContext

type FSMSetupContext<TSchemas extends FSMSetupSchemas> = TSchemas extends {
  context: infer TSchema extends StandardSchemaV1
} ? FSMSchemaContext<TSchema>
  : MachineContext

type FSMSetupEvents<TSchemas extends FSMSetupSchemas> = TSchemas extends {
  events: infer TEventSchemas extends Record<string, StandardSchemaV1>
} ? InferEvents<TEventSchemas>
  : EventObject

type FSMStateContext<
  TStateSchema,
  TGlobalContext extends MachineContext,
> = TStateSchema extends { schemas?: infer TSchemas } ? TSchemas extends {
    context?: infer TSchema extends StandardSchemaV1
  } ?
      & FSMSchemaContext<TSchema>
      & ([MachineContext] extends [TGlobalContext] ? {} : TGlobalContext)
  : TGlobalContext
  : TGlobalContext

type FSMContextFromDeclaredStates<
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
> = {
  [K in keyof TStates & string]: FSMStateContext<TStates[K], TGlobalContext>
}[keyof TStates & string]

type FSMContextFromStates<
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
> = [keyof TStates] extends [never] ? TGlobalContext
  : [MachineContext] extends [TGlobalContext] ? FSMContextFromDeclaredStates<TStates, TGlobalContext>
  : TGlobalContext | FSMContextFromDeclaredStates<TStates, TGlobalContext>

type FSMSetupStateContext<
  TState extends string,
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
> = TState extends keyof TStates ? FSMStateContext<TStates[TState], TGlobalContext>
  : TGlobalContext

type FSMSetupSnapshot<
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
  TMachineState extends string,
> = [keyof TStates] extends [never] ? FSMSnapshot<TGlobalContext, TMachineState>
  : {
    [K in TMachineState]: FSMSnapshot<
      FSMSetupStateContext<K, TStates, TGlobalContext>,
      K
    >
  }[TMachineState]

type FSMSetupTargetTransitionConfig<
  TSourceContext extends MachineContext,
  TTarget extends string,
  TTargetContext extends MachineContext,
> = [FSMRequiredTargetContextKeys<TSourceContext, TTargetContext>] extends [
  never,
] ? {
    target: TTarget
    context?: FSMTargetContextPatch<TSourceContext, TTargetContext>
  }
  : {
    target: TTarget
    context: FSMTargetContextPatch<TSourceContext, TTargetContext>
  }

type FSMRequiredTargetContextKeys<TSourceContext, TTargetContext> = {
  [K in keyof TTargetContext]-?: K extends keyof TSourceContext
    ? [TSourceContext[K]] extends [TTargetContext[K]] ? never
    : K
    : K
}[keyof TTargetContext]

type FSMTargetContextPatch<TSourceContext, TTargetContext> =
  & Partial<TTargetContext>
  & Pick<
    TTargetContext,
    Extract<
      FSMRequiredTargetContextKeys<TSourceContext, TTargetContext>,
      string
    >
  >

type FSMSetupTransitionConfig<
  TSourceContext extends MachineContext,
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
> =
  | { target?: undefined; context?: FSMContextPatch<TSourceContext> }
  | {
    [TTarget in keyof TStates & string]: FSMSetupTargetTransitionConfig<
      TSourceContext,
      TTarget,
      FSMSetupStateContext<TTarget, TStates, TGlobalContext>
    >
  }[keyof TStates & string]

type FSMSetupStringTransition<
  TSourceContext extends MachineContext,
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
> = {
  [TTarget in keyof TStates & string]: [TSourceContext] extends [
    FSMSetupStateContext<TTarget, TStates, TGlobalContext>,
  ] ? TTarget
    : never
}[keyof TStates & string]

type FSMSetupTransitionFunction<
  TSourceContext extends MachineContext,
  TEvent extends EventObject,
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
> = (
  args: FSMArgs<TSourceContext, TEvent>,
) =>
  | FSMSetupTransitionConfig<TSourceContext, TStates, TGlobalContext>
  | undefined

type FSMSetupTransition<
  TSourceContext extends MachineContext,
  TEvent extends EventObject,
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
  TMachineState extends string,
> = [keyof TStates] extends [never] ? FSMTransition<TSourceContext, TEvent, TMachineState>
  :
    | FSMSetupStringTransition<TSourceContext, TStates, TGlobalContext>
    | FSMSetupTransitionConfig<TSourceContext, TStates, TGlobalContext>
    | FSMSetupTransitionFunction<
      TSourceContext,
      TEvent,
      TStates,
      TGlobalContext
    >

type FSMSetupStateConfig<
  TSourceContext extends MachineContext,
  TEvent extends EventObject,
  TStates extends FSMSetupStates,
  TGlobalContext extends MachineContext,
  TMachineState extends string,
> = {
  on?: {
    [TType in TEvent['type'] & string]?: FSMSetupTransition<
      TSourceContext,
      EventForType<TEvent, TType>,
      TStates,
      TGlobalContext,
      TMachineState
    >
  }
}

type FSMSetupMachineConfig<
  TSchemas extends FSMSetupSchemas,
  TStates extends FSMSetupStates,
  TMachineState extends string,
> = {
  id?: string
  initial: NoInfer<TMachineState>
  states: {
    [K in TMachineState]: FSMSetupStateConfig<
      FSMStateContext<
        K extends keyof TStates ? TStates[K] : {},
        FSMSetupContext<TSchemas>
      >,
      FSMSetupEvents<TSchemas>,
      TStates,
      FSMSetupContext<TSchemas>,
      TMachineState
    >
  }
} & FSMContextConfig<FSMContextFromStates<TStates, FSMSetupContext<TSchemas>>>

/** @public */
export type FSMSetupConfig<
  TSchemas extends FSMSetupSchemas = {},
  TStates extends FSMSetupStates = {},
> = {
  schemas?: TSchemas
  states?: TStates
}

/** @public */
export type FSMSetupReturn<
  TSchemas extends FSMSetupSchemas,
  TStates extends FSMSetupStates,
> = {
  createFSM<TMachineState extends string>(
    config: FSMSetupMachineConfig<TSchemas, TStates, TMachineState>,
  ): FSM<
    FSMContextFromStates<TStates, FSMSetupContext<TSchemas>>,
    FSMSetupEvents<TSchemas>,
    TMachineState,
    FSMSetupSnapshot<TStates, FSMSetupContext<TSchemas>, TMachineState>,
    FSMSetupMachineConfig<TSchemas, TStates, TMachineState>
  >
}

type FSMResolution<TContext extends MachineContext, TState extends string> = {
  readonly target: TState | undefined
  readonly patch: FSMContextPatch<TContext> | undefined
}

const resolutionOfConfig = <TContext extends MachineContext, TState extends string>(
  config: FSMTransitionConfig<TContext, TState> | undefined,
): FSMResolution<TContext, TState> =>
  config === undefined
    ? { target: undefined, patch: undefined }
    : { target: config.target, patch: config.context }

const configTransitionOf = <
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
>(
  transition: FSMTransition<TContext, TEvent, TState> | undefined,
):
  | FSMTransitionConfig<TContext, TState>
  | FSMTransitionFunction<TContext, TEvent, TState>
  | undefined => typeof transition === 'string' ? { target: transition } : transition

const resolvedTransitionOf = <
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
>(
  transition: FSMTransition<TContext, TEvent, TState> | undefined,
  context: TContext,
  event: TEvent,
): FSMResolution<TContext, TState> => {
  const config = configTransitionOf(transition)
  return resolutionOfConfig(
    typeof config === 'function' ? config({ context, event }) : config,
  )
}

function isTransition<
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
>(
  value: object | string | undefined,
): value is FSMTransition<TContext, TEvent, TState> {
  return value !== undefined
}

const transitionAt = <
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
>(
  on: FSMOn<TContext, TEvent, TState>,
  type: TEvent['type'],
): FSMTransition<TContext, TEvent, TState> | undefined => {
  const value: object | string | undefined = on[type]
  return isTransition<TContext, TEvent, TState>(value) ? value : undefined
}

const ownTransitionOf = <
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
>(
  on: FSMOn<TContext, TEvent, TState>,
  type: TEvent['type'],
): FSMTransition<TContext, TEvent, TState> | undefined => Object.hasOwn(on, type) ? transitionAt(on, type) : undefined

const onTableFor = <
  TContext extends MachineContext,
  TEvent extends EventObject,
  TState extends string,
>(
  states: { readonly [K in TState]: FSMStateConfig<TContext, TEvent, TState> },
  value: TState,
): FSMOn<TContext, TEvent, TState> | undefined => states[value]?.on

const patchChangesContext = <TContext extends MachineContext>(
  patch: FSMContextPatch<TContext> | undefined,
  context: TContext,
): boolean => Object.entries(patch ?? {}).some(([key, value]) => value !== context[key])

const contextWithPatch = <TContext extends MachineContext>(
  patch: FSMContextPatch<TContext> | undefined,
  context: TContext,
): TContext => patchChangesContext(patch, context) ? { ...context, ...patch } : context

const targetedValue = <TState extends string>(
  target: TState | undefined,
  value: TState,
): TState => target ?? value

const unchangedSnapshot = <TContext extends MachineContext, TState extends string>(
  snapshot: FSMSnapshot<TContext, TState>,
  value: TState,
  context: TContext,
): boolean => value === snapshot.value && context === snapshot.context

const nextSnapshot = <TContext extends MachineContext, TState extends string>(
  snapshot: FSMSnapshot<TContext, TState>,
  value: TState,
  context: TContext,
  create: (value: TState, context: TContext) => FSMSnapshot<TContext, TState>,
): FSMSnapshot<TContext, TState> => unchangedSnapshot(snapshot, value, context) ? snapshot : create(value, context)

const assertContext: <TContext extends MachineContext>(
  value: MachineContext,
) => asserts value is TContext = () => undefined

const contextOrEmpty = <TContext extends MachineContext>(
  context: TContext | undefined,
): TContext => {
  const empty: MachineContext = {}
  assertContext<TContext>(empty)
  return context ?? empty
}

const assertSetupReturn: <TSetupReturn extends object>(
  value: object,
) => asserts value is TSetupReturn = () => undefined

/** @public */
export function setup<
  const TSchemas extends FSMSetupSchemas = {},
  const TStates extends FSMSetupStates = {},
>(
  _config: FSMSetupConfig<TSchemas, TStates> = {},
): FSMSetupReturn<TSchemas, TStates> {
  const api = {
    createFSM: (config: FSMConfig) => createFSM(config),
  }
  assertSetupReturn<FSMSetupReturn<TSchemas, TStates>>(api)
  return api
}

/** @public */
export function createFSM<
  TContext extends MachineContext = {},
  TEvent extends EventObject = EventObject,
  TState extends string = string,
>(
  config: FSMConfigForStates<TContext, TEvent, TState>,
): FSM<
  TContext,
  TEvent,
  TState,
  FSMSnapshot<TContext, TState>,
  FSMConfigForStates<TContext, TEvent, TState>
> {
  type TSnapshot = FSMSnapshot<TContext, TState>
  const createSnapshot = (value: TState, context: TContext): TSnapshot => ({
    status: 'active',
    value,
    context,
    output: undefined,
    error: undefined,
  })
  const initialState = createSnapshot(config.initial, contextOrEmpty<TContext>(config.context))

  return {
    id: config.id,
    config,
    initialState,
    initialTransition: () => [initialState, []],
    getInitialSnapshot: () => initialState,
    getPersistedSnapshot: (snapshot) => snapshot,
    transition(snapshot, event) {
      const on = onTableFor(config.states, snapshot.value)
      if (on === undefined) {
        return [snapshot, []]
      }
      const resolution = resolvedTransitionOf(
        ownTransitionOf(on, event.type),
        snapshot.context,
        event,
      )
      const context = contextWithPatch(resolution.patch, snapshot.context)
      const value = targetedValue(resolution.target, snapshot.value)
      return [nextSnapshot(snapshot, value, context, createSnapshot), []]
    },
  }
}
