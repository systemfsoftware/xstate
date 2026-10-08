import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createCallbackLogic, createMachine } from '../src/index.js'
import { StateNode } from '../src/StateNode.js'
import { trackEntries } from './utils.js'

describe('history states', (it) => {
  it('rejects a history state without a non-empty default target at runtime', function*({ expect }) {
    yield* expect(() =>
      (createMachine as any)({
        initial: 'on',
        states: {
          on: {
            initial: 'active',
            states: {
              active: {},
              history: { type: 'history' },
            },
          },
        },
      })
    ).toThrow(
      'History state "(machine).on.history" must declare a non-empty `target`.',
    )
  })

  it('should go to the most recently visited state (explicit shallow history type)', function*({ expect }) {
    const machine = createMachine({
      initial: 'on',
      states: {
        on: {
          initial: 'first',
          states: {
            first: {
              on: { SWITCH: { target: 'second' } },
            },
            second: {},
            hist: {
              type: 'history',
              history: 'shallow',
              target: 'first',
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
        off: {
          on: { POWER: { target: 'on.hist' } },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ on: 'second' })
  })

  it('should go to the most recently visited state (no explicit history type)', function*({ expect }) {
    const machine = createMachine({
      initial: 'on',
      states: {
        on: {
          initial: 'first',
          states: {
            first: {
              on: { SWITCH: { target: 'second' } },
            },
            second: {},
            hist: {
              type: 'history',
              target: 'first',
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
        off: {
          on: { POWER: { target: 'on.hist' } },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ on: 'second' })
  })

  it('should go to the initial state when no history present (explicit shallow history type)', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: { POWER: { target: 'on.hist' } },
        },
        on: {
          initial: 'first',
          states: {
            first: {},
            second: {},
            hist: {
              type: 'history',
              history: 'shallow',
              target: 'first',
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ on: 'first' })
  })

  it('should go to the initial state when no history present (no explicit history type)', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: { POWER: { target: 'on.hist' } },
        },
        on: {
          initial: 'first',
          states: {
            first: {},
            second: {},
            hist: {
              type: 'history',
              target: 'first',
            },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ on: 'first' })
  })

  it('should go to the most recently visited state by a transient transition', function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          id: 'idle',
          initial: 'absent',
          states: {
            absent: {
              on: {
                DEPLOY: { target: '#deploy' },
              },
            },
            present: {
              on: {
                DEPLOY: { target: '#deploy' },
                DESTROY: { target: '#destroy' },
              },
            },
            hist: {
              type: 'history',
              target: 'absent',
            },
          },
        },
        deploy: {
          id: 'deploy',
          on: {
            SUCCESS: { target: 'idle.present' },
            FAILURE: { target: 'idle.hist' },
          },
        },
        destroy: {
          id: 'destroy',
          always: { target: 'idle.absent' },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'DEPLOY' })
    actorRef.send({ type: 'SUCCESS' })
    actorRef.send({ type: 'DESTROY' })
    actorRef.send({ type: 'DEPLOY' })
    actorRef.send({ type: 'FAILURE' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ idle: 'absent' })
  })

  it('should reenter persisted state during reentering transition targeting a history state', function*({ expect }) {
    const actual: string[] = []

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            REENTER: {
              target: '#b_hist',
              reenter: true,
            },
          },
          initial: 'a1',
          states: {
            a1: {
              on: {
                NEXT: { target: 'a2' },
              },
            },
            a2: {
              // TODO: investigate why enq(actual.push, 'a2 entered') throws
              entry: (_, enq) => enq(() => actual.push('a2 entered')),
              exit: (_, enq) => enq(() => actual.push('a2 exited')),
            },
            a3: {
              type: 'history',
              id: 'b_hist',
              target: 'a1',
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'NEXT' })

    actual.length = 0
    actorRef.send({ type: 'REENTER' })

    yield* expect(actual).toEqual(['a2 exited', 'a2 entered'])
  })

  it(
    'should go to the configured default target when a history state is the initial state of the machine',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {
            type: 'history',
            target: 'bar',
          },
          bar: {},
        },
      })

      const actorRef = createActor(machine).start()

      yield* expect(actorRef.getSnapshot().value).toBe('bar')
    },
  )

  it(
    `should go to the configured default target when a history state is the initial state of the transition's target`,
    function*({ expect }) {
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {
            on: {
              NEXT: { target: 'bar' },
            },
          },
          bar: {
            initial: 'baz',
            states: {
              baz: {
                type: 'history',
                target: 'qwe',
              },
              qwe: {},
            },
          },
        },
      })

      const actorRef = createActor(machine).start()

      actorRef.send({ type: 'NEXT' })

      yield* expect(actorRef.getSnapshot().value).toEqual({
        bar: 'qwe',
      })
    },
  )

  it('should enter a legal multi-target default for deep parallel history', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: { on: { POWER: { target: 'on.hist' } } },
        on: {
          type: 'parallel',
          states: {
            A: { initial: 'B', states: { B: {}, C: {} } },
            K: { initial: 'L', states: { L: {}, M: {} } },
            hist: {
              type: 'history',
              history: 'deep',
              target: ['A.C', 'K.M'],
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: { A: 'C', K: 'M' },
    })
  })

  it(
    'should execute parent entry actions when a history default is used before its parent was visited',
    function*({ expect }) {
      const calls: Array<ReadonlyArray<unknown>> = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }

      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: '#hist' } },
          },
          b: {
            // initial: {
            //   target: 'b1',
            //   actions: spy
            // },
            entry: (_, enq) => enq(record),
            initial: 'b1',
            states: {
              b1: {},
              b2: {
                id: 'hist',
                type: 'history',
                target: 'b1',
              },
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })

      yield* expect(calls).toEqual([[]])
    },
  )

  it('should enter a deep parallel history default before its parent was visited', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: { GO: { target: 'on.hist' } },
        },
        on: {
          type: 'parallel',
          states: {
            regA: { initial: 'a1', states: { a1: {}, a2: {} } },
            regB: { initial: 'b1', states: { b1: {}, b2: {} } },
            hist: {
              type: 'history',
              history: 'deep',
              target: ['regA.a1', 'regB.b1'],
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'GO' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: { regA: 'a1', regB: 'b1' },
    })
  })

  it('should enter a shallow parallel history default before its parent was visited', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: { GO: { target: 'on.hist' } },
        },
        on: {
          type: 'parallel',
          states: {
            regA: { initial: 'a1', states: { a1: {}, a2: {} } },
            regB: { initial: 'b1', states: { b1: {}, b2: {} } },
            hist: {
              type: 'history',
              history: 'shallow',
              target: ['regA', 'regB'],
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'GO' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: { regA: 'a1', regB: 'b1' },
    })
  })

  // TODO: discuss - the workaround is that the entry action should be
  // on the b1 state node instead of the b state node
  it.skip(
    'should not execute actions of the initial transition when a history state with a default target is targeted and its parent state was never visited yet',
    function*({ expect }) {
      const calls: Array<ReadonlyArray<unknown>> = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: '#hist' } },
          },
          b: {
            // initial: {
            //   target: 'b1',
            //   actions: spy
            // },
            entry: (_, enq) => enq(record),
            initial: 'b1',
            states: {
              b1: {},
              b2: {
                id: 'hist',
                type: 'history',
                target: 'b3',
              },
              b3: {},
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })

      yield* expect(calls).toEqual([])
    },
  )

  it(
    'should execute entry actions of a parent of the targeted history state when its parent state was never visited yet',
    function*({ expect }) {
      const calls: Array<ReadonlyArray<unknown>> = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: '#hist' } },
          },
          b: {
            entry: (args, enq) => {
              enq(record)
            },
            initial: 'b1',
            states: {
              b1: {},
              b2: {
                id: 'hist',
                type: 'history',
                target: 'b3',
              },
              b3: {},
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })

      yield* expect(calls).toEqual([[]])
    },
  )

  it(
    'should execute actions of the initial transition when it select a history state as the initial state of its parent',
    function*({ expect }) {
      const calls: Array<ReadonlyArray<unknown>> = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: 'b' } },
          },
          b: {
            // initial: {
            //   target: 'b1',
            //   actions: spy
            // },
            entry: (_, enq) => enq(record),
            initial: 'b1',
            states: {
              b1: {
                id: 'hist',
                type: 'history',
                target: 'b2',
              },
              b2: {},
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })

      yield* expect(calls).toEqual([[]])
    },
  )

  // TODO: discuss - the workaround is that the entry action should be
  // on the b1 state node instead of the b state node
  it.skip('should execute parent entry actions when recorded history is restored', function*({ expect }) {
    const calls: Array<ReadonlyArray<unknown>> = []
    const record = (...args: unknown[]) => {
      calls.push(args)
    }

    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { NEXT: { target: '#hist' } },
        },
        b: {
          // initial: {
          //   target: 'b1',
          //   actions: spy
          // },
          entry: (_, enq) => enq(record),
          initial: 'b1',
          states: {
            b1: {},
            b2: {
              id: 'hist',
              type: 'history',
              target: 'b1',
            },
          },
          on: {
            NEXT: { target: 'a' },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })
    calls.length = 0

    actorRef.send({ type: 'NEXT' })
    actorRef.send({ type: 'NEXT' })

    yield* expect(calls).toEqual([])
  })

  // TODO: discuss - the workaround is that the entry action should be
  // on the b1 state node instead of the b state node
  it.skip(
    'should not execute actions of the initial transition when a history state with a default target is targeted and its parent state was already visited',
    function*({ expect }) {
      const calls: Array<ReadonlyArray<unknown>> = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: '#hist' } },
          },
          b: {
            // initial: {
            //   target: 'b1',
            //   actions: spy
            // },
            entry: (_, enq) => enq(record),
            initial: 'b1',
            states: {
              b1: {},
              b2: {
                id: 'hist',
                type: 'history',
                target: 'b3',
              },
              b3: {},
            },
            on: {
              NEXT: { target: 'a' },
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })
      calls.length = 0

      actorRef.send({ type: 'NEXT' })
      actorRef.send({ type: 'NEXT' })

      yield* expect(calls).toEqual([])
    },
  )

  it(
    'should execute entry actions of a parent of the targeted history state when its parent state was already visited',
    function*({ expect }) {
      const calls: Array<ReadonlyArray<unknown>> = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: { NEXT: { target: '#hist' } },
          },
          b: {
            entry: (args, enq) => {
              enq(record)
            },
            initial: 'b1',
            states: {
              b1: {},
              b2: {
                id: 'hist',
                type: 'history',
                target: 'b3',
              },
              b3: {},
            },
            on: {
              NEXT: { target: 'a' },
            },
          },
        },
      })

      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })
      calls.length = 0

      actorRef.send({ type: 'NEXT' })
      actorRef.send({ type: 'NEXT' })

      yield* expect(calls).toEqual([[]])
    },
  )

  it(
    'should invoke an actor when reentering the stored configuration through the history state',
    function*({ expect }) {
      const calls: unknown[] = []
      const record = (...args: unknown[]) => {
        calls.push(args)
      }

      const machine = createMachine({
        initial: 'running',
        states: {
          running: {
            on: {
              PING: {
                target: 'refresh',
              },
            },
            invoke: {
              src: createCallbackLogic(record),
            },
          },
          refresh: {
            type: 'history',
            target: 'running',
          },
        },
      })
      const actorRef = createActor(machine).start()
      calls.length = 0

      actorRef.send({ type: 'PING' })

      yield* expect(calls.length).toEqual(1)
    },
  )

  it(
    'should not enter ancestors of the entered history state that lie outside of the transition domain when entering the default history configuration',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'closed',
        states: {
          closed: {
            on: {
              'BUTTON.CLICK': { target: 'open.hist' },
            },
          },
          open: {
            on: {
              'BUTTON.CLICK': { target: 'closed' },
            },
            initial: 'first',
            states: {
              hist: { type: 'history', target: 'first' },
              first: {},
              second: {},
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actorRef = createActor(machine).start()
      flushTracked()

      actorRef.send({ type: 'BUTTON.CLICK' })
      yield* expect(flushTracked()).toEqual([
        'exit: closed',
        'enter: open',
        'enter: open.first',
      ])
    },
  )

  it(
    'should not enter ancestors of the entered history state that lie outside of the transition domain when restoring the stored history configuration',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'closed',
        states: {
          closed: {
            id: 'closed',
            on: {
              'BUTTON.CLICK': { target: 'open.hist' },
            },
          },
          open: {
            on: {
              'BUTTON.CLICK': { target: 'closed' },
            },
            initial: 'first',
            states: {
              hist: { type: 'history', target: 'first' },
              first: {
                on: {
                  NEXT: { target: 'second' },
                },
              },
              second: {
                on: {
                  CLOSE: { target: '#closed' },
                },
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actorRef = createActor(machine).start()

      actorRef.send({ type: 'BUTTON.CLICK' })
      actorRef.send({ type: 'NEXT' })
      actorRef.send({ type: 'CLOSE' })

      flushTracked()

      actorRef.send({ type: 'BUTTON.CLICK' })
      yield* expect(flushTracked()).toEqual([
        'exit: closed',
        'enter: open',
        'enter: open.second',
      ])
    },
  )
})

describe('deep history states', (it) => {
  it('should go to the shallow history', function*({ expect }) {
    const machine = createMachine({
      initial: 'on',
      states: {
        off: {
          on: {
            POWER: { target: 'on.history' },
          },
        },
        on: {
          initial: 'first',
          states: {
            first: {
              on: { SWITCH: { target: 'second' } },
            },
            second: {
              initial: 'A',
              states: {
                A: {
                  on: { INNER: { target: 'B' } },
                },
                B: {
                  initial: 'P',
                  states: {
                    P: {},
                    Q: {},
                  },
                },
              },
            },
            history: { history: 'shallow', target: 'first' },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        second: 'A',
      },
    })
  })

  it('should go to the deep history (explicit)', function*({ expect }) {
    const machine = createMachine({
      initial: 'on',
      states: {
        off: {
          on: {
            POWER: { target: 'on.history' },
          },
        },
        on: {
          initial: 'first',
          states: {
            first: {
              on: { SWITCH: { target: 'second' } },
            },
            second: {
              initial: 'A',
              states: {
                A: {
                  on: { INNER: { target: 'B' } },
                },
                B: {
                  initial: 'P',
                  states: {
                    P: {},
                    Q: {},
                  },
                },
              },
            },
            history: { history: 'deep', target: 'first' },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        second: {
          B: 'P',
        },
      },
    })
  })

  it('should go to the deepest history', function*({ expect }) {
    const machine = createMachine({
      initial: 'on',
      states: {
        off: {
          on: {
            POWER: { target: 'on.history' },
          },
        },
        on: {
          initial: 'first',
          states: {
            first: {
              on: { SWITCH: { target: 'second' } },
            },
            second: {
              initial: 'A',
              states: {
                A: {
                  on: { INNER: { target: 'B' } },
                },
                B: {
                  initial: 'P',
                  states: {
                    P: {
                      on: { INNER: { target: 'Q' } },
                    },
                    Q: {},
                  },
                },
              },
            },
            history: { history: 'deep', target: 'first' },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER' })
    actorRef.send({ type: 'INNER' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        second: {
          B: 'Q',
        },
      },
    })
  })
})

describe('parallel history states', (it) => {
  it('should ignore parallel state history', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: {
            SWITCH: { target: 'on' },
            POWER: { target: 'on.hist' },
          },
        },
        on: {
          type: 'parallel',
          states: {
            A: {
              initial: 'B',
              states: {
                B: {
                  on: { INNER_A: { target: 'C' } },
                },
                C: {
                  initial: 'D',
                  states: {
                    D: {},
                    E: {},
                  },
                },
                hist: { history: true, target: 'B' },
              },
            },
            K: {
              initial: 'L',
              states: {
                L: {},
                M: {},
                hist: { history: true, target: 'L' },
                deepHistory: {
                  history: 'deep',
                  target: 'L',
                },
              },
            },
            hist: {
              history: true,
              target: ['A', 'K'],
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        A: 'B',
        K: 'L',
      },
    })
  })

  it('should remember first level state history', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: {
            SWITCH: { target: 'on' },
            DEEP_POWER: { target: 'on.deepHistory' },
          },
        },
        on: {
          type: 'parallel',
          states: {
            A: {
              initial: 'B',
              states: {
                B: {
                  on: { INNER_A: { target: 'C' } },
                },
                C: {
                  initial: 'D',
                  states: {
                    D: {},
                    E: {},
                  },
                },
                hist: { history: true, target: 'B' },
                deepHistory: {
                  history: 'deep',
                  target: 'B',
                },
              },
            },
            K: {
              initial: 'L',
              states: {
                L: {},
                M: {},
                hist: { history: true, target: 'L' },
                deepHistory: {
                  history: 'deep',
                  target: 'L',
                },
              },
            },
            deepHistory: {
              history: 'deep',
              target: ['A.B', 'K.L'],
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'DEEP_POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        A: {
          C: 'D',
        },
        K: 'L',
      },
    })
  })

  it('should re-enter each regions of parallel state correctly', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: {
            SWITCH: { target: 'on' },
            DEEP_POWER: { target: 'on.deepHistory' },
          },
        },
        on: {
          type: 'parallel',
          states: {
            A: {
              initial: 'B',
              states: {
                B: {
                  on: { INNER_A: { target: 'C' } },
                },
                C: {
                  initial: 'D',
                  states: {
                    D: {
                      on: { INNER_A: { target: 'E' } },
                    },
                    E: {},
                  },
                },
                hist: { history: true, target: 'B' },
                deepHistory: {
                  history: 'deep',
                  target: 'B',
                },
              },
            },
            K: {
              initial: 'L',
              states: {
                L: {
                  on: { INNER_K: { target: 'M' } },
                },
                M: {
                  initial: 'N',
                  states: {
                    N: {
                      on: { INNER_K: { target: 'O' } },
                    },
                    O: {},
                  },
                },
                hist: { history: true, target: 'L' },
                deepHistory: {
                  history: 'deep',
                  target: 'L',
                },
              },
            },
            hist: {
              history: true,
              target: ['A', 'K'],
            },
            shallowHistory: {
              history: 'shallow',
              target: ['A', 'K'],
            },
            deepHistory: {
              history: 'deep',
              target: ['A.B', 'K.L'],
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'DEEP_POWER' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        A: { C: 'E' },
        K: { M: 'O' },
      },
    })
  })

  it('should re-enter multiple history states', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: {
            SWITCH: { target: 'on' },
            PARALLEL_HISTORY: {
              target: ['on.A.hist', 'on.K.hist'],
            },
          },
        },
        on: {
          type: 'parallel',
          states: {
            A: {
              initial: 'B',
              states: {
                B: {
                  on: { INNER_A: { target: 'C' } },
                },
                C: {
                  initial: 'D',
                  states: {
                    D: {
                      on: { INNER_A: { target: 'E' } },
                    },
                    E: {},
                  },
                },
                hist: { history: true, target: 'B' },
                deepHistory: {
                  history: 'deep',
                  target: 'B',
                },
              },
            },
            K: {
              initial: 'L',
              states: {
                L: {
                  on: { INNER_K: { target: 'M' } },
                },
                M: {
                  initial: 'N',
                  states: {
                    N: {
                      on: { INNER_K: { target: 'O' } },
                    },
                    O: {},
                  },
                },
                hist: { history: true, target: 'L' },
                deepHistory: {
                  history: 'deep',
                  target: 'L',
                },
              },
            },
            hist: {
              history: true,
              target: ['A', 'K'],
            },
            shallowHistory: {
              history: 'shallow',
              target: ['A', 'K'],
            },
            deepHistory: {
              history: 'deep',
              target: ['A.B', 'K.L'],
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'PARALLEL_HISTORY' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        A: { C: 'D' },
        K: { M: 'N' },
      },
    })
  })

  it('should re-enter a parallel with partial history', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: {
            SWITCH: { target: 'on' },
            PARALLEL_SOME_HISTORY: {
              target: ['on.A.C', 'on.K.hist'],
            },
          },
        },
        on: {
          type: 'parallel',
          states: {
            A: {
              initial: 'B',
              states: {
                B: {
                  on: { INNER_A: { target: 'C' } },
                },
                C: {
                  initial: 'D',
                  states: {
                    D: {
                      on: { INNER_A: { target: 'E' } },
                    },
                    E: {},
                  },
                },
                hist: { history: true, target: 'B' },
                deepHistory: {
                  history: 'deep',
                  target: 'B',
                },
              },
            },
            K: {
              initial: 'L',
              states: {
                L: {
                  on: { INNER_K: { target: 'M' } },
                },
                M: {
                  initial: 'N',
                  states: {
                    N: {
                      on: { INNER_K: { target: 'O' } },
                    },
                    O: {},
                  },
                },
                hist: { history: true, target: 'L' },
                deepHistory: {
                  history: 'deep',
                  target: 'L',
                },
              },
            },
            hist: {
              history: true,
              target: ['A', 'K'],
            },
            shallowHistory: {
              history: 'shallow',
              target: ['A', 'K'],
            },
            deepHistory: {
              history: 'deep',
              target: ['A.B', 'K.L'],
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'PARALLEL_SOME_HISTORY' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        A: { C: 'D' },
        K: { M: 'N' },
      },
    })
  })

  it('should re-enter a parallel with full history', function*({ expect }) {
    const machine = createMachine({
      initial: 'off',
      states: {
        off: {
          on: {
            SWITCH: { target: 'on' },
            PARALLEL_DEEP_HISTORY: {
              target: ['on.A.deepHistory', 'on.K.deepHistory'],
            },
          },
        },
        on: {
          type: 'parallel',
          states: {
            A: {
              initial: 'B',
              states: {
                B: {
                  on: { INNER_A: { target: 'C' } },
                },
                C: {
                  initial: 'D',
                  states: {
                    D: {
                      on: { INNER_A: { target: 'E' } },
                    },
                    E: {},
                  },
                },
                hist: { history: true, target: 'B' },
                deepHistory: {
                  history: 'deep',
                  target: 'B',
                },
              },
            },
            K: {
              initial: 'L',
              states: {
                L: {
                  on: { INNER_K: { target: 'M' } },
                },
                M: {
                  initial: 'N',
                  states: {
                    N: {
                      on: { INNER_K: { target: 'O' } },
                    },
                    O: {},
                  },
                },
                hist: { history: true, target: 'L' },
                deepHistory: {
                  history: 'deep',
                  target: 'L',
                },
              },
            },
            hist: {
              history: true,
              target: ['A', 'K'],
            },
            shallowHistory: {
              history: 'shallow',
              target: ['A', 'K'],
            },
            deepHistory: {
              history: 'deep',
              target: ['A.B', 'K.L'],
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_A' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'INNER_K' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'PARALLEL_DEEP_HISTORY' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      on: {
        A: { C: 'E' },
        K: { M: 'O' },
      },
    })
  })
})

it(
  'internal transition to a history state should enter default history state configuration if the containing state has never been exited yet',
  function*({ expect }) {
    const service = createActor(
      createMachine({
        initial: 'first',
        states: {
          first: {
            on: {
              NEXT: { target: 'second.other' },
            },
          },
          second: {
            initial: 'nested',
            states: {
              nested: {},
              other: {},
              hist: {
                history: true,
                target: 'nested',
              },
            },
            on: {
              NEXT: {
                target: '.hist',
              },
            },
          },
        },
      }),
    ).start()

    service.send({ type: 'NEXT' })
    service.send({ type: 'NEXT' })

    yield* expect(service.getSnapshot().value).toEqual({
      second: 'nested',
    })
  },
)

describe('multistage history states', (it) => {
  it('should go to the most recently visited state', function*({ expect }) {
    const machine = createMachine({
      initial: 'running',
      states: {
        running: {
          initial: 'normal',
          states: {
            normal: {
              on: { SWITCH_TURBO: { target: 'turbo' } },
            },
            turbo: {
              on: { SWITCH_TURBO: { target: 'normal' } },
            },
            H: {
              history: true,
              target: 'normal',
            },
          },
          on: {
            POWER: { target: 'off' },
          },
        },
        starting: {
          on: { STARTED: { target: 'running.H' } },
        },
        off: {
          on: { POWER: { target: 'starting' } },
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'SWITCH_TURBO' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'POWER' })
    actorRef.send({ type: 'STARTED' })

    yield* expect(actorRef.getSnapshot().value).toEqual({
      running: 'turbo',
    })
  })
})

describe('revive history states', (it) => {
  const machine = createMachine({
    initial: 'on',
    states: {
      on: {
        initial: 'first',
        states: {
          first: {
            on: { SWITCH: { target: 'second' } },
          },
          second: {},
          hist: {
            type: 'history',
            target: 'first',
          },
        },
        on: {
          POWER: { target: 'off' },
        },
      },
      off: {
        on: { POWER: { target: 'on.hist' } },
      },
    },
  })

  const sourceRef = createActor(machine).start()

  sourceRef.send({ type: 'SWITCH' })
  sourceRef.send({ type: 'POWER' })

  const persistedSnapshot = JSON.parse(
    JSON.stringify(sourceRef.getPersistedSnapshot()),
  )
  const snapshot = sourceRef.getSnapshot()

  sourceRef.stop()

  it('should restore from stringified snapshot', function*({ expect }) {
    const persistedValue = persistedSnapshot.value

    const actorRef = createActor(machine, {
      snapshot: persistedSnapshot,
    }).start()
    actorRef.send({ type: 'POWER' })

    yield* expect({
      persistedValue,
      restoredValue: actorRef.getSnapshot().value,
    }).toEqual({ persistedValue: 'off', restoredValue: { on: 'second' } })
  })

  it('should ignore unresolved ids as-is and log a warning', function*({ expect }) {
    const warned: string[] = []
    const fakeSnapshot = {
      ...persistedSnapshot,
      historyValue: { ['(machine).on.hist']: [{ id: 'nonexistent' }] },
    }
    const fakeValue = fakeSnapshot.value

    const actorRef = createActor(machine, {
      snapshot: fakeSnapshot,
      warn: (message) => {
        warned.push(message)
      },
    }).start()
    actorRef.send({ type: 'POWER' })

    const persistedAfterRestore = actorRef.getPersistedSnapshot() as unknown as {
      historyValue: unknown
    }
    yield* expect({
      fakeValue,
      warned,
      value: actorRef.getSnapshot().value,
      historyValue: persistedAfterRestore.historyValue,
    }).toEqual({
      fakeValue: 'off',
      warned: ['Could not resolve StateNode for id: nonexistent'],
      value: { on: 'first' },
      historyValue: {},
    })
  })

  it('should not re-resolve already-instantiated StateNode', function*({ expect }) {
    const snapshotValue = snapshot.value
    const historyNodes = snapshot.historyValue?.['(machine).on.hist']
    if (historyNodes === undefined) {
      throw new Error('expected history value for (machine).on.hist')
    }
    const isStateNode = historyNodes[0] instanceof StateNode

    const actorRef = createActor(machine, {
      snapshot,
    }).start()
    actorRef.send({ type: 'POWER' })

    yield* expect({
      snapshotValue,
      isStateNode,
      value: actorRef.getSnapshot().value,
    }).toEqual({
      snapshotValue: 'off',
      isStateNode: true,
      value: { on: 'second' },
    })
  })

  it('should handle null, undefined, and primitive values', function*({ expect }) {
    const results = [null, undefined, 42, 'foo', true, false].map((val) => {
      const fakeSnapshot = { ...persistedSnapshot, historyValue: val }

      const actorRef = createActor(machine, {
        snapshot: fakeSnapshot,
      }).start()
      actorRef.send({ type: 'POWER' })

      const persistedAfterRestore = actorRef.getPersistedSnapshot() as unknown as {
        historyValue: unknown
      }
      return {
        fakeValue: fakeSnapshot.value,
        value: actorRef.getSnapshot().value,
        historyValue: persistedAfterRestore.historyValue,
      }
    })
    yield* expect(results).toEqual(
      [null, undefined, 42, 'foo', true, false].map(() => ({
        fakeValue: 'off',
        value: { on: 'first' },
        historyValue: {},
      })),
    )
  })
})
