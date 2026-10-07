import { describe } from '@systemfsoftware/vitest'
import { type AnyActorRef, createActor, createMachine, type EventRejection, setup } from '@systemfsoftware/xstate'
import { Clock, Context, Deferred, Duration, Effect, Fiber, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import {
  createEffectActor,
  deadLetters,
  EffectInterruptedError,
  emitted,
  fromEffect,
  fromEffectEventStream,
  fromEffectStream,
  setupEffect,
  withActorScope,
} from './index.js'

const until = (predicate: () => boolean, timeoutMs = 1000) =>
  Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    while (!predicate()) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* Effect.die(new Error('Timed out waiting for condition'))
      }
      yield* Effect.sleep(1)
    }
  })

const tagOf = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && '_tag' in value
    ? value._tag
    : undefined

const observedTaskCleanup = Effect.gen(function*() {
  const order: string[] = []
  const started = { value: false }
  yield* Effect.scoped(
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* Effect.sleep(1)
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            order.push('actor resource')
          })).pipe(withActorScope)
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sleep(5).pipe(
            Effect.andThen(
              Effect.sync(() => {
                order.push('task resource')
              }),
            ),
          ))
        started.value = true
        return yield* Effect.never
      }).pipe(
        (effect) => fromEffect(effect),
        (logic) => createEffectActor(logic),
      )
      yield* until(() => started.value)
    }),
  )
  return order
})

const observedStreamResources = (kind: 'snapshot' | 'event') =>
  Effect.gen(function*() {
    const started = { value: false }
    const released = { value: 0 }
    const stream = Stream.unwrap(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released.value++
          }))
        started.value = true
        return Stream.never
      }),
    )
    const work = kind === 'snapshot'
      ? fromEffectStream(stream)
      : fromEffectEventStream(stream)
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: { src: 'work' },
          on: { CANCEL: { target: 'idle' } },
        },
        idle: {},
      },
    })
    const actor = yield* createEffectActor(machine)
    yield* until(() => started.value)
    actor.send({ type: 'CANCEL' })
    yield* until(() => released.value === 1)
    return {
      value: actor.getSnapshot().value,
      status: actor.getSnapshot().status,
    }
  })

const observedActorScopedResources = (outcome: 'success' | 'cancel') =>
  Effect.gen(function*() {
    const started = { value: false }
    const interrupted = { value: false }
    const released = { value: 0 }
    const work = fromEffect(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sleep(5).pipe(
            Effect.andThen(
              Effect.sync(() => {
                released.value++
              }),
            ),
          )).pipe(withActorScope)
        started.value = true
        if (outcome === 'cancel') {
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted.value = true
              })
            ),
          )
        }
        return 'complete'
      }),
    )
    const machine = setup({ actors: { work } }).createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: { src: 'work', onDone: { target: 'idle' } },
          on: { CANCEL: { target: 'idle' } },
        },
        idle: {},
      },
    })
    const inside = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(machine)
        yield* until(() => started.value)
        if (outcome === 'cancel') {
          actor.send({ type: 'CANCEL' })
          yield* until(() => interrupted.value)
        }
        yield* until(() => actor.getSnapshot().matches('idle'))
        return {
          releasedAtActive: released.value,
          statusAtActive: actor.getSnapshot().status,
        }
      }),
    )
    return { ...inside, releasedAfterScope: released.value }
  })

const observedActionOverride = Effect.gen(function*() {
  class Audit extends Context.Service<
    Audit,
    { record: Effect.Effect<void> }
  >()('@systemfsoftware/xstate-effect/runtime.test/Audit') {}
  const recorded = { value: false }
  const machine = setupEffect({ actions: { audit: (_args) => Effect.void } })
    .createMachine({
      on: { GO: (args, enq) => enq(args.actions.audit, args) },
    })
    .provide({
      actions: { audit: () => Audit.use((audit) => audit.record) },
    })
  const actor = yield* Effect.provideService(createEffectActor(machine), Audit, {
    record: Effect.sync(() => {
      recorded.value = true
    }),
  })
  actor.send({ type: 'GO' })
  yield* until(() => recorded.value)
  return actor.getSnapshot().status
})

