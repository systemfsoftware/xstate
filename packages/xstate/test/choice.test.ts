import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createActor, createAsyncLogic, createMachine } from '../src/index.js'
import { createInertActorScope } from '../src/inertActorScope.js'

describe('choice states', () => {
  it('routes through the first matching condition', function*({ expect }) {
    const machine = createMachine({
      context: {
        isVip: true,
        overBudget: true,
      },
      initial: 'routing',
      states: {
        routing: {
          type: 'choice',
          choice: ({ context }) => {
            if (context.isVip) {
              return { target: 'vipFlow' }
            }
            if (context.overBudget) {
              return { target: 'review' }
            }
            return { target: 'standardFlow' }
          },
        },
        vipFlow: {},
        review: {},
        standardFlow: {},
      },
    })

    const actor = createActor(machine).start()

    yield* expect(actor.getSnapshot().value).toBe('vipFlow')
  })

  it('routes through the fallback when no condition matches', function*({ expect }) {
    const machine = createMachine({
      context: {
        isVip: false,
        overBudget: false,
      },
      initial: 'routing',
      states: {
        routing: {
          type: 'choice',
          choice: (args) => {
            if (args.guards.isVip(args.context.isVip)) {
              return { target: 'vipFlow' }
            }
            if (args.guards.isOverBudget(args.context.overBudget)) {
              return { target: 'review' }
            }
            return { target: 'standardFlow' }
          },
        },
        vipFlow: {},
        review: {},
        standardFlow: {},
      },
      guards: {
        isVip: (isVip: boolean) => isVip,
        isOverBudget: (overBudget: boolean) => overBudget,
      },
    })

    const actor = createActor(machine).start()

    yield* expect(actor.getSnapshot().value).toBe('standardFlow')
  })

  it('routes when entered via a transition', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          isVip: z.boolean(),
          overBudget: z.boolean(),
        }),
        events: {
          ROUTE: z.object({}),
        },
      },
      context: {
        isVip: false,
        overBudget: true,
      },
      initial: 'idle',
      states: {
        idle: {
          on: {
            ROUTE: { target: 'routing' },
          },
        },
        routing: {
          type: 'choice',
          choice: ({ context }) => {
            if (context.isVip) {
              return { target: 'vipFlow' }
            }
            if (context.overBudget) {
              return { target: 'review' }
            }
            return { target: 'standardFlow' }
          },
        },
        vipFlow: {},
        review: {},
        standardFlow: {},
      },
    })

    const actor = createActor(machine).start()

    actor.trigger.ROUTE()

    yield* expect(actor.getSnapshot().value).toBe('review')
  })

  it('throws when a choice state does not declare a `choice` function', function*({ expect }) {
    yield* expect(() =>
      createMachine({
        initial: 'routing',
        states: {
          routing: {
            type: 'choice',
          },
          a: {},
        },
      } as any)
    ).toThrow(
      'Choice state "(machine).routing" must declare a `choice` function.',
    )
  })

  it('throws when a non-choice state declares `choice`', function*({ expect }) {
    yield* expect(() =>
      createMachine({
        initial: 'a',
        states: {
          a: {
            choice: () => ({ target: 'b' }),
          },
          b: {},
        },
      } as any)
    ).toThrow(
      'State "(machine).a" has `choice`, but `choice` can only be used with `type: \'choice\'`.',
    )
  })

  it('throws when a choice does not resolve to a target', function*({ expect }) {
    const machine = createMachine({
      initial: 'routing',
      states: {
        routing: {
          type: 'choice',
          choice: (() => undefined) as any,
        },
        done: {},
      },
    })

    yield* expect(() => machine.getInitialSnapshot(createInertActorScope(machine))).toThrow(
      'Choice state "(machine).routing" must resolve to a target.',
    )
  })

  it.each([
    [
      'invoke',
      { invoke: { src: createAsyncLogic({ run: () => Promise.resolve(undefined) }) } },
    ],
    ['after', { after: { 10: { target: 'done' } } }],
    ['on', { on: { NEXT: { target: 'done' } } }],
    ['entry', { entry: () => undefined }],
    ['exit', { exit: () => undefined }],
  ])('throws when a choice state declares `%s`', function*([key, config], { expect }) {
    yield* expect(() =>
      createMachine({
        initial: 'routing',
        states: {
          routing: {
            type: 'choice',
            choice: () => ({ target: 'done' }),
            ...(config as any),
          },
          done: {},
        },
      })
    ).toThrow(`Choice state "(machine).routing" cannot declare \`${key}\`.`)
  })
})
