import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import { createMachineFromConfig } from '../src/createMachineFromConfig.js'
import { assertEvent, createActor, createMachine } from '../src/index.js'

describe('event descriptors', () => {
  it('selects serialized transition arrays by shallow event payload matches', function*({ expect }) {
    const machine = createMachineFromConfig({
      initial: 'pending',
      states: {
        pending: {
          on: {
            result: [
              {
                matches: { actorId: 'first' },
                target: 'first',
              },
              {
                matches: { actorId: 'second' },
                target: 'second',
              },
            ],
          },
        },
        first: {},
        second: {},
      },
    })
    const actor = createActor(machine).start()

    actor.send({ type: 'result', actorId: 'second' } as any)

    yield* expect(actor.getSnapshot().value).toBe('second')
  })

  it('selects canonical actor events by actor ID', function*({ expect }) {
    const machine = createMachine({
      initial: 'pending',
      states: {
        pending: {
          on: {
            'xstate.done.actor': {
              matches: { actorId: 'job' },
              target: 'complete',
            },
          },
        },
        complete: {},
      },
    })
    const actor = createActor(machine).start()

    actor.send({
      type: 'xstate.done.actor',
      actorId: 'job',
      sessionId: 'x:1',
      output: undefined,
    } as any)

    yield* expect(actor.getSnapshot().value).toBe('complete')
  })

  it('should fallback to using wildcard transition definition (if specified)', function*({ expect }) {
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            FOO: { target: 'B' },
            '*': { target: 'C' },
          },
        },
        B: {},
        C: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'BAR' })
    yield* expect(service.getSnapshot().value).toBe('C')
  })

  it('should prioritize explicit descriptor even if wildcard comes first', function*({ expect }) {
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            '*': { target: 'fail' },
            NEXT: { target: 'pass' },
          },
        },
        fail: {},
        pass: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'NEXT' })
    yield* expect(service.getSnapshot().value).toBe('pass')
  })

  it('should prioritize explicit descriptor even if a partial one comes first', function*({ expect }) {
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            'foo.*': { target: 'fail' },
            'foo.bar': { target: 'pass' },
          },
        },
        fail: {},
        pass: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'foo.bar' })
    yield* expect(service.getSnapshot().value).toBe('pass')
  })

  it('should prioritize a longer descriptor even if the shorter one comes first', function*({ expect }) {
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            'foo.*': { target: 'fail' },
            'foo.bar.*': { target: 'pass' },
          },
        },
        fail: {},
        pass: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'foo.bar.baz' })
    yield* expect(service.getSnapshot().value).toBe('pass')
  })

  it(`should use a shorter descriptor if the longer one doesn't match`, function*({ expect }) {
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            'foo.bar.*': () => {
              if (1 + 1 !== 2) {
                return { target: 'fail' }
              }
              return undefined
            },
            'foo.*': { target: 'pass' },
          },
        },
        fail: {},
        pass: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'foo.bar.baz' })
    yield* expect(service.getSnapshot().value).toBe('pass')
  })

  it('should fall back to wildcard descriptor when exact descriptor guard fails', function*({ expect }) {
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            'foo.bar': () => {
              if (false) {
                return { target: 'fail' }
              }
            },
            'foo.*': { target: 'pass' },
          },
        },
        fail: {},
        pass: {},
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'foo.bar' })
    yield* expect(service.getSnapshot().value).toBe('pass')
  })

  it('should NOT support non-tokenized wildcards', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actorRef1 = createActor(machine).start()

    actorRef1.send({ type: 'event' })

    const firstMatches = actorRef1.getSnapshot().matches('success')

    const actorRef2 = createActor(machine).start()

    actorRef2.send({ type: 'eventually' })

    const secondMatches = actorRef2.getSnapshot().matches('success')

    yield* expect({ firstMatches, secondMatches }).toEqual({
      firstMatches: false,
      secondMatches: false,
    })
  })

  it('should support prefix matching with wildcards (+0)', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event.*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actorRef1 = createActor(machine).start()

    actorRef1.send({ type: 'event' })

    const firstMatches = actorRef1.getSnapshot().matches('success')

    const actorRef2 = createActor(machine).start()

    actorRef2.send({ type: 'eventually' })

    const secondMatches = actorRef2.getSnapshot().matches('success')

    yield* expect({ firstMatches, secondMatches }).toEqual({
      firstMatches: true,
      secondMatches: false,
    })
  })

  it('should support prefix matching with wildcards (+1)', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event.*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actorRef1 = createActor(machine).start()

    actorRef1.send({ type: 'event.whatever' })

    const firstMatches = actorRef1.getSnapshot().matches('success')

    const actorRef2 = createActor(machine).start()

    actorRef2.send({ type: 'eventually' })

    const secondMatches = actorRef2.getSnapshot().matches('success')

    const actorRef3 = createActor(machine).start()

    actorRef3.send({ type: 'eventually.event' })

    const thirdMatches = actorRef3.getSnapshot().matches('success')

    yield* expect({ firstMatches, secondMatches, thirdMatches }).toEqual({
      firstMatches: true,
      secondMatches: false,
      thirdMatches: false,
    })
  })

  it('should support prefix matching with wildcards (+n)', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event.*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'event.first.second' })

    yield* expect({
      matches: actorRef.getSnapshot().matches('success'),
    }).toEqual({ matches: true })
  })

  it('should support prefix matching with wildcards (+n, multi-prefix)', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event.foo.bar.*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const actorRef = createActor(machine).start()

    actorRef.send({ type: 'event.foo.bar.first.second' })

    yield* expect({
      matches: actorRef.getSnapshot().matches('success'),
    }).toEqual({ matches: true })
  })

  it('should not match infix wildcards', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event.*.bar.*': { target: 'success' },
            '*.event.*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const firstWarnings: string[] = []
    const actorRef1 = createActor(machine, {
      warn: (message) => firstWarnings.push(message),
    }).start()

    actorRef1.send({ type: 'event.foo.bar.first.second' })

    const firstMatches = actorRef1.getSnapshot().matches('success')

    const secondWarnings: string[] = []
    const actorRef2 = createActor(machine, {
      warn: (message) => secondWarnings.push(message),
    }).start()

    actorRef2.send({ type: 'whatever.event' })

    const secondMatches = actorRef2.getSnapshot().matches('success')

    yield* expect({
      firstMatches,
      secondMatches,
      firstWarnings,
      secondWarnings,
    }).toEqual({
      firstMatches: false,
      secondMatches: false,
      firstWarnings: [
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "event.*.bar.*" event.',
        'Infix wildcards in transition events are not allowed. Check the "event.*.bar.*" transition.',
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "*.event.*" event.',
        'Infix wildcards in transition events are not allowed. Check the "*.event.*" transition.',
        'Actor x:0 received event "event.foo.bar.first.second" in state "start" with no matching transition',
      ],
      secondWarnings: [
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "event.*.bar.*" event.',
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "*.event.*" event.',
        'Infix wildcards in transition events are not allowed. Check the "*.event.*" transition.',
        'Actor x:0 received event "whatever.event" in state "start" with no matching transition',
      ],
    })
  })

  it('should not match wildcards as part of tokens', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            'event*.bar.*': { target: 'success' },
            '*event.*': { target: 'success' },
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const firstWarnings: string[] = []
    const actorRef1 = createActor(machine, {
      warn: (message) => firstWarnings.push(message),
    }).start()

    actorRef1.send({ type: 'eventually.bar.baz' })

    const firstMatches = actorRef1.getSnapshot().matches('success')

    const secondWarnings: string[] = []
    const actorRef2 = createActor(machine, {
      warn: (message) => secondWarnings.push(message),
    }).start()

    actorRef2.send({ type: 'prevent.whatever' })

    const secondMatches = actorRef2.getSnapshot().matches('success')

    yield* expect({
      firstMatches,
      secondMatches,
      firstWarnings,
      secondWarnings,
    }).toEqual({
      firstMatches: false,
      secondMatches: false,
      firstWarnings: [
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "event*.bar.*" event.',
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "*event.*" event.',
        'Actor x:0 received event "eventually.bar.baz" in state "start" with no matching transition',
      ],
      secondWarnings: [
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "event*.bar.*" event.',
        'Wildcards can only be the last token of an event descriptor (e.g., "event.*") or the entire event descriptor ("*"). Check the "*event.*" event.',
        'Actor x:0 received event "prevent.whatever" in state "start" with no matching transition',
      ],
    })
  })

  it('should allow assertEvent to use partial descriptors', function*({ expect }) {
    type FeedbackEvents =
      | {
        type: 'FEEDBACK.MESSAGE'
        message: string
      }
      | {
        type: 'FEEDBACK.RATE'
        rate: number
      }
      | { type: 'OTHER' }

    const handledEvents: FeedbackEvents[] = []
    const machine = createMachine({
      schemas: {
        events: {
          'FEEDBACK.MESSAGE': z.object({ message: z.string() }),
          'FEEDBACK.RATE': z.object({ rate: z.number() }),
        },
      },
      actions: {
        handleEvent: ({ event }: { event: FeedbackEvents }) => {
          assertEvent(event, 'FEEDBACK.*')

          if (event.type === 'FEEDBACK.MESSAGE') {
            event.message satisfies string

            // @ts-expect-error
            event.message satisfies number
            // @ts-expect-error
            event.rate
          } else {
            event.rate satisfies number

            // @ts-expect-error
            event.rate satisfies string
            // @ts-expect-error
            event.message
          }

          handledEvents.push(event)
        },
      },
      initial: 'listening',
      states: {
        listening: {
          on: {
            'FEEDBACK.*': ({ actions, event }, enq) => {
              enq(actions.handleEvent, { event })
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'FEEDBACK.MESSAGE', message: 'hello' })
    actor.send({ type: 'FEEDBACK.RATE', rate: 5 })

    yield* expect(handledEvents).toEqual([
      { type: 'FEEDBACK.MESSAGE', message: 'hello' },
      { type: 'FEEDBACK.RATE', rate: 5 },
    ])
  })

  it('should throw if assertEvent partial descriptor does not match', function*({ expect }) {
    type FeedbackEvents =
      | {
        type: 'FEEDBACK.MESSAGE'
        message: string
      }
      | {
        type: 'FEEDBACK.RATE'
        rate: number
      }
      | { type: 'OTHER' }

    const nonFeedbackEvent = { type: 'OTHER' } as FeedbackEvents

    yield* expect(() => assertEvent(nonFeedbackEvent, 'FEEDBACK.*')).toThrow(
      new Error(
        'Expected event {"type":"OTHER"} to have type matching "FEEDBACK.*"',
      ),
    )
  })
})