const observedInvocationRelease = (outcome: 'success' | 'failure' | 'cancel') =>
  Effect.gen(function*() {
    const started = { value: false }
    const released = { value: 0 }
    const work = fromEffect(
      Effect.gen(function*() {
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            released.value++
          }))
        started.value = true
        yield* Effect.sleep(5)
        if (outcome === 'failure') return yield* Effect.fail('failed')
        if (outcome === 'cancel') return yield* Effect.never
        return 'complete'
      }),
    )
    const machine = setup({ actors: { work } }).createMachine({
      context: { releasedAtOutcome: 0 },
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: 'work',
            onDone: {
              target: 'idle',
              context: () => ({ releasedAtOutcome: released.value }),
            },
            onError: {
              target: 'idle',
              context: () => ({ releasedAtOutcome: released.value }),
            },
          },
          on: { CANCEL: { target: 'idle' } },
        },
        idle: {},
      },
    })
    const actor = yield* createEffectActor(machine)
    yield* until(() => started.value)
    if (outcome === 'cancel') actor.send({ type: 'CANCEL' })
    yield* until(() => actor.getSnapshot().matches('idle'))
    yield* until(() => released.value === 1)
    const status = actor.getSnapshot().status
    return outcome === 'cancel'
      ? { status, released: released.value }
      : {
        status,
        released: released.value,
        releasedAtOutcome: actor.getSnapshot().context['releasedAtOutcome'],
      }
  })

const observedAsyncFinalizer = Effect.gen(function*() {
  const started = { value: false }
  const released = { value: false }
  yield* Effect.scoped(
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sleep(10).pipe(
            Effect.andThen(
              Effect.sync(() => {
                released.value = true
              }),
            ),
          )
        )
        started.value = true
        return yield* Effect.never
      }).pipe(
        (effect) => fromEffect(effect),
        (logic) => createEffectActor(logic),
      )
      yield* until(() => started.value)
    }),
  )
  return { released: released.value }
})

const observedScopeCloseInterrupt = Effect.gen(function*() {
  const started = { value: false }
  const interrupted = { value: false }
  const logic = fromEffect(
    Effect.ensuring(
      Effect.sync(() => {
        started.value = true
      }).pipe(Effect.andThen(Effect.never)),
      Effect.sync(() => {
        interrupted.value = true
      }),
    ),
  )
  const whileOpen = yield* Effect.scoped(
    Effect.gen(function*() {
      const actor = yield* createEffectActor(logic)
      yield* until(() => started.value)

      return {
        actor,
        status: actor.getSnapshot().status,
        interrupted: interrupted.value,
      }
    }),
  )

  return {
    statusWhileOpen: whileOpen.status,
    interruptedWhileOpen: whileOpen.interrupted,
    statusAfterClose: whileOpen.actor.getSnapshot().status,
    interruptedAfterClose: interrupted.value,
  }
})

const observedStopFinalizer = Effect.gen(function*() {
  const started = { value: false }
  const released = { value: 0 }
  const logic = fromEffect(
    Effect.gen(function*() {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          released.value++
        })
      )
      started.value = true
      return yield* Effect.never
    }),
  )
  const actor = yield* createEffectActor(logic)
  yield* until(() => started.value)

  const before = released.value

  actor.stop()
  yield* until(() => released.value === 1)

  return { before, after: released.value }
})

const observedScopeCloseFinalizer = Effect.gen(function*() {
  const started = { value: false }
  const released = { value: 0 }

  const whileOpen = yield* Effect.scoped(
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released.value++
          })
        )
        started.value = true
        return yield* Effect.never
      }).pipe(
        (effect) => fromEffect(effect),
        (logic) => createEffectActor(logic),
      )
      yield* until(() => started.value)

      return released.value
    }),
  )

  return { whileOpen, afterClose: released.value }
})

const observedCompletedActionFinalizer = Effect.gen(function*() {
  const completed = { value: false }
  const released = { value: 0 }
  const machine = setupEffect({
    actions: {
      work: (_args) =>
        Effect.gen(function*() {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released.value++
            })
          )
          completed.value = true
        }),
    },
  }).createMachine({
    on: {
      WORK: (args, enq) => enq(args.actions.work, args),
    },
  })
  const actor = yield* createEffectActor(machine)

  actor.send({ type: 'WORK' })
  yield* until(() => completed.value)

  const releasedWhileActive = released.value
  const statusWhileActive = actor.getSnapshot().status

  actor.stop()
  yield* until(() => released.value === 1)

  return {
    releasedWhileActive,
    statusWhileActive,
    releasedAfterStop: released.value,
  }
})

const observedHostedFinalizerOrder = Effect.gen(function*() {
  const order: string[] = []
  const started = { value: false }

  yield* Effect.scoped(
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            order.push('finalizer')
          })
        )
        started.value = true
        return yield* Effect.never
      }).pipe(
        (effect) => fromEffect(effect),
        (logic) => createEffectActor(logic),
      )
      yield* until(() => started.value)
    }),
  )
  order.push('scope closed')

  return order
})

const observedErrorFinalizer = Effect.gen(function*() {
  const released = { value: 0 }
  const logic = fromEffect(
    Effect.gen(function*() {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          released.value++
        })
      )
      return yield* Effect.fail({ code: 'BOOM' as const }).pipe(
        Effect.delay(1),
      )
    }),
  )
  const actor = yield* createEffectActor(logic)
  actor.subscribe({ error: () => {} })
  yield* until(() => actor.getSnapshot().status === 'error')
  yield* until(() => released.value === 1)

  return released.value
})

