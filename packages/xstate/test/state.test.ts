import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createCallbackLogic } from '../src/actors/callback.js'
import { createActor, createMachine } from '../src/index.js'

const exampleMachine = createMachine({
  schemas: {
    events: {
      BAR_EVENT: z.object({}),
      DEEP_EVENT: z.object({}),
      EXTERNAL: z.object({}),
      FOO_EVENT: z.object({}),
      FORBIDDEN_EVENT: z.object({}),
      INERT: z.object({}),
      INTERNAL: z.object({}),
      MACHINE_EVENT: z.object({}),
      P31: z.object({}),
      P32: z.object({}),
      THREE_EVENT: z.object({}),
      TO_THREE: z.object({}),
      TO_TWO: z.object({ foo: z.string() }),
      TO_TWO_MAYBE: z.object({}),
      TO_FINAL: z.object({}),
    },
  },
  initial: 'one',
  states: {
    one: {
      on: {
        EXTERNAL: {
          target: 'one',
          reenter: true,
        },
        INERT: {},
        INTERNAL: {},
        TO_TWO: { target: 'two' },
        TO_TWO_MAYBE: () => {
          if (true) {
            return { target: 'two' }
          }
        },
        TO_THREE: { target: 'three' },
        FORBIDDEN_EVENT: undefined,
        TO_FINAL: { target: 'success' },
      },
    },
    two: {
      initial: 'deep',
      states: {
        deep: {
          initial: 'foo',
          states: {
            foo: {
              on: {
                FOO_EVENT: { target: 'bar' },
                FORBIDDEN_EVENT: undefined,
              },
            },
            bar: {
              on: {
                BAR_EVENT: { target: 'foo' },
              },
            },
          },
        },
      },
      on: {
        DEEP_EVENT: { target: '.' },
      },
    },
    three: {
      type: 'parallel',
      states: {
        first: {
          initial: 'p31',
          states: {
            p31: {
              on: { P31: { target: '.' } },
            },
          },
        },
        guarded: {
          initial: 'p32',
          states: {
            p32: {
              on: { P32: { target: '.' } },
            },
          },
        },
      },
      on: {
        THREE_EVENT: { target: '.' },
      },
    },
    success: {
      type: 'final',
    },
  },
  on: {
    MACHINE_EVENT: { target: '.two' },
  },
})

