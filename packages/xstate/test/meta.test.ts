import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine, serializeMachine, setup, type StateId } from '../src/index.js'

describe('state meta data', () => {
  const enter_walk = () => {}
  const exit_walk = () => {}
  const enter_wait = () => {}
  const exit_wait = () => {}
  const enter_stop = () => {}
  const exit_stop = () => {}

  const pedestrianStates = {
    initial: 'walk',
    states: {
      walk: {
        meta: { walkData: 'walk data' },
        on: {
          PED_COUNTDOWN: { target: 'wait' },
        },
        entry: enter_walk,
        exit: exit_walk,
      },
      wait: {
        meta: { waitData: 'wait data' },
        on: {
          PED_COUNTDOWN: { target: 'stop' },
        },
        entry: enter_wait,
        exit: exit_wait,
      },
      stop: {
        meta: { stopData: 'stop data' },
        entry: enter_stop,
        exit: exit_stop,
      },
    },
  }

  const enter_green = () => {}
  const exit_green = () => {}
  const enter_yellow = () => {}
  const exit_yellow = () => {}
  const enter_red = () => {}
  const exit_red = () => {}

  const lightMachine = createMachine({
    schemas: {
      meta: z.union([
        z.array(z.string()),
        z.object({
          yellowData: z.string(),
        }),
        z.object({
          redData: z.object({
            nested: z.object({
              red: z.string(),
              array: z.array(z.number()),
            }),
          }),
        }),
        z.object({
          walkData: z.string(),
        }),
        z.object({
          waitData: z.string(),
        }),
        z.object({
          stopData: z.string(),
        }),
      ]),
    },
    id: 'light',
    initial: 'green',
    states: {
      green: {
        meta: ['green', 'array', 'data'],
        on: {
          TIMER: { target: 'yellow' },
          POWER_OUTAGE: { target: 'red' },
          NOTHING: { target: 'green' },
        },
        entry: (args, enq) => {
          enq(enter_green)
        },
        exit: (args, enq) => {
          enq(exit_green)
        },
      },
      yellow: {
        meta: { yellowData: 'yellow data' },
        on: {
          TIMER: { target: 'red' },
          POWER_OUTAGE: { target: 'red' },
        },
        entry: (args, enq) => {
          enq(enter_yellow)
        },
        exit: (args, enq) => {
          enq(exit_yellow)
        },
      },
      red: {
        meta: {
          redData: {
            nested: {
              red: 'data',
              array: [1, 2, 3],
            },
          },
        },
        on: {
          TIMER: { target: 'green' },
          POWER_OUTAGE: { target: 'red' },
          NOTHING: { target: 'red' },
        },
        entry: (args, enq) => {
          enq(enter_red)
        },
        exit: (args, enq) => {
          enq(exit_red)
        },
        ...pedestrianStates,
      },
    },
  })

  it('states should aggregate meta data', function*({ expect }) {
    const actorRef = createActor(lightMachine).start()
    actorRef.send({ type: 'TIMER' })
    const yellowState = actorRef.getSnapshot()

    yield* expect({
      meta: yellowState.getMeta(),
      hasGreen: 'light.green' in yellowState.getMeta(),
      hasRoot: 'light' in yellowState.getMeta(),
    }).toEqual({
      meta: {
        'light.yellow': {
          yellowData: 'yellow data',
        },
      },
      hasGreen: false,
      hasRoot: false,
    })
  })

  it('states should aggregate meta data (deep)', function*({ expect }) {
    const actorRef = createActor(lightMachine).start()
    actorRef.send({ type: 'TIMER' })
    actorRef.send({ type: 'TIMER' })
    yield* expect(actorRef.getSnapshot().getMeta()).toEqual({
      'light.red': {
        redData: {
          nested: {
            array: [1, 2, 3],
            red: 'data',
          },
        },
      },
      'light.red.walk': {
        walkData: 'walk data',
      },
    })
  })

  // https://github.com/statelyai/xstate/issues/1105
  it('services started from a persisted state should calculate meta data', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          name: z.string(),
        }),
      },
      id: 'test',
      initial: 'first',
      states: {
        first: {
          meta: {
            name: 'first state',
          },
        },
        second: {
          meta: {
            name: 'second state',
          },
        },
      },
    })

    const actor = createActor(machine, {
      snapshot: machine.resolveState({ value: 'second' }),
    })
    actor.start()

    yield* expect(actor.getSnapshot().getMeta()).toEqual({
      'test.second': {
        name: 'second state',
      },
    })
  })

  it('meta keys are strongly-typed', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          template: z.string(),
        }),
      },
      id: 'root',
      initial: 'a',
      states: {
        a: {},
        b: {},
        c: {
          initial: 'one',
          states: {
            one: {
              id: 'one',
            },
            two: {},
            three: {},
          },
        },
      },
    })

    type M = Pick<typeof machine.states, 'id' | 'states'>

    type T = StateId<M>

    const actor = createActor(machine).start()

    const snapshot = actor.getSnapshot()
    const meta = snapshot.getMeta()

    meta['root']
    meta['root.c']
    meta['one'] satisfies { template: string } | undefined
    // @ts-expect-error
    meta['one'] satisfies { template: number } | undefined
    // @ts-expect-error
    meta['one'] satisfies { template: string }

    // @ts-expect-error
    meta['(machine)']

    // @ts-expect-error
    meta['c']

    // @ts-expect-error
    meta['root.c.one']

    yield* expect(snapshot.getMeta()).toEqual({})
  })

  it('TS should error with unexpected meta property', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      initial: 'a',
      states: {
        a: {
          meta: {
            layout: 'a-layout',
          },
        },
        b: {
          meta: {
            notLayout: 'uh oh',
          } as any,
        },
      },
    })

    yield* expect(machine.states['b']!.meta).toEqual({ notLayout: 'uh oh' })
  })

  it('TS should error with wrong meta value type', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      initial: 'a',
      states: {
        a: {
          meta: {
            layout: 'a-layout',
          },
        },
        d: {
          meta: {
            layout: 42,
          },
        },
      } as any,
    })

    yield* expect(machine.states['d']!.meta).toEqual({ layout: 42 })
  })

  it('should allow states to omit meta', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      initial: 'a',
      states: {
        a: {
          meta: {
            layout: 'a-layout',
          },
        },
        c: {}, // no meta
      },
    })

    yield* expect({
      a: machine.states['a']!.meta,
      c: machine.states['c']!.meta,
    }).toEqual({ a: { layout: 'a-layout' }, c: undefined })
  })

  it('TS should error with unexpected transition meta property', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      on: {
        e1: () => ({
          meta: {
            layout: 'event-layout',
          },
        }),
        e2: () => ({
          meta: {
            layout: 42,
          },
        }),
      } as any,
    })

    yield* expect(machine.root.transitions.get('e1')!.length).toEqual(1)
  })

  it('TS should error with wrong transition meta value type', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      on: {
        e1: () => ({
          meta: {
            layout: 'event-layout',
          },
        }),
        e2: () => ({
          meta: {
            layout: 42,
          },
        }),
      } as any,
    })

    yield* expect(machine.root.transitions.get('e1')!.length).toEqual(1)
  })

  it('should support typing meta properties (no ts-expected errors)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      initial: 'a',
      states: {
        a: {
          meta: {
            layout: 'a-layout',
          },
        },
        b: {},
        c: {},
        d: {},
      },
      on: {
        e1: () => ({
          meta: {
            layout: 'event-layout',
          },
        }),
        e2: () => ({}),
        e3: () => ({}),
        e4: () => ({}),
      },
    })

    const actor = createActor(machine)

    actor.getSnapshot().getMeta()['(machine)'] satisfies
      | { layout: string }
      | undefined

    actor.getSnapshot().getMeta()['(machine).a']

    yield* expect(actor.getSnapshot().getMeta()['(machine).a']).toEqual({
      layout: 'a-layout',
    })
  })

  it('should strongly type the state IDs in snapshot.getMeta()', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({}),
      },
      id: 'root',
      initial: 'parentState',
      states: {
        parentState: {
          meta: {},
          initial: 'childState',
          states: {
            childState: {
              meta: {},
            },
            stateWithId: {
              id: 'state with id',
              meta: {},
            },
          },
        },
      },
    })

    const actor = createActor(machine)

    const metaValues = actor.getSnapshot().getMeta()

    metaValues.root
    metaValues['root.parentState']
    metaValues['root.parentState.childState']
    metaValues['state with id']

    // @ts-expect-error
    metaValues['root.parentState.stateWithId']

    // @ts-expect-error
    metaValues['unknown state']

    yield* expect({
      parentState: metaValues['root.parentState'],
      childState: metaValues['root.parentState.childState'],
    }).toEqual({ parentState: {}, childState: {} })
  })

  it('should strongly type the state IDs in snapshot.getMeta() (no root ID)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({}),
      },
      // id is (machine)
      initial: 'parentState',
      states: {
        parentState: {
          meta: {},
          initial: 'childState',
          states: {
            childState: {
              meta: {},
            },
            stateWithId: {
              id: 'state with id',
              meta: {},
            },
          },
        },
      },
    })

    const actor = createActor(machine)

    const metaValues = actor.getSnapshot().getMeta()

    metaValues['(machine)']
    metaValues['(machine).parentState']
    metaValues['(machine).parentState.childState']
    metaValues['state with id']

    // @ts-expect-error
    metaValues['(machine).parentState.stateWithId']

    // @ts-expect-error
    metaValues['unknown state']

    yield* expect({
      parentState: metaValues['(machine).parentState'],
      childState: metaValues['(machine).parentState.childState'],
    }).toEqual({ parentState: {}, childState: {} })
  })
})