const observedDoubleStop = Effect.gen(function*() {
  const started = { value: false }
  const released = { value: 0 }
  const stopped = { value: undefined as string | undefined }

  const resolved = yield* Effect.scoped(
    Effect.gen(function*() {
      const actor = yield* Effect.gen(function*() {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            released.value++
          })
        )
        started.value = true
        return yield* Effect.never
      }).pipe(
        (effect) => fromEffect(effect),
        (logic) => createEffectActor(logic),
      )
      yield* until(() => started.value)

      actor.stop()
      actor.stop()
      yield* until(() => released.value === 1)

      stopped.value = actor.getSnapshot().status
    }),
  )

  return { resolved, stopped: stopped.value, released: released.value }
})

const observedDelayedTransition = Effect.gen(function*() {
  const machine = createMachine({
    initial: 'green',
    states: {
      green: { after: { 1000: { target: 'yellow' } } },
      yellow: {},
    },
  })

  return yield* Effect.scoped(
    Effect.gen(function*() {
      const actor = yield* createEffectActor(machine)

      const initial = actor.getSnapshot().value

      yield* TestClock.adjust('1 second')
      const spins = { value: 0 }
      while (actor.getSnapshot().value !== 'yellow' && spins.value < 2000) {
        spins.value++
        yield* TestClock.adjust('1 millis')
      }

      return { initial, final: actor.getSnapshot().value }
    }),
  ).pipe(Effect.provide(TestClock.layer()))
})

const observedInterruptedAfterTimer = Effect.gen(function*() {
  const entered = { value: 0 }
  const machine = createMachine({
    initial: 'green',
    states: {
      green: { after: { 1000: { target: 'yellow' } } },
      yellow: {
        entry: () => {
          entered.value++
        },
      },
    },
  })

  yield* Effect.gen(function*() {
    yield* Effect.scoped(
      Effect.gen(function*() {
        yield* createEffectActor(machine)
        yield* TestClock.adjust('500 millis')
      }),
    )

    yield* TestClock.adjust('5 seconds')
  }).pipe(Effect.provide(TestClock.layer()))

  return entered.value
})

const observedSelfInterruption = Effect.gen(function*() {
  const actor = yield* Effect.interrupt.pipe(
    (effect) => fromEffect(effect),
    (logic) => createEffectActor(logic),
  )
  yield* until(() => actor.getSnapshot().status === 'error')

  const error: unknown = actor.getSnapshot().error
  return {
    isInterruptedError: error instanceof EffectInterruptedError,
    tag: tagOf(error),
  }
})

const observedTimeout = Effect.gen(function*() {
  const logic = fromEffect(Effect.timeout(Effect.never, Duration.millis(1)))
  const actor = yield* createEffectActor(logic)
  actor.subscribe({ error: () => {} })
  yield* until(() => actor.getSnapshot().status === 'error')

  const error: unknown = actor.getSnapshot().error
  return {
    tag: tagOf(error),
    isInterruptedError: error instanceof EffectInterruptedError,
  }
})

const observedDefect = Effect.gen(function*() {
  const defect = new Error('defect')
  const actor = yield* Effect.die(defect).pipe(
    (effect) => fromEffect(effect),
    (logic) => createEffectActor(logic),
  )
  yield* until(() => actor.getSnapshot().status === 'error')

  return {
    status: actor.getSnapshot().status,
    errorIsDefect: actor.getSnapshot().error === defect,
  }
})

const observedInterruptedInvoke = Effect.gen(function*() {
  const received = { value: undefined as unknown }
  const worker = fromEffect(Effect.interrupt)
  const machine = setup({ actors: { worker } }).createMachine({
    initial: 'pending',
    states: {
      pending: {
        invoke: {
          src: 'worker',
          onError: ({ event }) => {
            received.value = event.error
            return { target: 'failed' }
          },
        },
      },
      failed: {},
    },
  })

  const actor = yield* createEffectActor(machine)
  yield* until(() => actor.getSnapshot().value === 'failed')

  return received.value
})

const observedInvokeExit = Effect.gen(function*() {
  const interrupted = { value: false }
  const worker = fromEffect(
    Effect.ensuring(
      Effect.never,
      Effect.sync(() => {
        interrupted.value = true
      }),
    ),
  )
  const machine = setup({ actors: { worker } }).createMachine({
    initial: 'working',
    states: {
      working: {
        invoke: { src: 'worker', id: 'worker' },
        on: { CANCEL: { target: 'cancelled' } },
      },
      cancelled: {},
    },
  })

  const actor = yield* createEffectActor(machine)
  const child = actor.getSnapshot().children['worker']

  actor.send({ type: 'CANCEL' })
  yield* until(() => interrupted.value)

  return {
    value: actor.getSnapshot().value,
    status: actor.getSnapshot().status,
    childStatus: child?.getSnapshot().status,
    childError: child?.getSnapshot().error,
  }
})

