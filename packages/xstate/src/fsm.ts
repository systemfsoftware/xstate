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

type AnyFSMConfig = FSMConfig<MachineContext, EventObject, string>
type AnyFSMSnapshot = FSMSnapshot<MachineContext, string>
type AnyFSMTransition = FSMTransition<MachineContext, EventObject, string>
type AnyFSM = FSM<MachineContext, EventObject, string, AnyFSMSnapshot, AnyFSMConfig>

type FSMResolution = {
  readonly target: string | undefined
  readonly patch: FSMContextPatch<MachineContext> | undefined
}

const resolutionOfConfig = (
  config: FSMTransitionConfig<MachineContext, string> | undefined,
): FSMResolution =>
  config === undefined
    ? { target: undefined, patch: undefined }
    : { target: config.target, patch: config.context }

const configTransitionOf = (
  transition: AnyFSMTransition | undefined,
):
  | FSMTransitionConfig<MachineContext, string>
  | FSMTransitionFunction<MachineContext, EventObject, string>
  | undefined => typeof transition === 'string' ? { target: transition } : transition

const resolvedTransitionOf = (
  transition: AnyFSMTransition | undefined,
  context: MachineContext,
  event: EventObject,
): FSMResolution => {
  const config = configTransitionOf(transition)
  return resolutionOfConfig(
    typeof config === 'function' ? config({ context, event }) : config,
  )
}

const ownTransitionOf = (
  on: FSMOn<MachineContext, EventObject, string>,
  type: string,
): AnyFSMTransition | undefined => Object.hasOwn(on, type) ? on[type] : undefined

const onTableFor = (
  config: AnyFSMConfig,
  value: string,
): FSMOn<MachineContext, EventObject, string> | undefined => config.states[value]?.on

const patchChangesContext = (
  patch: FSMContextPatch<MachineContext> | undefined,
  context: MachineContext,
): boolean => Object.entries(patch ?? {}).some(([key, value]) => value !== context[key])

const contextWithPatch = (
  patch: FSMContextPatch<MachineContext> | undefined,
  context: MachineContext,
): MachineContext => patchChangesContext(patch, context) ? { ...context, ...patch } : context

const snapshotOf = (value: string, context: MachineContext): AnyFSMSnapshot => ({
  status: 'active',
  value,
  context,
  output: undefined,
  error: undefined,
})

const unchangedSnapshot = (
  snapshot: AnyFSMSnapshot,
  value: string,
  context: MachineContext,
): boolean => value === snapshot.value && context === snapshot.context

const targetedValue = (target: string | undefined, value: string): string => target ?? value

const nextSnapshot = (
  snapshot: AnyFSMSnapshot,
  value: string,
  context: MachineContext,
): AnyFSMSnapshot => unchangedSnapshot(snapshot, value, context) ? snapshot : snapshotOf(value, context)

const fsmOf = (config: AnyFSMConfig): AnyFSM => {
  const initialState = snapshotOf(config.initial, config.context ?? {})

  return {
    id: config.id,
    config,
    initialState,
    initialTransition: () => [initialState, []],
    getInitialSnapshot: () => initialState,
    getPersistedSnapshot: (snapshot) => snapshot,
    transition(snapshot, event) {
      const on = onTableFor(config, snapshot.value)
      if (on === undefined) {
        return [snapshot, []]
      }
      const resolution = resolvedTransitionOf(
        ownTransitionOf(on, event.type),
        snapshot.context,
        event,
      )
      const context = contextWithPatch(resolution.patch, snapshot.context)
      return [nextSnapshot(snapshot, targetedValue(resolution.target, snapshot.value), context), []]
    },
  }
}

/** @public */
export function setup<
  const TSchemas extends FSMSetupSchemas = {},
  const TStates extends FSMSetupStates = {},
>(
  _config?: FSMSetupConfig<TSchemas, TStates>,
): FSMSetupReturn<TSchemas, TStates>
export function setup(): object {
  return { createFSM: fsmOf }
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
>
export function createFSM(config: AnyFSMConfig): AnyFSM {
  return fsmOf(config)
}