describe('transition meta data', () => {
  it('supports distinct state and transition metadata schemas', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({ label: z.string() }),
        transitionMeta: z.object({ trackingId: z.number() }),
      },
      meta: { label: 'root' },
      on: {
        NEXT: { meta: { trackingId: 42 } },
      },
    })

    machine.root.meta satisfies { label: string } | undefined
    const nextTransition = machine.root.transitions.get('NEXT')![0]
    if (nextTransition === undefined) {
      throw new Error('expected the NEXT transition')
    }
    nextTransition.meta satisfies
      | { trackingId: number }
      | undefined

    yield* expect({
      rootMeta: machine.root.meta,
      nextMeta: nextTransition.meta,
    }).toEqual({ rootMeta: { label: 'root' }, nextMeta: { trackingId: 42 } })
  })

  it('rejects state and transition metadata in the wrong positions', function*({ expect }) {
    const stateMetaMachine = createMachine({
      schemas: {
        meta: z.object({ state: z.string() }),
        transitionMeta: z.object({ transition: z.string() }),
      },
      // @ts-expect-error transition metadata is invalid on a state node
      meta: { transition: 'root' },
    })

    const transitionMetaMachine = createMachine({
      schemas: {
        meta: z.object({ state: z.string() }),
        transitionMeta: z.object({ transition: z.string() }),
      },
      // @ts-expect-error state metadata is invalid on a transition
      on: {
        NEXT: {
          meta: { state: 'next' },
        },
      },
    })

    const nextTransition = transitionMetaMachine.root.transitions.get('NEXT')![0]
    if (nextTransition === undefined) {
      throw new Error('expected the NEXT transition')
    }

    yield* expect({
      stateRootMeta: stateMetaMachine.root.meta,
      transitionMeta: nextTransition.meta,
    }).toEqual({
      stateRootMeta: { transition: 'root' },
      transitionMeta: { state: 'next' },
    })
  })

  it('uses the state metadata schema for transitions by default', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({}),
        meta: z.object({ legacy: z.string() }),
      },
      context: {},
      meta: { legacy: 'state' },
      on: {
        NEXT: { meta: { legacy: 'transition' } },
      },
    })

    machine.root.meta satisfies { legacy: string } | undefined
    const nextTransition = machine.root.transitions.get('NEXT')![0]
    if (nextTransition === undefined) {
      throw new Error('expected the NEXT transition')
    }
    nextTransition.meta satisfies
      | { legacy: string }
      | undefined

    yield* expect({
      rootMeta: machine.root.meta,
      nextMeta: nextTransition.meta,
    }).toEqual({
      rootMeta: { legacy: 'state' },
      nextMeta: { legacy: 'transition' },
    })

    createMachine({
      schemas: {
        // @ts-expect-error invalid metadata prevents this overload match
        context: z.object({}),
        // @ts-expect-error invalid metadata prevents this overload match
        meta: z.object({ legacy: z.string() }),
      },
      context: {},
      // @ts-expect-error transitions fall back to the state metadata schema
      on: {
        NEXT: {
          meta: { unrelated: true },
        },
      },
    })
  })

  it('preserves transition metadata on v6 transition definitions', function*({ expect }) {
    const machine = setup({
      schemas: {
        meta: z.object({ state: z.string() }),
        transitionMeta: z.object({ source: z.string() }),
      },
      actors: {
        child: createMachine({}),
      },
    }).createMachine({
      initial: {
        target: 'idle',
        meta: { source: 'initial' },
        description: 'start idle',
      },
      states: {
        idle: {
          meta: { state: 'idle' },
          route: { meta: { source: 'route' } },
          always: { meta: { source: 'always' } },
          after: {
            100: { target: 'routing', meta: { source: 'after' } },
          },
          timeout: 200,
          onTimeout: { meta: { source: 'state.timeout' } },
          invoke: {
            src: 'child',
            timeout: 300,
            onDone: { meta: { source: 'invoke.done' } },
            onError: { meta: { source: 'invoke.error' } },
            onSnapshot: { meta: { source: 'invoke.snapshot' } },
            onTimeout: { meta: { source: 'invoke.timeout' } },
          },
        },
        routing: {
          type: 'choice',
          meta: { state: 'routing' },
          choice: () => ({
            target: 'idle',
            meta: { source: 'choice' },
          }),
        },
      },
    })

    machine.root.initial.meta satisfies { source: string } | undefined
    const idleState = machine.root.states['idle']
    if (idleState === undefined) {
      throw new Error('expected the idle state')
    }
    idleState.meta satisfies { state: string } | undefined
    const alwaysTransition = idleState.always![0]
    if (alwaysTransition === undefined) {
      throw new Error('expected the always transition')
    }
    alwaysTransition.meta satisfies
      | { source: string }
      | undefined
    const afterTransition = idleState.after[0]
    if (afterTransition === undefined) {
      throw new Error('expected the after transition')
    }
    afterTransition.meta satisfies
      | { source: string }
      | undefined

    const invoke = idleState.invoke[0]
    if (invoke === undefined) {
      throw new Error('expected an invoke config')
    }
    type SingleTransition<T> = Exclude<
      NonNullable<T>,
      string | readonly unknown[]
    >
    ;(({}) as SingleTransition<typeof invoke.onDone>).meta satisfies
      | { source: string }
      | undefined
    ;(({}) as SingleTransition<typeof invoke.onError>).meta satisfies
      | { source: string }
      | undefined
    ;(({}) as SingleTransition<typeof invoke.onSnapshot>).meta satisfies
      | { source: string }
      | undefined
    ;(({}) as SingleTransition<typeof invoke.onTimeout>).meta satisfies
      | { source: string }
      | undefined

    yield* expect({
      initialMeta: machine.root.initial.meta,
      initialDescriptionIsStartIdle: machine.root.initial.description === 'start idle',
      serializedInitial: JSON.parse(JSON.stringify(serializeMachine(machine)))
        .initial,
    }).toEqual({
      initialMeta: { source: 'initial' },
      initialDescriptionIsStartIdle: true,
      serializedInitial: expect.objectContaining({
        meta: { source: 'initial' },
        description: 'start idle',
      }),
    })
  })

  it('TS should error with unexpected transition meta property', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      on: {
        e1: () => ({
          meta: {
            layout: 'event-layout',
          },
        }),
        e2: () => ({
          meta: {
            notLayout: 'uh oh',
          },
        }),
      } as any,
    })

    yield* expect(machine.root.transitions.get('e1')!.length).toEqual(1)
  })

  it('TS should error with wrong transition meta value type', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        meta: z.object({
          layout: z.string(),
        }),
      },
      on: {
        e1: () => ({
          meta: {
            layout: 'event-layout',
          },
        }),
        e2: () => ({
          meta: {
            layout: 42,
          },
        }),
      } as any,
    })

    yield* expect(machine.root.transitions.get('e1')!.length).toEqual(1)
  })
})

describe('state description', () => {
  it('state node should have its description', function*({ expect }) {
    const machine = createMachine({
      initial: 'test',
      states: {
        test: {
          description: 'This is a test',
        },
      },
    })

    const testState = machine.states['test']
    if (testState === undefined) {
      throw new Error('expected the test state')
    }

    yield* expect(testState.description).toEqual('This is a test')
  })
})

describe('transition description', () => {
  it('state node should have its description', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          EVENT: z.object({}),
        },
      },
      on: {
        EVENT: {
          description: 'This is a test',
        },
      },
    })

    const eventTransitions = machine.root.on['EVENT']
    if (eventTransitions === undefined) {
      throw new Error('expected EVENT transitions')
    }
    const eventTransition = eventTransitions[0]
    if (eventTransition === undefined) {
      throw new Error('expected an EVENT transition')
    }

    yield* expect(eventTransition.description).toEqual('This is a test')
  })
})