describe('State', () => {
  it('should expose active state nodes as nodes', function*({ expect }) {
    const snapshot = createActor(exampleMachine).getSnapshot()

    yield* expect({
      nodeIds: snapshot.nodes.map((node) => node.id),
      hasNodesKey: '_nodes' in snapshot,
    }).toEqual({
      nodeIds: ['(machine)', '(machine).one'],
      hasNodesKey: false,
    })
  })

  describe('status', () => {
    it('should show that a machine has not reached its final state', function*({ expect }) {
      yield* expect(createActor(exampleMachine).getSnapshot().status).not.toBe('done')
    })

    it('should show that a machine has reached its final state', function*({ expect }) {
      const actorRef = createActor(exampleMachine).start()
      actorRef.send({ type: 'TO_FINAL' })
      yield* expect(actorRef.getSnapshot().status).toBe('done')
    })
  })

  describe('.can', () => {
    it(
      'should return true for a simple event that results in a transition to a different state',
      function*({ expect }) {
        const machine = createMachine({
          initial: 'a',
          states: {
            a: {
              on: {
                NEXT: { target: 'b' },
              },
            },
            b: {},
          },
        })

        yield* expect({
          can: createActor(machine).getSnapshot().can({ type: 'NEXT' }),
        }).toEqual({ can: true })
      },
    )

    it(
      'should return true for an event object that results in a transition to a different state',
      function*({ expect }) {
        const machine = createMachine({
          initial: 'a',
          states: {
            a: {
              on: {
                NEXT: { target: 'b' },
              },
            },
            b: {},
          },
        })

        yield* expect({
          can: createActor(machine).getSnapshot().can({ type: 'NEXT' }),
        }).toEqual({ can: true })
      },
    )

    it('should return true for an event object that results in a new action', function*({ expect }) {
      const newAction = () => {}
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: (_, enq) => {
                enq(newAction)
              },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'NEXT' }),
      }).toEqual({ can: true })
    })

    it('should return true for an event object that results in a context change', function*({ expect }) {
      const machine = createMachine({
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        initial: 'a',
        context: { count: 0 },
        states: {
          a: {
            on: {
              NEXT: () => {
                return {
                  context: {
                    count: 1,
                  },
                }
              },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'NEXT' }),
      }).toEqual({ can: true })
    })

    it('should return true for a reentering self-transition without actions', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              EV: { target: 'a' },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'EV' }),
      }).toEqual({ can: true })
    })

    it('should return true for a reentering self-transition with reentry action', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            entry: () => {},
            on: {
              EV: { target: 'a' },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'EV' }),
      }).toEqual({ can: true })
    })

    it('should return true for a reentering self-transition with transition action', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              EV: (_, enq) => {
                enq(() => {})
                return { target: 'a' }
              },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'EV' }),
      }).toEqual({ can: true })
    })

    it('should return true for a targetless transition with actions', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              EV: (_, enq) => {
                enq(() => {})
              },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'EV' }),
      }).toEqual({ can: true })
    })

    it('should return false for a forbidden transition', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              EV: undefined,
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'EV' }),
      }).toEqual({ can: false })
    })

    it('should return false for an unknown event', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {},
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'UNKNOWN' }),
      }).toEqual({ can: false })
    })

    it('should return true when a guarded transition allows the transition', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              CHECK: () => {
                if (true) {
                  return { target: 'b' }
                }
              },
            },
          },
          b: {},
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({
          type: 'CHECK',
        }),
      }).toEqual({ can: true })
    })

    it('should return false when a guarded transition disallows the transition', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              CHECK: () => {
                if (1 + 1 !== 2) {
                  return { target: 'b' }
                }
                return undefined
              },
            },
          },
          b: {},
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({
          type: 'CHECK',
        }),
      }).toEqual({ can: false })
    })

    it('should not spawn actors when determining if an event is accepted', function*({ expect }) {
      let spawned = false
      const machine = createMachine({
        schemas: {
          context: z.object({
            ref: z.any(),
          }),
        },
        context: {},
        initial: 'a',
        states: {
          a: {
            on: {
              SPAWN: (_, enq) => {
                return {
                  context: {
                    ref: enq.spawn(
                      createCallbackLogic(() => {
                        spawned = true
                      }),
                    ),
                  },
                }
              },
            },
          },
          b: {},
        },
      })

      const service = createActor(machine).start()
      service.getSnapshot().can({ type: 'SPAWN' })

      yield* expect({ spawned }).toEqual({ spawned: false })
    })

    it('should not execute actions when used with non-started actor', function*({ expect }) {
      let executed = false
      const machine = createMachine({
        on: {
          EVENT: (_, enq) => {
            enq(() => (executed = true))
          },
        },
      })

      const actorRef = createActor(machine)

      yield* expect({
        can: actorRef.getSnapshot().can({ type: 'EVENT' }),
        executed,
      }).toEqual({ can: true, executed: false })
    })

    it('should not execute actions when used with started actor', function*({ expect }) {
      let executed = false
      const machine = createMachine({
        on: {
          EVENT: (_, enq) => {
            enq(() => (executed = true))
          },
        },
      })

      const actorRef = createActor(machine).start()

      yield* expect({
        can: actorRef.getSnapshot().can({ type: 'EVENT' }),
        executed,
      }).toEqual({ can: true, executed: false })
    })

    it('should return true when non-first parallel region changes value', function*({ expect }) {
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                id: 'foo',
                on: {
                  EVENT: { target: ['#foo', '#bar'] },
                },
              },
            },
          },
          b: {
            initial: 'b1',
            states: {
              b1: {},
              b2: {
                id: 'bar',
              },
            },
          },
        },
      })

      yield* expect({
        can: createActor(machine).getSnapshot().can({ type: 'EVENT' }),
      }).toEqual({ can: true })
    })

    it(
      'should return true when transition targets a state that is already part of the current configuration but the final state value changes',
      function*({ expect }) {
        const machine = createMachine({
          initial: 'a',
          states: {
            a: {
              id: 'foo',
              initial: 'a1',
              states: {
                a1: {
                  on: {
                    NEXT: { target: 'a2' },
                  },
                },
                a2: {
                  on: {
                    NEXT: { target: '#foo' },
                  },
                },
              },
            },
          },
        })

        const actorRef = createActor(machine).start()
        actorRef.send({ type: 'NEXT' })

        yield* expect({
          can: actorRef.getSnapshot().can({ type: 'NEXT' }),
        }).toEqual({ can: true })
      },
    )
  })

  describe('.hasTag', () => {
    it('should be able to check a tag after recreating a persisted state', function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            tags: ['foo'],
          },
        },
      })

      const actorRef = createActor(machine).start()
      const persistedState = actorRef.getPersistedSnapshot()
      actorRef.stop()
      const restoredSnapshot = createActor(machine, {
        snapshot: persistedState,
      }).getSnapshot()

      yield* expect({ hasTag: restoredSnapshot.hasTag('foo') }).toEqual({
        hasTag: true,
      })
    })
  })

  describe('.status', () => {
    it("should be 'stopped' after a running actor gets stopped", function*({ expect }) {
      const snapshot = createActor(createMachine({}))
        .start()
        .stop()
        .getSnapshot()
      yield* expect(snapshot.status).toBe('stopped')
    })
  })
})

it.each(['__proto__', 'constructor', 'toString'])(
  'transitions from a state named %s in a JSON config',
  function*(key, { expect }) {
    const machine = createMachine(
      JSON.parse(
        JSON.stringify({
          initial: key,
          states: { [key]: { on: { GO: 'done' } }, done: { type: 'final' } },
        }),
      ),
    )
    const actor = createActor(machine)
    const errors: Array<unknown> = []
    actor.subscribe({
      error: (error) => {
        errors.push(error)
      },
    })
    actor.start()
    const hasOwnState = Object.hasOwn(machine.root.states, key)
    actor.send({ type: 'GO' })
    const status = actor.getSnapshot().status

    yield* expect({ hasOwnState, status, errors }).toEqual({
      hasOwnState: true,
      status: 'done',
      errors: [],
    })
  },
)
