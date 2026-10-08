import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import {
  type ActorLogicValidator,
  type AnyActorRef,
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  createEventObservableLogic,
  createLogic,
  createMachine,
  createObservableLogic,
  createSystem,
  type DeadLetterExecutableActionObject,
  type EventRejection,
  initialTransition,
  setup,
  transition,
  types,
} from '../src/index.js'
import { ActorValidationError, isActorValidationError, standardSchemaValidator } from '../src/validation/index.js'

function getThrown(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function getRejection(
  result: [unknown, ReadonlyArray<{ kind?: string; type?: string }>],
): DeadLetterExecutableActionObject | undefined {
  return result[1].find(
    (effect) => effect.kind === 'builtin' && effect.type === '@xstate.deadLetter',
  ) as DeadLetterExecutableActionObject | undefined
}

interface ValidationSummary {
  name: string | undefined
  isValidationError: boolean
  boundary: ActorValidationError['boundary'] | undefined
  reason: ActorValidationError['reason'] | undefined
}

function validationOf(error: unknown): ValidationSummary {
  const validation = isActorValidationError(error) ? error : undefined
  return {
    name: error instanceof Error ? error.name : undefined,
    isValidationError: validation !== undefined,
    boundary: validation?.boundary,
    reason: validation?.reason,
  }
}

function expectedValidation(
  boundary: ActorValidationError['boundary'],
  reason: ActorValidationError['reason'] = 'invalid',
): ValidationSummary {
  return {
    name: 'ActorValidationError',
    isValidationError: true,
    boundary,
    reason,
  }
}

function eventOriginOf(error: unknown): ActorValidationError['eventOrigin'] | undefined {
  return isActorValidationError(error) ? error.eventOrigin : undefined
}

describe('runtime schema validation', () => {
  it('validates setup schemas created through a system builder', function*({ expect }) {
    const machine = createSystem()
      .setup({
        validator: standardSchemaValidator(),
        schemas: { input: z.object({ count: z.number() }) },
      })
      .createMachine({})

    const error = getThrown(() => initialTransition(machine, { count: 'invalid' } as any))

    yield* expect(validationOf(error)).toEqual(expectedValidation('input'))
  })

  it('validates input across actor logic creators', function*({ expect }) {
    const input = z.object({ count: z.number() })
    const validator = standardSchemaValidator()
    const subscribable = {
      subscribe: () => ({ unsubscribe: () => {} }),
    }
    const logics = [
      createLogic({
        validator,
        schemas: { input },
        context: undefined,
        run: () => undefined,
      }),
      createAsyncLogic({
        validator,
        schemas: { input },
        run: () => Promise.resolve(undefined),
      }),
      createCallbackLogic({
        validator,
        schemas: { input },
        run: () => undefined,
      }),
      createObservableLogic({
        validator,
        schemas: { input },
        run: () => subscribable,
      }),
      createEventObservableLogic({
        validator,
        schemas: { input },
        run: () => subscribable,
      }),
    ]

    const summaries = logics.map((logic) =>
      validationOf(
        getThrown(() => initialTransition(logic as any, { count: 'invalid' } as any)),
      )
    )

    yield* expect(summaries).toEqual([
      expectedValidation('input'),
      expectedValidation('input'),
      expectedValidation('input'),
      expectedValidation('input'),
      expectedValidation('input'),
    ])
  })

  it('validates generic actor output before returning it', function*({ expect }) {
    const effectCalls: string[] = []
    const effect = () => {
      effectCalls.push('effect')
    }
    const logic = createLogic({
      validator: standardSchemaValidator(),
      schemas: { output: z.number() },
      context: undefined,
      run: (_, enq) => {
        enq.effect(effect)
        return { status: 'done', output: 'invalid' as any }
      },
    })

    const error = getThrown(() => initialTransition(logic))

    const actor = createActor(logic)
    actor.subscribe({ error: () => {} })
    actor.start()

    yield* expect({
      error: validationOf(error),
      status: actor.getSnapshot().status,
      effectCalls,
    }).toEqual({
      error: expectedValidation('output'),
      status: 'error',
      effectCalls: [],
    })
  })

  it('can be disabled by a derived setup', function*({ expect }) {
    const validated = setup({
      validator: standardSchemaValidator(),
      schemas: { input: z.object({ count: z.number() }) },
    })
    const unvalidated = validated.extend({ validator: undefined })

    const outcome = yield* Effect.exit(
      Effect.sync(() =>
        initialTransition(unvalidated.createMachine({}), {
          count: 'not validated',
        } as any)
      ),
    )

    yield* expect(outcome._tag).toEqual('Success')
  })

  it('can be installed by a derived setup', function*({ expect }) {
    const validated = setup({
      schemas: { input: z.object({ count: z.number() }) },
    }).extend({ validator: standardSchemaValidator() })

    const error = getThrown(() =>
      initialTransition(validated.createMachine({}), {
        count: 'invalid',
      } as any)
    )

    yield* expect(validationOf(error)).toEqual(expectedValidation('input'))
  })

  it('calls validators only at pure calculation boundaries', function*({ expect }) {
    const kinds: string[] = []
    const check: ActorLogicValidator['check'] = (request) => {
      kinds.push(request.kind)
      return undefined
    }
    const machine = setup({ validator: { check } }).createMachine({
      on: {
        GO: (_, enq) => {
          enq.raise({ type: 'INTERNAL' })
        },
        INTERNAL: {},
      },
    })

    const [snapshot] = initialTransition(machine)
    const initialKinds = [...kinds]

    kinds.length = 0
    transition(machine, snapshot, { type: 'GO' })
    const transitionKinds = [...kinds]

    yield* expect({ initialKinds, transitionKinds }).toEqual({
      initialKinds: ['input', 'result'],
      transitionKinds: ['event', 'result'],
    })
  })

  it('validates input before initial context construction', function*({ expect }) {
    const contextCalls: number[] = []
    const context = () => {
      contextCalls.push(1)
      return { count: 0 }
    }
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: { input: z.object({ count: z.number() }) },
    }).createMachine({ context })

    const error = getThrown(() => initialTransition(machine, { count: 'x' } as any))

    yield* expect({
      error: validationOf(error),
      contextCalls,
    }).toEqual({
      error: expectedValidation('input'),
      contextCalls: [],
    })
  })

  it('does not validate the machine input schema as root state input', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        input: z.object({ count: z.number() }),
        events: { GO: z.object({}) },
      },
    }).createMachine({
      initial: 'idle',
      states: { idle: { on: { GO: { target: 'done' } } }, done: {} },
    })

    const [snapshot] = initialTransition(machine, { count: 1 })
    const next = transition(machine, snapshot, { type: 'GO' })[0]

    yield* expect({
      initial: snapshot.value,
      after: next.value,
    }).toEqual({
      initial: 'idle',
      after: 'done',
    })
  })

  it('validates external events before guard or transition selection', function*({ expect }) {
    const guardCalls: unknown[] = []
    const guard = (event: unknown) => {
      guardCalls.push(event)
      return true
    }
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: { events: { GO: z.object({ count: z.number() }) } },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: ({ event }) => (guard(event) ? { target: 'done' } : undefined),
          },
        },
        done: {},
      },
    })
    const [snapshot] = initialTransition(machine)

    const result = transition(machine, snapshot, {
      type: 'GO',
      count: 'x',
    } as any)
    const rejection = getRejection(result)

    yield* expect({
      sameSnapshot: result[0] === snapshot,
      rejection: rejection === undefined
        ? undefined
        : {
          event: rejection.event,
          reason: rejection.reason,
          error: validationOf(rejection.detail!.error),
        },
      guardCalls,
    }).toEqual({
      sameSnapshot: true,
      rejection: {
        event: { type: 'GO', count: 'x' },
        reason: 'invalidEvent',
        error: expectedValidation('event'),
      },
      guardCalls: [],
    })
  })

  it('validates separately declared internal event schemas', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: { GO: z.object({}) },
        internalEvents: { TICK: z.object({ count: z.number() }) },
      },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { TICK: { target: 'done' } } },
        done: {},
      },
    })
    const [snapshot] = initialTransition(machine)

    const result = transition(machine, snapshot, {
      type: 'TICK',
      count: 'x',
    } as any)

    yield* expect({
      sameSnapshot: result[0] === snapshot,
      error: validationOf(getRejection(result)!.detail!.error),
    }).toEqual({
      sameSnapshot: true,
      error: expectedValidation('event'),
    })
  })

  it('is strict for unknown events by default and supports open protocols', function*({ expect }) {
    const create = (unknownEvents?: 'error' | 'ignore') =>
      setup({
        validator: standardSchemaValidator({
          ...(unknownEvents === undefined ? {} : { unknownEvents }),
        }),
        schemas: { events: { KNOWN: z.object({}) } },
      }).createMachine({})

    const strict = create()
    const [strictSnapshot] = initialTransition(strict)
    const strictResult = transition(strict, strictSnapshot, {
      type: 'UNKNOWN',
    } as any)

    const open = create('ignore')
    const [openSnapshot] = initialTransition(open)
    const openResult = transition(open, openSnapshot, {
      type: 'UNKNOWN',
    } as any)

    yield* expect({
      strictSameSnapshot: strictResult[0] === strictSnapshot,
      strictError: validationOf(getRejection(strictResult)!.detail!.error),
      openRejection: getRejection(openResult),
    }).toEqual({
      strictSameSnapshot: true,
      strictError: expectedValidation('event', 'unknownEvent'),
      openRejection: undefined,
    })
  })

  it('validates stable root context after the macrostep', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        context: z.object({ count: z.number() }),
        events: { BREAK: z.object({}) },
      },
    }).createMachine({
      context: { count: 0 },
      on: {
        BREAK: () => ({ context: { count: 'x' } as any }),
      },
    })
    const [snapshot] = initialTransition(machine)

    const error = getThrown(() => transition(machine, snapshot, { type: 'BREAK' }))

    yield* expect(validationOf(error)).toEqual(expectedValidation('context'))
  })

  it('does not validate immediate raised events in v1', function*({ expect }) {
    const raisedCalls: boolean[] = []
    const raisedHandler = () => {
      raisedCalls.push(true)
    }
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: {
          GO: z.object({}),
          RAISED: z.object({ value: z.number() }),
        },
      },
    }).createMachine({
      on: {
        GO: (_, enq) => {
          enq.raise({ type: 'RAISED', value: 'x' } as any)
        },
        RAISED: () => {
          raisedHandler()
        },
      },
    })
    const [snapshot] = initialTransition(machine)

    const outcome = yield* Effect.exit(
      Effect.sync(() => transition(machine, snapshot, { type: 'GO' })),
    )

    yield* expect({
      outcome: outcome._tag,
      raisedCalls,
    }).toEqual({
      outcome: 'Success',
      raisedCalls: [true],
    })
  })

  it('validates delayed raised events retained by the stable snapshot', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: { events: { LATER: z.object({ value: z.number() }) } },
    }).createMachine({
      entry: (_, enq) => {
        enq.raise({ type: 'LATER', value: 'x' } as any, { delay: 10 })
      },
    })

    const error = getThrown(() => initialTransition(machine))

    yield* expect({
      ...validationOf(error),
      eventOrigin: eventOriginOf(error),
    }).toEqual({
      ...expectedValidation('event'),
      eventOrigin: 'raised',
    })
  })

  it('validates emitted events before any effect executes', function*({ expect }) {
    const actionCalls: string[] = []
    const action = () => {
      actionCalls.push('action')
    }
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: { GO: z.object({}) },
        emitted: { notice: z.object({ value: z.number() }) },
      },
      actions: { action },
    }).createMachine({
      on: {
        GO: ({ actions }, enq) => {
          enq(actions.action)
          enq.emit({ type: 'notice', value: 'x' } as any)
        },
      },
    })
    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()
    actor.send({ type: 'GO' })

    yield* expect({
      status: actor.getSnapshot().status,
      error: validationOf((actor.getSnapshot() as any).error),
      actionCalls,
    }).toEqual({
      status: 'error',
      error: expectedValidation('emitted'),
      actionCalls: [],
    })
  })

  it('is strict for unknown emitted events and supports open protocols', function*({ expect }) {
    const create = (unknownEmitted?: 'error' | 'ignore') =>
      setup({
        validator: standardSchemaValidator({
          ...(unknownEmitted === undefined ? {} : { unknownEmitted }),
        }),
        schemas: { emitted: { known: z.object({}) } },
      }).createMachine({
        entry: (_, enq) => {
          enq.emit({ type: 'unknown' } as any)
        },
      })

    const strictError = getThrown(() => initialTransition(create()))
    const ignoreOutcome = yield* Effect.exit(
      Effect.sync(() => initialTransition(create('ignore'))),
    )

    yield* expect({
      strictError: validationOf(strictError),
      ignoreOutcome: ignoreOutcome._tag,
    }).toEqual({
      strictError: expectedValidation('emitted', 'unknownEmitted'),
      ignoreOutcome: 'Success',
    })
  })

  it('surfaces boundary rejections through onRejectedEvent without erroring the actor', function*({ expect }) {
    const inspection: any[] = []
    const rejections: EventRejection[] = []
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: { events: { GO: z.object({ value: z.number() }) } },
    }).createMachine({})
    const actor = createActor(machine, {
      inspect: (event) => inspection.push(event),
      onRejectedEvent: (rejection) => rejections.push(rejection),
    })
    actor.start()
    actor.send({ type: 'GO', value: 'x' } as any)

    yield* expect({
      status: actor.getSnapshot().status,
      rejections: rejections.map((rejection) => ({
        event: rejection.event,
        sourceRef: rejection.sourceRef,
        reason: rejection.reason,
        error: validationOf(rejection.error),
      })),
      erroringTransition: inspection.some(
        (event) =>
          event.type === '@xstate.transition' &&
          event.snapshot.status === 'error',
      ),
    }).toEqual({
      status: 'active',
      rejections: [
        {
          event: { type: 'GO', value: 'x' },
          sourceRef: undefined,
          reason: 'invalidEvent',
          error: expectedValidation('event'),
        },
      ],
      erroringTransition: false,
    })
  })

  it('does not expose rejected macrostep facets through inspection', function*({ expect }) {
    const inspection: any[] = []
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        context: z.object({ count: z.number() }),
        events: { BREAK: z.object({}) },
      },
    }).createMachine({
      context: { count: 0 },
      on: {
        BREAK: ({ context }) => ({
          context: { ...context, count: 'invalid' } as any,
        }),
      },
    })
    const actor = createActor(machine, {
      inspect: (event) => inspection.push(event),
    })
    actor.subscribe({ error: () => {} })
    actor.start()
    actor.send({ type: 'BREAK' })

    const failure = inspection.find(
      (event) =>
        event.type === '@xstate.transition' &&
        event.event.type === 'BREAK' &&
        event.snapshot.status === 'error',
    )
    if (failure === undefined) {
      throw new Error('expected a failed transition')
    }

    yield* expect({
      error: validationOf(failure.snapshot.error),
      actions: failure.actions,
      sent: failure.sent,
      microsteps: failure.microsteps,
    }).toEqual({
      error: expectedValidation('context'),
      actions: [],
      sent: [],
      microsteps: [],
    })
  })

  it('allows active onError handlers to recover validation failures', function*({ expect }) {
    const inspection: any[] = []
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        context: z.object({ count: z.number() }),
        events: { BREAK: z.object({}) },
      },
    }).createMachine({
      context: { count: 0 },
      initial: 'active',
      states: {
        active: {
          on: { BREAK: () => ({ context: { count: 'x' } as any }) },
          onError: { target: 'failed' },
        },
        failed: {},
      },
    })
    const actor = createActor(machine, {
      inspect: (event) => inspection.push(event),
    }).start()

    actor.send({ type: 'BREAK' })

    const recovery = inspection.find(
      (event) =>
        event.type === '@xstate.transition' &&
        event.event.type === 'xstate.error.execution',
    )
    if (recovery === undefined) {
      throw new Error('expected a recovery transition')
    }

    yield* expect({
      snapshot: {
        status: actor.getSnapshot().status,
        value: actor.getSnapshot().value,
      },
      recoveryError: validationOf(recovery.event.error),
    }).toEqual({
      snapshot: { status: 'active', value: 'failed' },
      recoveryError: expectedValidation('context'),
    })
  })

  it('allows root onError to recover initial result validation failures', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: { context: z.object({ count: z.number() }) },
    }).createMachine({
      context: { count: 'invalid' } as any,
      initial: 'active',
      onError: () => ({
        target: '.recovered',
        context: { count: 0 },
      }),
      states: {
        active: {},
        recovered: {},
      },
    })

    const [snapshot] = initialTransition(machine)

    yield* expect({
      status: snapshot.status,
      value: snapshot.value,
      context: snapshot.context,
    }).toEqual({
      status: 'active',
      value: 'recovered',
      context: { count: 0 },
    })
  })

  it('validates final output before completion', function*({ expect }) {
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: { FINISH: z.object({}) },
        output: z.object({ total: z.number() }),
      },
    }).createMachine({
      initial: 'active',
      states: {
        active: { on: { FINISH: { target: 'done' } } },
        done: { type: 'final', output: { total: 'x' } as any },
      },
    })
    const [snapshot] = initialTransition(machine)

    const error = getThrown(() => transition(machine, snapshot, { type: 'FINISH' }))

    yield* expect(validationOf(error)).toEqual(expectedValidation('output'))
  })

  it('validates state input and state-local context in the stable snapshot', function*({ expect }) {
    const stateInputMachine = setup({
      validator: standardSchemaValidator(),
      schemas: { events: { GO: z.object({}) } },
      states: {
        done: { schemas: { input: z.object({ id: z.number() }) } },
      },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: { GO: { target: 'done', input: { id: 'x' } as any } },
        },
        done: {},
      },
    })
    const [inputSnapshot] = initialTransition(stateInputMachine)
    const inputError = getThrown(() => transition(stateInputMachine, inputSnapshot, { type: 'GO' }))

    const stateContextMachine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        context: z.object({ mode: z.string() }),
        events: { GO: z.object({}) },
      },
      states: {
        done: { schemas: { context: z.object({ mode: z.literal('done') }) } },
      },
    }).createMachine({
      context: { mode: 'idle' },
      initial: 'idle',
      states: {
        idle: { on: { GO: { target: 'done' } as any } },
        done: {},
      },
    })
    const [contextSnapshot] = initialTransition(stateContextMachine)
    const contextError = getThrown(() => transition(stateContextMachine, contextSnapshot, { type: 'GO' }))

    yield* expect({
      inputError: validationOf(inputError),
      contextError: validationOf(contextError),
    }).toEqual({
      inputError: expectedValidation('state.input'),
      contextError: expectedValidation('state.context'),
    })
  })

  it('validates root and partial state context schemas independently', function*({ expect }) {
    const createPartialContextMachine = (context: unknown) =>
      setup({
        validator: standardSchemaValidator(),
        schemas: {
          context: z.object({
            requestId: z.string(),
            draft: z.string().optional(),
          }),
        },
        states: {
          reviewing: {
            schemas: { context: z.object({ draft: z.string() }) },
          },
        },
      }).createMachine({
        context: context as any,
        initial: 'reviewing',
        states: { reviewing: {} },
      })

    const validOutcome = yield* Effect.exit(
      Effect.sync(() =>
        initialTransition(
          createPartialContextMachine({ requestId: 'req-1', draft: 'Ready' }),
        )
      ),
    )
    const rootError = getThrown(() =>
      initialTransition(
        createPartialContextMachine({ requestId: 1, draft: 'Ready' }),
      )
    )
    const stateError = getThrown(() => initialTransition(createPartialContextMachine({ requestId: 'req-1' })))

    yield* expect({
      validOutcome: validOutcome._tag,
      rootError: validationOf(rootError),
      stateError: validationOf(stateError),
    }).toEqual({
      validOutcome: 'Success',
      rootError: expectedValidation('context'),
      stateError: expectedValidation('state.context'),
    })
  })

  it('does not validate named action and guard params in v1', function*({ expect }) {
    const actionCalls: string[] = []
    const action = (..._args: unknown[]) => {
      actionCalls.push('action')
    }
    const actionMachine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: { GO: z.object({}) },
        actions: { track: { params: z.object({ count: z.number() }) } },
      },
      actions: { track: action },
    }).createMachine({
      on: {
        GO: ({ actions }, enq) => {
          enq(actions.track, { count: 'x' } as any)
        },
      },
    })
    const actionActor = createActor(actionMachine).start()
    actionActor.send({ type: 'GO' })

    const guardCalls: boolean[] = []
    const guard = () => {
      guardCalls.push(true)
      return true
    }
    const guardMachine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: { GO: z.object({}) },
        guards: { allowed: { params: z.object({ count: z.number() }) } },
      },
      guards: { allowed: guard },
    }).createMachine({
      on: {
        GO: ({ guards }) => {
          if ((guards.allowed as any)({ count: 'x' })) {
            return {}
          }
          return undefined
        },
      },
    })
    const [guardSnapshot] = initialTransition(guardMachine)
    const guardOutcome = yield* Effect.exit(
      Effect.sync(() => transition(guardMachine, guardSnapshot, { type: 'GO' })),
    )

    yield* expect({
      actionCalls,
      guardOutcome: guardOutcome._tag,
      guardCalls,
    }).toEqual({
      actionCalls: ['action'],
      guardOutcome: 'Success',
      guardCalls: [true],
    })
  })

  it('validates declared child slots', function*({ expect }) {
    const child = createMachine({})
    const machine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        children: {
          worker: z.custom<AnyActorRef>(() => false, 'invalid worker'),
        },
      },
      actors: { worker: child },
    }).createMachine({ invoke: { id: 'worker', src: 'worker' } })

    const error = getThrown(() => initialTransition(machine))

    yield* expect(validationOf(error)).toEqual(expectedValidation('child'))
  })

  it('rejects async schemas and permits type-only schemas', function*({ expect }) {
    const asyncMachine = setup({
      validator: standardSchemaValidator(),
      schemas: {
        events: {
          GO: z.object({}).refine(() => Promise.resolve(true)),
        },
      },
    }).createMachine({})
    const [snapshot] = initialTransition(asyncMachine)
    const asyncError = getRejection(
      transition(asyncMachine, snapshot, { type: 'GO' }),
    )!.detail!.error

    const rejectingSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => Promise.reject(new Error('async schema failed')),
      },
    }
    const rejectingMachine = setup({
      validator: standardSchemaValidator(),
      schemas: { events: { GO: rejectingSchema } },
    }).createMachine({})
    const [rejectingSnapshot] = initialTransition(rejectingMachine)
    const rejectingError = getRejection(
      transition(rejectingMachine, rejectingSnapshot, { type: 'GO' }),
    )!.detail!.error

    yield* Effect.promise(() => Promise.resolve())

    const typeOnlyMachine = setup({
      validator: standardSchemaValidator(),
      schemas: { events: { GO: types<{ value: number }>() } },
    }).createMachine({})
    const [typeOnlySnapshot] = initialTransition(typeOnlyMachine)
    const typeOnlyOutcome = yield* Effect.exit(
      Effect.sync(() =>
        transition(typeOnlyMachine, typeOnlySnapshot, {
          type: 'GO',
          value: 'not checked',
        } as any)
      ),
    )

    yield* expect({
      asyncError: validationOf(asyncError),
      rejectingError: validationOf(rejectingError),
      typeOnlyOutcome: typeOnlyOutcome._tag,
    }).toEqual({
      asyncError: expectedValidation('event', 'asyncValidationUnsupported'),
      rejectingError: expectedValidation('event', 'asyncValidationUnsupported'),
      typeOnlyOutcome: 'Success',
    })
  })
})
