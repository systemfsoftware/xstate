import { describe, expect, it } from 'vitest'
import { createMachine, getInitialMicrosteps, getMicrosteps } from '../src/index.js'
import { createInertActorScope } from '../src/inertActorScope.js'

describe('machine.microstep()', () => {
  it('should return an array of states from all microsteps', () => {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            GO: { target: 'a' },
          },
        },
        a: {
          // entry: raise({ type: 'NEXT' }),
          entry: (_, enq) => enq.raise({ type: 'NEXT' }),
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          always: { target: 'c' },
        },
        c: {
          entry: (_, enq) => enq.raise({ type: 'NEXT' }),
          on: {
            NEXT: { target: 'd' },
          },
        },
        d: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.getInitialSnapshot(actorScope),
      { type: 'GO' },
      actorScope,
    )

    expect(states.map((s) => s.value)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('should return the states from microstep (transient)', () => {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            TRIGGER: { target: 'second' },
          },
        },
        second: {
          always: { target: 'third' },
        },
        third: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.resolveState({ value: 'first' }),
      { type: 'TRIGGER' },
      actorScope,
    )

    expect(states.map((s) => s.value)).toEqual(['second', 'third'])
  })

  it('should return the states from microstep (raised event)', () => {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            // TRIGGER: {
            //   target: 'second',
            //   actions: raise({ type: 'RAISED' })
            // }
            TRIGGER: (_, enq) => {
              enq.raise({ type: 'RAISED' })
              return { target: 'second' }
            },
          },
        },
        second: {
          on: {
            RAISED: { target: 'third' },
          },
        },
        third: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.resolveState({ value: 'first' }),
      { type: 'TRIGGER' },
      actorScope,
    )

    expect(states.map((s) => s.value)).toEqual(['second', 'third'])
  })

  it('should return a single-item array for normal transitions', () => {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            TRIGGER: { target: 'second' },
          },
        },
        second: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.getInitialSnapshot(actorScope),
      { type: 'TRIGGER' },
      actorScope,
    )

    expect(states.map((s) => s.value)).toEqual(['second'])
  })

  it('each state should preserve their internal queue', () => {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            // TRIGGER: {
            //   target: 'second',
            //   actions: [raise({ type: 'FOO' }), raise({ type: 'BAR' })]
            // }
            TRIGGER: (_, enq) => {
              enq.raise({ type: 'FOO' })
              enq.raise({ type: 'BAR' })
              return { target: 'second' }
            },
          },
        },
        second: {
          on: {
            FOO: {
              target: 'third',
            },
          },
        },
        third: {
          on: {
            BAR: {
              target: 'fourth',
            },
          },
        },
        fourth: {
          always: { target: 'fifth' },
        },
        fifth: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.getInitialSnapshot(actorScope),
      { type: 'TRIGGER' },
      actorScope,
    )

    expect(states.map((s) => s.value)).toEqual([
      'second',
      'third',
      'fourth',
      'fifth',
    ])
  })
})

