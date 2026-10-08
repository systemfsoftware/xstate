import { describe } from '@systemfsoftware/vitest'
import { createMachine, setup } from '@systemfsoftware/xstate'
import { Cause, Context, Effect, Layer, Schema } from 'effect'
import { AsyncResult, Atom, AtomRegistry } from 'effect/reactivity'
import { until } from '../tests/__fixtures__/untilCondition.js'
import { createActorAtoms } from './atom.js'
import { NotReadyError } from './atom.js'
import { fromEffect, setupEffect, withActorScope } from './index.js'

const counterMachine = createMachine({
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
  },
})

const observedResourceScope = (lifetime: 'invocation' | 'actor') =>
  Effect.gen(function*() {
    const released = { value: false }
    const acquire = Effect.acquireRelease(Effect.succeed('resource'), () =>
      Effect.sync(() => {
        released.value = true
      }))
    const logic = lifetime === 'actor'
      ? fromEffect(acquire.pipe(withActorScope))
      : fromEffect(acquire)
    const registry = AtomRegistry.make()
    const atoms = createActorAtoms(Atom.runtime(Layer.empty), logic)
    const unmount = registry.mount(atoms.snapshot)
    try {
      yield* until(() => {
        const snapshot = registry.get(atoms.snapshot)
        return (
          released.value &&
          AsyncResult.isSuccess(snapshot) &&
          snapshot.value.status === 'done'
        )
      })
      const snapshot = registry.get(atoms.snapshot)
      return AsyncResult.isSuccess(snapshot) && snapshot.value.output
    } finally {
      unmount()
      registry.dispose()
    }
  })

const observedFirstRead = Effect.gen(function*() {
  const registry = AtomRegistry.make()
  const runtime = Atom.runtime(Layer.empty)
  const atoms = createActorAtoms(runtime, counterMachine)

  const unmount = registry.mount(atoms.snapshot)
  yield* until(() => AsyncResult.isSuccess(registry.get(atoms.snapshot)))

  const snapshot = registry.get(atoms.snapshot)
  unmount()
  return AsyncResult.isSuccess(snapshot) && snapshot.value.context
})

const observedSendAtom = Effect.gen(function*() {
  const registry = AtomRegistry.make()
  const runtime = Atom.runtime(Layer.empty)
  const atoms = createActorAtoms(runtime, counterMachine)
  const counts: number[] = []

  const unsubscribe = registry.subscribe(
    atoms.select((snapshot) => snapshot.context.count),
    (result) => {
      if (AsyncResult.isSuccess(result)) {
        counts.push(result.value)
      }
    },
    { immediate: true },
  )
  yield* until(() => counts.length > 0)

  registry.set(atoms.send, { type: 'INC' })
  registry.set(atoms.send, { type: 'INC' })
  yield* until(() => counts.at(-1) === 2)

  unsubscribe()
  return counts
})

const observedRuntimeLayer = Effect.gen(function*() {
  class Greeting extends Context.Service<Greeting, { value: string }>()(
    '@systemfsoftware/xstate-effect/atom.test/Greeting',
  ) {}
  const greet = fromEffect(
    Greeting.use((greeting) => Effect.succeed(greeting.value)),
  )
  const machine = setup({ actors: { greet } }).createMachine({
    context: { greeting: '' },
    initial: 'loading',
    states: {
      loading: {
        invoke: {
          src: 'greet',
          onDone: {
            target: 'done',
            context: ({ event }) => ({ greeting: event.output }),
          },
        },
      },
      done: {},
    },
  })
  const registry = AtomRegistry.make()
  const runtime = Atom.runtime(Layer.succeed(Greeting, { value: 'hello' }))
  const atoms = createActorAtoms(runtime, machine)

  const unmount = registry.mount(atoms.snapshot)
  yield* until(() => {
    const result = registry.get(atoms.snapshot)
    return AsyncResult.isSuccess(result) && result.value.value === 'done'
  })

  const result = registry.get(atoms.snapshot)
  unmount()
  return AsyncResult.isSuccess(result) && result.value.context
})

const observedRelease = Effect.gen(function*() {
  const registry = AtomRegistry.make()
  const runtime = Atom.runtime(Layer.empty)
  const atoms = createActorAtoms(runtime, counterMachine)

  const unmount = registry.mount(atoms.snapshot)
  yield* until(() => AsyncResult.isSuccess(registry.get(atoms.actor)))
  const result = registry.get(atoms.actor)
  const actor = AsyncResult.isSuccess(result) ? result.value : undefined
  const beforeUnmount = actor?.getSnapshot().status

  unmount()
  yield* until(() => actor?.getSnapshot().status === 'stopped')

  return { beforeUnmount, afterUnmount: actor?.getSnapshot().status }
})