const observedStopInterruptsAction = Effect.gen(function*() {
  const started = { value: false }
  const interrupted = { value: false }
  const machine = setupEffect({
    actions: {
      work: (_args) =>
        Effect.ensuring(
          Effect.sync(() => {
            started.value = true
          }).pipe(Effect.andThen(Effect.never)),
          Effect.sync(() => {
            interrupted.value = true
          }),
        ),
    },
  }).createMachine({
    initial: 'active',
    states: {
      active: {
        on: {
          WORK: (args, enq) => enq(args.actions.work, args),
        },
      },
    },
  })
  const actor = yield* createEffectActor(machine)

  actor.send({ type: 'WORK' })
  yield* until(() => started.value)
  actor.stop()
  yield* until(() => interrupted.value)

  return { interrupted: interrupted.value }
})

const observedNonBlockingAction = Effect.gen(function*() {
  const started = { value: false }
  const finished = { value: false }
  const machine = setupEffect({
    actions: {
      work: (_args) =>
        Effect.gen(function*() {
          started.value = true
          return yield* Effect.never
          finished.value = true
        }),
    },
  }).createMachine({
    context: { count: 0 },
    on: {
      WORK: (args, enq) => enq(args.actions.work, args),
      PING: ({ context }) => ({ context: { count: context['count'] + 1 } }),
    },
  })
  const actor = yield* createEffectActor(machine)

  actor.send({ type: 'WORK' })
  yield* until(() => started.value)
  actor.send({ type: 'PING' })
  yield* until(() => actor.getSnapshot().context['count'] === 1)

  return { context: actor.getSnapshot().context, finished: finished.value }
})

const observedProvidedEffectAction = Effect.gen(function*() {
  class Audit extends Context.Service<
    Audit,
    { record: (value: string) => void }
  >()('@systemfsoftware/xstate-effect/runtime.test/Audit') {}
  const recorded: string[] = []
  const machine = setupEffect({
    actions: {
      audit: (_args) => Audit.use((audit) => Effect.sync(() => audit.record('declared'))),
    },
  }).createMachine({
    on: {
      AUDIT: (args, enq) => enq(args.actions.audit, args),
    },
  })
  const provided = machine.provide({
    actions: {
      audit: (_args: unknown) => Audit.use((audit) => Effect.sync(() => audit.record('provided'))),
    },
  })

  const actor = yield* Effect.provideService(
    createEffectActor(provided),
    Audit,
    {
      record: (value) => recorded.push(value),
    },
  )
  actor.send({ type: 'AUDIT' })
  yield* until(() => recorded.length > 0, 50)

  return recorded
})

const observedProvidedPlainAction = Effect.gen(function*() {
  const recorded: string[] = []
  const machine = setupEffect({
    actions: {
      audit: (_args) => Effect.sync(() => recorded.push('declared')),
    },
  }).createMachine({
    on: {
      AUDIT: (args, enq) => enq(args.actions.audit, args),
    },
  })
  const provided = machine.provide({
    actions: {
      audit: () => {
        recorded.push('provided')
      },
    },
  })

  const actor = yield* createEffectActor(provided)
  actor.send({ type: 'AUDIT' })
  yield* until(() => recorded.length > 0)

  return recorded
})

const observedEmittedEvents = Effect.gen(function*() {
  const gate = yield* Deferred.make<void>()
  const logic = fromEffect(({ emit }) =>
    Effect.gen(function*() {
      yield* Deferred.await(gate)
      emit({ type: 'progress', value: 1 })
      emit({ type: 'progress', value: 2 })
      return 'done'
    })
  )

  const collected: unknown[] = []
  const listeners = { value: 0 }

  const actor = yield* createEffectActor(logic)
  const actorOn = actor.on.bind(actor)
  actor.on = ((...args: Parameters<typeof actorOn>) => {
    listeners.value++
    return actorOn(...args)
  }) as typeof actor.on

  yield* Effect.forkScoped(
    Stream.runForEach(emitted(actor), (event) =>
      Effect.sync(() => {
        collected.push(event)
      })),
  )
  yield* until(() => listeners.value > 0)
  yield* Deferred.succeed(gate, void 0)
  yield* until(() => collected.length === 2)

  return collected
})

const observedStreamFailure = Effect.gen(function*() {
  const failure = { code: 'STREAM_FAILED' as const }
  const actor = yield* Stream.fail(failure).pipe(
    (stream) => fromEffectStream(stream),
    (logic) => createEffectActor(logic),
  )
  yield* until(() => actor.getSnapshot().status === 'error')

  return actor.getSnapshot().error
})

