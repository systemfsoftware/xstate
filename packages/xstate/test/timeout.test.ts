import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import z from 'zod'
import { createAsyncLogic, TimeoutError } from '../src/actors/promise.js'
import { createActor, createMachine, initialTransition, setup, transition } from '../src/index.js'

function createManualClock() {
  let now = 0
  let nextId = 0
  const scheduled = new Map<number, { at: number; fn: (...args: unknown[]) => void }>()

  const clock = {
    now: () => now,
    setTimeout: (fn: (...args: unknown[]) => void, timeout: number) => {
      const id = ++nextId
      scheduled.set(id, { at: now + timeout, fn })
      return id
    },
    clearTimeout: (id: number) => {
      scheduled.delete(id)
    },
  }

  return {
    clock,
    advance(ms: number) {
      now += ms
      for (let pass = 0; pass < 100; pass++) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)
        if (due.length === 0) {
          break
        }
        for (const [id, timer] of due) {
          scheduled.delete(id)
          timer.fn()
        }
      }
    },
  }
}

const afterRealTime = (milliseconds: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}

describe('async logic timeout', () => {
  it('aborts and errors when createAsyncLogic exceeds its timeout', function*({ expect }) {
    const { clock, advance } = createManualClock()

    let signal: AbortSignal | undefined
    const logic = createAsyncLogic({
      id: 'slow-task',
      timeout: '10ms',
      run: ({ signal: receivedSignal }) => {
        signal = receivedSignal
        return new Promise(() => {})
      },
    })
    const actor = createActor(logic, { clock })
    actor.subscribe({ error: () => {} })

    actor.start()
    advance(10)

    yield* expect({
      id: logic.id,
      aborted: signal?.aborted,
      snapshot: actor.getSnapshot(),
    }).toEqual({
      id: 'slow-task',
      aborted: true,
      snapshot: expect.objectContaining({
        status: 'error',
        error: expect.any(TimeoutError),
      }),
    })
  })
})

