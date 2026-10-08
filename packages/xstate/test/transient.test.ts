import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine, matchesState } from '../src/index.js'

const greetingContext = { hour: 10 }
const greetingMachine = createMachine({
  schemas: {
    context: z.object({
      hour: z.number(),
    }),
  },
  id: 'greeting',
  initial: 'pending',
  context: greetingContext,
  states: {
    pending: {
      always: ({ context }) => {
        if (context.hour < 12) {
          return { target: 'morning' }
        } else if (context.hour < 18) {
          return { target: 'afternoon' }
        } else {
          return { target: 'evening' }
        }
      },
    },
    morning: {},
    afternoon: {},
    evening: {},
  },
  on: {
    CHANGE: () => ({
      context: {
        hour: 20,
      },
    }),
    RECHECK: { target: '#greeting' },
  },
})

describe('transient states (eventless transitions)', (it) => {
  it('should choose the first candidate target that matches the guard 1', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.boolean(),
        }),
      },
      context: { data: false },
      initial: 'G',
      states: {
        G: {
          on: { UPDATE_BUTTON_CLICKED: { target: 'E' } },
        },
        E: {
          always: ({ context }) => {
            if (!context.data) {
              return { target: 'D' }
            } else {
              return { target: 'F' }
            }
          },
        },
        D: {},
        F: {},
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'UPDATE_BUTTON_CLICKED' })

    yield* expect(actorRef.getSnapshot().value).toEqual('D')
  })

  it('should choose the first candidate target that matches the guard 2', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.boolean(),
          status: z.string().optional(),
        }),
      },
      context: { data: false },
      initial: 'G',
      states: {
        G: {
          on: { UPDATE_BUTTON_CLICKED: { target: 'E' } },
        },
        E: {
          always: ({ context }) => {
            if (!context.data) {
              return { target: 'D' }
            } else {
              return { target: 'F' }
            }
          },
        },
        D: {},
        F: {},
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'UPDATE_BUTTON_CLICKED' })

    yield* expect(actorRef.getSnapshot().value).toEqual('D')
  })

  it('should choose the final candidate without a guard if none others match', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          data: z.boolean(),
          status: z.string().optional(),
        }),
      },
      context: { data: true },
      initial: 'G',
      states: {
        G: {
          on: { UPDATE_BUTTON_CLICKED: { target: 'E' } },
        },
        E: {
          always: ({ context }) => {
            if (!context.data) {
              return { target: 'D' }
            } else {
              return { target: 'F' }
            }
          },
        },
        D: {},
        F: {},
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'UPDATE_BUTTON_CLICKED' })

    yield* expect(actorRef.getSnapshot().value).toEqual('F')
  })

  it('should carry actions from previous transitions within same step', function*({ expect }) {
    const actual: string[] = []
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          exit: (_, enq) => {
            enq(() => void actual.push('exit_A'))
          },
          on: {
            TIMER: (_, enq) => {
              enq(() => void actual.push('timer'))
              return { target: 'T' }
            },
          },
        },
        T: {
          always: { target: 'B' },
        },
        B: {
          entry: (_, enq) => {
            enq(() => void actual.push('enter_B'))
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'TIMER' })

    yield* expect(actual).toEqual(['exit_A', 'timer', 'enter_B'])
  })

  it('should execute all internal events one after the other', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {
              on: {
                E: { target: 'A2' },
              },
            },
            A2: {
              entry: (_, enq) => {
                enq.raise({ type: 'INT1' })
              },
            },
          },
        },

        B: {
          initial: 'B1',
          states: {
            B1: {
              on: {
                E: { target: 'B2' },
              },
            },
            B2: {
              entry: (_, enq) => {
                enq.raise({ type: 'INT2' })
              },
            },
          },
        },

        C: {
          initial: 'C1',
          states: {
            C1: {
              on: {
                INT1: { target: 'C2' },
                INT2: { target: 'C3' },
              },
            },
            C2: {
              on: {
                INT2: { target: 'C4' },
              },
            },
            C3: {
              on: {
                INT1: { target: 'C4' },
              },
            },
            C4: {},
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'E' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ A: 'A2', B: 'B2', C: 'C4' })
  })

  it('should execute all eventless transitions in the same microstep', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {
              on: {
                E: { target: 'A2' },
              },
            },
            A2: {
              always: { target: 'A3' },
            },
            A3: {
              always: ({ value }) => {
                if (matchesState({ B: 'B3' }, value)) {
                  return { target: 'A4' }
                }
                return undefined
              },
            },
            A4: {},
          },
        },

        B: {
          initial: 'B1',
          states: {
            B1: {
              on: {
                E: { target: 'B2' },
              },
            },
            B2: {
              always: ({ value }) => {
                if (matchesState({ A: 'A2' }, value)) {
                  return { target: 'B3' }
                }
                return undefined
              },
            },
            B3: {
              always: ({ value }) => {
                if (matchesState({ A: 'A3' }, value)) {
                  return { target: 'B4' }
                }
                return undefined
              },
            },
            B4: {},
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'E' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ A: 'A4', B: 'B4' })
  })

  it('should check for automatic transitions even after microsteps are done', function*({ expect }) {
    const machine = createMachine({
      type: 'parallel',
      states: {
        A: {
          initial: 'A1',
          states: {
            A1: {
              on: {
                A: { target: 'A2' },
              },
            },
            A2: {},
          },
        },
        B: {
          initial: 'B1',
          states: {
            B1: {
              always: ({ value }) => {
                if (matchesState({ A: 'A2' }, value)) {
                  return { target: 'B2' }
                }
                return undefined
              },
            },
            B2: {},
          },
        },
        C: {
          initial: 'C1',
          states: {
            C1: {
              always: ({ value }) => {
                if (matchesState({ A: 'A2' }, value)) {
                  return { target: 'C2' }
                }
                return undefined
              },
            },
            C2: {},
          },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'A' })

    yield* expect(actorRef.getSnapshot().value).toEqual({ A: 'A2', B: 'B2', C: 'C2' })
  })

  it('should determine the resolved initial state from the transient state', function*({ expect }) {
    yield* expect(createActor(greetingMachine).getSnapshot().value).toEqual('morning')
  })

  it('should determine the resolved state from an initial transient state', function*({ expect }) {
    const actorRef = createActor(greetingMachine).start()

    actorRef.send({ type: 'CHANGE' })
    const afterChange = actorRef.getSnapshot().value

    actorRef.send({ type: 'RECHECK' })
    const afterRecheck = actorRef.getSnapshot().value

    yield* expect({ afterChange, afterRecheck }).toEqual({
      afterChange: 'morning',
      afterRecheck: 'evening',
    })
  })

  it('should select eventless transition before processing raised events', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            FOO: { target: 'b' },
          },
        },
        b: {
          entry: (_, enq) => {
            enq.raise({ type: 'BAR' })
          },
          always: { target: 'c' },
          on: {
            BAR: { target: 'd' },
          },
        },
        c: {
          on: {
            BAR: { target: 'e' },
          },
        },
        d: {},
        e: {},
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FOO' })

    yield* expect(actorRef.getSnapshot().value).toBe('e')
  })

  it('should not select wildcard for eventless transition', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: { FOO: { target: 'b' } },
        },
        b: {
          always: { target: 'pass' },
          on: {
            '*': { target: 'fail' },
          },
        },
        fail: {},
        pass: {},
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FOO' })

    yield* expect(actorRef.getSnapshot().value).toBe('pass')
  })

  it('should work with transient transition on root', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      id: 'machine',
      initial: 'first',
      context: { count: 0 },
      states: {
        first: {
          on: {
            ADD: ({ context }) => ({
              context: {
                count: context.count + 1,
              },
            }),
          },
        },
        success: {
          type: 'final',
        },
      },

      always: ({ context }) => {
        if (context.count > 0) {
          return { target: '.success' }
        }
        return undefined
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'ADD' })

    yield* expect(actorRef.getSnapshot().status).toBe('done')
  })

  it(
    "shouldn't crash when invoking a machine with initial transient transition depending on custom data",
    function*({ expect }) {
      const timerMachine = createMachine({
        initial: 'initial',
        schemas: {
          context: z.object({
            duration: z.number(),
          }),
          input: z.object({
            duration: z.number(),
          }),
        },
        context: ({ input }: { input: { duration: number } }) => ({
          duration: input.duration,
        }),
        states: {
          initial: {
            always: ({ context }) => {
              if (context.duration < 1000) {
                return { target: 'finished' }
              } else {
                return { target: 'active' }
              }
            },
          },
          active: {},
          finished: { type: 'final' },
        },
      })

      const machine = createMachine({
        schemas: {
          context: z.object({
            customDuration: z.number(),
          }),
        },
        initial: 'active',
        context: {
          customDuration: 3000,
        },
        states: {
          active: {
            invoke: {
              src: timerMachine,
              input: ({ context }) => ({
                duration: context.customDuration,
              }),
            },
          },
        },
      })

      const actorRef = createActor(machine)

      yield* expect(actorRef.start().getSnapshot().value).toEqual('active')
    },
  )

  it('should be taken even in absence of other transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          always: ({ event }) => {
            if (event.type === 'WHATEVER') {
              return { target: 'b' }
            }
            return undefined
          },
        },
        b: {},
      },
    })
    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'WHATEVER' })

    yield* expect(actorRef.getSnapshot().value).toBe('b')
  })

  it('should select subsequent transient transitions even in absence of other transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          always: ({ event }) => {
            if (event.type === 'WHATEVER') {
              return { target: 'b' }
            }
            return undefined
          },
        },
        b: {
          always: () => {
            if (true) {
              return { target: 'c' }
            }
            return undefined
          },
        },
        c: {},
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'WHATEVER' })

    yield* expect(actorRef.getSnapshot().value).toBe('c')
  })

  it('events that trigger eventless transitions should be preserved in guards', function*({ expect }) {
    const guardEvents: string[] = []
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            EVENT: { target: 'b' },
          },
        },
        b: {
          always: { target: 'c' },
        },
        c: {
          always: ({ event }) => {
            guardEvents.push(event.type)
            if (event.type === 'EVENT') {
              return { target: 'd' }
            }
            return undefined
          },
        },
        d: { type: 'final' },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT' })

    yield* expect({
      guardEventsOtherThanEvent: guardEvents.filter((type) => type !== 'EVENT'),
      status: actorRef.getSnapshot().status,
    }).toEqual({ guardEventsOtherThanEvent: [], status: 'done' })
  })

  it('events that trigger eventless transitions should be preserved in actions', function*({ expect }) {
    const actionEvents: unknown[] = []

    const machine = createMachine({
      schemas: {
        events: {
          EVENT: z.object({ value: z.number() }),
        },
      },
      initial: 'a',
      states: {
        a: {
          on: {
            EVENT: { target: 'b' },
          },
        },
        b: {
          always: ({ event }, enq) => {
            enq(() => void actionEvents.push(event))
            return { target: 'c' }
          },
        },
        c: {
          entry: ({ event }, enq) => {
            enq(() => void actionEvents.push(event))
          },
        },
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'EVENT', value: 42 })

    yield* expect(actionEvents).toEqual([
      { type: 'EVENT', value: 42 },
      { type: 'EVENT', value: 42 },
    ])
  })

  it('should avoid infinite loops with eventless transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      options: {
        maxIterations: 100,
      },
      states: {
        a: {
          always: {
            target: 'b',
          },
        },
        b: {
          always: {
            target: 'c',
          },
        },
        c: {
          always: {
            target: 'a',
          },
        },
      },
    })
    const errors: unknown[] = []
    const actor = createActor(machine)

    actor.subscribe({
      error: (err) => {
        errors.push(err)
      },
    })

    actor.start()

    yield* expect(errors.map((err) => (err as Error).message)).toEqual([
      expect.stringMatching(/infinite loop/i),
    ])
  })

  it('should avoid infinite loops with raised events', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          always: {
            target: 'b',
          },
        },
        b: {
          entry: (_, enq) => {
            enq.raise({ type: 'EVENT' })
          },
          on: {
            EVENT: {
              target: 'c',
            },
          },
        },
        c: {
          always: {
            target: 'a',
          },
        },
      },
      options: {
        maxIterations: 100,
      },
    })
    const errors: unknown[] = []
    const actor = createActor(machine)

    actor.subscribe({
      error: (err) => {
        errors.push(err)
      },
    })

    actor.start()

    yield* expect(errors.map((err) => (err as Error).message)).toEqual([
      expect.stringMatching(/infinite loop/i),
    ])
  })

  it("shouldn't end up in an infinite loop when selecting the fallback target", function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            event: { target: 'active' },
          },
        },
        active: {
          initial: 'a',
          states: {
            a: {},
            b: {},
          },
          always: () => {
            if (1 + 1 === 3) {
              return { target: '.a' }
            } else {
              return { target: '.b' }
            }
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({
      type: 'event',
    })

    yield* expect(actorRef.getSnapshot().value).toEqual({ active: 'b' })
  })

  it("shouldn't end up in an infinite loop when selecting a guarded target", function*({ expect }) {
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            event: { target: 'active' },
          },
        },
        active: {
          initial: 'a',
          states: {
            a: {},
            b: {},
          },
          always: () => {
            if (1 + 1 === 2) {
              return { target: '.a' }
            } else {
              return { target: '.b' }
            }
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({
      type: 'event',
    })

    yield* expect(actorRef.getSnapshot().value).toEqual({ active: 'a' })
  })

  it(
    "shouldn't end up in an infinite loop when executing a fire-and-forget action that doesn't change state",
    function*({ expect }) {
      let count = 0
      const machine = createMachine({
        initial: 'idle',
        states: {
          idle: {
            on: {
              event: { target: 'active' },
            },
          },
          active: {
            initial: 'a',
            states: {
              a: {},
            },
            always: (_, enq) => {
              enq(() => {
                count++
                if (count > 5) {
                  throw new Error('Infinite loop detected')
                }
              })
              return { target: '.a' }
            },
          },
        },
      })

      const actorRef = createActor(machine)

      actorRef.start()
      actorRef.send({
        type: 'event',
      })

      yield* expect({
        value: actorRef.getSnapshot().value,
        count,
      }).toEqual({ value: { active: 'a' }, count: 1 })
    },
  )

  it('should loop (but not infinitely) for assign actions', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: { count: 0 },
      initial: 'counting',
      states: {
        counting: {
          always: ({ context }) => {
            if (context.count < 5) {
              return {
                context: { count: context.count + 1 },
              }
            }
            return undefined
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    yield* expect(actorRef.getSnapshot().context.count).toEqual(5)
  })

  it(
    "should execute an always transition after a raised transition even if that raised transition doesn't change the state",
    function*({ expect }) {
      const calls: unknown[][] = []
      let counter = 0
      const machine = createMachine({
        always: (_, enq) => {
          enq((...args) => {
            calls.push(args)
          }, counter)
        },
        on: {
          EV: (_, enq) => {
            enq.raise({ type: 'RAISED' })
          },
          RAISED: (_, enq) => {
            enq(() => {
              ++counter
            })
          },
        },
      })
      const actorRef = createActor(machine).start()
      calls.length = 0
      actorRef.send({ type: 'EV' })

      yield* expect(calls).toEqual([[0], [0]])
    },
  )
})