const observedStreamInterrupt = Effect.gen(function*() {
  const interrupted = { value: false }
  const worker = fromEffectStream(
    Stream.fromEffect(
      Effect.ensuring(
        Effect.never,
        Effect.sync(() => {
          interrupted.value = true
        }),
      ),
    ),
  )
  const machine = setup({ actors: { worker } }).createMachine({
    initial: 'streaming',
    states: {
      streaming: {
        invoke: { src: 'worker' },
        on: { CANCEL: { target: 'cancelled' } },
      },
      cancelled: {},
    },
  })

  const actor = yield* createEffectActor(machine)
  actor.send({ type: 'CANCEL' })
  yield* until(() => interrupted.value)

  return actor.getSnapshot().value
})

const observedRaceLoser = Effect.gen(function*() {
  const loserReleased = { value: false }
  const logic = fromEffect(
    Effect.race(
      Effect.as(Effect.sleep('5 millis'), 'winner'),
      Effect.ensuring(
        Effect.never,
        Effect.sync(() => {
          loserReleased.value = true
        }),
      ),
    ),
  )

  const actor = yield* createEffectActor(logic)
  yield* until(() => actor.getSnapshot().status === 'done')

  return {
    output: actor.getSnapshot().output,
    error: actor.getSnapshot().error,
    loserReleased: loserReleased.value,
  }
})

const observedParentChainHost = Effect.gen(function*() {
  class Greeting extends Context.Service<
    Greeting,
    { value: string }
  >()('@systemfsoftware/xstate-effect/runtime.test/Greeting') {}
  const leaf = fromEffect(
    Greeting.use((greeting) => Effect.succeed(greeting.value)),
  )
  const child = setup({ actors: { leaf } }).createMachine({
    context: { greeting: '' },
    initial: 'pending',
    states: {
      pending: {
        invoke: {
          src: 'leaf',
          onDone: {
            target: 'done',
            context: ({ event }) => ({ greeting: event.output }),
          },
        },
      },
      done: { type: 'final' },
    },
  })
  const root = setup({ actors: { child } }).createMachine({
    initial: 'pending',
    states: {
      pending: {
        invoke: { src: 'child', id: 'child', onDone: { target: 'done' } },
      },
      done: {},
    },
  })

  const actor = yield* Effect.provideService(createEffectActor(root), Greeting, {
    value: 'from the root',
  })
  yield* until(() => actor.getSnapshot().value === 'done')

  return actor.getSnapshot().value
})

const observedSpawnedLogic = Effect.gen(function*() {
  class Greeting extends Context.Service<
    Greeting,
    { value: string }
  >()('@systemfsoftware/xstate-effect/runtime.test/Greeting') {}
  const leaf = fromEffect(
    Greeting.use((greeting) => Effect.succeed(greeting.value)),
  )
  const machine = setup({ actors: { leaf } }).createMachine({
    context: { ref: undefined as AnyActorRef | undefined },
    entry: ({ actors }, enq) => ({
      context: { ref: enq.spawn(actors.leaf) },
    }),
  })

  const actor = yield* Effect.provideService(createEffectActor(machine), Greeting, {
    value: 'spawned',
  })
  const ref = actor.getSnapshot().context['ref']!
  yield* until(() => ref.getSnapshot().status === 'done')

  return ref.getSnapshot().output
})

const observedInlineSpawnRejected = Effect.gen(function*() {
  const machine = setup({}).createMachine({
    context: { ref: undefined as AnyActorRef | undefined },
    entry: (_args, enq) => ({
      context: { ref: enq.spawn(fromEffect(Effect.succeed('inline'))) },
    }),
  })

  const actor = yield* createEffectActor(machine)
  const ref = actor.getSnapshot().context['ref']!
  yield* until(() => ref.getSnapshot().status === 'error')

  return String(ref.getSnapshot().error)
})

const observedInlineSpawnDynamicSrc = Effect.gen(function*() {
  const leaf = fromEffect(Effect.succeed('leaf'))
  const machine = setup({ actors: { leaf } }).createMachine({
    context: {
      declared: undefined as AnyActorRef | undefined,
      inline: undefined as AnyActorRef | undefined,
    },
    initial: 'working',
    states: {
      working: {
        invoke: {
          src: ({ actors }) => actors.leaf,
          id: 'dynamic',
          onDone: { target: 'done' },
        },
        entry: ({ actors }, enq) => ({
          context: {
            declared: enq.spawn(actors.leaf),
            inline: enq.spawn(fromEffect(Effect.succeed('inline'))),
          },
        }),
      },
      done: {},
    },
  })

  const actor = yield* createEffectActor(machine)
  const { declared, inline } = actor.getSnapshot().context
  yield* until(() => declared!.getSnapshot().status === 'done')
  yield* until(() => inline!.getSnapshot().status === 'error')
  yield* until(() => actor.getSnapshot().value === 'done')

  return {
    declaredOutput: declared!.getSnapshot().output,
    inlineError: String(inline!.getSnapshot().error),
    value: actor.getSnapshot().value,
  }
})