describe('state-level timeout', () => {
  it('transitions via onTimeout when duration elapses', function*({ expect }) {
    const { clock, advance } = createManualClock()
    const timeoutCalls: unknown[][] = []
    const onTimeoutCall = (...args: unknown[]) => {
      timeoutCalls.push(args)
    }

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          timeout: 1000,
          onTimeout: ({ event }, enq) => {
            enq(onTimeoutCall, event)
            return { target: 'escalated' }
          },
        },
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()
    const atStart = actor.getSnapshot().value

    advance(500)
    const afterHalf = actor.getSnapshot().value

    advance(600)

    yield* expect({
      atStart,
      afterHalf,
      afterTimeout: actor.getSnapshot().value,
      timeoutCalls,
    }).toEqual({
      atStart: 'waiting',
      afterHalf: 'waiting',
      afterTimeout: 'escalated',
      timeoutCalls: [[{ type: 'xstate.timeout', stateId: '(machine).waiting' }]],
    })
  })

  it('cancels the timeout when the state is exited by another event', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          timeout: 1000,
          onTimeout: { target: 'escalated' },
          on: { APPROVE: { target: 'approved' } },
        },
        approved: {},
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()
    actor.send({ type: 'APPROVE' })
    const afterApprove = actor.getSnapshot().value

    advance(5000)

    yield* expect({
      afterApprove,
      afterTimeout: actor.getSnapshot().value,
    }).toEqual({ afterApprove: 'approved', afterTimeout: 'approved' })
  })

  it('coexists with `after` on the same state (independent timers)', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          after: { 500: { target: 'periodic' } },
          timeout: 1000,
          onTimeout: { target: 'escalated' },
        },
        periodic: {},
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()
    const atStart = actor.getSnapshot().value

    advance(600)

    yield* expect({ atStart, afterAfter: actor.getSnapshot().value }).toEqual({
      atStart: 'waiting',
      afterAfter: 'periodic',
    })
  })

  it('accepts a cross-state context patch (typed against the target state schema)', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = setup({
      schemas: {
        context: z.object({
          reason: z.union([z.literal('timeout'), z.literal('after'), z.null()]),
        }),
      },
      states: {
        running: { schemas: { context: z.object({ reason: z.null() }) } },
        expired: {
          schemas: { context: z.object({ reason: z.literal('timeout') }) },
        },
        elapsed: {
          schemas: { context: z.object({ reason: z.literal('after') }) },
        },
      },
    }).createMachine({
      context: { reason: null },
      initial: 'running',
      states: {
        running: {
          timeout: 1000,
          onTimeout: () => ({
            target: 'expired',
            context: { reason: 'timeout' },
          }),
          after: {
            2000: () => ({
              target: 'elapsed',
              context: { reason: 'after' },
            }),
          },
        },
        expired: { type: 'final' },
        elapsed: { type: 'final' },
      },
    })

    const actor = createActor(machine, { clock }).start()
    const atStart = actor.getSnapshot().value

    advance(1000)

    yield* expect({
      atStart,
      afterTimeout: actor.getSnapshot().value,
      afterTimeoutContext: actor.getSnapshot().context,
    }).toEqual({
      atStart: 'running',
      afterTimeout: 'expired',
      afterTimeoutContext: { reason: 'timeout' },
    })
  })

  it('rejects a cross-state context patch that does not match the target state schema', function*({ expect }) {
    const machine = setup({
      schemas: {
        context: z.object({
          reason: z.union([z.literal('timeout'), z.null()]),
        }),
      },
      states: {
        running: { schemas: { context: z.object({ reason: z.null() }) } },
        expired: {
          schemas: { context: z.object({ reason: z.literal('timeout') }) },
        },
      },
    }).createMachine({
      context: { reason: null },
      initial: 'running',
      states: {
        running: {
          timeout: 1000,
          // @ts-expect-error - `reason: null` is not assignable to the target state's context
          onTimeout: () => ({
            target: 'expired',
            context: { reason: null },
          }),
          after: {
            // @ts-expect-error - `reason: null` is not assignable to the target state's context
            2000: () => ({
              target: 'expired',
              context: { reason: null },
            }),
          },
        },
        expired: { type: 'final' },
      },
    })

    yield* expect(initialTransition(machine)[0].value).toEqual('running')
  })

  it('supports onTimeout with object form { target }', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          timeout: 500,
          onTimeout: { target: 'escalated' },
        },
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()
    const atStart = actor.getSnapshot().value

    advance(600)

    yield* expect({ atStart, afterTimeout: actor.getSnapshot().value }).toEqual({
      atStart: 'waiting',
      afterTimeout: 'escalated',
    })
  })

  it('supports a dynamic timeout function', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      context: { slaMs: 1500 },
      initial: 'waiting',
      states: {
        waiting: {
          timeout: ({ context }) => context.slaMs,
          onTimeout: { target: 'escalated' },
        },
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()

    advance(1000)
    const afterOneSecond = actor.getSnapshot().value

    advance(600)

    yield* expect({
      afterOneSecond,
      afterTimeout: actor.getSnapshot().value,
    }).toEqual({ afterOneSecond: 'waiting', afterTimeout: 'escalated' })
  })

  it('supports a referenced delay', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      delays: {
        approvalSla: 750,
      },
      initial: 'waiting',
      states: {
        waiting: {
          timeout: 'approvalSla',
          onTimeout: { target: 'escalated' },
        },
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()

    advance(700)
    const afterSevenHundred = actor.getSnapshot().value

    advance(100)

    yield* expect({
      afterSevenHundred,
      afterTimeout: actor.getSnapshot().value,
    }).toEqual({ afterSevenHundred: 'waiting', afterTimeout: 'escalated' })
  })

  it('keeps `timeout` and `after` independent on the same state', function*({ expect }) {
    const { clock, advance } = createManualClock()
    const afterCalls: unknown[][] = []
    const afterCall = (...args: unknown[]) => {
      afterCalls.push(args)
    }

    const machine = createMachine({
      initial: 'waiting',
      states: {
        waiting: {
          after: {
            500: ({ context, event, guards, actions }, enq) => {
              enq(afterCall)
            },
          },
          timeout: 1000,
          onTimeout: { target: 'escalated' },
        },
        escalated: {},
      },
    })

    const actor = createActor(machine, { clock }).start()

    advance(600)
    const afterSixHundred = actor.getSnapshot().value
    const afterCallsAtSixHundred = [...afterCalls]

    advance(500)

    yield* expect({
      afterSixHundred,
      afterCallsAtSixHundred,
      afterTimeout: actor.getSnapshot().value,
    }).toEqual({
      afterSixHundred: 'waiting',
      afterCallsAtSixHundred: [[]],
      afterTimeout: 'escalated',
    })
  })

  it('throws at construction when timeout is set without onTimeout', function*({ expect }) {
    const invalidDefinition = {
      initial: 'waiting',
      states: {
        waiting: {
          timeout: 1000,
        },
      },
    } as unknown as Parameters<typeof createMachine>[0]

    yield* expect(() => createMachine(invalidDefinition)).toThrow(/onTimeout/)
  })

  it('passes state input to entry, exit, on, timeout, onTimeout, and after', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const entryCalls: unknown[][] = []
    const entryCall = (...args: unknown[]) => {
      entryCalls.push(args)
    }
    const exitCalls: unknown[][] = []
    const exitCall = (...args: unknown[]) => {
      exitCalls.push(args)
    }
    const timeoutCalls: unknown[][] = []
    const timeoutCall = (...args: unknown[]) => {
      timeoutCalls.push(args)
    }
    const onTimeoutCalls: unknown[][] = []
    const onTimeoutCall = (...args: unknown[]) => {
      onTimeoutCalls.push(args)
    }
    const onPingCalls: unknown[][] = []
    const onPingCall = (...args: unknown[]) => {
      onPingCalls.push(args)
    }
    const afterCalls: unknown[][] = []
    const afterCall = (...args: unknown[]) => {
      afterCalls.push(args)
    }

    const machine = setup({
      schemas: {
        events: {
          activate: z.object({
            duration: z.number(),
          }),
          ping: z.object({}),
        },
      },
      states: {
        idle: {},
        active: {
          schemas: {
            input: z.object({
              duration: z.number(),
            }),
          },
        },
      },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            activate: ({ event }) => ({
              target: 'active',
              input: {
                duration: event.duration,
              },
            }),
          },
        },
        active: {
          entry: ({ input }, enq) => {
            enq(entryCall, input.duration)
          },
          exit: ({ input }, enq) => {
            enq(exitCall, input.duration)
          },
          timeout: ({ input }) => {
            timeoutCall(input.duration)

            return input.duration
          },
          onTimeout: ({ input }, enq) => {
            enq(onTimeoutCall, input.duration)

            return {
              target: 'idle',
            }
          },
          on: {
            ping: ({ input }, enq) => {
              onPingCall(input.duration)
            },
          },
          after: {
            1000: ({ input }) => {
              afterCall(input.duration)
            },
          },
        },
      },
    })

    const actor = createActor(machine, { clock }).start()

    actor.send({ type: 'activate', duration: 500 })

    const activeValue = actor.getSnapshot().value
    const entryCallsAtActive = [...entryCalls]
    const timeoutCallsAtActive = [...timeoutCalls]
    const onTimeoutCallsAtActive = [...onTimeoutCalls]

    actor.send({ type: 'ping' })
    const onPingCallsAfterPing = [...onPingCalls]

    advance(500)
    const idleValue = actor.getSnapshot().value
    const onTimeoutCallsAfterTimeout = [...onTimeoutCalls]
    const exitCallsAfterTimeout = [...exitCalls]
    const afterCallsAfterTimeout = [...afterCalls]

    actor.send({ type: 'activate', duration: 2000 })
    const reenteredValue = actor.getSnapshot().value

    advance(1000)

    yield* expect({
      activeValue,
      entryCallsAtActive,
      timeoutCallsAtActive,
      onTimeoutCallsAtActive,
      onPingCallsAfterPing,
      idleValue,
      onTimeoutCallsAfterTimeout,
      exitCallsAfterTimeout,
      afterCallsAfterTimeout,
      reenteredValue,
      afterCallsAfterAfter: [...afterCalls],
    }).toEqual({
      activeValue: 'active',
      entryCallsAtActive: [[500]],
      timeoutCallsAtActive: [[500]],
      onTimeoutCallsAtActive: [],
      onPingCallsAfterPing: [[500]],
      idleValue: 'idle',
      onTimeoutCallsAfterTimeout: [[500]],
      exitCallsAfterTimeout: [[500]],
      afterCallsAfterTimeout: [],
      reenteredValue: 'active',
      afterCallsAfterAfter: [[2000]],
    })
  })

  it('passes the correct state input to nested states', function*({ expect }) {
    const parentCalls: unknown[][] = []
    const parentCall = (...args: unknown[]) => {
      parentCalls.push(args)
    }
    const childCalls: unknown[][] = []
    const childCall = (...args: unknown[]) => {
      childCalls.push(args)
    }

    const machine = setup({
      schemas: {
        events: {
          ping: z.object({}),
        },
      },
      states: {
        parent: {
          schemas: {
            input: z.object({
              label: z.literal('parent'),
            }),
          },
          states: {
            child: {
              schemas: {
                input: z.object({
                  label: z.literal('child'),
                }),
              },
            },
          },
        },
      },
    }).createMachine({
      initial: {
        target: 'parent',
        input: { label: 'parent' },
      },
      states: {
        parent: {
          initial: {
            target: 'child',
            input: { label: 'child' },
          },
          on: {
            ping: ({ input }) => {
              parentCall(input.label)
            },
          },
          states: {
            child: {
              on: {
                ping: ({ input }) => {
                  childCall(input.label)
                },
              },
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'ping' })

    yield* expect({ childCalls, parentCalls }).toEqual({
      childCalls: [['child']],
      parentCalls: [['parent']],
    })
  })
})

describe('invoke-level timeout', () => {
  it('preserves the canonical invoke timeout event on the pure path', function*({ expect }) {
    let observedEvent: unknown
    const machine = createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: {
            id: 'child',
            src: createAsyncLogic({ run: () => new Promise(() => {}) }),
            timeout: 1000,
            onTimeout: ({ event }) => {
              observedEvent = event
              return { target: 'timedOut' }
            },
          },
        },
        timedOut: {},
      },
    })
    const [working] = initialTransition(machine)
    const child = working.children['child']
    if (child === undefined) {
      throw new Error('expected a child actor')
    }

    const timeoutEvent = {
      type: 'xstate.timeout.actor',
      actorId: 'child',
      sessionId: child.sessionId,
    } as unknown as Parameters<typeof transition>[2]

    const [timedOut] = transition(machine, working, timeoutEvent)

    yield* expect({
      value: timedOut.value,
      observedEvent,
    }).toEqual({
      value: 'timedOut',
      observedEvent: {
        type: 'xstate.timeout.actor',
        actorId: 'child',
        sessionId: child.sessionId,
      },
    })
  })

  it('transitions via invoke.onTimeout when the invoke exceeds its timeout', function*({ expect }) {
    const { clock, advance } = createManualClock()
    const timeoutCalls: unknown[][] = []
    const onTimeoutCall = (...args: unknown[]) => {
      timeoutCalls.push(args)
    }

    const machine = createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: {
            id: 'child',
            src: createAsyncLogic({
              run: () => new Promise(() => {}),
            }),
            timeout: 1000,
            onTimeout: ({ event }, enq) => {
              enq(onTimeoutCall, event)
              return { target: 'timedOut' }
            },
            onDone: { target: 'done' },
          },
        },
        done: {},
        timedOut: {},
      },
    })

    const actor = createActor(machine, { clock }).start()
    const atStart = actor.getSnapshot().value

    advance(1100)

    yield* expect({
      atStart,
      afterTimeout: actor.getSnapshot().value,
      timeoutCalls,
    }).toEqual({
      atStart: 'working',
      afterTimeout: 'timedOut',
      timeoutCalls: [[{
        type: 'xstate.timeout.actor',
        actorId: 'child',
        sessionId: expect.any(String),
      }]],
    })
  })

  it.live('does NOT fire onTimeout if the invoke completes first', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve('ok') }),
            timeout: 5000,
            onTimeout: { target: 'timedOut' },
            onDone: { target: 'done' },
          },
        },
        done: {},
        timedOut: {},
      },
    })

    const actor = createActor(machine, { clock }).start()

    yield* Effect.promise(() => afterRealTime(0))

    const afterCompletion = actor.getSnapshot().value

    advance(10_000)

    yield* expect({ afterCompletion, afterTimeout: actor.getSnapshot().value }).toEqual({
      afterCompletion: 'done',
      afterTimeout: 'done',
    })
  })

  it.live('cancels the timeout when the invoke completes and the parent state stays active', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve('ok') }),
            timeout: 1000,
            onTimeout: { target: 'timedOut' },
          },
        },
        timedOut: {},
      },
    })

    const actor = createActor(machine, { clock }).start()

    yield* Effect.promise(() => afterRealTime(0))

    const afterCompletion = actor.getSnapshot().value

    advance(10_000)

    yield* expect({ afterCompletion, afterTimeout: actor.getSnapshot().value }).toEqual({
      afterCompletion: 'working',
      afterTimeout: 'working',
    })
  })

  it.live('cancels the timeout when invoke.onDone only enqueues actions', function*({ expect }) {
    const { clock, advance } = createManualClock()
    const emittedCalls: unknown[][] = []
    const onEmitted = (...args: unknown[]) => {
      emittedCalls.push(args)
    }

    const machine = createMachine({
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve('ok') }),
            timeout: 1000,
            onTimeout: { target: 'timedOut' },
            onDone: (_args, enq) => {
              enq.emit({ type: 'invokeDone' })
            },
          },
        },
        timedOut: {},
      },
    })

    const actor = createActor(machine, { clock })
    actor.on('invokeDone', onEmitted)
    actor.start()

    yield* Effect.promise(() => afterRealTime(0))

    const afterCompletion = actor.getSnapshot().value
    const emittedCallsAfterCompletion = emittedCalls.length

    advance(10_000)

    yield* expect({
      afterCompletion,
      emittedCallsAfterCompletion,
      afterTimeout: actor.getSnapshot().value,
    }).toEqual({
      afterCompletion: 'working',
      emittedCallsAfterCompletion: 1,
      afterTimeout: 'working',
    })
  })

  it('supports a dynamic invoke-level timeout', function*({ expect }) {
    const { clock, advance } = createManualClock()

    const machine = createMachine({
      context: { timeoutMs: 2000 },
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({
              run: () => new Promise(() => {}),
            }),
            timeout: ({ context }) => context.timeoutMs,
            onTimeout: { target: 'timedOut' },
            onDone: { target: 'done' },
          },
        },
        done: {},
        timedOut: {},
      },
    })

    const actor = createActor(machine, { clock }).start()

    advance(1000)
    const afterOneSecond = actor.getSnapshot().value

    advance(1500)

    yield* expect({
      afterOneSecond,
      afterTimeout: actor.getSnapshot().value,
    }).toEqual({ afterOneSecond: 'working', afterTimeout: 'timedOut' })
  })

  it('throws at construction when invoke.timeout is set without onTimeout', function*({ expect }) {
    const invalidDefinition = {
      initial: 'working',
      states: {
        working: {
          invoke: {
            src: createAsyncLogic({ run: () => Promise.resolve('ok') }),
            timeout: 1000,
          },
        },
        done: {},
      },
    } as unknown as Parameters<typeof createMachine>[0]

    yield* expect(() => createMachine(invalidDefinition)).toThrow(/onTimeout/)
  })
})
