import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import z from 'zod'
import { builtInActions } from '../src/actions.js'
import { createActor, createMachine, setup, SimulatedClock } from '../src/index.js'

const lightMachine = createMachine({
  schemas: {
    context: z.object({
      canTurnGreen: z.boolean(),
    }),
  },
  id: 'light',
  initial: 'green',
  context: {
    canTurnGreen: true,
  },
  states: {
    green: {
      after: {
        1000: { target: 'yellow' },
      },
    },
    yellow: {
      after: {
        1000: { target: 'red' },
      },
    },
    red: {
      after: {
        1000: { target: 'green' },
      },
    },
  },
})

describe('delayed transitions', () => {
  it('resolves a named delay with context updated by the same state entry', function*({ expect }) {
    const clock = new SimulatedClock()

    const machine = setup({
      delays: { d: ({ context }) => context['ms'] },
    }).createMachine({
      context: { ms: 0 },
      initial: 'a',
      states: {
        a: { on: { go: { target: 'b' } } },
        b: {
          entry: () => ({ context: { ms: 300 } }),
          after: { d: { target: 'a' } },
        },
      },
    })
    const actor = createActor(machine, { clock }).start()

    actor.send({ type: 'go' })
    const contextMs = actor.getSnapshot().context['ms']

    clock.increment(299)
    const after299 = actor.getSnapshot().value

    clock.increment(1)
    const after300 = actor.getSnapshot().value
    actor.stop()

    yield* expect({ contextMs, after299, after300 }).toEqual({
      contextMs: 300,
      after299: 'b',
      after300: 'a',
    })
  })

  it('resolves all initial state delays after an enqueue entry context patch', function*({ expect }) {
    const clock = new SimulatedClock()
    const order: string[] = []
    const effectCalls: unknown[][] = []
    const effect = (...args: unknown[]) => {
      effectCalls.push(args)
    }
    const machine = setup({
      delays: {
        first: ({ context }) => {
          order.push('first')
          return context['ms'] + context['offset']
        },
        second: ({ context }) => {
          order.push('second')
          return context['ms'] * 2 + context['offset']
        },
      },
    }).createMachine({
      context: { ms: 0, offset: 20 },
      initial: 'waiting',
      states: {
        waiting: {
          entry: (_, enq) => {
            order.push('entry')
            enq(effect)
            return { context: { ms: 300 } }
          },
          after: {
            first: { target: 'done' },
            second: { target: 'done' },
          },
        },
        done: {},
      },
    })
    const actor = createActor(machine, { clock }).start()

    const delays = Object.values(actor.getSnapshot().timers).map((timer) => timer.delay)

    clock.increment(319)
    const after319 = actor.getSnapshot().value

    clock.increment(1)
    const after320 = actor.getSnapshot().value
    const timersAfter = actor.getSnapshot().timers
    actor.stop()

    yield* expect({ order, effectCalls, delays, after319, after320, timersAfter }).toEqual({
      order: ['entry', 'first', 'second'],
      effectCalls: [[]],
      delays: [320, 620],
      after319: 'waiting',
      after320: 'done',
      timersAfter: {},
    })
  })

  it.each([false, true])(
    'schedules after entry cancellation and honors later cancellation (cancel after entry: %s)',
    function*(cancelAfterEntry, { expect }) {
      const clock = new SimulatedClock()
      const timerId = 'xstate.after.100.(machine).waiting'
      const machine = createMachine({
        initial: 'waiting',
        states: {
          waiting: {
            entry: (_, enq) => {
              enq.cancel(timerId)
            },
            after: { 100: { target: 'done' } },
            on: {
              cancel: (_, enq) => {
                enq.cancel(timerId)
              },
            },
          },
          done: {},
        },
      })
      const actor = createActor(machine, { clock }).start()

      const scheduledDelay = actor.getSnapshot().timers[timerId]?.delay
      clock.increment(50)
      const after50 = actor.getSnapshot().value

      let afterCancel: unknown = undefined
      if (cancelAfterEntry) {
        actor.send({ type: 'cancel' })
        afterCancel = actor.getSnapshot().timers
      }

      clock.increment(100)
      const finalValue = actor.getSnapshot().value
      actor.stop()

      yield* expect({ scheduledDelay, after50, afterCancel, finalValue }).toEqual({
        scheduledDelay: 100,
        after50: 'waiting',
        afterCancel: cancelAfterEntry ? {} : undefined,
        finalValue: cancelAfterEntry ? 'waiting' : 'done',
      })
    },
  )

  it('does not rely on inferred function names for built-in timer effects', function*({ expect }) {
    const clock = new SimulatedClock()
    const raise = builtInActions['@xstate.raise']
    const originalName = Object.getOwnPropertyDescriptor(raise, 'name')!
    Object.defineProperty(raise, 'name', { ...originalName, value: 'a' })

    try {
      const actor = createActor(
        createMachine({
          initial: 'waiting',
          states: {
            waiting: { after: { 10: { target: 'done' } } },
            done: {},
          },
        }),
        { clock },
      ).start()

      clock.increment(10)
      yield* expect(actor.getSnapshot().value).toBe('done')
    } finally {
      Object.defineProperty(raise, 'name', originalName)
    }
  })

  it('uses a canonical after event with delay and state identity', function*({ expect }) {
    const clock = new SimulatedClock()
    const afterEventCalls: unknown[][] = []
    const spy = (...args: unknown[]) => {
      afterEventCalls.push(args)
    }
    const actor = createActor(
      createMachine({
        id: 'job',
        after: {
          10: ({ event }, enq) => {
            enq(spy, event)
            return {}
          },
        },
      }),
      { clock },
    ).start()

    clock.increment(10)
    actor.stop()

    yield* expect(afterEventCalls).toEqual([[{ type: 'xstate.after', delay: 10, stateId: 'job' }]])
  })

  it('should transition after delay', function*({ expect }) {
    const clock = new SimulatedClock()

    const actorRef = createActor(lightMachine, { clock }).start()
    const start = actorRef.getSnapshot().value

    clock.increment(500)
    const after500 = actorRef.getSnapshot().value

    clock.increment(510)
    const after1010 = actorRef.getSnapshot().value
    actorRef.stop()

    yield* expect({ start, after500, after1010 }).toEqual({
      start: 'green',
      after500: 'green',
      after1010: 'yellow',
    })
  })

  it('should transition after an ISO8601 duration without a delay source', function*({ expect }) {
    const clock = new SimulatedClock()

    const actorRef = createActor(
      createMachine({
        initial: 'pending',
        states: {
          pending: {
            after: {
              'PT0.5S': { target: 'done' },
            },
          },
          done: {},
        },
      }),
      { clock },
    ).start()

    clock.increment(499)
    const after499 = actorRef.getSnapshot().value

    clock.increment(1)
    const after500 = actorRef.getSnapshot().value
    actorRef.stop()

    yield* expect({ after499, after500 }).toEqual({ after499: 'pending', after500: 'done' })
  })

  it('should error on a delay that is neither a delay name nor a duration', function*({ expect }) {
    const actorRef = createActor(
      createMachine({
        initial: 'pending',
        states: {
          pending: {
            after: {
              Pfoo: { target: 'done' },
            },
          },
          done: {},
        },
      }),
    )
    actorRef.subscribe({ error: () => {} })
    actorRef.start()

    const snapshot = actorRef.getSnapshot()

    yield* expect({ status: snapshot.status, message: (snapshot.error as Error).message }).toEqual({
      status: 'error',
      message:
        'Invalid delay "Pfoo": not a configured delay name or a valid duration string (e.g. "500ms", "1.5s", "PT1M30S").',
    })
  })

  it('should prefer a delay source value over the parsed ISO8601 duration', function*({ expect }) {
    const clock = new SimulatedClock()

    const actorRef = createActor(
      createMachine({
        delays: {
          PT1S: 20,
        },
        initial: 'pending',
        states: {
          pending: {
            after: {
              PT1S: { target: 'done' },
            },
          },
          done: {},
        },
      }),
      { clock },
    ).start()

    clock.increment(19)
    const after19 = actorRef.getSnapshot().value

    clock.increment(2)
    const after21 = actorRef.getSnapshot().value
    actorRef.stop()

    yield* expect({ after19, after21 }).toEqual({ after19: 'pending', after21: 'done' })
  })

  it(
    'should not try to clear an undefined timeout when exiting source state of a delayed transition',
    function*({ expect }) {
      // https://github.com/statelyai/xstate/issues/5001
      const clock = new SimulatedClock()
      const clearTimeoutCalls: unknown[][] = []
      const recordingClock = {
        now: () => clock.now(),
        setTimeout: (fn: (...args: unknown[]) => void, milliseconds: number) => clock.setTimeout(fn, milliseconds),
        clearTimeout: (id: number) => {
          clearTimeoutCalls.push([id])
          clock.clearTimeout(id)
        },
      }

      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            after: {
              1: { target: 'yellow' },
            },
          },
          yellow: {},
        },
      })

      const actorRef = createActor(machine, { clock: recordingClock }).start()

      clock.increment(1)

      yield* expect({ value: actorRef.getSnapshot().value, clearCalls: clearTimeoutCalls }).toEqual({
        value: 'yellow',
        clearCalls: [],
      })
    },
  )

  it('should format transitions properly', function*({ expect }) {
    const greenNode = lightMachine.states['green']
    if (greenNode === undefined) {
      throw new Error('expected a green state node')
    }

    const transitions = greenNode.transitions
    const keys = [...transitions.keys()]

    const afterTransition = transitions.get('xstate.after')?.[0]
    if (afterTransition === undefined) {
      throw new Error('expected an after transition')
    }

    yield* expect({ keys, matches: afterTransition.matches }).toEqual({
      keys: ['xstate.after'],
      matches: { delay: 1000, stateId: 'light.green' },
    })
  })

  it('should be able to transition with delay from nested initial state', function*({ expect }) {
    const clock = new SimulatedClock()
    const { resolve, promise } = Promise.withResolvers<void>()

    const machine = createMachine({
      initial: 'nested',
      states: {
        nested: {
          initial: 'wait',
          states: {
            wait: {
              after: {
                10: { target: '#end' },
              },
            },
          },
        },
        end: {
          id: 'end',
          type: 'final',
        },
      },
    })

    const actor = createActor(machine, { clock })
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    actor.start()
    clock.increment(10)

    yield* Effect.promise(() => promise)

    yield* expect(actor.getSnapshot().status).toBe('done')
  })

  it('parent state should enter child state without re-entering self (relative target)', function*({ expect }) {
    const clock = new SimulatedClock()
    const { resolve, promise } = Promise.withResolvers<void>()

    const actual: string[] = []

    const machine = createMachine({
      initial: 'one',
      states: {
        one: {
          initial: 'two',
          entry: (_, enq) => enq(() => actual.push('entered one')),
          states: {
            two: {
              entry: (_, enq) => {
                enq(() => actual.push('entered two'))
              },
            },
            three: {
              entry: (_, enq) => {
                enq(() => actual.push('entered three'))
              },
              always: { target: '#end' },
            },
          },
          after: {
            10: () => {
              return { target: '.three' }
            },
          },
        },
        end: {
          id: 'end',
          type: 'final',
        },
      },
    })

    const actor = createActor(machine, { clock })
    actor.subscribe({
      complete: () => {
        resolve()
      },
    })
    actor.start()
    clock.increment(10)

    yield* Effect.promise(() => promise)

    yield* expect({ actual, status: actor.getSnapshot().status }).toEqual({
      actual: ['entered one', 'entered two', 'entered three'],
      status: 'done',
    })
  })

  it('should defer a single send event for a delayed conditional transition (#886)', function*({ expect }) {
    const clock = new SimulatedClock()
    const sendCalls: unknown[][] = []
    const spy = (...args: unknown[]) => {
      sendCalls.push(args)
    }
    const machine = createMachine({
      initial: 'X',
      states: {
        X: {
          after: {
            1: () => {
              if (1 + 1 === 2) {
                return { target: 'Y' }
              } else {
                return { target: 'Z' }
              }
            },
          },
        },
        Y: {
          on: {
            '*': (_, enq) => enq(spy),
          },
        },
        Z: {},
      },
    })

    createActor(machine, { clock }).start()

    clock.increment(10)
    yield* expect(sendCalls).toEqual([])
  })

  it.skip(
    'should execute an after transition after starting from a state resolved using `.getPersistedSnapshot`',
    function*({ expect }) {
      const clock = new SimulatedClock()

      const machine = createMachine({
        id: 'machine',
        initial: 'a',
        states: {
          a: {
            on: { next: { target: 'withAfter' } },
          },

          withAfter: {
            after: {
              1: { target: 'done' },
            },
          },

          done: {
            type: 'final',
          },
        },
      })

      const actorRef1 = createActor(machine, { clock }).start()
      actorRef1.send({ type: 'next' })
      const withAfterState = actorRef1.getPersistedSnapshot()

      const actorRef2 = createActor(machine, { clock, snapshot: withAfterState })
      actorRef2.start()
      clock.increment(1)

      yield* expect(actorRef2.getSnapshot().value).toBe('done')
    },
  )

  it('should execute an after transition after starting from a persisted state', function*({ expect }) {
    const clock = new SimulatedClock()
    const { resolve, promise } = Promise.withResolvers<void>()
    const createMyMachine = () =>
      createMachine({
        initial: 'A',
        states: {
          A: {
            on: {
              NEXT: { target: 'B' },
            },
          },
          B: {
            after: {
              1: { target: 'C' },
            },
          },
          C: {
            type: 'final',
          },
        },
      })

    let service = createActor(createMyMachine(), { clock }).start()

    const persistedSnapshot = JSON.parse(JSON.stringify(service.getSnapshot()))

    service = createActor(createMyMachine(), {
      clock,
      snapshot: persistedSnapshot,
    }).start()

    service.subscribe({ complete: () => resolve() })

    service.send({ type: 'NEXT' })
    clock.increment(1)

    yield* Effect.promise(() => promise)

    yield* expect(service.getSnapshot().status).toBe('done')
  })

  describe('delay expressions', () => {
    it('should evaluate the expression (function) to determine the delay', function*({ expect }) {
      const clock = new SimulatedClock()
      const delayCalls: unknown[][] = []
      const spy = (...args: unknown[]) => {
        delayCalls.push(args)
      }
      const context = {
        delay: 500,
      }
      const machine = createMachine({
        initial: 'inactive',
        schemas: {
          context: z.object({
            delay: z.number(),
          }),
        },
        context,
        delays: {
          myDelay: ({ context }) => {
            spy(context)
            return context.delay
          },
        },
        states: {
          inactive: {
            after: { myDelay: { target: 'active' } },
          },
          active: {},
        },
      })

      const actor = createActor(machine, { clock }).start()

      const initial = actor.getSnapshot().value

      clock.increment(300)
      const after300 = actor.getSnapshot().value

      clock.increment(200)
      const after500 = actor.getSnapshot().value
      actor.stop()

      yield* expect({ delayCalls, initial, after300, after500 }).toEqual({
        delayCalls: [[context]],
        initial: 'inactive',
        after300: 'inactive',
        after500: 'active',
      })
    })

    it('should evaluate the expression (string) to determine the delay', function*({ expect }) {
      const clock = new SimulatedClock()
      const delayCalls: unknown[][] = []
      const spy = (...args: unknown[]) => {
        delayCalls.push(args)
      }
      const machine = createMachine({
        initial: 'inactive',
        schemas: {
          events: {
            ACTIVATE: z.object({ delay: z.number() }),
          },
        },
        delays: {
          someDelay: ({ event }) => {
            spy(event)
            return event.delay
          },
        },
        states: {
          inactive: {
            on: {
              ACTIVATE: { target: 'active' },
            },
          },
          active: {
            after: {
              someDelay: { target: 'inactive' },
            },
          },
        },
      })

      const actor = createActor(machine, { clock }).start()

      const event = {
        type: 'ACTIVATE',
        delay: 500,
      } as const
      actor.send(event)

      const afterSend = actor.getSnapshot().value

      clock.increment(300)
      const after300 = actor.getSnapshot().value

      clock.increment(200)
      const after500 = actor.getSnapshot().value
      actor.stop()

      yield* expect({ delayCalls, afterSend, after300, after500 }).toEqual({
        delayCalls: [[event]],
        afterSend: 'active',
        after300: 'active',
        after500: 'inactive',
      })
    })
  })

  describe('stateNode in delay functions', () => {
    it('should pass stateNode to delay expression', function*({ expect }) {
      const clock = new SimulatedClock()
      const delayCalls: unknown[][] = []
      const spy = (...args: unknown[]) => {
        delayCalls.push(args)
      }

      const machine = createMachine({
        initial: 'waiting',
        schemas: {
          context: z.object({
            durations: z.record(z.number()),
          }),
        },
        context: {
          durations: {
            waiting: 300,
            active: 500,
          },
        },
        delays: {
          phaseDuration: ({ context, stateNode }) => {
            spy(stateNode.key)
            const duration = context.durations[stateNode.key]
            if (duration === undefined) {
              throw new Error('expected a duration for the state node')
            }
            return duration
          },
        },
        states: {
          waiting: {
            after: { phaseDuration: { target: 'active' } },
          },
          active: {
            after: { phaseDuration: { target: 'done' } },
          },
          done: { type: 'final' },
        },
      })

      const actor = createActor(machine, { clock }).start()

      const initial = actor.getSnapshot().value

      clock.increment(300)
      const after300 = actor.getSnapshot().value

      clock.increment(500)
      const after800 = actor.getSnapshot().value
      actor.stop()

      yield* expect({ delayCalls, initial, after300, after800 }).toEqual({
        delayCalls: [['waiting'], ['active']],
        initial: 'waiting',
        after300: 'active',
        after800: 'done',
      })
    })

    it('should pass stateNode with correct id', function*({ expect }) {
      const clock = new SimulatedClock()
      const delayCalls: unknown[][] = []
      const spy = (...args: unknown[]) => {
        delayCalls.push(args)
      }

      const machine = createMachine({
        id: 'test',
        initial: 'a',
        delays: {
          myDelay: ({ stateNode }) => {
            spy(stateNode.id)
            return 100
          },
        },
        states: {
          a: {
            after: { myDelay: { target: 'b' } },
          },
          b: { type: 'final' },
        },
      })

      createActor(machine, { clock }).start()

      clock.increment(100)

      yield* expect(delayCalls).toEqual([['test.a']])
    })
  })
})
