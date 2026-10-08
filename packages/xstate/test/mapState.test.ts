import { describe, it } from '@systemfsoftware/vitest'
import { createActor, mapState, setup, types } from '../src/index.js'

describe('mapState', (it) => {
  it('should map context from root state', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ count: number }>(),
      },
    }).createMachine({
      context: { count: 42 },
      initial: 'a',
      states: {
        a: {},
      },
    })

    const snapshot = createActor(machine).getSnapshot()

    const results = mapState(snapshot, {
      map: ({ context }) => context.count,
    })

    yield* expect({
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
    }).toEqual({ keys: ['(machine)'], results: [42] })
  })

  it('should map context from nested states', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ value: string }>(),
      },
    }).createMachine({
      context: { value: 'test' },
      initial: 'a',
      states: {
        a: {
          initial: 'one',
          states: {
            one: {},
            two: {},
          },
        },
      },
    })

    const snapshot = createActor(machine).getSnapshot()

    const results = mapState(snapshot, {
      map: ({ context }) => `root:${context.value}`,
      states: {
        a: {
          map: ({ context }) => `a:${context.value}`,
          states: {
            one: {
              map: ({ context }) => `one:${context.value}`,
            },
          },
        },
      },
    })

    yield* expect({
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
    }).toEqual({
      keys: ['one', 'a', '(machine)'],
      results: ['one:test', 'a:test', 'root:test'],
    })
  })

  it('should only call mappers for active states', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ x: number }>(),
      },
    }).createMachine({
      context: { x: 1 },
      initial: 'a',
      states: {
        a: {},
        b: {},
      },
    })

    const snapshot = createActor(machine).getSnapshot()

    const results = mapState(snapshot, {
      map: () => 'root',
      states: {
        a: {
          map: () => 'a',
        },
        b: {
          map: () => 'b',
        },
      },
    })

    yield* expect({
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
    }).toEqual({ keys: ['a', '(machine)'], results: ['a', 'root'] })
  })

  it('should work with parallel states', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ val: number }>(),
      },
    }).createMachine({
      context: { val: 100 },
      type: 'parallel',
      states: {
        region1: {
          initial: 'x',
          states: {
            x: {},
            y: {},
          },
        },
        region2: {
          initial: 'p',
          states: {
            p: {},
            q: {},
          },
        },
      },
    })

    const snapshot = createActor(machine).getSnapshot()

    const results = mapState(snapshot, {
      map: () => 'root',
      states: {
        region1: {
          map: () => 'region1',
          states: {
            x: {
              map: () => 'x',
            },
          },
        },
        region2: {
          map: () => 'region2',
          states: {
            p: {
              map: () => 'p',
            },
          },
        },
      },
    })

    yield* expect({
      count: results.length,
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
    }).toEqual({
      count: 5,
      keys: expect.arrayContaining([
        'x',
        'region1',
        '(machine)',
        'p',
        'region2',
      ]),
      results: expect.arrayContaining([
        'x',
        'region1',
        'root',
        'p',
        'region2',
      ]),
    })
  })

  it('should handle states without mappers', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: types<{ n: number }>(),
      },
    }).createMachine({
      context: { n: 5 },
      initial: 'a',
      states: {
        a: {
          initial: 'one',
          states: {
            one: {},
          },
        },
      },
    })

    const snapshot = createActor(machine).getSnapshot()

    const results = mapState(snapshot, {
      map: () => 'root',
      states: {
        a: {
          map: () => 'a',
          states: {
            one: {
              map: () => 'one',
            },
          },
        },
      },
    })

    yield* expect({
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
    }).toEqual({
      keys: ['one', 'a', '(machine)'],
      results: ['one', 'a', 'root'],
    })
  })

  it('should work with final states', function*({ expect }) {
    const machine = setup({}).createMachine({
      initial: 'active',
      states: {
        active: {
          on: { DONE: { target: 'finished' } },
        },
        finished: {
          type: 'final',
        },
      },
    })

    const actor = createActor(machine)
    actor.start()
    actor.send({ type: 'DONE' })
    const snapshot = actor.getSnapshot()

    const results = mapState(snapshot, {
      map: () => 'root',
      states: {
        finished: {
          map: () => 'finished',
        },
      },
    })

    yield* expect({
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
    }).toEqual({
      keys: ['finished', '(machine)'],
      results: ['finished', 'root'],
    })
  })

  it('should include stateNode in results', function*({ expect }) {
    const machine = setup({}).createMachine({
      initial: 'a',
      states: {
        a: {
          initial: 'one',
          states: {
            one: {},
          },
        },
      },
    })

    const snapshot = createActor(machine).getSnapshot()

    const results = mapState(snapshot, {
      map: () => 'root',
      states: {
        a: {
          map: () => 'a',
          states: {
            one: {
              map: () => 'one',
            },
          },
        },
      },
    })

    if (
      results[0] === undefined ||
      results[1] === undefined ||
      results[2] === undefined
    ) {
      throw new Error('expected three mapped states')
    }

    yield* expect({
      keys: results.map((r) => r.stateNode.key),
      results: results.map((r) => r.result),
      rootPath: results[2].stateNode.path,
    }).toEqual({
      keys: ['one', 'a', '(machine)'],
      results: ['one', 'a', 'root'],
      rootPath: [],
    })
  })

  describe('type safety', (it) => {
    it('should accept valid state keys', function*({ expect }) {
      const machine = setup({
        schemas: {
          context: types<{ foo: string }>(),
        },
      }).createMachine({
        context: { foo: 'bar' },
        initial: 'idle',
        states: {
          idle: {},
          loading: {},
          success: {},
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState(snapshot, {
        map: ({ context }) => context.foo,
        states: {
          idle: {
            map: ({ context }) => context.foo,
          },
          loading: {
            map: ({ context }) => context.foo,
          },
          success: {
            map: ({ context }) => context.foo,
          },
        },
      })

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        results: results.map((r) => r.result),
      }).toEqual({ keys: ['idle', '(machine)'], results: ['bar', 'bar'] })
    })

    it('should error on invalid state keys', function*({ expect }) {
      const machine = setup({
        schemas: {
          context: types<{ foo: string }>(),
        },
      }).createMachine({
        context: { foo: 'bar' },
        initial: 'idle',
        states: {
          idle: {},
          loading: {},
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState(snapshot, {
        map: ({ context }) => context.foo,
        states: {
          idle: {
            map: ({ context }) => context.foo,
          },
          // @ts-expect-error - 'nonexistent' is not a valid state key
          nonexistent: {
            map: (_snapshot: any) => _snapshot.context.foo,
          },
        },
      })

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        results: results.map((r) => r.result),
      }).toEqual({ keys: ['idle', '(machine)'], results: ['bar', 'bar'] })
    })

    it('should error on invalid nested state keys', function*({ expect }) {
      const machine = setup({
        schemas: {
          context: types<{ val: number }>(),
        },
      }).createMachine({
        context: { val: 0 },
        initial: 'parent',
        states: {
          parent: {
            initial: 'child1',
            states: {
              child1: {},
              child2: {},
            },
          },
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState(snapshot, {
        map: ({ context }) => context.val,
        states: {
          parent: {
            map: ({ context }) => context.val,
            states: {
              child1: {
                map: ({ context }) => context.val,
              },
              // @ts-expect-error - 'invalidChild' is not a valid nested state key
              invalidChild: {
                map: (_snapshot: any) => _snapshot.context.val,
              },
            },
          },
        },
      })

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        results: results.map((r) => r.result),
      }).toEqual({
        keys: ['child1', 'parent', '(machine)'],
        results: [0, 0, 0],
      })
    })

    it('should infer snapshot type in map function', function*({ expect }) {
      const machine = setup({
        schemas: {
          context: types<{ count: number; name: string }>(),
        },
      }).createMachine({
        context: { count: 0, name: 'test' },
        initial: 'idle',
        states: {
          idle: {},
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState(snapshot, {
        map: ({ context }) => {
          const n: number = context.count
          const s: string = context.name
          return { n, s }
        },
      })

      yield* expect(results.map((r) => r.result)).toEqual([
        { n: 0, s: 'test' },
      ])
    })

    it('should enforce consistent TResult type across all map functions', function*({
      expect,
    }) {
      const machine = setup({
        schemas: {
          context: types<{ count: number }>(),
        },
      }).createMachine({
        context: { count: 0 },
        initial: 'a',
        states: {
          a: {
            initial: 'one',
            states: {
              one: {},
            },
          },
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState<typeof snapshot, number>(snapshot, {
        map: () => 42,
        states: {
          a: {
            map: () => 100,
            states: {
              one: {
                map: () => 200,
              },
            },
          },
        },
      })

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        results: results.map((r) => r.result),
      }).toEqual({
        keys: ['one', 'a', '(machine)'],
        results: [200, 100, 42],
      })
    })

    it('should error when nested map returns wrong type', function*({
      expect,
    }) {
      const machine = setup({
        schemas: {
          context: types<{ count: number }>(),
        },
      }).createMachine({
        context: { count: 0 },
        initial: 'a',
        states: {
          a: {},
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState<typeof snapshot, number>(snapshot, {
        map: () => 42,
        states: {
          a: {
            // @ts-expect-error - boolean is not assignable to number
            map: () => true,
          },
        },
      })

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        results: results.map((r) => r.result),
      }).toEqual({ keys: ['a', '(machine)'], results: [true, 42] })
    })

    it('should error when deeply nested map returns wrong type', function*({
      expect,
    }) {
      const machine = setup({
        schemas: {
          context: types<{ val: string }>(),
        },
      }).createMachine({
        context: { val: 'test' },
        initial: 'parent',
        states: {
          parent: {
            initial: 'child',
            states: {
              child: {},
            },
          },
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState<typeof snapshot, string>(snapshot, {
        map: () => 'root',
        states: {
          parent: {
            map: () => 'parent',
            states: {
              child: {
                // @ts-expect-error - number is not assignable to string
                map: () => 123,
              },
            },
          },
        },
      })

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        results: results.map((r) => r.result),
      }).toEqual({
        keys: ['child', 'parent', '(machine)'],
        results: [123, 'parent', 'root'],
      })
    })

    it('should infer result type in return value', function*({ expect }) {
      const machine = setup({}).createMachine({
        initial: 'idle',
        states: {
          idle: {},
        },
      })

      const snapshot = createActor(machine).getSnapshot()

      const results = mapState<typeof snapshot, number>(snapshot, {
        map: () => 42,
      })

      if (results[0] === undefined) {
        throw new Error('expected a first result')
      }

      results[0].result satisfies number
      // @ts-expect-error
      results[0].result satisfies string

      yield* expect({
        keys: results.map((r) => r.stateNode.key),
        result: results[0].result,
      }).toEqual({ keys: ['(machine)'], result: 42 })
    })
  })
})