describe('getMicrosteps', () => {
  it('should return microsteps with actions', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            GO: (_: any, enq: any) => {
              enq(() => {})
              return { target: 'b' }
            },
          },
        },
        b: {
          entry: () => {},
          always: (_: any, enq: any) => {
            enq(() => {})
            return { target: 'c' }
          },
        },
        c: {},
      } as any,
    })

    const actorScope = createInertActorScope(machine)
    const initialSnapshot = machine.getInitialSnapshot(actorScope)

    const microsteps = getMicrosteps(machine, initialSnapshot, { type: 'GO' })

    expect(microsteps).toHaveLength(2)

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }
    const secondMicrostep = microsteps[1]
    if (secondMicrostep === undefined) {
      throw new Error('expected a second microstep')
    }

    // First microstep: a -> b
    expect(firstMicrostep[0].value).toEqual('b')
    expect(firstMicrostep[1]).toHaveLength(2) // transition action + entry action

    // Second microstep: b -> c (always)
    expect(secondMicrostep[0].value).toEqual('c')
    expect(secondMicrostep[1]).toHaveLength(1) // always transition action
  })

  it('should capture actions from raised events', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            GO: (_: any, enq: any) => {
              enq.raise({ type: 'NEXT' })
              enq(() => {})
              return { target: 'b' }
            },
          },
        },
        b: {
          on: {
            NEXT: (_: any, enq: any) => {
              enq(() => {})
              return { target: 'c' }
            },
          },
        },
        c: {},
      } as any,
    })

    const actorScope = createInertActorScope(machine)
    const initialSnapshot = machine.getInitialSnapshot(actorScope)

    const microsteps = getMicrosteps(machine, initialSnapshot, { type: 'GO' })

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }
    const secondMicrostep = microsteps[1]
    if (secondMicrostep === undefined) {
      throw new Error('expected a second microstep')
    }

    expect(microsteps).toHaveLength(2)
    expect(firstMicrostep[0].value).toEqual('b')
    expect(secondMicrostep[0].value).toEqual('c')
  })
  it('should return the transitions taken in each microstep', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            GO: (_: any, enq: any) => {
              enq.raise({ type: 'NEXT' })
              return { target: 'b' }
            },
          },
        },
        b: {
          on: { NEXT: { target: 'c' } },
        },
        c: {
          always: { target: 'd' },
        },
        d: {},
      } as any,
    })

    const actorScope = createInertActorScope(machine)
    const initialSnapshot = machine.getInitialSnapshot(actorScope)

    const microsteps = getMicrosteps(machine, initialSnapshot, { type: 'GO' })

    expect(microsteps.map(([snapshot]) => snapshot.value)).toEqual([
      'b',
      'c',
      'd',
    ])
    expect(
      microsteps.map(([, , transitions]) => transitions.map((t) => [t.source.key, t.eventType])),
    ).toEqual([[['a', 'GO']], [['b', 'NEXT']], [['c', '']]])
  })

  it('should return the transition taken by a single-transition fast path', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: { on: { GO: { target: 'b' } } },
        b: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const initialSnapshot = machine.getInitialSnapshot(actorScope)

    const microsteps = getMicrosteps(machine, initialSnapshot, { type: 'GO' })

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }
    const stateA = machine.root.states['a']
    if (stateA === undefined) {
      throw new Error('expected state a')
    }

    expect(microsteps).toHaveLength(1)
    expect(firstMicrostep[2]).toEqual([
      stateA.transitions.get('GO')![0],
    ])
  })

  it('should return no transitions for an unhandled event', () => {
    const machine = createMachine({
      initial: 'a',
      states: { a: {} },
    })

    const actorScope = createInertActorScope(machine)
    const initialSnapshot = machine.getInitialSnapshot(actorScope)

    const microsteps = getMicrosteps(machine, initialSnapshot, {
      type: 'UNKNOWN',
    } as never)

    expect(microsteps.flatMap(([, , transitions]) => transitions)).toEqual([])
  })
})

describe('getInitialMicrosteps', () => {
  it('should return initial microsteps with entry actions', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          entry: () => {},
        },
      },
    })

    const microsteps = getInitialMicrosteps(machine)

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }

    expect(microsteps).toHaveLength(1)
    expect(firstMicrostep[0].value).toEqual('a')
    expect(firstMicrostep[1]).toHaveLength(1) // entry action
  })

  it('should capture actions from initial always transitions', () => {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          entry: () => {},
          always: (_: any, enq: any) => {
            enq(() => {})
            return { target: 'b' }
          },
        },
        b: {
          entry: () => {},
        },
      } as any,
    })

    const microsteps = getInitialMicrosteps(machine)

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }
    const secondMicrostep = microsteps[1]
    if (secondMicrostep === undefined) {
      throw new Error('expected a second microstep')
    }
    const stateA = machine.root.states['a']
    if (stateA === undefined) {
      throw new Error('expected state a')
    }

    expect(microsteps).toHaveLength(2)
    expect(firstMicrostep[0].value).toEqual('a')
    expect(firstMicrostep[1]).toHaveLength(1) // entry action for 'a'
    expect(secondMicrostep[0].value).toEqual('b')
    expect(secondMicrostep[1]).toHaveLength(2) // always action + entry action for 'b'
    // The first microstep enters the initial states; the second takes `always`
    expect(firstMicrostep[2]).toEqual([])
    expect(secondMicrostep[2]).toEqual([stateA.always![0]])
  })

  it('should work with nested initial states', () => {
    const machine = createMachine({
      initial: 'parent',
      states: {
        parent: {
          entry: () => {},
          initial: 'child',
          states: {
            child: {
              entry: () => {},
            },
          },
        },
      },
    })

    const microsteps = getInitialMicrosteps(machine)

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }

    expect(microsteps).toHaveLength(1)
    expect(firstMicrostep[0].value).toEqual({ parent: 'child' })
    expect(firstMicrostep[1]).toHaveLength(2) // parent entry + child entry
  })

  it('should pass input to context function', () => {
    const machine = createMachine({
      context: (({ input }: { input: { value: number } }) => ({
        count: input.value,
      })) as any,
      initial: 'a',
      states: {
        a: {},
      },
    })

    const microsteps = getInitialMicrosteps(machine, { value: 42 })

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }

    expect(firstMicrostep[0].context).toEqual({ count: 42 })
  })
})
