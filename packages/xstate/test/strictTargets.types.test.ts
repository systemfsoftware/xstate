import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, setup, types } from '../src/index.js'

describe('strict authored targets', () => {
  it('requires defaults for authored history states', function*({ expect }) {
    if (false) {
      // @ts-expect-error - authored history states require an SCXML default target
      createMachine({
        initial: 'flow',
        states: {
          flow: {
            initial: 'idle',
            states: {
              idle: {},
              history: { history: 'deep' },
            },
          },
        },
      })
    }

    const machine = createMachine({
      initial: 'flow',
      states: {
        flow: {
          initial: 'idle',
          states: {
            idle: {},
            history: { type: 'history', target: 'idle' },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual({ flow: 'idle' })
  })

  it('rejects empty history default target sets', function*({ expect }) {
    if (false) {
      // @ts-expect-error - an SCXML default transition needs at least one target
      createMachine({
        initial: 'flow',
        states: {
          flow: {
            initial: 'idle',
            states: {
              idle: {},
              history: { type: 'history', target: [] },
            },
          },
        },
      })
    }

    const machine = createMachine({
      initial: 'flow',
      states: {
        flow: {
          initial: 'idle',
          states: {
            idle: {},
            history: { type: 'history', target: ['idle'] },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual({ flow: 'idle' })
  })

  it('rejects an unknown literal descendant target', function*({ expect }) {
    const s = setup({
      schemas: {
        events: {
          GO: types<{}>(),
        },
      },
      states: {
        flow: {
          states: {
            idle: {},
            done: {},
          },
        },
      },
    })

    if (false) {
      // @ts-expect-error - `.missing` is not a descendant of `flow`
      s.createMachine({
        initial: 'flow',
        states: {
          flow: {
            initial: 'idle',
            on: {
              GO: { target: '.missing' },
            },
            states: {
              idle: {},
              done: {},
            },
          },
        },
      })
    }

    yield* expect(Object.keys(s.states)).toEqual(['flow'])
  })

  it('rejects an unknown literal state ID target', function*({ expect }) {
    const s = setup({
      schemas: { events: { GO: types<{}>() } },
      states: { idle: {}, done: {} },
    })

    if (false) {
      s.createMachine({
        id: 'root',
        initial: 'idle',
        states: {
          idle: {
            on: {
              // @ts-expect-error - no state declares the ID `missing`
              GO: {
                target: '#missing',
              },
            },
          },
          done: { id: 'finished' },
        },
      })
    }

    yield* expect(Object.keys(s.states)).toEqual(['idle', 'done'])
  })

  it('rejects literal target sets that select two children of one compound state', function*({ expect }) {
    if (false) {
      // @ts-expect-error - `left` is compound and cannot activate both children
      createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: {
              GO: { target: ['parallel.left.a', 'parallel.left.b'] },
            },
          },
          parallel: {
            type: 'parallel',
            states: {
              left: { initial: 'a', states: { a: {}, b: {} } },
              right: { initial: 'c', states: { c: {}, d: {} } },
            },
          },
        },
      })
    }

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            GO: { target: ['parallel.left.a', 'parallel.right.c'] },
          },
        },
        parallel: {
          type: 'parallel',
          states: {
            left: { initial: 'a', states: { a: {}, b: {} } },
            right: { initial: 'c', states: { c: {}, d: {} } },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('accepts a legal partial or complete parallel target specification', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            PARTIAL: { target: 'parallel.left.b' },
            COMPLETE: {
              target: ['parallel.left.b', 'parallel.right.d'],
            },
          },
        },
        parallel: {
          type: 'parallel',
          states: {
            left: { initial: 'a', states: { a: {}, b: {} } },
            right: { initial: 'c', states: { c: {}, d: {} } },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('rejects a target set containing an ancestor and its descendant', function*({ expect }) {
    if (false) {
      // @ts-expect-error - a legal SCXML target set cannot contain an ancestor and descendant
      createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: { GO: { target: ['parallel.left', 'parallel.left.b'] } },
          },
          parallel: {
            type: 'parallel',
            states: {
              left: { initial: 'a', states: { a: {}, b: {} } },
              right: { initial: 'c', states: { c: {}, d: {} } },
            },
          },
        },
      })
    }

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: { GO: { target: ['parallel.left.b', 'parallel.right.d'] } },
        },
        parallel: {
          type: 'parallel',
          states: {
            left: { initial: 'a', states: { a: {}, b: {} } },
            right: { initial: 'c', states: { c: {}, d: {} } },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('rejects a target set spanning different top-level roots', function*({ expect }) {
    if (false) {
      // @ts-expect-error - an SCXML configuration contains exactly one root child
      createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: { GO: { target: ['first.a', 'second.b'] } },
          },
          first: { initial: 'a', states: { a: {} } },
          second: { initial: 'b', states: { b: {} } },
        },
      })
    }

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: { GO: { target: ['parallel.first.a', 'parallel.second.b'] } },
        },
        parallel: {
          type: 'parallel',
          states: {
            first: { initial: 'a', states: { a: {} } },
            second: { initial: 'b', states: { b: {} } },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('rejects an unknown literal returned from a transition function', function*({ expect }) {
    const s = setup({
      schemas: { events: { GO: types<{}>() } },
      states: {
        flow: { states: { idle: {}, done: {} } },
      },
    })

    if (false) {
      // @ts-expect-error - the returned descendant target does not exist
      s.createMachine({
        initial: 'flow',
        states: {
          flow: {
            initial: 'idle',
            on: { GO: () => ({ target: '.missing' }) },
            states: { idle: {}, done: {} },
          },
        },
      })
    }

    yield* expect(Object.keys(s.states)).toEqual(['flow'])
  })

  it('rejects an unknown literal initial target', function*({ expect }) {
    if (false) {
      // @ts-expect-error - `missing` is not a child of `flow`
      createMachine({
        initial: 'flow',
        states: {
          flow: {
            initial: 'missing',
            states: { idle: {}, done: {} },
          },
        },
      })
    }

    const machine = createMachine({
      initial: 'flow',
      states: {
        flow: {
          initial: 'idle',
          states: { idle: {}, done: {} },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual({ flow: 'idle' })
  })

  it('accepts a legal multi-target default for deep parallel history', function*({ expect }) {
    const machine = createMachine({
      initial: 'parallel',
      states: {
        parallel: {
          type: 'parallel',
          states: {
            left: { initial: 'a', states: { a: {}, b: {} } },
            right: { initial: 'c', states: { c: {}, d: {} } },
            history: {
              type: 'history',
              history: 'deep',
              target: ['left.b', 'right.d'],
            },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual({
      parallel: { left: 'a', right: 'c' },
    })
  })

  it('resolves bare targets as siblings of source keys containing dots', function*({ expect }) {
    const machine = createMachine({
      initial: 'foo.bar',
      states: {
        'foo.bar': {
          on: { NEXT: { target: 'done' } },
        },
        done: {},
      },
    })

    yield* expect({
      value: machine.getInitialSnapshot().value,
      keys: Object.keys(machine.root.states),
    }).toEqual({ value: 'foo.bar', keys: ['foo.bar', 'done'] })
  })

  it('resolves escaped dots in target paths as literal key dots', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: { on: { NEXT: { target: 'foo\\.bar' } } },
        'foo.bar': {},
        foo: { initial: 'bar', states: { bar: {} } },
      },
    })

    const startState = machine.root.states['start']
    if (startState === undefined) {
      throw new Error('expected the start state')
    }

    yield* expect(startState.transitions.get('NEXT')?.[0]?.target?.[0]?.key).toEqual('foo.bar')
  })

  it('applies SCXML target-set legality to state ID targets', function*({ expect }) {
    if (false) {
      // @ts-expect-error - both IDs select children of the same compound state
      createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: { INVALID: { target: ['#leftA', '#leftB'] } },
          },
          parallel: {
            type: 'parallel',
            states: {
              left: {
                initial: 'a',
                states: {
                  a: { id: 'leftA' },
                  b: { id: 'leftB' },
                },
              },
              right: {
                initial: 'c',
                states: {
                  c: { id: 'rightC' },
                  d: { id: 'rightD' },
                },
              },
            },
          },
        },
      })
    }

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: { VALID: { target: ['#leftB', '#rightD'] } },
        },
        parallel: {
          type: 'parallel',
          states: {
            left: {
              initial: 'a',
              states: { a: { id: 'leftA' }, b: { id: 'leftB' } },
            },
            right: {
              initial: 'c',
              states: { c: { id: 'rightC' }, d: { id: 'rightD' } },
            },
          },
        },
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })

  it('localizes validation escape hatches to opaque state subtrees', function*({ expect }) {
    const opaqueState = {} as any

    if (false) {
      // @ts-expect-error - an opaque sibling does not disable concrete validation
      createMachine({
        initial: 'idle',
        states: {
          idle: { on: { GO: { target: 'missing' } } },
          opaque: opaqueState,
        },
      })
    }

    if (false) {
      createMachine({
        initial: 'idle',
        states: {
          idle: { on: { GO: { target: 'opaque.dynamicChild' } } },
          opaque: opaqueState,
        },
      })
    }

    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {},
        opaque: opaqueState,
      },
    })

    yield* expect(machine.getInitialSnapshot().value).toEqual('idle')
  })
})
