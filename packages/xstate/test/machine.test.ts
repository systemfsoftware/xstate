import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createActor, createMachine } from '../src/index.js'

const pedestrianStates = {
  initial: 'walk',
  states: {
    walk: {
      contextSchema: z.object({
        color: z.literal('walk'),
      }),
      on: {
        PED_COUNTDOWN: { target: 'wait' },
      },
    },
    wait: {
      on: {
        PED_COUNTDOWN: { target: 'stop' },
      },
    },
    stop: {},
  },
} as const

const lightMachine = createMachine({
  initial: 'green',
  states: {
    green: {
      contextSchema: z.object({
        color: z.literal('green'),
      }),
      on: {
        TIMER: { target: 'yellow' },
        POWER_OUTAGE: { target: 'red' },
        FORBIDDEN_EVENT: undefined,
      },
    },
    yellow: {
      on: {
        TIMER: { target: 'red' },
        POWER_OUTAGE: { target: 'red' },
      },
    },
    red: {
      on: {
        TIMER: { target: 'green' },
        POWER_OUTAGE: { target: 'red' },
      },
      ...pedestrianStates,
    },
  },
})

describe('machine', () => {
  describe('machine.states', () => {
    it('should properly register machine states', function*({ expect }) {
      yield* expect(Object.keys(lightMachine.states)).toEqual([
        'green',
        'yellow',
        'red',
      ])
    })
  })

  describe('machine.events', () => {
    it('should return the set of events accepted by machine', function*({ expect }) {
      yield* expect(lightMachine.events).toEqual([
        'TIMER',
        'POWER_OUTAGE',
        'PED_COUNTDOWN',
      ])
    })
  })

  describe('machine.config', () => {
    it('state node config should reference original machine config', function*({ expect }) {
      const machine = createMachine({
        initial: 'one',
        states: {
          one: {
            initial: 'deep',
            states: {
              deep: {},
            },
          },
        },
      })

      const oneState = machine.states['one']
      if (oneState === undefined) {
        throw new Error('expected a one state')
      }

      const oneConfig = machine.config.states!['one']
      if (oneConfig === undefined) {
        throw new Error('expected a one config')
      }

      const deepState = oneState.states['deep']
      if (deepState === undefined) {
        throw new Error('expected a deep state')
      }

      const deepConfig = oneConfig.states?.['deep']
      if (deepConfig === undefined) {
        throw new Error('expected a deep config')
      }

      const oneConfigIsSame = Object.is(oneState.config, oneConfig)
      const deepConfigIsSame = Object.is(deepState.config, deepConfig)

      deepState.config.meta = 'testing meta'

      yield* expect({
        oneConfigIsSame,
        deepConfigIsSame,
        deepConfigMeta: deepConfig.meta,
      }).toEqual({
        oneConfigIsSame: true,
        deepConfigIsSame: true,
        deepConfigMeta: 'testing meta',
      })
    })
  })

  describe('machine.provide', () => {
    // https://github.com/davidkpiano/xstate/issues/674
    it('should throw if initial state is missing in a compound state', function*({ expect }) {
      yield* expect(() => {
        createMachine({
          initial: 'first',
          states: {
            first: {
              states: {
                second: {},
                third: {},
              },
            },
          },
        })
      }).toThrow(
        'No initial state specified for compound state node "#(machine).first". Try adding { initial: "second" } to the state config.',
      )
    })

    it('machines defined without context should have a default empty object for context', function*({
      expect,
    }) {
      yield* expect(createActor(createMachine({})).getSnapshot().context).toEqual({})
    })

    it(
      'should lazily create context for all interpreter instances created from the same machine template created by `provide`',
      function*({
        expect,
      }) {
        const machine = createMachine({
          schemas: {
            context: z.object({
              foo: z.object({
                prop: z.string(),
              }),
            }),
          },
          context: () => ({
            foo: { prop: 'baz' },
          }),
        })

        const copiedMachine = machine.provide({})

        const a = createActor(copiedMachine).start()
        const b = createActor(copiedMachine).start()

        yield* expect(a.getSnapshot().context.foo).not.toBe(b.getSnapshot().context.foo)
      },
    )
  })

  describe('machine function context', () => {
    it('context from a function should be lazily evaluated', function*({ expect }) {
      const config = {
        initial: 'active',
        context: () => ({
          foo: { bar: 'baz' },
        }),
        states: {
          active: {},
        },
      }
      const testMachine1 = createMachine(config)
      const testMachine2 = createMachine(config)

      const initialState1 = createActor(testMachine1).getSnapshot()
      const initialState2 = createActor(testMachine2).getSnapshot()

      yield* expect({
        derivedContextsAreDistinct: initialState1.context !== initialState2.context,
        firstContext: initialState1.context,
        secondContext: initialState2.context,
      }).toEqual({
        derivedContextsAreDistinct: true,
        firstContext: {
          foo: { bar: 'baz' },
        },
        secondContext: {
          foo: { bar: 'baz' },
        },
      })
    })
  })

  describe('machine.resolveState()', () => {
    const resolveMachine = createMachine({
      id: 'resolve',
      initial: 'foo',
      states: {
        foo: {
          initial: 'one',
          states: {
            one: {
              type: 'parallel',
              states: {
                a: {
                  initial: 'aa',
                  states: { aa: {} },
                },
                b: {
                  initial: 'bb',
                  states: { bb: {} },
                },
              },
              on: {
                TO_TWO: { target: 'two' },
              },
            },
            two: {
              on: { TO_ONE: { target: 'one' } },
            },
          },
          on: {
            TO_BAR: { target: 'bar' },
          },
        },
        bar: {
          on: {
            TO_FOO: { target: 'foo' },
          },
        },
      },
    })

    it('should resolve the state value', function*({ expect }) {
      const resolvedState = resolveMachine.resolveState({ value: 'foo' })

      yield* expect(resolvedState.value).toEqual({
        foo: { one: { a: 'aa', b: 'bb' } },
      })
    })

    it('should resolve `status: done`', function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {
            on: { NEXT: { target: 'bar' } },
          },
          bar: {
            type: 'final',
          },
        },
      })

      const resolvedState = machine.resolveState({ value: 'bar' })

      yield* expect(resolvedState.status).toBe('done')
    })
  })

  describe('initial state', () => {
    it('should follow always transition', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            always: { target: 'b' },
          },
          b: {},
        },
      })

      yield* expect(createActor(machine).getSnapshot().value).toBe('b')
    })
  })

  describe('versioning', () => {
    it('should allow a version to be specified', function*({ expect }) {
      const versionMachine = createMachine({
        id: 'version',
        version: '1.0.4',
        states: {},
      })

      yield* expect(versionMachine.version).toEqual('1.0.4')
    })
  })

  describe('id', () => {
    it('should represent the ID', function*({ expect }) {
      const idMachine = createMachine({
        id: 'some-id',
        initial: 'idle',
        states: { idle: {} },
      })

      yield* expect(idMachine.id).toEqual('some-id')
    })

    it('should represent the ID (state node)', function*({ expect }) {
      const idMachine = createMachine({
        id: 'some-id',
        initial: 'idle',
        states: {
          idle: {
            id: 'idle',
          },
        },
      })

      const idleState = idMachine.states['idle']
      if (idleState === undefined) {
        throw new Error('expected an idle state')
      }
      yield* expect(idleState.id).toEqual('idle')
    })

    it('should use the key as the ID if no ID is provided (state node)', function*({
      expect,
    }) {
      const noStateNodeIDMachine = createMachine({
        id: 'some-id',
        initial: 'idle',
        states: { idle: {} },
      })

      const idleState = noStateNodeIDMachine.states['idle']
      if (idleState === undefined) {
        throw new Error('expected an idle state')
      }
      yield* expect(idleState.id).toEqual('some-id.idle')
    })
  })

  describe('combinatorial machines', () => {
    it('should support combinatorial machines (single-state)', function*({ expect }) {
      const testMachine = createMachine({
        schemas: {
          context: z.object({ value: z.number() }),
        },
        context: { value: 42 },
        on: {
          INC: ({ context }) => ({
            context: {
              value: context.value + 1,
            },
          }),
        },
      })

      const actorRef = createActor(testMachine)
      const initialValue = actorRef.getSnapshot().value

      actorRef.start()
      actorRef.send({ type: 'INC' })

      yield* expect({
        initialValue,
        contextValue: actorRef.getSnapshot().context.value,
      }).toEqual({ initialValue: {}, contextValue: 43 })
    })
  })

  it('should pass through schemas', function*({ expect }) {
    const contextSchema = z.object({ count: z.number() })
    const machine = createMachine({
      schemas: {
        context: contextSchema,
      },
      context: () => ({ count: 42 }),
    })

    yield* expect({
      keys: Object.keys(machine.schemas ?? {}),
      contextIsDeclaredSchema: Object.is(machine.schemas?.context, contextSchema),
    }).toEqual({ keys: ['context'], contextIsDeclaredSchema: true })
  })
})

describe('StateNode', () => {
  it('should list transitions', function*({ expect }) {
    const greenNode = lightMachine.states['green']
    if (greenNode === undefined) {
      throw new Error('expected a green state node')
    }

    const transitions = greenNode.transitions

    yield* expect([...transitions.keys()]).toEqual([
      'TIMER',
      'POWER_OUTAGE',
      'FORBIDDEN_EVENT',
    ])
  })
})

describe('typestates', () => {
  it('testing', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          user: z.string().nullable(),
        }),
      },
      context: {
        user: null,
      },
      initial: 'active',
      states: {
        active: {
          contextSchema: z.object({
            user: z.string(),
          }),
          on: {
            ACTIVATE: (x) => ({
              target: 'inactive',
              context: {
                ...x.context,
                user: 'test',
              },
            }),
          },
        },
        inactive: {
          contextSchema: z.object({
            user: z.null(),
          }),
        },
      },
    })

    yield* expect(Object.keys(machine.states)).toEqual(['active', 'inactive'])
  })
})
