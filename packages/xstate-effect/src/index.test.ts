import { describe, expectTypeOf, it } from '@systemfsoftware/vitest'
import {
  createActor,
  createMachine,
  initialTransition,
  setup,
  type StandardSchemaV1,
  types,
} from '@systemfsoftware/xstate'
import { standardSchemaValidator } from '@systemfsoftware/xstate/validation'
import { Clock, Context, Deferred, Effect, Layer, ManagedRuntime, Option, Ref, Schema, Scope, Stream } from 'effect'
import { createEffectActor, fromEffect, fromEffectEventStream, fromEffectStream, setupEffect } from './index.js'

const until = (predicate: () => boolean, timeoutMs = 1000) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while (!predicate()) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(
          new Error('Timed out waiting for condition'),
        )
      }
      yield* Effect.sleep(1)
    }
  })

const rejects = (schema: StandardSchemaV1, value: unknown): boolean => {
  const result = schema['~standard'].validate(value)
  if (result instanceof Promise) {
    throw new Error('Expected a synchronous schema')
  }
  return result.issues !== undefined
}

const thrownMessage = (call: () => unknown): string => {
  try {
    call()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw')
}

describe('@xstate/effect', (it) => {
  it('accepts Effect schemas in setupEffect with full type inference', function*({ expect }) {
    const effectSetup = setupEffect({
      schemas: {
        context: Schema.Struct({ count: Schema.Finite }),
        events: {
          ADD: Schema.Struct({ value: Schema.Finite }),
          RESET: types<{}>(),
        },
      },
    })
    const machine = effectSetup.createMachine({
      context: { count: 0 },
      initial: 'active',
      states: {
        active: {
          on: {
            ADD: ({ context, event }) => {
              context.count satisfies number
              event.value satisfies number
              return { context: { count: context.count + event.value } }
            },
            RESET: { context: { count: 0 } },
          },
        },
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        actor.send({ type: 'ADD', value: 3 })
        const sendInvalidEvent = () => {
          // @ts-expect-error -- Effect schemas constrain event payloads
          actor.send({ type: 'ADD', value: 'invalid' })
        }
        void sendInvalidEvent
        yield* until(() => actor.getSnapshot().context.count === 3)

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ count: 3 })
  })

  it('validates converted context and event schemas at runtime', function*({ expect }) {
    const machine = setupEffect({
      validator: standardSchemaValidator(),
      schemas: {
        context: Schema.Struct({ count: Schema.Finite }),
        events: { ADD: Schema.Struct({ value: Schema.Finite }) },
      },
    }).createMachine({
      context: { count: 0 },
      on: {
        ADD: ({ context, event }) => ({
          context: { count: context.count + event.value },
        }),
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)

        actor.send({ type: 'ADD', value: 2 })
        yield* until(() => actor.getSnapshot().context.count === 2)

        actor.send({ type: 'ADD', value: 'invalid' } as any)
        actor.send({ type: 'ADD', value: 1 })
        yield* until(() => actor.getSnapshot().context.count === 3)

        return actor.getSnapshot().context
      }),
    )

    const invalidContext = setupEffect({
      validator: standardSchemaValidator(),
      schemas: { context: Schema.Struct({ count: Schema.Finite }) },
    }).createMachine({ context: { count: 'invalid' } as any })

    yield* expect({
      context,
      invalidContext: thrownMessage(() => initialTransition(invalidContext)),
    }).toEqual({
      context: { count: 3 },
      invalidContext: expect.stringMatching(/Invalid context/),
    })
  })

  it('accepts Effect schemas when extending setupEffect', function*({ expect }) {
    const effectSetup = setupEffect({
      schemas: {
        context: Schema.Struct({ count: Schema.Finite }),
      },
    }).extend({
      schemas: {
        events: {
          ADD: Schema.Struct({ value: Schema.Finite }),
        },
      },
      guards: {
        canAdd: ({ context, event }) => {
          context.count satisfies number
          event.value satisfies number
          return event.value > 0
        },
      },
    })
    const machine = effectSetup.createMachine({
      context: { count: 0 },
      on: {
        ADD: {
          context: ({ context, event }) => ({
            count: context.count + event.value,
          }),
        },
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)

        actor.send({ type: 'ADD', value: 2 })
        yield* until(() => actor.getSnapshot().context.count === 2)

        return actor.getSnapshot().context
      }),
    )

    yield* expect({
      context,
      rejected: rejects(effectSetup.schemas.events.ADD, { value: 'invalid' }),
    }).toEqual({ context: { count: 2 }, rejected: true })
  })

  it('preserves runtime validation compatibility through setupEffect.extend', function*({ expect }) {
    const validated = setupEffect({
      validator: standardSchemaValidator(),
    })
    const incompatibleSchemas = setupEffect({
      schemas: { input: Schema.FiniteFromString },
    })
    const incompatibleStates = setupEffect({
      states: {
        loading: { schemas: { input: Schema.FiniteFromString } },
      },
    })

    if (false) {
      validated.extend({
        schemas: {
          // @ts-expect-error -- extended schemas inherit runtime validation
          input: Schema.FiniteFromString,
        },
      })

      // @ts-expect-error -- validation cannot be installed over a transforming schema
      incompatibleSchemas.extend({ validator: standardSchemaValidator() })

      // @ts-expect-error -- inherited state schemas must also be compatible
      incompatibleStates.extend({ validator: standardSchemaValidator() })
    }

    const extended = validated.extend({
      validator: undefined,
      schemas: { input: Schema.FiniteFromString },
    })

    const baseSchemas: Record<string, unknown> = validated.schemas
    yield* expect({
      baseInput: baseSchemas['input'] ?? null,
      extendedInputDiffers: extended.schemas.input !== baseSchemas['input'],
    }).toEqual({ baseInput: null, extendedInputDiffers: true })
  })

  it('preserves Effect action requirements when extending setupEffect', function*({ expect }) {
    class Audit extends Context.Service<Audit, { record: () => void }>()(
      '@systemfsoftware/xstate-effect/index.test/Audit',
    ) {}
    const machine = setupEffect()
      .extend({
        actions: {
          audit: (_args) => Audit.use((audit) => Effect.sync(() => audit.record())),
        },
      })
      .createMachine({
        on: {
          AUDIT: (args, enq) => enq(args.actions.audit, args),
        },
      })
    const actorWithoutAudit = createEffectActor(machine)
    expectTypeOf<Effect.Services<typeof actorWithoutAudit>>().toEqualTypeOf<Audit | Scope.Scope>()

    yield* expect(machine.id).toEqual('(machine)')
  })

  it('converts nested Effect state schemas', function*({ expect }) {
    const effectSetup = setupEffect({
      states: {
        running: {
          schemas: {
            input: Schema.Struct({ timeout: Schema.Finite }),
          },
          states: {
            retrying: {
              schemas: {
                context: Schema.Struct({ attempt: Schema.Finite }),
              },
            },
          },
        },
      },
    })

    yield* expect([
      rejects(effectSetup.states.running.schemas!.input!, {}),
      rejects(effectSetup.states.running.schemas!.input!, { timeout: 5 }),
      rejects(effectSetup.states.running.states!.retrying.schemas!.context!, {
        attempt: 'no',
      }),
    ]).toEqual([true, false, true])
  })

  it('converts Effect schemas in every setup schema map', function*({ expect }) {
    const effectSetup = setupEffect({
      schemas: {
        internalEvents: {
          TICK: Schema.Struct({ count: Schema.Finite }),
        },
        actions: {
          track: { params: Schema.Struct({ key: Schema.String }) },
        },
        guards: {
          hasAccess: { params: Schema.Struct({ role: Schema.String }) },
        },
        emitted: {
          changed: Schema.Struct({ value: Schema.Finite }),
        },
        meta: Schema.Struct({ label: Schema.String }),
        tags: Schema.Literals(['active']),
        children: {
          child: Schema.Unknown,
        },
      },
    })

    yield* expect({
      internalEvents: rejects(effectSetup.schemas.internalEvents.TICK, { count: 'no' }),
      actions: rejects(effectSetup.schemas.actions.track.params, { key: 1 }),
      guards: rejects(effectSetup.schemas.guards.hasAccess.params, { role: 1 }),
      emitted: rejects(effectSetup.schemas.emitted.changed, { value: 'no' }),
      meta: rejects(effectSetup.schemas.meta, { label: 1 }),
      tags: rejects(effectSetup.schemas.tags, 'inactive'),
      // `Schema.Unknown` accepts anything; converting it must not change that.
      children: rejects(effectSetup.schemas.children.child, 'anything'),
    }).toEqual({
      internalEvents: true,
      actions: true,
      guards: true,
      emitted: true,
      meta: true,
      tags: true,
      children: false,
    })
  })

  it('preserves __proto__ schema and state keys while converting', function*({ expect }) {
    const effectSetup = setupEffect({
      schemas: {
        events: { ['__proto__']: Schema.String },
      },
      states: {
        ['__proto__']: {
          schemas: { input: Schema.String },
        },
      },
    })

    yield* expect([
      Object.hasOwn(effectSetup.schemas.events, '__proto__'),
      rejects(effectSetup.schemas.events['__proto__'], 42),
      Object.hasOwn(effectSetup.states, '__proto__'),
      rejects(effectSetup.states['__proto__'].schemas!.input!, 42),
    ]).toEqual([true, true, true, true])
  })

  it('uses converted Effect schemas with XState runtime validation', function*({ expect }) {
    const machine = setupEffect({
      validator: standardSchemaValidator(),
      schemas: {
        input: Schema.Struct({ count: Schema.Finite }),
      },
    }).createMachine({
      context: ({ input }) => ({ count: input.count }),
    })

    yield* expect(() => initialTransition(machine, { count: 'invalid' } as any)).toThrow('Invalid input')
  })

  it('reports asynchronous Effect schemas as unsupported by runtime validation', function*({ expect }) {
    const asyncString = Schema.String.pipe(
      Schema.catchDecoding(() => Effect.delay(Effect.succeed(Option.some('fallback')), 1)),
    )
    const machine = setupEffect({
      validator: standardSchemaValidator(),
      schemas: { input: asyncString },
    }).createMachine({})

    yield* expect(() => initialTransition(machine, 42 as any)).toThrow(
      'Async schema validation is unsupported for input',
    )
  })

  it('rejects transforming Effect schemas when runtime validation is enabled', function*({ expect }) {
    const invalidSetup = () =>
      setupEffect({
        validator: standardSchemaValidator(),
        schemas: {
          // @ts-expect-error -- XState validation asserts values but does not transform them
          input: Schema.FiniteFromString,
        },
      })
    const invalidLogic = () =>
      fromEffect({
        // @ts-expect-error -- XState validation asserts values but does not transform them
        validator: standardSchemaValidator(),
        schemas: {
          input: Schema.FiniteFromString,
        },
        effect: ({ input }: { input: number }) => Effect.succeed(input),
      })

    void invalidSetup
    void invalidLogic

    yield* expect(
      Object.keys(setupEffect({ schemas: { input: Schema.FiniteFromString } }).schemas),
    ).toEqual(['input'])
  })

  it('accepts Effect schemas for fromEffect input and output', function*({ expect }) {
    const logic = fromEffect({
      schemas: {
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.Struct({ greeting: Schema.String }),
      },
      effect: ({ input }) => {
        input.id satisfies string
        return Effect.succeed({ greeting: `Hello ${input.id}` })
      },
    })

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic, { input: { id: '42' } })
        const createWithInvalidInput = () => {
          // @ts-expect-error -- input comes from the Effect schema
          const invalidActor = createEffectActor(logic, { input: { id: 42 } })
          void invalidActor
        }
        void createWithInvalidInput
        yield* until(() => actor.getSnapshot().status === 'done')

        actor.getSnapshot().output?.greeting satisfies string | undefined
        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toEqual({ greeting: 'Hello 42' })
  })

  it('rejects invalid fromEffect input with XState runtime validation', function*({ expect }) {
    const logic = fromEffect({
      validator: standardSchemaValidator(),
      schemas: {
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.Struct({ greeting: Schema.String }),
      },
      effect: ({ input }) => Effect.succeed({ greeting: `Hello ${input.id}` }),
    })

    yield* expect(() => initialTransition(logic, { id: 42 } as any)).toThrow(
      'Invalid input',
    )
  })

  it('checks fromEffect results against the output schema', function*({ expect }) {
    const invalidLogic = () =>
      fromEffect({
        // @ts-expect-error -- the Effect result must match the output schema
        schemas: { output: Schema.String },
        effect: Effect.succeed(42),
      })

    void invalidLogic

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(invalidLogic())
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toEqual(42)
  })

  it('preserves failures and requirements with input and output schemas', function*({ expect }) {
    class Service extends Context.Service<Service, { name: string }>()(
      '@systemfsoftware/xstate-effect/index.test/Service',
    ) {}
    const failure = { code: 'NOT_FOUND' as const }
    const logic = fromEffect({
      schemas: {
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.Struct({ name: Schema.String }),
      },
      effect: ({ input }) =>
        Service.use((service) =>
          input.id === 'missing'
            ? Effect.fail(failure)
            : Effect.succeed({ name: service.name })
        ),
    })
    setup({ actors: { logic } }).createMachine({
      invoke: {
        src: 'logic',
        input: { id: '42' },
        onError: ({ event }) => {
          event.error.code satisfies 'NOT_FOUND'
          return {}
        },
      },
    })
    const actorWithoutService = createEffectActor(logic, { input: { id: '42' } })
    expectTypeOf<Effect.Services<typeof actorWithoutService>>().toEqualTypeOf<Service | Scope.Scope>()

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* Effect.provideService(
          createEffectActor(logic, { input: { id: '42' } }),
          Service,
          { name: 'svc' },
        )
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toEqual({ name: 'svc' })
  })

  it('infers fromEffect output and requirements with only an input schema', function*({ expect }) {
    class Service extends Context.Service<Service, { prefix: string }>()(
      '@systemfsoftware/xstate-effect/index.test/Service',
    ) {}
    const logic = fromEffect({
      schemas: {
        input: Schema.Struct({ id: Schema.String }),
      },
      effect: ({ input }) => Service.use((service) => Effect.succeed(`${service.prefix}${input.id}`)),
    })

    const actorWithoutService = createEffectActor(logic, { input: { id: '42' } })
    expectTypeOf<Effect.Services<typeof actorWithoutService>>().toEqualTypeOf<Service | Scope.Scope>()

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* Effect.provideService(
          createEffectActor(logic, { input: { id: '42' } }),
          Service,
          { prefix: 'p' },
        )
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toEqual('p42')
  })

  it('accepts a constant Effect with only an input schema', function*({ expect }) {
    const logic = fromEffect({
      schemas: {
        input: Schema.Struct({ id: Schema.String }),
      },
      effect: Effect.succeed('ok'),
    })

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic, { input: { id: '42' } })
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toBe('ok')
  })

  it('accepts an output-only Effect schema', function*({ expect }) {
    const logic = fromEffect({
      schemas: { output: Schema.String },
      effect: Effect.succeed('ok'),
    })

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic)
        yield* until(() => actor.getSnapshot().status === 'done')

        actor.getSnapshot().output satisfies string | undefined
        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toBe('ok')
  })

  it('infers actor input with only an output schema', function*({ expect }) {
    const logic = fromEffect({
      schemas: { output: Schema.String },
      effect: ({ input }: { input: number }) => Effect.succeed(String(input)),
    })

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic, { input: 42 })
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toBe('42')
  })

  it('validates fromEffect schemas when a validator is provided', function*({ expect }) {
    const logic = fromEffect({
      validator: standardSchemaValidator(),
      schemas: { output: Schema.String },
      effect: Effect.succeed('ok'),
    })

    const status = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic)
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().status
      }),
    )

    yield* expect(status).toBe('done')
  })

  it('rejects invalid fromEffect output with XState runtime validation', function*({ expect }) {
    const deferred = yield* Deferred.make<number>()
    const logic = fromEffect({
      validator: standardSchemaValidator(),
      schemas: { output: Schema.String },
      effect: Deferred.await(deferred) as Effect.Effect<any>,
    })
    const errors: unknown[] = []
    yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic)
        actor.subscribe({ error: (error) => errors.push(error) })
        yield* Deferred.succeed(deferred, 42)
        yield* until(() => actor.getSnapshot().status === 'error')
      }),
    )

    const [first] = errors
    yield* expect({
      count: errors.length,
      isError: first instanceof Error,
      message: first instanceof Error ? first.message : undefined,
    }).toEqual({ count: 1, isError: true, message: expect.stringMatching(/Invalid output/) })
  })

  it('runs setupEffect actions inside the host Effect context', function*({ expect }) {
    class Audit extends Context.Service<
      Audit,
      { record: (value: number) => void }
    >()('@systemfsoftware/xstate-effect/index.test/Audit') {}
    const recorded: number[] = []

    const effectSetup = setupEffect({
      actions: {
        audit: ({ context }) => Audit.use((audit) => Effect.sync(() => audit.record(context.count))),
      },
    })
    const machine = effectSetup.createMachine({
      context: { count: 1 },
      initial: 'active',
      states: {
        active: {
          on: {
            AUDIT: (args, enq) => {
              enq(args.actions.audit, args)
            },
          },
        },
      },
    })

    const actorWithoutAudit = createEffectActor(machine)
    expectTypeOf<Effect.Services<typeof actorWithoutAudit>>().toEqualTypeOf<Audit | Scope.Scope>()

    yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* Effect.provideService(createEffectActor(machine), Audit, {
          record: (value) => recorded.push(value),
        })

        actor.send({ type: 'AUDIT' })
        yield* until(() => recorded.length === 1)
      }),
    )

    yield* expect(recorded).toEqual([1])
  })

  it.live('uses scoped Layer services while the caller-owned runtime is alive', function*({ expect }) {
    class Resource extends Context.Service<Resource, { value: string }>()(
      '@systemfsoftware/xstate-effect/index.test/Resource',
    ) {}
    const acquired = yield* Ref.make(0)
    const released = yield* Ref.make(0)
    const observed = yield* Ref.make<string | undefined>(undefined)
    const layer = Layer.effect(
      Resource,
      Effect.acquireRelease(
        Effect.sync(() => {
          Effect.runSync(Ref.update(acquired, (n) => n + 1))
          return { value: 'scoped' }
        }),
        () =>
          Effect.sync(() => {
            Effect.runSync(Ref.update(released, (n) => n + 1))
          }),
      ),
    )
    const runtime = ManagedRuntime.make(layer)
    const machine = setupEffect({
      actions: {
        read: (_args) =>
          Resource.use((resource) =>
            Effect.sync(() => {
              Effect.runSync(Ref.set(observed, resource.value))
            })
          ),
      },
    }).createMachine({
      on: {
        READ: (args, enq) => enq(args.actions.read, args),
      },
    })

    const scope = yield* Effect.promise(() => runtime.runPromise(Scope.make()))
    const actor = yield* Effect.promise(() =>
      runtime.runPromise(
        Scope.provide(createEffectActor(machine), scope),
      )
    )

    yield* expect({
      acquired: Ref.getUnsafe(acquired),
      released: Ref.getUnsafe(released),
    }).toEqual({ acquired: 1, released: 0 })

    actor.send({ type: 'READ' })
    yield* until(() => Ref.getUnsafe(observed) !== undefined)
    actor.stop()

    yield* expect({
      observed: Ref.getUnsafe(observed),
      released: Ref.getUnsafe(released),
    }).toEqual({ observed: 'scoped', released: 0 })

    yield* Effect.promise(() => runtime.dispose())

    yield* expect(Ref.getUnsafe(released)).toEqual(1)
  })

  it('routes failed Effect actions through the machine error transition', function*({ expect }) {
    const failure = { code: 'AUDIT_FAILED' as const }
    const received = yield* Ref.make<unknown>(undefined)
    const effectSetup = setupEffect({
      actions: {
        fail: (_args) => Effect.fail(failure),
      },
    })
    const machine = effectSetup.createMachine({
      initial: 'active',
      states: {
        active: {
          on: {
            FAIL: (args, enq) => enq(args.actions.fail, args),
          },
          onError: ({ event }) => {
            Effect.runSync(Ref.set(received, event.error))
            return { target: 'failed' }
          },
        },
        failed: {},
      },
    })

    yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        actor.send({ type: 'FAIL' })
        yield* until(() => actor.getSnapshot().value === 'failed')
      }),
    )

    const error = yield* Ref.get(received)
    yield* expect(error).toEqual(failure)
  })

  it('invokes an Effect actor and routes success to onDone', function*({ expect }) {
    const logic = fromEffect(Effect.succeed('ok'))
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: logic,
            onDone: {
              target: 'success',
              context: ({ event }) => ({ result: event.output }),
            },
          },
        },
        success: {},
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        yield* until(() => actor.getSnapshot().value === 'success')

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ result: 'ok' })
  })

  it('uses the Effect runtime brand when distinguishing config objects', function*({ expect }) {
    const directEffect = Object.assign(Effect.succeed('direct'), {
      effect: Effect.succeed('nested'),
    })
    const logic = fromEffect(directEffect)

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic)
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toBe('direct')
  })

  it('routes typed Effect failures to onError', function*({ expect }) {
    const failure = { code: 'NOT_FOUND' as const }
    const logic = fromEffect(Effect.fail(failure))
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: logic,
            onError: {
              target: 'failed',
              context: ({ event }) => ({ error: event.error }),
            },
          },
        },
        failed: {},
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        yield* until(() => actor.getSnapshot().value === 'failed')

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ error: failure })
  })

  it('preserves typed Effect errors through registered v6 actors', function*({ expect }) {
    const failure = { code: 'NOT_FOUND' as const }
    const request = fromEffect(Effect.fail(failure))
    const effectSetup = setupEffect({ actors: { request } })
    const machine = effectSetup.createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: {
            src: 'request',
            onError: ({ event }) => {
              const code: 'NOT_FOUND' = event.error.code
              // @ts-expect-error -- the Effect failure is discriminated
              const other: 'OTHER' = code
              void other
              return { target: 'failed' }
            },
          },
        },
        failed: {},
      },
    })

    const value = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        yield* until(() => actor.getSnapshot().value === 'failed')

        return actor.getSnapshot().value
      }),
    )

    yield* expect(value).toEqual('failed')
  })

  it('collects requirements from registered Effect actors', function*({ expect }) {
    class Service extends Context.Service<Service, { value: number }>()(
      '@systemfsoftware/xstate-effect/index.test/Service',
    ) {}
    const logic = fromEffect(
      Service.use((service) => Effect.succeed(service.value)),
    )
    const actorWithoutService = createEffectActor(logic)
    expectTypeOf<Effect.Services<typeof actorWithoutService>>().toEqualTypeOf<Service | Scope.Scope>()
    const machine = setup({ actors: { logic } }).createMachine({
      initial: 'pending',
      states: {
        pending: {
          invoke: { src: 'logic' },
        },
      },
    })

    const actorWithoutRegisteredService = createEffectActor(machine)
    expectTypeOf<Effect.Services<typeof actorWithoutRegisteredService>>().toEqualTypeOf<Service | Scope.Scope>()

    const output = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* Effect.provideService(createEffectActor(logic), Service, {
          value: 7,
        })
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().output
      }),
    )

    yield* expect(output).toEqual(7)
  })

  it('rejects running Effect logic through ordinary createActor', function*({ expect }) {
    const logic = fromEffect(Effect.succeed('ok'))
    const actor = createActor(logic)
    actor.subscribe({ error: () => {} })
    actor.start()

    yield* expect(actor.getSnapshot().status).toBe('error')
  })

  it('exposes the latest item from an Effect stream and completes', function*({ expect }) {
    const logic = fromEffectStream(Stream.make(1, 2, 3))

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic)
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toBe(3)
  })

  it('infers stream input from the fromEffectStream config form', function*({ expect }) {
    const logic = fromEffectStream({
      schemas: { input: Schema.Struct({ n: Schema.Finite }) },
      stream: ({ input }) => {
        input satisfies { readonly n: number }
        return Stream.make(input.n, input.n + 1)
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic, { input: { n: 5 } })
        yield* until(() => actor.getSnapshot().status === 'done')

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toBe(6)
  })

  it('relays a configured Effect event stream to its parent', function*({ expect }) {
    const relay = fromEffectEventStream({
      schemas: { input: Schema.Struct({ n: Schema.Finite }) },
      stream: ({ input }) => {
        input satisfies { readonly n: number }
        return Stream.make(
          { type: 'VALUE' as const, value: input.n },
          { type: 'VALUE' as const, value: input.n * 2 },
        )
      },
    })
    const machine = setup({
      schemas: { events: { VALUE: types<{ value: number }>() } },
      actors: { relay },
    }).createMachine({
      context: { seen: 0 },
      initial: 'active',
      states: {
        active: {
          invoke: { src: 'relay', input: { n: 3 } },
          on: {
            VALUE: {
              context: ({ context, event }) => ({
                seen: context['seen'] + event.value,
              }),
            },
          },
        },
      },
    })

    const context = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        yield* until(() => actor.getSnapshot().context['seen'] === 9)

        return actor.getSnapshot().context
      }),
    )

    yield* expect(context).toEqual({ seen: 9 })
  })
})