const observedActionDefectOnError = Effect.gen(function*() {
  const defect = new Error('boom')
  const received = { value: undefined as unknown }
  const machine = setupEffect({
    actions: {
      boom: (_args) => Effect.die(defect),
    },
  }).createMachine({
    initial: 'active',
    states: {
      active: {
        on: { BOOM: (args, enq) => enq(args.actions.boom, args) },
        onError: ({ event }) => {
          received.value = event.error
          return { target: 'failed' }
        },
      },
      failed: {},
    },
  })

  const actor = yield* createEffectActor(machine)
  actor.send({ type: 'BOOM' })
  yield* until(() => actor.getSnapshot().value === 'failed')

  return { receivedIsDefect: received.value === defect }
})

const observedDeadLetters = Effect.gen(function*() {
  const worker = fromEffect(Effect.never)
  const machine = setup({ actors: { worker } }).createMachine({
    initial: 'working',
    states: {
      working: {
        invoke: { src: 'worker', id: 'worker' },
        on: { CANCEL: { target: 'cancelled' } },
      },
      cancelled: {},
    },
  })
  const letters: Array<{ reason: string; type: string }> = []
  const subscribed = { value: false }

  const actor = yield* createEffectActor(machine)
  const onRejectedEvent = actor.system.onRejectedEvent
  actor.system.onRejectedEvent = (
    listener: (rejection: EventRejection) => void,
  ) => {
    subscribed.value = true
    return onRejectedEvent.call(actor.system, listener)
  }

  yield* Effect.forkScoped(
    Stream.runForEach(deadLetters(actor), (event) =>
      Effect.sync(() => {
        letters.push({
          reason: event.reason,
          type: event.event.type,
        })
      })),
  )
  yield* until(() => subscribed.value)

  const child = actor.getSnapshot().children['worker']!
  actor.send({ type: 'CANCEL' })
  yield* until(() => child.getSnapshot().status === 'stopped')

  child.send({ type: 'TO_CHILD' })
  actor.stop()
  actor.send({ type: 'TO_ROOT' })

  yield* until(() => letters.length === 2)

  return letters
})

const observedRejectionStream = Effect.gen(function*() {
  const actor = createActor(createMachine({})).start()
  actor.stop()
  const active = { value: 0 }
  const onRejectedEvent = actor.system.onRejectedEvent
  actor.system.onRejectedEvent = (
    listener: (rejection: EventRejection) => void,
  ) => {
    active.value++
    const subscription = onRejectedEvent.call(actor.system, listener)
    return {
      unsubscribe: () => {
        active.value--
        subscription.unsubscribe()
      },
    }
  }

  const fiber = yield* Effect.forkScoped(
    Stream.runCollect(Stream.take(deadLetters(actor), 1)),
  )
  yield* until(() => active.value === 1)
  actor.send({ type: 'FIRST' })
  const collected = yield* Fiber.join(fiber)
  const letters: EventRejection[] = Array.from(collected)

  return { count: letters.length, first: letters[0], active: active.value, actor }
})

const observedConfigWithoutSchemas = Effect.gen(function*() {
  const logic = fromEffect({
    id: 'loadUser',
    effect: ({ input }: { input: { id: string } }) => Effect.succeed({ greeting: `Hello ${input.id}` }),
  })

  const id = logic.id

  const actor = yield* createEffectActor(logic, { input: { id: '42' } })
  yield* until(() => actor.getSnapshot().status === 'done')

  return { id, output: actor.getSnapshot().output }
})

const observedSpans = Effect.gen(function*() {
  const spans: Array<{ name: string; attributes: Record<string, unknown> }> = []
  const record = Effect.gen(function*() {
    const span = yield* Effect.currentSpan
    spans.push({
      name: span.name,
      attributes: Object.fromEntries(span.attributes),
    })
  })
  const worker = fromEffect(Effect.as(record, 'ok'))
  const machine = setupEffect({
    actors: { worker },
    actions: { audit: (_args) => record },
  }).createMachine({
    initial: 'pending',
    on: { AUDIT: (args, enq) => enq(args.actions.audit, args) },
    states: {
      pending: {
        invoke: { src: 'worker', id: 'worker', onDone: { target: 'done' } },
      },
      done: {},
    },
  })

  const actor = yield* createEffectActor(machine)
  yield* until(() => actor.getSnapshot().value === 'done')
  actor.send({ type: 'AUDIT' })
  yield* until(() => spans.length === 2)

  return {
    first: spans[0],
    second: spans[1],
    workerAddress: `${actor.address}/worker`,
    actorId: actor.id,
    actorAddress: actor.address,
  }
})

