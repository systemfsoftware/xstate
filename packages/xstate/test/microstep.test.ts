import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, getInitialMicrosteps, getMicrosteps } from '../src/index.js'
import { createInertActorScope } from '../src/inertActorScope.js'

describe('machine.microstep()', () => {
  it('should return an array of states from all microsteps', function*({ expect }) {
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

    yield* expect(states.map((s) => s.value)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('should return the states from microstep (transient)', function*({ expect }) {
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

    yield* expect(states.map((s) => s.value)).toEqual(['second', 'third'])
  })

  it('should return the states from microstep (raised event)', function*({ expect }) {
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

    yield* expect(states.map((s) => s.value)).toEqual(['second', 'third'])
  })

  it('should return a single-item array for normal transitions', function*({ expect }) {
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

    yield* expect(states.map((s) => s.value)).toEqual(['second'])
  })

  it('each state should preserve their internal queue', function*({ expect }) {
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

    yield* expect(states.map((s) => s.value)).toEqual([
      'second',
      'third',
      'fourth',
      'fifth',
    ])
  })
})

describe('getMicrosteps', () => {
  it('should return microsteps with actions', function*({ expect }) {
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

    const firstMicrostep = microsteps[0]
    if (firstMicrostep === undefined) {
      throw new Error('expected a first microstep')
    }
    const secondMicrostep = microsteps[1]
    if (secondMicrostep === undefined) {
      throw new Error('expected a second microstep')
    }

    yield* expect({
      microstepCount: microsteps.length,
      firstValue: firstMicrostep[0].value,
      firstActionCount: firstMicrostep[1].length,
      secondValue: secondMicrostep[0].value,
      secondActionCount: secondMicrostep[1].length,
    }).toEqual({
      microstepCount: 2,
      firstValue: 'b',
      firstActionCount: 2,
      secondValue: 'c',
      secondActionCount: 1,
    })
  })

  it('should capture actions from raised events', function*({ expect }) {
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

    yield* expect({
      microstepCount: microsteps.length,
      firstValue: firstMicrostep[0].value,
      secondValue: secondMicrostep[0].value,
    }).toEqual({
      microstepCount: 2,
      firstValue: 'b',
      secondValue: 'c',
    })
  })
  it('should return the transitions taken in each microstep', function*({ expect }) {
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

    yield* expect({
      values: microsteps.map(([snapshot]) => snapshot.value),
      transitions: microsteps.map(([, , transitions]) => transitions.map((t) => [t.source.key, t.eventType])),
    }).toEqual({
      values: ['b', 'c', 'd'],
      transitions: [[['a', 'GO']], [['b', 'NEXT']], [['c', '']]],
    })
  })

  it('should return the transition taken by a single-transition fast path', function*({ expect }) {
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

    yield* expect({
      microstepCount: microsteps.length,
      transitions: firstMicrostep[2],
    }).toEqual({
      microstepCount: 1,
      transitions: [stateA.transitions.get('GO')![0]],
    })
  })

  it('should return no transitions for an unhandled event', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: { a: {} },
    })

    const actorScope = createInertActorScope(machine)
    const initialSnapshot = machine.getInitialSnapshot(actorScope)

    const microsteps = getMicrosteps(machine, initialSnapshot, {
      type: 'UNKNOWN',
    } as never)

    yield* expect(microsteps.flatMap(([, , transitions]) => transitions)).toEqual([])
  })
})

describe('getInitialMicrosteps', () => {
  it('should return initial microsteps with entry actions', function*({ expect }) {
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

    yield* expect({
      microstepCount: microsteps.length,
      firstValue: firstMicrostep[0].value,
      firstActionCount: firstMicrostep[1].length,
    }).toEqual({
      microstepCount: 1,
      firstValue: 'a',
      firstActionCount: 1,
    })
  })

  it('should capture actions from initial always transitions', function*({ expect }) {
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

    yield* expect({
      microstepCount: microsteps.length,
      firstValue: firstMicrostep[0].value,
      firstActionCount: firstMicrostep[1].length,
      secondValue: secondMicrostep[0].value,
      secondActionCount: secondMicrostep[1].length,
      firstTransitions: firstMicrostep[2],
      secondTransitions: secondMicrostep[2],
    }).toEqual({
      microstepCount: 2,
      firstValue: 'a',
      firstActionCount: 1,
      secondValue: 'b',
      secondActionCount: 2,
      firstTransitions: [],
      secondTransitions: [stateA.always![0]],
    })
  })

  it('should work with nested initial states', function*({ expect }) {
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

    yield* expect({
      microstepCount: microsteps.length,
      firstValue: firstMicrostep[0].value,
      firstActionCount: firstMicrostep[1].length,
    }).toEqual({
      microstepCount: 1,
      firstValue: { parent: 'child' },
      firstActionCount: 2,
    })
  })

  it('should pass input to context function', function*({ expect }) {
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

    yield* expect(firstMicrostep[0].context).toEqual({ count: 42 })
  })
})
