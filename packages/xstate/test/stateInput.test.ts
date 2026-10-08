import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createActor, createAsyncLogic, setup, types } from '../src/index.js'
import type { IsAny, StateContextFromStateValue, StateFrom, StateSchemaFrom } from '../src/types.js'

const thrownMessage = (call: () => unknown): string => {
  try {
    call()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw')
}

describe('setup', () => {
  it('requires authored history states to declare a default target', function*({ expect }) {
    const s = setup({
      states: {
        off: {
          states: {
            idle: {},
            hist: {},
          },
        },
      },
    })

    if (false) {
      // @ts-expect-error - SCXML history states require a default transition
      s.createMachine({
        initial: 'off',
        states: {
          off: {
            initial: 'idle',
            states: {
              idle: {},
              hist: { type: 'history' },
            },
          },
        },
      })
    }

    yield* expect(Object.keys(s.states)).toEqual(['off'])
  })

  it('setup without schemas should infer context from machine config', function*({ expect }) {
    const machine = setup({}).createMachine({
      context: {
        count: 0,
      },
      on: {
        INC: ({ context }) => {
          context['count'] satisfies number
          return {
            context: {
              count: context['count'] + 1,
            },
          }
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().context).toEqual({ count: 0 })
  })

  it('should create a setup object with states', function*({ expect }) {
    const s = setup({
      states: {
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    yield* expect(s.states).toEqual({
      loading: {
        schemas: {
          input: expect.any(Object),
        },
      },
    })
  })

  it('should create a setup object with nested state schemas', function*({ expect }) {
    const childInput = z.object({
      childId: z.string(),
    })

    const s = setup({
      states: {
        parent: {
          schemas: {
            input: z.object({
              parentId: z.string(),
            }),
          },
          states: {
            child: {
              schemas: {
                input: childInput,
              },
            },
          },
        },
      },
    })

    yield* expect(s.states.parent.states?.child.schemas?.input).toBe(childInput)
  })

  it('should create typed state configs from setup', function*({ expect }) {
    const s = setup({
      schemas: {
        context: types<{ count: number }>(),
        events: {
          INC: types<{ value: number }>(),
          RESET: types<{}>(),
        },
        tags: types<'active'>(),
        meta: types<{ label: string }>(),
      },
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const idle = s.createStateConfig({
      tags: ['active'],
      meta: { label: 'Idle' },
      on: {
        INC: ({ context, event }) => {
          context.count satisfies number
          event.value satisfies number

          return {
            context: {
              count: context.count + event.value,
            },
          }
        },
        RESET: {
          target: 'loading',
          context: { count: 0 },
          input: { userId: 'user-123' },
        },
      },
    })

    s.createMachine({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle,
        loading: {},
      },
    })

    yield* expect(idle).toEqual({
      tags: ['active'],
      meta: { label: 'Idle' },
      on: expect.any(Object),
    })
  })

  it('createStateConfig should type a top-level state input by path', function*({ expect }) {
    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const loading = s.createStateConfig('loading', {
      entry: ({ input }) => {
        input.userId satisfies string
      },
    })

    s.createMachine({
      initial: 'idle',
      states: {
        idle: {},
        loading,
      },
    })

    yield* expect(loading.entry).toEqual(expect.any(Function))
  })

  it('createStateConfig should type a nested state input by dotted path', function*({ expect }) {
    const s = setup({
      states: {
        parent: {
          schemas: {
            input: z.object({ parentId: z.string() }),
          },
          states: {
            child: {
              schemas: {
                input: z.object({ childId: z.number() }),
              },
            },
          },
        },
      },
    })

    // A nested state config authored standalone, addressed by dotted path.
    const child = s.createStateConfig('parent.child', {
      entry: ({ input }) => {
        input.childId satisfies number
      },
    })

    // Round-trip: the standalone nested config nests back under its parent,
    // and the parent's own input is typed too.
    const parent = s.createStateConfig('parent', {
      entry: ({ input }) => {
        input.parentId satisfies string
      },
      initial: {
        target: 'child',
        input: { childId: 42 },
      },
      states: {
        child,
      },
    })

    s.createMachine({
      initial: {
        target: 'parent',
        input: { parentId: 'p1' },
      },
      states: {
        parent,
      },
    })

    yield* expect(parent.states.child).toBe(child)
  })

  it('createStateConfig should reject invalid paths and mistyped input', function*({ expect }) {
    const s = setup({
      states: {
        idle: {},
        parent: {
          states: {
            child: {
              schemas: {
                input: z.object({ childId: z.number() }),
              },
            },
          },
        },
      },
    })

    s.createStateConfig(
      // @ts-expect-error - unknown top-level state path
      'missing',
      {},
    )

    s.createStateConfig(
      // @ts-expect-error - unknown nested state path
      'parent.missing',
      {},
    )

    s.createStateConfig('parent.child', {
      entry: ({ input }) => {
        // @ts-expect-error - childId is a number, not a string
        input.childId satisfies string
      },
    })

    yield* expect(Object.keys(s.states)).toEqual(['idle', 'parent'])
  })

  // The (path, config) overload validates bare on/always transition targets
  // against the resolved state's SIBLINGS — the children of the path's parent,
  // or the root states for a top-level path — because a bare target resolves
  // relative to the PARENT. These tests guard that: a real sibling is accepted;
  // a child or unknown target is rejected.
  it(
    'createStateConfig should validate (path, config) branch-state transition targets against siblings, not children',
    function*({ expect }) {
      const s = setup({
        schemas: {
          events: {
            GO: types<{}>(),
          },
        },
        states: {
          parent: {
            states: {
              child: {
                states: {
                  gc1: {},
                },
              },
              sibling: {},
            },
          },
        },
      })

      // 'sibling' is a real sibling of 'child' (both children of 'parent'), so a
      // bare target to it is valid.
      const siblingTarget = s.createStateConfig('parent.child', {
        on: {
          GO: {
            target: 'sibling',
          },
        },
      })

      // 'gc1' is a CHILD of 'child', not a sibling. A bare target should be
      // rejected (it would require descendant syntax '.gc1').
      s.createStateConfig('parent.child', {
        on: {
          // @ts-expect-error - 'gc1' is a child, not a sibling; needs '.gc1'
          GO: {
            target: 'gc1',
          },
        },
      })

      yield* expect(siblingTarget).toEqual({ on: { GO: { target: 'sibling' } } })
    },
  )

  it('createStateConfig (path, config) rejects sibling-region targets in parallel states', function*({ expect }) {
    const s = setup({
      schemas: {
        events: {
          E: types<{}>(),
        },
      },
      states: {
        p: {
          type: 'parallel',
          states: {
            r1: {},
            r2: {},
          },
        },
      },
    })

    s.createStateConfig('p.r1', {
      on: {
        // @ts-expect-error - parallel regions cannot target sibling regions by name
        E: {
          target: 'r2',
        },
      },
    })

    yield* expect(s.states.p).toEqual({ type: 'parallel', states: { r1: {}, r2: {} } })
  })

  it('should create typed machines from setup schemas', function*({ expect }) {
    const s = setup({
      schemas: {
        context: types<{ count: number }>(),
        events: {
          INC: types<{ value: number }>(),
        },
      },
    })

    const machine = s.createMachine({
      context: { count: 0 },
      on: {
        INC: ({ context, event }) => {
          context.count satisfies number
          event.value satisfies number

          return {
            context: {
              count: context.count + event.value,
            },
          }
        },
      },
    })

    s.createMachine({
      context: { count: 0 },
      on: {
        // @ts-expect-error - unknown event
        UNKNOWN: {},
      },
    })

    yield* expect(machine.getInitialSnapshot().context).toEqual({ count: 0 })
  })

  it('should type enq in state transition functions', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ count: number }>(),
        events: {
          INC: types<{}>(),
        },
        emitted: {
          notify: types<{}>(),
        },
      },
    }).createMachine({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            INC: (_args, enq) => {
              enq.raise({ type: 'INC' })
              enq.emit({ type: 'notify' })

              // @ts-expect-error - unknown event
              enq.raise({ type: 'UNKNOWN' })

              // @ts-expect-error - unknown emitted event
              enq.emit({ type: 'unknown' })
            },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('should allow target-only state transition function returns for compatible context', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ count: number }>(),
        events: {
          NEXT: types<{}>(),
        },
      },
      states: {
        idle: {},
        loading: {},
      },
    }).createMachine({
      context: { count: 0 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            NEXT: () => ({
              target: 'loading',
            }),
          },
        },
        loading: {},
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('should allow partial context patches in transition function returns', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ a: number; b: number; c: number }>(),
        events: {
          GO: types<{}>(),
        },
      },
    }).createMachine({
      context: { a: 1, b: 2, c: 3 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: ({ context }) => ({
              target: 'done',
              context: {
                b: context.b + 1,
              },
            }),
          },
        },
        done: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'GO' })

    yield* expect(actor.getSnapshot().context).toEqual({ a: 1, b: 3, c: 3 })
  })

  it('should allow partial context patches in root transition function returns', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ a: number; b: number; c: number }>(),
        events: {
          GO: types<{}>(),
        },
      },
      states: {
        idle: {},
        done: {},
      },
    }).createMachine({
      context: { a: 1, b: 2, c: 3 },
      initial: 'idle',
      on: {
        GO: ({ context }) => ({
          target: '.done',
          context: {
            b: context.b + 1,
          },
        }),
      },
      states: {
        idle: {},
        done: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'GO' })

    yield* expect(actor.getSnapshot().context).toEqual({ a: 1, b: 3, c: 3 })
  })

  it('should allow partial context patches in static transition configs', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ a: number; b: number; c: number }>(),
        events: {
          GO: types<{}>(),
        },
      },
    }).createMachine({
      context: { a: 1, b: 2, c: 3 },
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: {
              target: 'done',
              context: {
                b: 4,
              },
            },
          },
        },
        done: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'GO' })

    yield* expect(actor.getSnapshot().context).toEqual({ a: 1, b: 4, c: 3 })
  })

  it('should reject invalid setup-created state configs', function*({ expect }) {
    const s = setup({
      schemas: {
        context: types<{ count: number }>(),
        events: {
          INC: types<{ value: number }>(),
          RESET: types<{}>(),
        },
        tags: types<'active'>(),
        meta: types<{ label: string }>(),
      },
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    s.createStateConfig({
      on: {
        // @ts-expect-error - unknown event
        UNKNOWN: {},
      },
    })

    s.createStateConfig({
      // @ts-expect-error - unknown tag
      tags: ['inactive'],
    })

    s.createStateConfig({
      // @ts-expect-error - meta.label should be a string
      meta: { label: 42 },
    })

    s.createStateConfig({
      on: {
        // @ts-expect-error - loading input should include a string userId
        RESET: () => ({
          target: 'loading',
          context: { count: 0 },
          input: { userId: 42 },
        }),
      },
    })

    yield* expect(Object.keys(s.states)).toEqual(['idle', 'loading'])
  })

  it('should type setup-defined state keys in machines', function*({ expect }) {
    const s = setup({
      schemas: {
        events: {
          LOAD: types<{}>(),
        },
      },
      states: {
        idle: {},
        loading: {},
      },
    })

    s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'loading',
            },
          },
        },
        loading: {},
      },
    })

    const idle = s.createStateConfig({
      on: {
        LOAD: {
          target: 'loading',
        },
      },
    })

    const external = s.createStateConfig({
      on: {
        LOAD: {
          target: '#external',
        },
      },
    })

    s.createStateConfig({
      on: {
        LOAD: {
          target: '.child',
        },
      },
    })

    s.createStateConfig({
      on: {
        // @ts-expect-error - target should be a setup-defined sibling, relative target, or state ID
        LOAD: {
          target: 'missing',
        },
      },
    })

    s.createMachine({
      initial: 'missing',
      states: {
        idle: {},
        loading: {},
        missing: {},
      },
    })

    s.createMachine({
      initial: {
        // @ts-expect-error - initial transition input requires a setup-defined target
        target: 'missing',
      },
      states: {
        idle: {},
        loading: {},
      },
    })

    s.createMachine({
      initial: 'idle',
      states: {
        idle: {},
        loading: {},
        missing: {},
      },
    })

    const thrown = thrownMessage(() => {
      s.createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: {
              // @ts-expect-error - target should be a setup-defined sibling, relative target, or state ID
              LOAD: {
                target: 'missing',
              },
            },
          },
          loading: {},
        },
      })
    })

    yield* expect({
      idle,
      external,
      thrown,
    }).toEqual({
      idle: { on: { LOAD: { target: 'loading' } } },
      external: { on: { LOAD: { target: '#external' } } },
      thrown:
        "Invalid transition definition for state node '(machine).idle':\nChild state 'missing' does not exist on '(machine)'",
    })
  })

  it('should allow top-level machine states outside the setup state tree', function*({ expect }) {
    const s = setup({
      schemas: {
        events: {
          LOAD: types<{}>(),
        },
      },
      states: {
        foo: {
          states: {
            bar: {},
            baz: {},
          },
        },
        rootSibling: {},
      },
    })

    s.createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'asdf',
          states: {
            bar: {},
            baz: {},
            asdf: {},
          },
        },
        rootSibling: {},
      },
    })

    s.createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'bar',
          states: {
            bar: {},
            baz: {},
          },
          on: {
            LOAD: {
              target: 'rootSibling',
            },
          },
        },
        rootSibling: {},
      },
    })

    s.createMachine({
      initial: 'bar',
      states: {
        foo: {
          initial: 'bar',
          states: {
            bar: {},
            baz: {},
          },
        },
        bar: {},
        rootSibling: {},
      },
    })

    s.createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'bar',
          states: {
            bar: {},
            baz: {},
            qux: {},
          },
        },
        bar: {},
        rootSibling: {},
      },
    })

    s.createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'baz',
          states: {
            bar: {},
            baz: {
              on: {
                LOAD: {
                  target: 'bar',
                },
              },
            },
          },
        },
        rootSibling: {},
      },
    })

    const thrown = thrownMessage(() => {
      s.createMachine({
        initial: 'foo',
        states: {
          foo: {
            initial: 'baz',
            states: {
              bar: {},
              baz: {
                on: {
                  // @ts-expect-error - target should be a local sibling key, relative target, or state ID
                  LOAD: {
                    target: 'rootSibling',
                  },
                },
              },
            },
          },
          rootSibling: {},
        },
      })
    })

    yield* expect(thrown).toEqual(
      "Invalid transition definition for state node '(machine).foo.baz':\nChild state 'rootSibling' does not exist on '(machine).foo'",
    )
  })

  it('should create a machine from setup', function*({ expect }) {
    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {},
        loading: {},
      },
    })

    const initial = machine.root.initial

    yield* expect({
      target: initial.target?.map((stateNode) => stateNode.id),
      value: machine.getInitialSnapshot().value,
    }).toEqual({ target: ['(machine).idle'], value: 'idle' })
  })

  it('should allow setup with no config', function*({ expect }) {
    const s = setup()

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {},
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('should allow setup with empty states', function*({ expect }) {
    const s = setup({
      states: {},
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {},
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('should preserve schemas.input for multiple states', function*({ expect }) {
    const userIdSchema = z.object({ userId: z.string() })
    const nameSchema = z.object({ name: z.string() })

    const s = setup({
      states: {
        loading: { schemas: { input: userIdSchema } },
        creating: { schemas: { input: nameSchema } },
      },
    })

    yield* expect({
      loading: s.states.loading.schemas?.input === userIdSchema,
      creating: s.states.creating.schemas?.input === nameSchema,
    }).toEqual({ loading: true, creating: true })
  })

  it('entry action should receive input', function*({ expect }) {
    const entryInputs: unknown[] = []

    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'loading',
              input: { userId: 'user-123' },
            },
          },
        },
        loading: {
          entry: ({ input }) => {
            entryInputs.push(input)
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'LOAD' })

    yield* expect(entryInputs).toEqual([{ userId: 'user-123' }])
  })

  it('exit action should receive input', function*({ expect }) {
    const exitInputs: unknown[] = []

    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'loading',
              input: { userId: 'user-456' },
            },
          },
        },
        loading: {
          exit: ({ input }) => {
            exitInputs.push(input)
          },
          on: {
            DONE: { target: 'idle' },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'LOAD' })
    actor.send({ type: 'DONE' })

    yield* expect(exitInputs).toEqual([{ userId: 'user-456' }])
  })

  it('final output should receive input', function*({ expect }) {
    const receivedInputs: unknown[] = []

    const s = setup({
      states: {
        idle: {},
        done: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'done',
              input: { userId: 'user-123' },
            },
          },
        },
        done: {
          type: 'final',
          output: ({ input }) => {
            input.userId satisfies string
            receivedInputs.push(input)
            return input
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'LOAD' })

    yield* expect({
      receivedInputs,
      output: actor.getSnapshot().output,
    }).toEqual({
      receivedInputs: [{ userId: 'user-123' }],
      output: { userId: 'user-123' },
    })
  })

  it('parallel final outputs should receive their nested state inputs', function*({ expect }) {
    const s = setup({
      states: {
        a: {
          states: {
            done: {
              schemas: {
                input: z.object({ value: z.literal('a') }),
              },
            },
          },
        },
        b: {
          states: {
            done: {
              schemas: {
                input: z.object({ value: z.literal('b') }),
              },
            },
          },
        },
      },
    })

    const machine = s.createMachine({
      type: 'parallel',
      states: {
        a: {
          initial: {
            target: 'done',
            input: { value: 'a' },
          },
          states: {
            done: {
              type: 'final',
              output: ({ input }) => {
                input.value satisfies 'a'
                return input.value
              },
            },
          },
        },
        b: {
          initial: {
            target: 'done',
            input: { value: 'b' },
          },
          states: {
            done: {
              type: 'final',
              output: ({ input }) => {
                input.value satisfies 'b'
                return input.value
              },
            },
          },
        },
      },
      output: ({ output }) => output,
    })

    const snapshot = createActor(machine).start().getSnapshot()

    yield* expect({
      done: snapshot.status === 'done',
      output: snapshot.output,
    }).toEqual({ done: true, output: { a: 'a', b: 'b' } })
  })

  it('transition should pass input to target state', function*({ expect }) {
    const receivedInputs: unknown[] = []

    const s = setup({
      states: {
        idle: {},
        fetching: {
          schemas: {
            input: z.object({
              url: z.string(),
              method: z.enum(['GET', 'POST']),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            FETCH: {
              target: 'fetching',
              input: { url: '/api/users', method: 'GET' },
            },
          },
        },
        fetching: {
          entry: ({ input }) => {
            receivedInputs.push(input)
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'FETCH' })

    yield* expect(receivedInputs).toEqual([{ url: '/api/users', method: 'GET' }])
  })

  it('function-syntax transition should compute input from event and context', function*({ expect }) {
    const receivedInputs: unknown[] = []
    const s = setup({
      schemas: {
        events: {
          FETCH: types<{ url: string }>(),
        },
      },
      states: {
        idle: {},
        fetching: {
          schemas: {
            input: z.object({ url: z.string(), token: z.string() }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      context: { authToken: 'abc-123' },
      states: {
        idle: {
          on: {
            FETCH: ({ context, event }) => ({
              target: 'fetching',
              input: { url: event.url, token: context['authToken'] },
            }),
          },
        },
        fetching: {
          entry: ({ input }) => {
            receivedInputs.push(input)
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'FETCH', url: '/api/users' })
    yield* expect(receivedInputs).toEqual([{ url: '/api/users', token: 'abc-123' }])
  })

  it('initial transition should accept input', function*({ expect }) {
    const entryInputs: unknown[] = []

    const s = setup({
      states: {
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: {
        target: 'loading',
        input: { userId: 'initial-user' },
      },
      states: {
        loading: {
          entry: ({ input }) => {
            entryInputs.push(input)
          },
        },
      },
    })

    createActor(machine).start()

    yield* expect(entryInputs).toEqual([{ userId: 'initial-user' }])
  })

  it('input can be a function resolving dynamically', function*({ expect }) {
    const entryInputs: unknown[] = []

    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
              timestamp: z.number(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      schemas: {
        context: z.object({
          currentUser: z.string(),
        }),
      },
      initial: 'idle',
      context: { currentUser: 'dynamic-user' } as any,
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'loading',
              input: ({ context }) => ({
                userId: context.currentUser,
                timestamp: 1234567890,
              }),
            },
          },
        },
        loading: {
          entry: ({ input }, enq) => {
            enq((input) => entryInputs.push(input), input)
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'LOAD' })

    yield* expect(entryInputs).toEqual([
      { userId: 'dynamic-user', timestamp: 1234567890 },
    ])
  })

  it('nested state should receive input from parent initial', function*({ expect }) {
    const entryInputs: unknown[] = []

    const s = setup({
      states: {
        parent: {
          states: {
            child: {
              schemas: {
                input: z.object({
                  childValue: z.string(),
                }),
              },
            },
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'parent',
      states: {
        parent: {
          initial: {
            target: 'child',
            input: { childValue: 'nested-param' },
          },
          states: {
            child: {
              entry: ({ input }, enq) => {
                enq((input) => entryInputs.push(input), input)
              },
            },
          },
        },
      },
    })

    createActor(machine).start()

    yield* expect(entryInputs).toEqual([{ childValue: 'nested-param' }])
  })

  it('should correctly type input in nested states', function*({ expect }) {
    const s = setup({
      states: {
        idle: {},
        active: {
          schemas: {
            input: z.object({ activeId: z.number() }),
          },
          states: {
            loading: {
              schemas: {
                input: z.object({ loadingUrl: z.string() }),
              },
            },
            ready: {},
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          entry: ({ input }) => {
            input satisfies undefined
            // @ts-expect-error - input should be undefined, not string
            input satisfies string
          },
        },
        active: {
          initial: 'loading',
          entry: ({ input }) => {
            input satisfies { activeId: number } | undefined
            // @ts-expect-error - activeId should be number, not string
            input satisfies { activeId: string }
          },
          states: {
            loading: {
              entry: ({ input }) => {
                input satisfies { loadingUrl: string } | undefined
                // @ts-expect-error - loadingUrl should be string, not number
                input satisfies { loadingUrl: number }
              },
            },
            ready: {
              entry: ({ input }) => {
                input satisfies undefined
                // @ts-expect-error - input should be undefined, not object
                input satisfies { foo: string }
              },
            },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('input should be accessible in snapshot via getInputs()', function*({ expect }) {
    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({
              userId: z.string(),
            }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'loading',
              input: { userId: 'snapshot-user' },
            },
          },
        },
        loading: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'LOAD' })

    const snapshot = actor.getSnapshot()
    const inputs = snapshot.getInputs()

    // Inputs are keyed by state node ID
    yield* expect(inputs['(machine).loading']).toEqual({ userId: 'snapshot-user' })
  })

  it('nested state input should be accessible in snapshot', function*({ expect }) {
    const s = setup({
      states: {
        parent: {
          schemas: {
            input: z.object({ parentId: z.string() }),
          },
          states: {
            child: {
              schemas: {
                input: z.object({ childId: z.number() }),
              },
            },
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: {
        target: 'parent',
        input: { parentId: 'p1' },
      },
      states: {
        parent: {
          initial: {
            target: 'child',
            input: { childId: 42 },
          },
          states: {
            child: {},
          },
        },
      },
    })

    const actor = createActor(machine).start()
    const snapshot = actor.getSnapshot()
    const inputs = snapshot.getInputs()

    yield* expect({
      parent: inputs['(machine).parent'],
      child: inputs['(machine).parent.child'],
    }).toEqual({ parent: { parentId: 'p1' }, child: { childId: 42 } })
  })

  it('getInputs() should be strongly typed', function*({ expect }) {
    const s = setup({
      states: {
        idle: {},
        loading: {
          schemas: {
            input: z.object({ userId: z.string() }),
          },
        },
        active: {
          schemas: {
            input: z.object({ sessionId: z.number() }),
          },
          states: {
            running: {
              schemas: {
                input: z.object({ taskId: z.string() }),
              },
            },
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'idle',
      states: {
        idle: {},
        loading: {},
        active: {
          initial: 'running',
          states: {
            running: {},
          },
        },
      },
    })

    const actor = createActor(machine).start()
    const inputs = actor.getSnapshot().getInputs()

    inputs['(machine).idle'] satisfies undefined
    inputs['(machine).loading'] satisfies { userId: string } | undefined
    inputs['(machine).active'] satisfies { sessionId: number } | undefined
    inputs['(machine).active.running'] satisfies { taskId: string } | undefined

    // @ts-expect-error - loading input should have userId string, not number
    inputs['(machine).loading'] satisfies { userId: number }
    // @ts-expect-error - active input should have sessionId number, not string
    inputs['(machine).active'] satisfies { sessionId: string }

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('input should persist across self-transitions', function*({ expect }) {
    const s = setup({
      states: {
        active: {
          schemas: {
            input: z.object({ count: z.number() }),
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: {
        target: 'active',
        input: { count: 1 },
      },
      states: {
        active: {
          on: {
            // Self-transition without reenter
            PING: {},
          },
        },
      },
    })

    const actor = createActor(machine).start()

    const beforePing = actor.getSnapshot().getInputs()['(machine).active']

    actor.send({ type: 'PING' })

    const afterPing = actor.getSnapshot().getInputs()['(machine).active']

    yield* expect({ beforePing, afterPing }).toEqual({
      beforePing: { count: 1 },
      afterPing: { count: 1 },
    })
  })

  it("a self-transition's input only takes effect when the state is re-entered", function*({ expect }) {
    const s = setup({
      schemas: {
        context: z.object({ count: z.number() }),
        events: {
          SET_MULTIPLIER_NO_REENTER: z.object({}),
          SET_MULTIPLIER_REENTER: z.object({}),
          MULTIPLY: z.object({}),
        },
      },
      states: {
        active: {
          schemas: {
            input: z.object({ multiplier: z.number() }),
          },
        },
      },
    })
    const entryInputs: Array<{ multiplier: number }> = []
    const machine = s.createMachine({
      context: { count: 1 },
      initial: {
        target: 'active',
        input: { multiplier: 3 },
      },
      states: {
        active: {
          entry: ({ input }) => {
            entryInputs.push(input)
          },
          on: {
            SET_MULTIPLIER_NO_REENTER: {
              target: 'active',
              input: { multiplier: 99 },
            },
            SET_MULTIPLIER_REENTER: {
              target: 'active',
              reenter: true,
              input: { multiplier: 10 },
            },
            MULTIPLY: ({ context, input }) => ({
              context: { count: context.count * input.multiplier },
            }),
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'MULTIPLY' })
    const afterFirstMultiply = actor.getSnapshot().context.count

    actor.send({ type: 'SET_MULTIPLIER_NO_REENTER' })
    const afterNoReenter = {
      entryInputs: [...entryInputs],
      input: actor.getSnapshot().getInputs()['(machine).active'],
    }

    actor.send({ type: 'MULTIPLY' })
    const afterSecondMultiply = actor.getSnapshot().context.count

    actor.send({ type: 'SET_MULTIPLIER_REENTER' })
    const afterReenter = {
      entryInputs: [...entryInputs],
      input: actor.getSnapshot().getInputs()['(machine).active'],
    }

    actor.send({ type: 'MULTIPLY' })
    const afterThirdMultiply = actor.getSnapshot().context.count

    yield* expect({
      afterFirstMultiply,
      afterNoReenter,
      afterSecondMultiply,
      afterReenter,
      afterThirdMultiply,
    }).toEqual({
      afterFirstMultiply: 3,
      afterNoReenter: {
        entryInputs: [{ multiplier: 3 }],
        input: { multiplier: 3 },
      },
      afterSecondMultiply: 9,
      afterReenter: {
        entryInputs: [{ multiplier: 3 }, { multiplier: 10 }],
        input: { multiplier: 10 },
      },
      afterThirdMultiply: 90,
    })
  })

  it("a non-reentering self-transition cannot overwrite a concurrent transition's input", function*({ expect }) {
    const s = setup({
      schemas: {
        events: {
          GO: z.object({}),
        },
      },
      states: {
        receiver: {
          states: {
            active: {
              schemas: {
                input: z.object({ value: z.number() }),
              },
            },
          },
        },
        sender: {
          states: {
            idle: {},
          },
        },
      },
    })
    const entryInputs: Array<{ value: number }> = []
    const machine = s.createMachine({
      type: 'parallel',
      states: {
        sender: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                GO: {
                  target: '#active',
                  input: { value: 2 },
                } as any,
              },
            },
          },
        },
        receiver: {
          initial: {
            target: 'active',
            input: { value: 1 },
          },
          states: {
            active: {
              id: 'active',
              entry: ({ input }) => {
                entryInputs.push(input)
              },
              on: {
                GO: {
                  target: '#active',
                  input: { value: 99 },
                } as any,
              },
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'GO' })

    yield* expect({
      entryInputs,
      active: (actor.getSnapshot().getInputs() as Record<string, unknown>)['active'],
    }).toEqual({ entryInputs: [{ value: 1 }, { value: 2 }], active: { value: 2 } })
  })

  it("a compound state's input is replaced only when the state is re-entered", function*({ expect }) {
    const s = setup({
      schemas: {
        events: {
          PING: z.object({}),
          PING_REENTER: z.object({}),
        },
      },
      states: {
        parent: {
          schemas: {
            input: z.object({ value: z.number() }),
          },
          states: {
            child: {},
          },
        },
      },
    })
    const parentInputs: Array<{ value: number }> = []
    const childEntries: string[] = []
    const machine = s.createMachine({
      initial: {
        target: 'parent',
        input: { value: 1 },
      },
      states: {
        parent: {
          initial: 'child',
          entry: ({ input }) => {
            parentInputs.push(input)
          },
          on: {
            PING: {
              target: 'parent',
              input: { value: 2 },
            },
            PING_REENTER: {
              target: 'parent',
              reenter: true,
              input: { value: 3 },
            },
          },
          states: {
            child: {
              entry: () => {
                childEntries.push('child')
              },
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    const observed: Array<{
      parentInputs: Array<{ value: number }>
      input: unknown
      childEntries: string[]
    }> = []
    const record = () => {
      observed.push({
        parentInputs: [...parentInputs],
        input: actor.getSnapshot().getInputs()['(machine).parent'],
        childEntries: [...childEntries],
      })
    }

    record()

    actor.send({ type: 'PING' })
    record()

    actor.send({ type: 'PING_REENTER' })
    record()

    yield* expect(observed).toEqual([
      {
        parentInputs: [{ value: 1 }],
        input: { value: 1 },
        childEntries: ['child'],
      },
      {
        parentInputs: [{ value: 1 }],
        input: { value: 1 },
        childEntries: ['child', 'child'],
      },
      {
        parentInputs: [{ value: 1 }, { value: 3 }],
        input: { value: 3 },
        childEntries: ['child', 'child', 'child'],
      },
    ])
  })

  it('invoke transitions should require context for incompatible targets', function*({ expect }) {
    const s = setup({
      schemas: {
        context: types<{}>(),
        events: {
          GO: types<{}>(),
        },
      },
      states: {
        idle: {},
        loading: {},
        success: {
          schemas: {
            context: z.object({ message: z.string() }),
          },
        },
      },
      actors: {
        load: createAsyncLogic({
          run: () => Promise.resolve('Done' as const),
        }),
      },
    })

    s.createMachine({
      context: {},
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: { target: 'loading' },
          },
        },
        loading: {
          // @ts-expect-error - success context requires a message
          invoke: {
            src: 'load',
            onDone: () => ({ target: 'success' }),
          },
        },
        success: {},
      },
    })

    s.createMachine({
      context: {},
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: { target: 'loading' },
          },
        },
        loading: {
          // @ts-expect-error - success context requires a message
          invoke: {
            src: 'load',
            onError: () => ({ target: 'success' }),
          },
        },
        success: {},
      },
    })

    s.createMachine({
      context: {},
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: { target: 'loading' },
          },
        },
        loading: {
          // @ts-expect-error - success context requires a message
          invoke: {
            src: 'load',
            onSnapshot: () => ({ target: 'success' }),
          },
        },
        success: {},
      },
    })

    s.createMachine({
      context: {},
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: { target: 'loading' },
          },
        },
        loading: {
          // @ts-expect-error - success context requires a message
          invoke: {
            src: 'load',
            timeout: 100,
            onTimeout: () => ({ target: 'success' }),
          },
        },
        success: {},
      },
    })

    const machine = s.createMachine({
      context: {},
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: { target: 'loading' },
          },
        },
        loading: {
          invoke: {
            src: 'load',
            timeout: 100,
            onDone: ({ event }) => {
              event.output satisfies 'Done'
              // @ts-expect-error - output should be inferred from actor logic
              event.output satisfies number
              return {
                target: 'success',
                context: { message: event.output },
              }
            },
            onError: ({ event }) => ({
              target: 'success',
              context: { message: event.actorId },
            }),
            onSnapshot: () => ({
              target: 'success',
              context: { message: 'Snapshot' },
            }),
            onTimeout: () => ({
              target: 'success',
              context: { message: 'Timeout' },
            }),
          },
        },
        success: {},
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('state context schemas should narrow context in state actions', function*({ expect }) {
    const s = setup({
      states: {
        idle: {
          schemas: {
            context: z.object({ user: z.null() }),
          },
        },
        success: {
          schemas: {
            context: z.object({ user: z.string() }),
          },
        },
      },
    })

    s.createMachine({
      schemas: {
        context: z.object({ user: z.string().nullable() }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { user: null },
      states: {
        idle: {
          entry: ({ context }) => {
            context.user satisfies null
            // @ts-expect-error
            context.user satisfies string
          },
          on: {
            LOAD: () => ({
              target: 'success',
              context: { user: 'Ada' },
            }),
          },
        },
        success: {
          entry: ({ context }) => {
            context.user satisfies string
            // @ts-expect-error - success context should not be nullable
            context.user satisfies null
          },
        },
      },
    })

    const machine = s.createMachine({
      schemas: {
        context: z.object({ user: z.string().nullable() }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { user: null },
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'success',
              context: { user: 'Ada' },
            },
          },
        },
        success: {},
      },
    })

    type SuccessContext = StateContextFromStateValue<
      StateSchemaFrom<typeof machine>,
      { user: string | null },
      'success'
    >
    ;(({}) as SuccessContext).user satisfies string // @ts-expect-error - success context should not be nullable
    ;(({}) as SuccessContext).user satisfies null

    const actor = createActor(machine).start()

    actor.send({ type: 'LOAD' })

    const snapshot = actor.getSnapshot()

    if (snapshot.matches('success')) {
      snapshot.context.user satisfies string
      // @ts-expect-error - matched success context should not be nullable
      snapshot.context.user satisfies null
    }

    yield* expect(actor.getSnapshot().context).toEqual({ user: 'Ada' })
  })

  it('state context schemas should refine part of the root context', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: z.object({
          requestId: z.string(),
          draft: z.string().optional(),
          approved: z.literal(true).optional(),
        }),
        events: { REVIEW: z.object({ approved: z.literal(true) }) },
      },
      states: {
        workflow: {
          type: 'compound',
          initial: 'editing',
          schemas: { context: z.object({ draft: z.string() }) },
          states: {
            editing: {},
            reviewing: {
              schemas: { context: z.object({ approved: z.literal(true) }) },
            },
          },
        },
      },
    }).createMachine({
      context: { requestId: 'req-1', draft: 'Ready' },
      initial: 'workflow',
      states: {
        workflow: {
          initial: 'editing',
          states: {
            editing: {
              on: {
                REVIEW: ({ event }) => ({
                  target: 'reviewing',
                  context: { approved: event.approved },
                }),
              },
            },
            reviewing: {
              entry: ({ context }) => {
                false satisfies IsAny<typeof context>
                false satisfies IsAny<typeof context.requestId>
                context.requestId satisfies string
                context.draft satisfies string
                context.approved satisfies true
                // @ts-expect-error - root context fields keep their declared type
                context.requestId satisfies number
              },
              on: {
                REVIEW: ({ context }) => {
                  context.requestId satisfies string
                  context.draft satisfies string
                  context.approved satisfies true
                },
              },
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'REVIEW', approved: true })

    type ReviewingContext = StateContextFromStateValue<
      StateSchemaFrom<typeof machine>,
      { requestId: string; draft?: string; approved?: true },
      { workflow: 'reviewing' }
    >
    false satisfies IsAny<ReviewingContext['requestId']>
    ;(({}) as ReviewingContext).requestId satisfies string
    ;(({}) as ReviewingContext).draft satisfies string
    ;(({}) as ReviewingContext).approved satisfies true // @ts-expect-error - the root field remains a string in the refinement
    ;(({}) as ReviewingContext).requestId satisfies number

    const snapshot = actor.getSnapshot()
    if (snapshot.matches({ workflow: 'reviewing' })) {
      false satisfies IsAny<typeof snapshot.context>
      false satisfies IsAny<typeof snapshot.context.requestId>
      snapshot.context.requestId satisfies string
      snapshot.context.draft satisfies string
      snapshot.context.approved satisfies true
      // @ts-expect-error - root context fields keep their declared type
      snapshot.context.requestId satisfies number
    }

    yield* expect(snapshot.context).toEqual({
      requestId: 'req-1',
      draft: 'Ready',
      approved: true,
    })
  })

  it('state schemas should allow undeclared sibling states', function*({ expect }) {
    const machine = setup({
      states: {
        done: {
          schemas: {
            context: z.object({ result: z.string() }),
          },
        },
      },
    }).createMachine({
      schemas: {
        context: z.object({ result: z.string().nullable() }),
      },
      initial: 'planning',
      context: { result: null },
      states: {
        planning: {
          entry: ({ context }) => {
            context.result satisfies string | null
          },
          on: {
            FINISH: {
              target: 'done',
              context: { result: 'complete' },
            },
          },
        },
        done: {
          entry: ({ context }) => {
            context.result satisfies string
            // @ts-expect-error - the declared state schema should still narrow
            context.result satisfies null
          },
          on: {
            RESET: {
              target: 'planning',
              context: { result: null },
            },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('planning')
  })

  it('transition context should satisfy the target state context', function*({ expect }) {
    const s = setup({
      states: {
        deciding: {},
        guessed: {
          schemas: {
            context: z.object({ guess: z.string() }),
          },
        },
      },
    })

    const machine = s.createMachine({
      schemas: {
        context: z.object({ guess: z.string().nullable() }),
      },
      initial: 'deciding',
      context: { guess: null },
      states: {
        deciding: {},
        guessed: {
          entry: ({ context }) => {
            context.guess satisfies string
          },
          on: {
            PLAY_AGAIN: {
              target: 'deciding',
              context: { guess: null },
            },
            PLAY_AGAIN_FUNCTION: () => ({
              target: 'deciding',
              context: { guess: null },
            }),
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('deciding')
  })

  it('snapshot matches should allow chained checks for states sharing the same context', function*({ expect }) {
    const sameContextMachine = setup({
      states: {
        Loading: {},
        InvalidRoute: {},
        Ready: {
          schemas: {
            context: types<{ data: 'value' }>(),
          },
        },
      },
    }).createMachine({
      initial: 'Loading',
      states: {
        Loading: {},
        InvalidRoute: {},
        Ready: {},
      },
    })

    type SameContextSnapshot = StateFrom<typeof sameContextMachine>
    type SameContextValue = SameContextSnapshot['value']
    false satisfies IsAny<SameContextValue>
    'Ready' satisfies SameContextValue
    // @ts-expect-error - unknown states should not be part of this machine's state value
    'Other' satisfies SameContextValue

    function chainedSameContext(snapshot: SameContextSnapshot) {
      if (snapshot.matches('Loading') || snapshot.matches('InvalidRoute')) {
        return true
      }

      snapshot.value satisfies 'Ready'
      type Data = typeof snapshot.context.data
      false satisfies IsAny<Data>
      snapshot.context.data satisfies 'value'

      return snapshot.context.data
    }

    const data = chainedSameContext(
      sameContextMachine.resolveState({
        value: 'Ready',
        context: { data: 'value' },
      }) as SameContextSnapshot,
    )

    yield* expect(data).toEqual('value')
  })

  it('snapshot matches should narrow context for nested state values', function*({ expect }) {
    const nestedMachine = setup({
      states: {
        Flow: {
          states: {
            Loading: {},
            InvalidRoute: {},
            Ready: {
              schemas: {
                context: types<{ data: 'nested-value' }>(),
              },
            },
          },
        },
      },
    }).createMachine({
      initial: 'Flow',
      states: {
        Flow: {
          initial: 'Loading',
          states: {
            Loading: {},
            InvalidRoute: {},
            Ready: {},
          },
        },
      },
    })

    type NestedSnapshot = StateFrom<typeof nestedMachine>
    type NestedValue = NestedSnapshot['value']
    false satisfies IsAny<NestedValue>
    ;({ Flow: 'Ready' }) satisfies NestedValue // @ts-expect-error - unknown nested states should not be part of this machine's state value
    ;({ Flow: 'Other' }) satisfies NestedValue

    function nestedReady(snapshot: NestedSnapshot) {
      if (snapshot.matches({ Flow: 'Ready' })) {
        snapshot.value satisfies { Flow: 'Ready' }
        type Data = typeof snapshot.context.data
        false satisfies IsAny<Data>
        snapshot.context.data satisfies 'nested-value'

        return snapshot.context.data
      }

      return true
    }

    const data = nestedReady(
      nestedMachine.resolveState({
        value: { Flow: 'Ready' },
        context: { data: 'nested-value' },
      }) as NestedSnapshot,
    )

    yield* expect(data).toEqual('nested-value')
  })

  it('state context schemas should require context for incompatible targets', function*({ expect }) {
    const s = setup({
      states: {
        idle: {
          schemas: {
            context: z.object({ count: z.number(), user: z.null() }),
          },
        },
        success: {
          schemas: {
            context: z.object({ count: z.number(), user: z.string() }),
          },
        },
      },
    })

    s.createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
          user: z.string().nullable(),
        }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { count: 0, user: null },
      states: {
        idle: {
          on: {
            // @ts-expect-error - success context requires a string user
            LOAD: () => ({
              target: 'success',
            }),
          },
        },
        success: {},
      },
    })

    s.createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
          user: z.string().nullable(),
        }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { count: 0, user: null },
      states: {
        idle: {
          on: {
            // @ts-expect-error - success context requires a string user
            LOAD: () => ({
              target: 'success',
              context: { count: 1 },
            }),
          },
        },
        success: {},
      },
    })

    s.createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
          user: z.string().nullable(),
        }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { count: 0, user: null },
      states: {
        idle: {
          on: {
            // @ts-expect-error - success context requires a string user
            LOAD: {
              target: 'success',
            },
          },
        },
        success: {},
      },
    })

    s.createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
          user: z.string().nullable(),
        }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { count: 0, user: null },
      states: {
        idle: {
          on: {
            // @ts-expect-error - success context requires a string user
            LOAD: {
              target: 'success',
              context: { count: 1 },
            },
          },
        },
        success: {},
      },
    })

    const machine = s.createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
          user: z.string().nullable(),
        }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { count: 0, user: null },
      states: {
        idle: {
          on: {
            LOAD: {
              target: 'success',
              context: { user: 'Ada' },
            },
          },
        },
        success: {},
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'LOAD' })

    yield* expect(actor.getSnapshot().context).toEqual({ count: 0, user: 'Ada' })
  })

  it('state context schemas should reject target context mismatch', function*({ expect }) {
    const s = setup({
      states: {
        idle: {
          schemas: {
            context: z.object({ user: z.null() }),
          },
        },
        success: {
          schemas: {
            context: z.object({ user: z.string() }),
          },
        },
      },
    })

    const machine = s.createMachine({
      schemas: {
        context: z.object({ user: z.string().nullable() }),
        events: {
          LOAD: z.object({}),
        },
      },
      initial: 'idle',
      context: { user: null },
      states: {
        idle: {
          on: {
            // @ts-expect-error - success context requires a string user
            LOAD: () => ({
              target: 'success',
              context: { user: null },
            }),
          },
        },
        success: {},
      },
    })

    yield* expect(machine.getInitialSnapshot().context).toEqual({ user: null })
  })
})
