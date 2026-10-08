import { describe, it } from '@systemfsoftware/vitest'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import { createActor, createMachine, setup } from '../src/index.js'

describe('route', () => {
  it('should transition directly to a route if route is an empty transition config', function*({ expect }) {
    const machine = createMachine({
      id: 'test',
      initial: 'a',
      states: {
        a: {},
        b: {
          id: 'b',
          route: {},
        },
        c: {},
      },
    })

    const actor = createActor(machine).start()

    actor.send({
      type: 'xstate.route',
      to: '#b',
    })

    const valueAfterRouteToB = actor.getSnapshot().value

    // c has no route, so this should not transition
    actor.send(
      {
        type: 'xstate.route',
        to: '#c',
      } as unknown as Parameters<typeof actor.send>[0],
    )

    yield* expect({
      valueAfterRouteToB,
      valueAfterRouteToC: actor.getSnapshot().value,
    }).toEqual({ valueAfterRouteToB: 'b', valueAfterRouteToC: 'b' })
  })

  it('should transition directly to a route if the route function allows it', function*({ expect }) {
    const machine = createMachine({
      id: 'test',
      initial: 'a',
      states: {
        a: {},
        b: {
          id: 'b',
          route: () => false,
        },
        c: {
          id: 'c',
          route: () => true,
        },
      },
    })

    const actor = createActor(machine).start()

    const initialValue = actor.getSnapshot().value

    actor.send({
      type: 'xstate.route',
      to: '#b',
    })

    const valueAfterBlockedRoute = actor.getSnapshot().value

    actor.send({
      type: 'xstate.route',
      to: '#c',
    })

    yield* expect({
      initialValue,
      valueAfterBlockedRoute,
      valueAfterAllowedRoute: actor.getSnapshot().value,
    }).toEqual({
      initialValue: 'a',
      valueAfterBlockedRoute: 'a',
      valueAfterAllowedRoute: 'c',
    })
  })

  it('should resolve guards provided in machine config on route transitions', function*({ expect }) {
    const machine = createMachine({
      id: 'flow',
      initial: 'amount',
      context: {
        ready: false as boolean,
      },
      guards: {
        isReady: (ready: boolean) => ready,
      },
      states: {
        amount: {
          id: 'amount',
          route: {},
          on: {
            READY: () => ({
              context: { ready: true },
            }),
          },
        },
        review: {
          id: 'review',
          route: (args) => args.guards.isReady(args.context.ready),
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({
      type: 'xstate.route',
      to: '#review',
    })

    const valueWhileGuardBlocked = actor.getSnapshot().value

    actor.send({ type: 'READY' })
    actor.send({
      type: 'xstate.route',
      to: '#review',
    })

    yield* expect({
      valueWhileGuardBlocked,
      valueAfterReady: actor.getSnapshot().value,
    }).toEqual({ valueWhileGuardBlocked: 'amount', valueAfterReady: 'review' })
  })

  it('route function can return a config object (with context update)', function*({ expect }) {
    const machine = createMachine({
      id: 'app',
      context: { visits: 0, loggedIn: false },
      initial: 'home',
      states: {
        home: {
          id: 'home',
          route: {},
          on: {
            LOGIN: ({ context }) => ({
              context: { ...context, loggedIn: true },
            }),
          },
        },
        profile: {
          id: 'profile',
          route: ({ context }) => {
            if (!context.loggedIn) {
              return // blocked — like an unhandled transition
            }
            return {
              context: { ...context, visits: context.visits + 1 },
            }
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'xstate.route', to: '#profile' })
    const valueWhileLoggedOut = actor.getSnapshot().value
    const visitsWhileLoggedOut = actor.getSnapshot().context.visits

    actor.send({ type: 'LOGIN' })
    actor.send({ type: 'xstate.route', to: '#profile' })

    yield* expect({
      valueWhileLoggedOut,
      visitsWhileLoggedOut,
      valueAfterLogin: actor.getSnapshot().value,
      visitsAfterLogin: actor.getSnapshot().context.visits,
    }).toEqual({
      valueWhileLoggedOut: 'home',
      visitsWhileLoggedOut: 0,
      valueAfterLogin: 'profile',
      visitsAfterLogin: 1,
    })
  })

  it('should throw on a JSON-layer route guard reference that is not implemented', function*({ expect }) {
    const machine = createMachineFromConfig(
      {
        id: 'flow',
        initial: 'amount',
        states: {
          amount: {
            id: 'amount',
            route: {},
          },
          review: {
            id: 'review',
            route: {
              guard: 'isRedy',
            },
          },
        },
      },
      {
        guards: {
          isReady: () => true,
        },
      },
    )

    const actor = createActor(machine)
    actor.subscribe({ error: () => {} })
    actor.start()

    actor.send({
      type: 'xstate.route',
      to: '#review',
    })

    const snapshot = actor.getSnapshot()
    yield* expect({
      status: snapshot.status,
      message: (snapshot.error as Error).message,
    }).toEqual({
      status: 'error',
      message: expect.stringMatching(
        /Guard 'isRedy' is not implemented in machine 'flow'.*Available guards: .*'isReady'/,
      ),
    })
  })

  it('should work with parallel states', function*({ expect }) {
    const todoMachine = createMachine({
      id: 'todos',
      type: 'parallel',
      states: {
        todo: {
          initial: 'new',
          states: {
            new: {},
            editing: {},
          },
        },
        filter: {
          initial: 'all',
          states: {
            all: {
              id: 'filter-all',
              route: {},
            },
            active: {
              id: 'filter-active',
              route: {},
            },
            completed: {
              id: 'filter-completed',
              route: {},
            },
          },
        },
      },
    })

    const todoActor = createActor(todoMachine).start()

    const initialValue = todoActor.getSnapshot().value

    todoActor.send({
      type: 'xstate.route',
      to: '#filter-active',
    })

    yield* expect({
      initialValue,
      valueAfterRoute: todoActor.getSnapshot().value,
    }).toEqual({
      initialValue: { todo: 'new', filter: 'all' },
      valueAfterRoute: { todo: 'new', filter: 'active' },
    })
  })

  it('route events are strongly typed', function*({ expect }) {
    const machine = setup({
      schemas: {
        events: {},
      },
    }).createMachine({
      id: 'root',
      initial: 'aRoute',
      states: {
        aRoute: {
          id: 'aRoute',
          route: {},
        },
        notARoute: {
          initial: 'childRoute',
          states: {
            childRoute: {
              id: 'childRoute',
              route: {},
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({
      type: 'xstate.route',
      to: '#aRoute',
    })

    actor.send({
      type: 'xstate.route',
      to: '#childRoute',
    })

    actor.send({
      type: 'xstate.route',
      // @ts-expect-error - 'notARoute' has no route config
      to: 'notARoute',
    })

    actor.send({
      type: 'xstate.route',
      // @ts-expect-error - 'root' is not routable
      to: 'root',
    })

    actor.send({
      type: 'xstate.route',
      // @ts-expect-error - 'blahblah' does not exist
      to: 'blahblah',
    })

    yield* expect(actor.getSnapshot().value).toEqual({ notARoute: 'childRoute' })
  })

  it('route config without id should not generate route events', function*({ expect }) {
    const machine = setup({
      schemas: {
        events: {},
      },
    }).createMachine({
      id: 'test',
      initial: 'a',
      states: {
        a: {
          // route without id — should NOT be routable
          route: {},
        },
        b: {
          id: 'b',
          route: {},
        },
      },
    })

    const actor = createActor(machine).start()

    // Only 'b' should be a valid route target
    actor.send({
      type: 'xstate.route',
      to: '#b',
    })

    yield* expect(actor.getSnapshot().value).toEqual('b')
  })

  it('machine.root.on should include route events', function*({ expect }) {
    const machine = createMachine({
      id: 'test',
      initial: 'a',
      states: {
        a: {},
        b: {
          id: 'b',
          route: {},
        },
        c: {
          id: 'c',
          route: () => true,
        },
      },
    })

    yield* expect({
      hasRouteDescriptor: Object.hasOwn(machine.root.on, 'xstate.route'),
      routeTransitionCount: machine.root.on['xstate.route']?.length,
    }).toEqual({ hasRouteDescriptor: true, routeTransitionCount: 2 })
  })

  it('nested state on should include route events for child routes', function*({ expect }) {
    const machine = createMachine({
      id: 'app',
      initial: 'home',
      states: {
        home: {
          id: 'home',
          route: {},
        },
        dashboard: {
          id: 'dashboard',
          initial: 'overview',
          route: {},
          states: {
            overview: {
              id: 'overview',
              route: {},
            },
            settings: {
              id: 'settings',
              route: {},
            },
          },
        },
      },
    })

    const a = createActor(machine).start()
    a.send({
      type: 'xstate.route',
      to: '#overview',
    })

    yield* expect({
      value: a.getSnapshot().value,
      hasRouteDescriptor: Object.hasOwn(machine.root.on, 'xstate.route'),
      routeTransitionCount: machine.root.on['xstate.route']?.length,
    }).toEqual({
      value: { dashboard: 'overview' },
      hasRouteDescriptor: true,
      routeTransitionCount: 4,
    })
  })

  it('parallel state on should include route events', function*({ expect }) {
    const machine = createMachine({
      id: 'todos',
      type: 'parallel',
      states: {
        list: {
          initial: 'idle',
          states: {
            idle: {},
            loading: {},
          },
        },
        filter: {
          initial: 'all',
          states: {
            all: {
              id: 'filter-all',
              route: {},
            },
            active: {
              id: 'filter-active',
              route: {},
            },
            completed: {
              id: 'filter-completed',
              route: {},
            },
          },
        },
      },
    })

    yield* expect({
      hasRouteDescriptor: Object.hasOwn(machine.root.on, 'xstate.route'),
      routeTransitionCount: machine.root.on['xstate.route']?.length,
    }).toEqual({ hasRouteDescriptor: true, routeTransitionCount: 3 })
  })

  it('should route to deeply nested state from anywhere', function*({ expect }) {
    const machine = createMachine({
      id: 'app',
      initial: 'home',
      states: {
        home: {
          id: 'home',
          route: {},
        },
        dashboard: {
          initial: 'overview',
          states: {
            overview: {
              id: 'overview',
              route: {},
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    // Should be able to route to deeply nested state from root
    const initialValue = actor.getSnapshot().value

    actor.send({ type: 'xstate.route', to: '#overview' })

    yield* expect({
      initialValue,
      valueAfterRoute: actor.getSnapshot().value,
    }).toEqual({
      initialValue: 'home',
      valueAfterRoute: { dashboard: 'overview' },
    })
  })

  it('should re-enter when routing to the current state', function*({ expect }) {
    let entries = 0
    const machine = createMachine({
      id: 'test',
      initial: 'a',
      states: {
        a: {
          id: 'a',
          route: {},
          entry: () => {
            entries++
          },
        },
      },
    })

    const actor = createActor(machine).start()
    const initialValue = actor.getSnapshot().value
    entries = 0

    actor.send({ type: 'xstate.route', to: '#a' })

    yield* expect({
      initialValue,
      valueAfterRoute: actor.getSnapshot().value,
      entries,
    }).toEqual({ initialValue: 'a', valueAfterRoute: 'a', entries: 1 })
  })

  it('should route to self with guard', function*({ expect }) {
    let allowed = false
    let entries = 0
    const machine = createMachine({
      id: 'test',
      initial: 'a',
      states: {
        a: {
          id: 'a',
          route: () => allowed,
          entry: () => {
            entries++
          },
        },
        b: { id: 'b', route: {} },
      },
    })

    const actor = createActor(machine).start()
    entries = 0

    actor.send({ type: 'xstate.route', to: '#a' })
    const entriesWhileBlocked = entries

    allowed = true
    actor.send({ type: 'xstate.route', to: '#a' })

    yield* expect({ entriesWhileBlocked, entriesAfterAllowed: entries }).toEqual({
      entriesWhileBlocked: 0,
      entriesAfterAllowed: 1,
    })
  })

  it('should not route using dot-separated nested id like #id.nested', function*({ expect }) {
    const machine = createMachine({
      id: 'app',
      initial: 'home',
      states: {
        home: {
          id: 'home',
          route: {},
        },
        dashboard: {
          id: 'dashboard',
          initial: 'overview',
          route: {},
          states: {
            overview: {
              id: 'overview',
              route: {},
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    const initialValue = actor.getSnapshot().value

    // Dot-separated ids should not work as route targets
    actor.send({
      type: 'xstate.route',
      // @ts-expect-error - dot-separated ids are not valid route targets
      to: '#dashboard.overview',
    })

    yield* expect({
      initialValue,
      valueAfterDotSeparatedRoute: actor.getSnapshot().value,
    }).toEqual({ initialValue: 'home', valueAfterDotSeparatedRoute: 'home' })
  })
})