describe('@xstate/effect runtime', (it) => {
  it.live('finishes task cleanup before releasing resources in the owning actor scope', function*({ expect }) {
    const order = yield* observedTaskCleanup
    yield* expect(order).toEqual(['task resource', 'actor resource'])
  })

  it.live.each(['snapshot', 'event'] as const)(
    'releases %s stream resources when the invoking state exits',
    function*(kind, { expect }) {
      const observed = yield* observedStreamResources(kind)
      yield* expect(observed).toEqual({ value: 'idle', status: 'active' })
    },
  )

  it.live.each(['success', 'cancel'] as const)(
    'keeps explicitly actor-scoped resources after invocation %s',
    function*(outcome, { expect }) {
      const observed = yield* observedActorScopedResources(outcome)
      yield* expect(observed).toEqual({
        releasedAtActive: 0,
        statusAtActive: 'active',
        releasedAfterScope: 1,
      })
    },
  )

  it.live('runs an action override with a newly required service', function*({ expect }) {
    const status = yield* observedActionOverride
    yield* expect(status).toEqual('active')
  })

  it.live.each(['success', 'failure', 'cancel'] as const)(
    'releases invocation resources on %s while the parent stays active',
    function*(outcome, { expect }) {
      const observed = yield* observedInvocationRelease(outcome)
      yield* expect(observed).toEqual(
        outcome === 'cancel'
          ? { status: 'active', released: 1 }
          : { status: 'active', released: 1, releasedAtOutcome: 1 },
      )
    },
  )

  it.live('awaits asynchronous invocation finalizers before the enclosing scope closes', function*({ expect }) {
    const observed = yield* observedAsyncFinalizer
    yield* expect(observed).toEqual({ released: true })
  })

  it.live('stops the actor and interrupts its Effect when the enclosing scope closes', function*({ expect }) {
    const observed = yield* observedScopeCloseInterrupt
    yield* expect(observed).toEqual({
      statusWhileOpen: 'active',
      interruptedWhileOpen: false,
      statusAfterClose: 'stopped',
      interruptedAfterClose: true,
    })
  })

  it.live('releases actor-scoped finalizers when the actor is stopped', function*({ expect }) {
    const observed = yield* observedStopFinalizer
    yield* expect(observed).toEqual({ before: 0, after: 1 })
  })

  it.live('releases actor-scoped finalizers when the enclosing scope closes', function*({ expect }) {
    const observed = yield* observedScopeCloseFinalizer
    yield* expect(observed).toEqual({ whileOpen: 0, afterClose: 1 })
  })

  it.live('keeps actor-scoped finalizers open after the Effect itself completes', function*({ expect }) {
    const observed = yield* observedCompletedActionFinalizer
    yield* expect(observed).toEqual({
      releasedWhileActive: 0,
      statusWhileActive: 'active',
      releasedAfterStop: 1,
    })
  })

  it.live('runs a hosted finalizer before Effect.scoped resolves', function*({ expect }) {
    const order = yield* observedHostedFinalizerOrder
    yield* expect(order).toEqual(['finalizer', 'scope closed'])
  })

  it.live('runs a hosted finalizer when the actor errors', function*({ expect }) {
    const released = yield* observedErrorFinalizer
    yield* expect(released).toEqual(1)
  })

  it.live('tolerates stopping an actor before its scope closes', function*({ expect }) {
    const observed = yield* observedDoubleStop
    yield* expect(observed).toEqual({
      resolved: undefined,
      stopped: 'stopped',
      released: 1,
    })
  })

  it.live('drives delayed transitions with the Effect clock', function*({ expect }) {
    const observed = yield* observedDelayedTransition
    yield* expect(observed).toEqual({ initial: 'green', final: 'yellow' })
  })

  it.live('interrupts a pending after timer when the enclosing scope closes', function*({ expect }) {
    const entered = yield* observedInterruptedAfterTimer
    yield* expect(entered).toEqual(0)
  })

  it.live('reports self-interruption as an EffectInterruptedError', function*({ expect }) {
    const observed = yield* observedSelfInterruption
    yield* expect(observed).toEqual({
      isInterruptedError: true,
      tag: 'EffectInterruptedError',
    })
  })

  it.live('reports an Effect.timeout as a TimeoutError failure', function*({ expect }) {
    const observed = yield* observedTimeout
    yield* expect(observed).toEqual({
      tag: 'TimeoutError',
      isInterruptedError: false,
    })
  })

  it.live('reports a defect from Effect.die as the actor error', function*({ expect }) {
    const observed = yield* observedDefect
    yield* expect(observed).toEqual({ status: 'error', errorIsDefect: true })
  })

  it.live('routes an interrupted invoked Effect to onError', function*({ expect }) {
    const received = yield* observedInterruptedInvoke
    yield* expect(received).toSatisfy(
      (error) => error instanceof EffectInterruptedError,
      'an EffectInterruptedError',
    )
  })

  it.live('does not report interruption when the invoking state exits', function*({ expect }) {
    const observed = yield* observedInvokeExit
    yield* expect(observed).toEqual({
      value: 'cancelled',
      status: 'active',
      childStatus: 'stopped',
      childError: undefined,
    })
  })

  it.live('interrupts a running Effect action when its actor is stopped', function*({ expect }) {
    const observed = yield* observedStopInterruptsAction
    yield* expect(observed).toEqual({ interrupted: true })
  })

  it.live('does not block the actor while an Effect action runs', function*({ expect }) {
    const observed = yield* observedNonBlockingAction
    yield* expect(observed).toEqual({ context: { count: 1 }, finished: false })
  })

  it.live('runs an Effect action provided through machine.provide in the host context', function*({ expect }) {
    const recorded = yield* observedProvidedEffectAction
    yield* expect(recorded).toEqual(['provided'])
  })

  it.live('runs a plain action provided through machine.provide', function*({ expect }) {
    const recorded = yield* observedProvidedPlainAction
    yield* expect(recorded).toEqual(['provided'])
  })

  it.live('observes events emitted from the fromEffect source args', function*({ expect }) {
    const collected = yield* observedEmittedEvents
    yield* expect(collected).toEqual([
      { type: 'progress', value: 1 },
      { type: 'progress', value: 2 },
    ])
  })

  it.live('reports a failing Effect stream as an actor error', function*({ expect }) {
    const error = yield* observedStreamFailure
    yield* expect(error).toEqual({ code: 'STREAM_FAILED' })
  })

  it.live('interrupts an Effect stream when the invoking state exits', function*({ expect }) {
    const value = yield* observedStreamInterrupt
    yield* expect(value).toEqual('cancelled')
  })

  it.live('does not report interruption of an Effect that loses an internal race', function*({ expect }) {
    const observed = yield* observedRaceLoser
    yield* expect(observed).toEqual({
      output: 'winner',
      error: undefined,
      loserReleased: true,
    })
  })

  it.live('resolves the Effect host through the parent chain', function*({ expect }) {
    const value = yield* observedParentChainHost
    yield* expect(value).toEqual('done')
  })

  it.live('runs spawned Effect logic in the host Effect context', function*({ expect }) {
    const output = yield* observedSpawnedLogic
    yield* expect(output).toEqual('spawned')
  })

  it.live('rejects inline Effect logic passed to enq.spawn', function*({ expect }) {
    const error = yield* observedInlineSpawnRejected
    yield* expect(error).toMatch(/must be declared in setup\(\{ actors \}\)/)
  })

  it.live('rejects inline spawned logic even when another invoke has a dynamic src', function*({ expect }) {
    const observed = yield* observedInlineSpawnDynamicSrc
    yield* expect({
      declaredOutput: observed.declaredOutput,
      inlineError: observed.inlineError,
      value: observed.value,
    }).toEqual({
      declaredOutput: 'leaf',
      inlineError: expect.stringMatching(
        /must be declared in setup\(\{ actors \}\)/,
      ),
      value: 'done',
    })
  })

  it.live('routes a defect in an Effect action to onError', function*({ expect }) {
    const observed = yield* observedActionDefectOnError
    yield* expect(observed).toEqual({ receivedIsDefect: true })
  })

  it.live('reports a send to a stopped actor as a dead letter', function*({ expect }) {
    const letters = yield* observedDeadLetters
    yield* expect(letters).toEqual([
      { reason: 'stopped', type: 'TO_CHILD' },
      { reason: 'stopped', type: 'TO_ROOT' },
    ])
  })

  it.live('streams EventRejection objects and unsubscribes when the stream ends', function*({ expect }) {
    const observed = yield* observedRejectionStream
    yield* expect({
      count: observed.count,
      first: observed.first,
      active: observed.active,
    }).toMatchObject({
      count: 1,
      first: {
        event: { type: 'FIRST' },
        targetRef: observed.actor,
        reason: 'stopped',
      },
      active: 0,
    })
  })

  it.live('accepts a fromEffect config without schemas', function*({ expect }) {
    const observed = yield* observedConfigWithoutSchemas
    observed.output satisfies { greeting: string } | undefined
    yield* expect(observed).toEqual({
      id: 'loadUser',
      output: { greeting: 'Hello 42' },
    })
  })

  it.live('runs hosted Effects inside spans named after their source', function*({ expect }) {
    const observed = yield* observedSpans
    yield* expect({
      first: observed.first,
      second: observed.second,
    }).toEqual({
      first: {
        name: 'fromEffect',
        attributes: {
          'xstate.actor.id': 'worker',
          'xstate.actor.address': observed.workerAddress,
        },
      },
      second: {
        name: 'action.audit',
        attributes: {
          'xstate.actor.id': observed.actorId,
          'xstate.actor.address': observed.actorAddress,
        },
      },
    })
  })
})