const observedNotReady = Effect.gen(function*() {
  class Slow extends Context.Service<Slow, { ready: true }>()(
    '@systemfsoftware/xstate-effect/atom.test/Slow',
  ) {}
  const registry = AtomRegistry.make()
  const runtime = Atom.runtime(
    Layer.effect(
      Slow,
      Effect.delay(Effect.succeed({ ready: true as const }), '5 millis'),
    ),
  )
  const atoms = createActorAtoms(runtime, counterMachine)

  const unmount = registry.mount(atoms.send)
  registry.set(atoms.send, { type: 'INC' })
  const early = registry.get(atoms.send)
  const earlyFailed = AsyncResult.isFailure(early)
  const earlyCause = AsyncResult.isFailure(early)
    ? Cause.squash(early.cause)
    : undefined

  yield* until(() => AsyncResult.isSuccess(registry.get(atoms.actor)))
  registry.set(atoms.send, { type: 'INC' })
  const late = registry.get(atoms.actor)
  yield* until(
    () =>
      AsyncResult.isSuccess(late) &&
      late.value.getSnapshot().context.count === 1,
  )
  const lateContext = AsyncResult.isSuccess(late) &&
    late.value.getSnapshot().context
  const sendSucceeded = AsyncResult.isSuccess(registry.get(atoms.send))
  unmount()
  return { earlyFailed, earlyCause, lateContext, sendSucceeded }
})

const observedErroredResult = Effect.gen(function*() {
  const failure = { code: 'BOOM' as const }
  const registry = AtomRegistry.make()
  const runtime = Atom.runtime(Layer.empty)
  const atoms = createActorAtoms(runtime, fromEffect(Effect.fail(failure)))

  const unmount = registry.mount(atoms.result)
  yield* until(() => AsyncResult.isFailure(registry.get(atoms.result)))

  const result = registry.get(atoms.result)
  unmount()
  return AsyncResult.isFailure(result) && Cause.squash(result.cause)
})

describe('createActorAtoms', (it) => {
  it.live.each(['invocation', 'actor'] as const)(
    'provides the %s resource scope',
    function*(lifetime, { expect }) {
      const observed = yield* observedResourceScope(lifetime)
      yield* expect(observed).toEqual('resource')
    },
  )

  it.live('requires and passes the input declared by the logic', function*({ expect }) {
    const logic = fromEffect({
      schemas: { input: Schema.Struct({ id: Schema.String }) },
      effect: ({ input }) => Effect.succeed(input.id),
    })
    const runtime = Atom.runtime(Layer.empty)
    const invalid = () => {
      // @ts-expect-error -- required input cannot be omitted
      createActorAtoms(runtime, logic)
      // @ts-expect-error -- the options must contain input
      createActorAtoms(runtime, logic, {})
      // @ts-expect-error -- input must match the schema
      createActorAtoms(runtime, logic, { input: { id: 1 } })
    }
    void invalid
    const registry = AtomRegistry.make()
    const atoms = createActorAtoms(runtime, logic, {
      input: { id: 'release' },
    })
    const unmount = registry.mount(atoms.snapshot)
    try {
      yield* until(() => {
        const result = registry.get(atoms.snapshot)
        return AsyncResult.isSuccess(result) && result.value.status === 'done'
      })
      const result = registry.get(atoms.snapshot)
      yield* expect(AsyncResult.isSuccess(result) && result.value.output)
        .toEqual('release')
    } finally {
      unmount()
    }
  })

  it.live('starts the actor on first read and exposes its snapshot', function*({ expect }) {
    const observed = yield* observedFirstRead
    yield* expect(observed).toEqual({ count: 0 })
  })

  it.live('sends events through the send atom and updates the snapshot', function*({ expect }) {
    const observed = yield* observedSendAtom
    yield* expect(observed).toEqual([0, 1, 2])
  })

  it.live('runs Effect logic with services from the runtime layer', function*({ expect }) {
    const observed = yield* observedRuntimeLayer
    yield* expect(observed).toEqual({ greeting: 'hello' })
  })

  it.live('rejects a runtime that does not provide a required service', function*({ expect }) {
    class Greeting extends Context.Service<Greeting, { value: string }>()(
      '@systemfsoftware/xstate-effect/atom.test/Greeting',
    ) {}
    const machine = setupEffect({
      actions: {
        greet: (_args) => Greeting.use(() => Effect.void),
      },
    }).createMachine({
      on: { GREET: (args, enq) => enq(args.actions.greet, args) },
    })
    const runtime = Atom.runtime(Layer.empty)

    const create = () => {
      // @ts-expect-error -- the runtime layer does not provide Greeting
      createActorAtoms(runtime, machine)
    }
    void create
    yield* expect(machine.getInitialSnapshot().status).toEqual('active')
  })

  it.live('stops the actor when its atoms are released', function*({ expect }) {
    const observed = yield* observedRelease
    yield* expect(observed).toEqual({
      beforeUnmount: 'active',
      afterUnmount: 'stopped',
    })
  })

  it.live('reports NotReadyError when an event is sent before the runtime is ready', function*({ expect }) {
    const observed = yield* observedNotReady
    yield* expect(observed).toEqual({
      earlyFailed: true,
      earlyCause: new NotReadyError(),
      lateContext: { count: 1 },
      sendSucceeded: true,
    })
  })

  it.live('exposes an errored actor as a failed result', function*({ expect }) {
    const observed = yield* observedErroredResult
    yield* expect(observed).toEqual({ code: 'BOOM' })
  })
})
