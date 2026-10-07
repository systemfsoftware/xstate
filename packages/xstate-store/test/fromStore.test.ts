import { describe, it } from '@systemfsoftware/vitest'
import { createActor, executeEffects, initialTransition, transition } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { z } from 'zod'
import { fromStore } from '../src/index.js'
import type { StoreEffectEnqueue } from '../src/index.js'

describe('fromStore', () => {
  it('creates an actor from store logic with input', function*({ expect }) {
    const storeLogic = fromStore({
      context: (count: number) => ({ count }),
      on: {
        inc: (ctx, ev: { by: number }) => {
          return {
            ...ctx,
            count: ctx.count + ev.by,
          }
        },
      },
    })

    const actor = createActor(storeLogic, {
      input: 42,
    })

    actor.start()

    actor.send({ type: 'inc', by: 8 })

    yield* expect(actor.getSnapshot().context.count).toEqual(50)
  })

  it('emits events', function*({ expect }) {
    const emitted: unknown[] = []

    const storeLogic = fromStore({
      context: (count: number) => ({ count }),
      schemas: {
        emitted: {
          increased: z.object({ upBy: z.number() }),
        },
      },
      on: {
        inc: (ctx, ev: { by: number }, enq) => {
          enq.emit.increased({ upBy: ev.by })
          return {
            ...ctx,
            count: ctx.count + ev.by,
          }
        },
      },
    })

    const actor = createActor(storeLogic, {
      input: 42,
    })

    actor.on('increased', (event) => {
      emitted.push(event)
    })

    actor.start()

    actor.send({ type: 'inc', by: 8 })

    yield* expect({
      count: actor.getSnapshot().context.count,
      calls: emitted,
    }).toEqual({
      count: 50,
      calls: [{ type: 'increased', upBy: 8 }],
    })
  })

  it(
    'enq.getSnapshot() in a sync effect reflects the post-transition state (matches createStore)',
    function*({ expect }) {
      let seen: number | undefined

      const storeLogic = fromStore({
        context: (_: void) => ({ count: 0 }),
        on: {
          inc: (ctx, _, enq) => {
            enq.effect(
              ({ getSnapshot }: StoreEffectEnqueue<{ count: number }>) => {
                seen = getSnapshot().context.count
              },
            )
            return { ...ctx, count: ctx.count + 1 }
          },
        },
      })

      const actor = createActor(storeLogic).start()
      actor.send({ type: 'inc' })

      yield* expect(seen).toEqual(1)
    },
  )

  it.live('enq.getSnapshot() in an async effect reflects the latest committed state', function*({ expect }) {
    let seen: number | undefined

    const storeLogic = fromStore({
      context: (_: void) => ({ count: 0 }),
      on: {
        start: (ctx, _, enq) => {
          enq.effect(
            async ({ getSnapshot }: StoreEffectEnqueue<{ count: number }>) => {
              await new Promise((resolve) => setTimeout(resolve, 5))
              seen = getSnapshot().context.count
            },
          )
          return { ...ctx, count: ctx.count + 1 }
        },
        bump: (ctx) => ({ count: ctx.count + 10 }),
      },
    })

    const actor = createActor(storeLogic).start()
    actor.send({ type: 'start' }) // count -> 1
    actor.send({ type: 'bump' }) // count -> 11 before the async effect resumes

    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))

    yield* expect(seen).toEqual(11)
  })

  it('routes effect sends through a custom transition runtime', function*({ expect }) {
    let effectCount: number | undefined
    const storeLogic = fromStore({
      context: { count: 0 },
      on: {
        inc: (context, _, enq) => {
          enq.effect(
            ({ getSnapshot, send }: StoreEffectEnqueue<{ count: number }>) => {
              effectCount = getSnapshot().context.count
              send({ type: 'dec' })
            },
          )
          return { count: context.count + 1 }
        },
        dec: (context) => ({ count: context.count - 1 }),
      },
    })
    const [initial] = initialTransition(storeLogic)
    const [, effects] = transition(storeLogic, initial, { type: 'inc' })
    const sent: string[] = []

    yield* Effect.promise(() =>
      executeEffects(effects, {
        sendEvent: (_source, _target, event) => {
          sent.push(event.type)
        },
      })
    )

    yield* expect({ sent, effectCount }).toEqual({ sent: ['dec'], effectCount: 1 })
  })

  it('routes effect triggers through a custom transition runtime', function*({ expect }) {
    const storeLogic = fromStore({
      context: { count: 0 },
      on: {
        inc: (context, _, enq) => {
          enq.effect(
            ({ trigger }: StoreEffectEnqueue<{ count: number }, { dec: {} }>) => trigger.dec(),
          )
          return { count: context.count + 1 }
        },
        dec: (context) => ({ count: context.count - 1 }),
      },
    })
    const [initial] = initialTransition(storeLogic)
    const [, effects] = transition(storeLogic, initial, { type: 'inc' })
    const sent: string[] = []

    yield* Effect.promise(() =>
      executeEffects(effects, {
        sendEvent: (_source, _target, event) => {
          sent.push(event.type)
        },
      })
    )

    yield* expect(sent).toEqual(['dec'])
  })
})
