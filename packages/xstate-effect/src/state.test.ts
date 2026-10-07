import { describe } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '@systemfsoftware/xstate'
import { Effect, Match, Schema, Stream } from 'effect'
import {
  createEffectActor,
  send,
  setupEffect,
  snapshots,
  type TaggedState,
  taggedState,
  type TaggedStateFrom,
} from './index.js'

const machine = setupEffect({
  schemas: {
    context: Schema.Struct({ id: Schema.String }),
    events: {
      START: Schema.Struct({}),
      DONE: Schema.Struct({}),
      FAIL: Schema.Struct({}),
    },
  },
  states: {
    idle: {},
    loading: {
      schemas: {
        context: Schema.Struct({ startedAt: Schema.Finite }),
      },
    },
    done: {
      states: {
        success: {},
        failure: {},
      },
    },
    failed: {},
  },
}).createMachine({
  context: { id: 'a' },
  initial: 'idle',
  states: {
    idle: {
      on: {
        START: ({ context }) => ({
          target: 'loading',
          context: { ...context, startedAt: 1 },
        }),
      },
    },
    loading: {
      on: { DONE: { target: 'done' }, FAIL: { target: 'failed' } },
    },
    done: {
      initial: 'success',
      states: {
        success: {},
        failure: {},
      },
    },
    failed: {},
  },
})

const parallelMachine = createMachine({
  type: 'parallel',
  states: {
    a: { initial: 'a1', states: { a1: {}, a2: {} } },
    b: { initial: 'b1', states: { b1: {} } },
  },
})

const describeState = Match.type<TaggedState<typeof machine>>().pipe(
  Match.tag('idle', () => 'idle'),
  Match.tag('loading', ({ context }) => `loading since ${context.startedAt}`),
  Match.tag('done.success', 'done.failure', 'failed', ({ _tag }) => _tag),
  Match.exhaustive,
)

describe('taggedState', (it) => {
  it('tags the state path and keeps the per-state context', function*({ expect }) {
    const actor = createActor(machine).start()
    const idle = taggedState(actor.getSnapshot())

    actor.send({ type: 'START' })
    const loading = taggedState(actor.getSnapshot())

    actor.send({ type: 'DONE' })
    const done = taggedState(actor.getSnapshot())
    yield* expect({
      idle: { _tag: idle._tag, value: idle.value },
      loading: { _tag: loading._tag, context: loading.context },
      done: {
        _tag: done._tag,
        value: done.value,
        sameSnapshot: done.snapshot === actor.getSnapshot(),
      },
    }).toEqual({
      idle: { _tag: 'idle', value: 'idle' },
      loading: { _tag: 'loading', context: { id: 'a', startedAt: 1 } },
      done: {
        _tag: 'done.success',
        value: { done: 'success' },
        sameSnapshot: true,
      },
    })
  })

  it('stops at a parallel state', function*({ expect }) {
    const actor = createActor(parallelMachine).start()
    const tagged = taggedState(actor.getSnapshot())
    yield* expect({ _tag: tagged._tag, value: tagged.value }).toEqual({
      _tag: '(machine)',
      value: { a: 'a1', b: 'b1' },
    })
  })

  it('matches exhaustively over snapshots of an Effect actor', function*({ expect }) {
    const program = Effect.gen(function*() {
      const actor = yield* createEffectActor(machine)
      const seen = yield* snapshots(actor).pipe(
        Stream.map(taggedState),
        Stream.tap(({ _tag }) =>
          _tag === 'idle'
            ? send(actor, { type: 'START' })
            : _tag === 'loading'
            ? send(actor, { type: 'FAIL' })
            : Effect.void
        ),
        Stream.map(describeState),
        Stream.take(3),
        Stream.runCollect,
      )
      return [...seen]
    })

    const seen = yield* Effect.scoped(program)
    yield* expect(seen).toEqual(['idle', 'loading since 1', 'failed'])
  })

  it('types the tag union and per-state context', function*({ expect }) {
    type Tagged = TaggedState<typeof machine>
    type Tags = Tagged['_tag']
    'idle' satisfies Tags
    'loading' satisfies Tags
    'done.success' satisfies Tags
    'done.failure' satisfies Tags
    'failed' satisfies Tags
    // @ts-expect-error - not a leaf state of this machine
    'done' satisfies Tags

    const check = (tagged: Tagged) => {
      if (tagged._tag === 'loading') {
        tagged.context.startedAt satisfies number
        tagged.value satisfies 'loading'
      }
    }
    const idle = taggedState(createActor(machine).getSnapshot())
    check(idle)
    yield* expect({ _tag: idle._tag, value: idle.value }).toEqual({
      _tag: 'idle',
      value: 'idle',
    })

    type Parallel = TaggedStateFrom<
      ReturnType<typeof parallelMachine.getInitialSnapshot>
    >
    '(machine)' satisfies Parallel['_tag']
  })
})
