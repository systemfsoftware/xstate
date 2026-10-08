import { describe, expectTypeOf, it } from '@systemfsoftware/vitest'
import {
  type AnyActorLogic,
  createMachine,
  createObservableLogic,
  setup,
  type Snapshot,
  types,
} from '@systemfsoftware/xstate'
import { getShortestPaths } from '@systemfsoftware/xstate/graph'
import { Clock, Duration, Effect, Exit, Layer, Ref, Scope, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import fc from 'fast-check'
import { untilOnLiveClock } from '../tests/__fixtures__/untilCondition.js'
import { createEffectActor, type EffectActor, fromEffect, fromEffectStream, join, waitFor } from './index.js'

const roundTrip = (snapshot: Snapshot<unknown>): Snapshot<unknown> => JSON.parse(JSON.stringify(snapshot))

type Recording = {
  pending: number
  requested: number[]
}

const recordingClock = () => {
  const state: Recording = { pending: 0, requested: [] }
  const layer = Layer.effect(
    Clock.Clock,
    Effect.map(TestClock.make(), (clock) => ({
      ...clock,
      sleep: (duration: Duration.Duration) =>
        Effect.suspend(() => {
          state.pending++
          state.requested.push(Duration.toMillis(duration))
          return clock.sleep(duration)
        }).pipe(Effect.ensuring(Effect.sync(() => state.pending--))),
    })),
  )
  return { state, layer }
}

type Command = 'NEXT' | 'BACK' | 'FETCH' | 'PING' | 'TICK'

const record = <T extends string>(target: T) => ({
  target,
  context: ({
    context,
    event,
  }: {
    context: Context
    event: { type: string }
  }) => ({ ...context, trail: context.trail + event.type[0] }),
})

type Context = {
  trail: string
  sent: number
  counted: number
  syncs: number
  report: string
}

type Comparison = {
  readonly observed: unknown
  readonly entries: number
  readonly expired: number
  readonly ready: number
  readonly fetches: number
  readonly expectedObserved: unknown
  readonly expectedExpired: number
  readonly expectedReady: number
  readonly expectedFetches: number
}

const restoredValues = (comparisons: readonly Comparison[]) =>
  comparisons.map((comparison) => ({
    observed: comparison.observed,
    entries: comparison.entries,
    expired: comparison.expired,
    ready: comparison.ready,
    fetches: comparison.fetches,
  }))

const expectedValues = (comparisons: readonly Comparison[]) =>
  comparisons.map((comparison) => ({
    observed: comparison.expectedObserved,
    entries: 1,
    expired: comparison.expectedExpired,
    ready: comparison.expectedReady,
    fetches: comparison.expectedFetches,
  }))

const makeWorld = () =>
  Effect.gen(function*() {
    const tally = { entries: 0, expired: 0, ready: 0, fetches: 0 }
    const syncs = yield* Ref.make(0)

    const counter = createMachine({
      context: { count: 0 },
      on: {
        inc: ({ context, parent }, enq) => {
          const count = context.count + 1
          const counted = { type: 'counted', count }
          enq.sendTo(parent!, counted)
          return { context: { count } }
        },
      },
    })

    const fetchReport = fromEffect(
      Effect.gen(function*() {
        tally.fetches++
        yield* Effect.sleep('1 second')
        return 'report'
      }),
    )

    const model = createMachine({
      id: 'model',
      actors: { counter, fetchReport },
      schemas: {
        events: {
          NEXT: types<{}>(),
          BACK: types<{}>(),
          FETCH: types<{}>(),
          PING: types<{}>(),
          SYNC: types<{}>(),
          counted: types<{ count: number }>(),
        },
      },
      context: {
        trail: '',
        sent: 0,
        counted: 0,
        syncs: 0,
        report: '',
      } as Context,
      entry: () => {
        tally.entries++
      },
      invoke: { src: 'counter', id: 'counter' },
      on: {
        PING: ({ context, children }, enq) => {
          if (context.sent >= 2) {
            return
          }
          enq.sendTo(children['counter']!, { type: 'inc' })
          return {
            context: {
              ...context,
              trail: context.trail + 'P',
              sent: context.sent + 1,
            },
          }
        },
        counted: ({ context, event }) => ({
          context: { ...context, counted: event.count },
        }),
        SYNC: ({ context }) => ({
          context: { ...context, syncs: context.syncs + 1 },
        }),
      },
      type: 'parallel',
      states: {
        flow: {
          initial: 'idle',
          states: {
            idle: { on: { NEXT: record('working') } },
            working: {
              initial: 'one',
              on: { BACK: record('idle') },
              states: { one: { on: { NEXT: record('two') } }, two: {} },
            },
          },
        },
        report: {
          initial: 'waiting',
          states: {
            waiting: { on: { FETCH: record('fetching') } },
            fetching: {
              invoke: {
                src: 'fetchReport',
                onDone: {
                  target: 'ready',
                  context: ({ context, event }) => ({
                    ...context,
                    report: event.output,
                  }),
                },
              },
            },
            ready: {
              entry: () => {
                tally.ready++
              },
            },
          },
        },
        timer: {
          initial: 'armed',
          states: {
            armed: { after: { 2000: { target: 'expired' } } },
            expired: {
              entry: () => {
                tally.expired++
              },
            },
          },
        },
      },
    })

    type ModelActor = EffectActor<typeof model>

    const settle = (actor: ModelActor, clock: Recording) =>
      untilOnLiveClock(() => {
        const snapshot = actor.getSnapshot()
        const sleeping = Number(snapshot.matches({ timer: 'armed' })) +
          Number(snapshot.matches({ report: 'fetching' }))
        return (
          snapshot.context.syncs === Ref.getUnsafe(syncs) &&
          snapshot.context.counted === snapshot.context.sent &&
          clock.pending === sleeping
        )
      })

    const run = (actor: ModelActor, clock: Recording, command: Command) =>
      Effect.gen(function*() {
        if (command === 'TICK') {
          yield* TestClock.adjust('1 second')
        } else {
          actor.send({ type: command })
        }
        yield* Ref.update(syncs, (n) => n + 1)
        actor.send({ type: 'SYNC' })
        yield* settle(actor, clock)
      })

    const observe = (actor: ModelActor) => {
      const snapshot = actor.getSnapshot()
      return {
        value: snapshot.value,
        context: snapshot.context,
        child: snapshot.children['counter']?.getSnapshot().context,
      }
    }

    const execute = (commands: readonly Command[], k?: number) => {
      const clock = recordingClock()
      return Effect.gen(function*() {
        Object.assign(tally, { entries: 0, expired: 0, ready: 0, fetches: 0 })
        yield* Ref.set(syncs, 0)
        const first = commands.slice(0, k ?? commands.length)
        const [persisted, fetchingAtPersist] = yield* Effect.scoped(
          Effect.gen(function*() {
            const actor = yield* createEffectActor(model)
            yield* settle(actor, clock.state)
            for (const command of first) {
              yield* run(actor, clock.state, command)
            }
            return [
              k === undefined
                ? observe(actor)
                : roundTrip(actor.getPersistedSnapshot()),
              actor.getSnapshot().matches({ report: 'fetching' }),
            ] as const
          }),
        )
        if (k === undefined) {
          return { observed: persisted, tally: { ...tally }, fetchingAtPersist }
        }
        const observed = yield* Effect.scoped(
          Effect.gen(function*() {
            const actor = yield* createEffectActor(model, {
              snapshot: persisted as Snapshot<unknown>,
            })
            yield* settle(actor, clock.state)
            for (const command of commands.slice(k)) {
              yield* run(actor, clock.state, command)
            }
            return observe(actor)
          }),
        )
        return { observed, tally: { ...tally }, fetchingAtPersist }
      }).pipe(Effect.provide(clock.layer))
    }

    const compareUninterrupted = (commands: readonly Command[], k: number) =>
      Effect.gen(function*() {
        const expected = yield* execute(commands)
        const restored = yield* execute(commands, k)
        return {
          observed: restored.observed,
          entries: restored.tally.entries,
          expired: restored.tally.expired,
          ready: restored.tally.ready,
          fetches: restored.tally.fetches - Number(restored.fetchingAtPersist),
          expectedObserved: expected.observed,
          expectedExpired: expected.tally.expired,
          expectedReady: expected.tally.ready,
          expectedFetches: expected.tally.fetches,
        }
      })

    return { model, tally, execute, compareUninterrupted }
  })

describe('createEffectActor with a persisted snapshot', (it) => {
  it('resubscribes a restored root observable and receives values and completion', function*({ expect }) {
    const subscriptions = yield* Ref.make(0)
    const logic = createObservableLogic<number, undefined>(() => ({
      subscribe(observer) {
        Effect.runSync(Ref.update(subscriptions, (n) => n + 1))
        const count = Ref.getUnsafe(subscriptions)
        if (typeof observer === 'function') {
          observer(count)
        } else {
          observer.next?.(count)
          if (count === 2) {
            observer.complete?.()
          }
        }
        return { unsubscribe() {} }
      },
    }))
    const snapshot = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic)
        yield* waitFor(actor, (s) => s.context === 1)
        return roundTrip(actor.getPersistedSnapshot())
      }),
    )
    const restored = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(logic, { snapshot })
        yield* waitFor(actor, (s) => s.status === 'done')
        return { context: actor.getSnapshot().context, status: actor.getSnapshot().status }
      }),
    )

    yield* expect({ ...restored, subscriptions: yield* Ref.get(subscriptions) }).toEqual({
      context: 2,
      status: 'done',
      subscriptions: 2,
    })
  })

  it('restores a nested machine timer on the Effect clock with its remaining delay', function*({ expect }) {
    const child = createMachine({
      initial: 'waiting',
      states: {
        waiting: { after: { 1000: { target: 'done' } } },
        done: { type: 'final' },
      },
    })
    const parent = createMachine({
      actors: { child },
      invoke: { src: 'child', id: 'child' },
    })
    const clock = recordingClock()

    const observed = yield* Effect.gen(function*() {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(parent)
          yield* untilOnLiveClock(() => clock.state.pending === 1)
          yield* TestClock.adjust('600 millis')
          return roundTrip(actor.getPersistedSnapshot())
        }),
      )
      return yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(parent, { snapshot })
          yield* untilOnLiveClock(() => clock.state.pending === 1)
          const requested = [...clock.state.requested]
          const childStatus = actor.getSnapshot().children['child']?.getSnapshot().status
          yield* TestClock.adjust('400 millis')
          yield* untilOnLiveClock(
            () =>
              actor.getSnapshot().children['child']?.getSnapshot().status ===
                'done',
          )
          return { requested, childStatus }
        }),
      )
    }).pipe(Effect.provide(clock.layer))

    yield* expect(observed).toEqual({ requested: [1000, 400], childStatus: 'active' })
  })

  const restoreComparisonTimeoutWithHeadroomMs = 15_000

  it('matches an uninterrupted run when restored at every step of every shortest path', function*({ expect }) {
    const world = yield* makeWorld()
    const paths = getShortestPaths(world.model, {
      events: [
        { type: 'NEXT' },
        { type: 'BACK' },
        { type: 'FETCH' },
        { type: 'PING' },
      ],
      serializeState: (snapshot) => JSON.stringify([snapshot.value, snapshot.context.sent]),
    })

    yield* expect(paths.length).toBeGreaterThan(10)

    const comparisons: Comparison[] = []
    for (const path of paths) {
      const commands = path.steps
        .slice(1)
        .map((step) => step.event.type as Command)
      for (let k = 0; k <= commands.length; k++) {
        comparisons.push(yield* world.compareUninterrupted(commands, k))
      }
    }

    yield* expect(restoredValues(comparisons)).toEqual(expectedValues(comparisons))
  }, restoreComparisonTimeoutWithHeadroomMs)

  it('matches an uninterrupted run for generated events, clock advances and persist points', function*({ expect }) {
    const world = yield* makeWorld()
    const samples = fc.sample(
      fc.tuple(
        fc.array(
          fc.constantFrom<Command>('NEXT', 'BACK', 'FETCH', 'PING', 'TICK'),
          {
            maxLength: 8,
          },
        ),
        fc.nat(),
      ),
      { seed: 5773, numRuns: 40 },
    )
    const comparisons: Comparison[] = []
    for (const [commands, point] of samples) {
      comparisons.push(
        yield* world.compareUninterrupted(
          commands,
          point % (commands.length + 1),
        ),
      )
    }

    yield* expect(restoredValues(comparisons)).toEqual(expectedValues(comparisons))
  }, restoreComparisonTimeoutWithHeadroomMs)

  it('resumes a pending delayed transition with its remaining delay', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: { green: { after: { 1000: { target: 'yellow' } } }, yellow: {} },
    })
    const clock = recordingClock()

    const requested = yield* Effect.gen(function*() {
      const persisted = yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(machine)
          yield* untilOnLiveClock(() => clock.state.pending === 1)
          yield* TestClock.adjust('600 millis')
          return roundTrip(actor.getPersistedSnapshot())
        }),
      )
      return yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(machine, {
            snapshot: persisted,
          })
          yield* untilOnLiveClock(() => clock.state.pending === 1)
          const requested = [...clock.state.requested]
          yield* TestClock.adjust('400 millis')
          yield* waitFor(actor, (s) => s.matches('yellow'))
          return requested
        }),
      )
    }).pipe(Effect.provide(clock.layer))

    yield* expect(requested).toEqual([1000, 400])
  })

  it('fires a delayed transition whose deadline passed while persisted', function*({ expect }) {
    const machine = createMachine({
      initial: 'green',
      states: { green: { after: { 1000: { target: 'yellow' } } }, yellow: {} },
    })
    const clock = recordingClock()

    const settled = yield* Effect.gen(function*() {
      const persisted = yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(machine)
          yield* untilOnLiveClock(() => clock.state.pending === 1)
          return roundTrip(actor.getPersistedSnapshot())
        }),
      )
      yield* TestClock.adjust('1 hour')
      return yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(machine, {
            snapshot: persisted,
          })
          return yield* waitFor(actor, (s) => s.matches('yellow'))
        }),
      )
    }).pipe(Effect.provide(clock.layer))

    yield* expect(settled.value).toEqual('yellow')
  })

  it('stops a restored actor, its children and its timers when the scope closes', function*({ expect }) {
    const clock = recordingClock()
    const world = yield* makeWorld()
    world.tally.expired = 0
    const persisted = yield* Effect.scoped(
      Effect.gen(function*() {
        const actor = yield* createEffectActor(world.model)
        actor.send({ type: 'FETCH' })
        yield* untilOnLiveClock(() => clock.state.pending === 2)
        return roundTrip(actor.getPersistedSnapshot())
      }),
    ).pipe(Effect.provide(clock.layer))

    const outcome = yield* Effect.gen(function*() {
      const scope = yield* Scope.make()
      const actor = yield* Scope.provide(
        createEffectActor(world.model, { snapshot: persisted }),
        scope,
      )
      yield* untilOnLiveClock(() => clock.state.pending === 2)
      yield* Scope.close(scope, Exit.void)

      const status = actor.getSnapshot().status
      const pending = clock.state.pending
      yield* TestClock.adjust('1 hour')
      return { status, pending, expired: world.tally.expired }
    }).pipe(Effect.provide(clock.layer))

    yield* expect(outcome).toEqual({ status: 'stopped', pending: 0, expired: 0 })
  })

  it('settles a restored final snapshot without running anything', function*({ expect }) {
    const entered = yield* Ref.make(0)
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: { on: { FINISH: { target: 'done' } } },
        done: {
          type: 'final',
          entry: () => {
            Effect.runSync(Ref.update(entered, (n) => n + 1))
          },
        },
      },
      output: () => 'finished',
    })

    const result = yield* Effect.gen(function*() {
      const persisted = yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(machine)
          actor.send({ type: 'FINISH' })
          yield* waitFor(actor, (s) => s.status === 'done')
          return roundTrip(actor.getPersistedSnapshot())
        }),
      )
      const output = yield* Effect.scoped(
        Effect.gen(function*() {
          const actor = yield* createEffectActor(machine, {
            snapshot: persisted,
          })
          const settled = yield* waitFor(actor, (s) => s.status === 'done')
          return settled.output
        }),
      )
      return { output, entered: Ref.getUnsafe(entered) }
    })

    yield* expect(result).toEqual({ output: 'finished', entered: 1 })
  })

  describe('Effect tasks and streams that were running when persisted', (it) => {
    const persistWhile = (logic: AnyActorLogic, started: () => boolean) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const actor = yield* createEffectActor(logic)
            yield* untilOnLiveClock(started)
            return roundTrip(actor.getPersistedSnapshot())
          }),
        ),
      )

    it('restarts a root fromEffect task', function*({ expect }) {
      const attempts = yield* Ref.make(0)
      const task = fromEffect(
        Effect.suspend(() => {
          Effect.runSync(Ref.update(attempts, (n) => n + 1))
          return Ref.getUnsafe(attempts) === 1 ? Effect.never : Effect.succeed('done')
        }),
      )
      const snapshot = yield* Effect.promise(() => persistWhile(task, () => Ref.getUnsafe(attempts) === 1))
      const output = yield* Effect.scoped(
        Effect.flatMap(createEffectActor(task, { snapshot }), join),
      )

      yield* expect({ output, attempts: Ref.getUnsafe(attempts) }).toEqual({ output: 'done', attempts: 2 })
    })

    it('restarts root and child streams from their first item', function*({ expect }) {
      const seen: number[] = []
      const runs = yield* Ref.make(0)
      const ticks = fromEffectStream(() => {
        Effect.runSync(Ref.update(runs, (n) => n + 1))
        const items = Stream.fromIterable([1, 2, 3]).pipe(
          Stream.tap((n) => Effect.sync(() => seen.push(n))),
        )
        return Ref.getUnsafe(runs) === 1
          ? Stream.concat(Stream.take(items, 2), Stream.never)
          : items
      })
      const parent = setup({ actors: { ticks } }).createMachine({
        initial: 'listening',
        states: {
          listening: { invoke: { src: 'ticks', onDone: { target: 'done' } } },
          done: { type: 'final' },
        },
      })

      const results: Array<{ readonly runs: number; readonly seen: number[] }> = []
      for (const logic of [ticks, parent] as const) {
        seen.length = 0
        yield* Ref.set(runs, 0)
        const snapshot = yield* Effect.promise(() => persistWhile(logic, () => seen.length === 2))
        yield* Effect.scoped(
          Effect.gen(function*() {
            const actor = yield* createEffectActor(logic as typeof parent, {
              snapshot,
            })
            yield* waitFor(actor, (s) => s.status === 'done')
          }),
        )
        results.push({ runs: Ref.getUnsafe(runs), seen: [...seen] })
      }

      yield* expect(results).toEqual([
        { runs: 2, seen: [1, 2, 1, 2, 3] },
        { runs: 2, seen: [1, 2, 1, 2, 3] },
      ])
    })
  })

  it('restores without input when the logic requires input', function*({ expect }) {
    const machine = createMachine({
      schemas: { input: types<{ id: string }>() },
      context: ({ input }) => ({ id: input.id }),
    })
    const snapshot = {} as Snapshot<unknown>

    expectTypeOf(createEffectActor(machine, { snapshot })).not.toBeNever()
    expectTypeOf(
      createEffectActor(machine, { input: { id: 'a' } }),
    ).not.toBeNever()
    // @ts-expect-error -- a fresh actor still needs its input
    const withoutInput = createEffectActor(machine, {})
    // @ts-expect-error -- and so does one with no options at all
    const withoutOptions = createEffectActor(machine)
    void withoutInput
    void withoutOptions

    yield* expect(machine.id).toEqual('(machine)')
  })
})
