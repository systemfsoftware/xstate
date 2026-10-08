import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { createActor, createCallbackLogic, createMachine, initialTransition, transition } from '../src/index.js'
import { trackEntries } from './utils.js'

describe('final states', () => {
  it('status of a machine with a root state being final should be done', function*({ expect }) {
    const machine = createMachine({ type: 'final' })
    const actorRef = createActor(machine).start()

    yield* expect(actorRef.getSnapshot().status).toBe('done')
  })
  it('output of a machine with a root state being final should receive its state ID', function*({ expect }) {
    const outputCalls: unknown[] = []
    const machine = createMachine({
      type: 'final',
      output: ({ event }) => {
        outputCalls.push(event)
      },
    })
    createActor(machine, { input: 42 }).start()

    yield* expect(outputCalls).toEqual([
      {
        output: undefined,
        stateId: '(machine)',
        type: 'xstate.done.state',
      },
    ])
  })
  it('should emit the done state event when all nested states are final', function*({ expect }) {
    const onDoneEventTypes: string[] = []

    const machine = createMachine({
      id: 'm',
      initial: 'foo',
      states: {
        foo: {
          type: 'parallel',
          states: {
            first: {
              initial: 'a',
              states: {
                a: {
                  on: { NEXT_1: { target: 'b' } },
                },
                b: {
                  type: 'final',
                },
              },
            },
            second: {
              initial: 'a',
              states: {
                a: {
                  on: { NEXT_2: { target: 'b' } },
                },
                b: {
                  type: 'final',
                },
              },
            },
          },
          onDone: ({ event }, enq) => {
            enq(() => {
              onDoneEventTypes.push(event.type)
            })
            return {
              target: 'bar',
            }
          },
        },
        bar: {},
      },
    })

    const actor = createActor(machine).start()

    actor.send({
      type: 'NEXT_1',
    })
    actor.send({
      type: 'NEXT_2',
    })

    yield* expect({
      value: actor.getSnapshot().value,
      onDoneEventTypes,
    }).toEqual({
      value: 'bar',
      onDoneEventTypes: ['xstate.done.state'],
    })
  })

  it('should execute final child state actions first', function*({ expect }) {
    const actual: string[] = []
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'bar',
          onDone: (_, enq) => {
            enq(() => actual.push('fooAction'))
          },
          states: {
            bar: {
              initial: 'baz',
              onDone: { target: 'barFinal' },
              states: {
                baz: {
                  type: 'final',
                  entry: (_, enq) => enq(() => actual.push('bazAction')),
                },
              },
            },
            barFinal: {
              type: 'final',
              entry: (_, enq) => enq(() => actual.push('barAction')),
            },
          },
        },
      },
    })

    createActor(machine).start()

    yield* expect(actual).toEqual(['bazAction', 'barAction', 'fooAction'])
  })

  it('should call output expressions on nested final nodes', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()

    const machine = createMachine({
      schemas: {
        context: z.object({
          revealedSecret: z.string().optional(),
        }),
      },
      initial: 'secret',
      context: {
        revealedSecret: undefined,
      },
      states: {
        secret: {
          initial: 'wait',
          states: {
            wait: {
              on: {
                REQUEST_SECRET: { target: 'reveal' },
              },
            },
            reveal: {
              type: 'final',
              output: () => ({
                secret: 'the secret',
              }),
            },
          },
          onDone: ({ event }) => {
            return {
              target: 'success',
              context: {
                revealedSecret: (event.output as any).secret,
              },
            }
          },
        },
        success: {
          type: 'final',
        },
      },
    })

    const service = createActor(machine)
    let contextOnComplete: unknown
    service.subscribe({
      complete: () => {
        contextOnComplete = service.getSnapshot().context
        resolve()
      },
    })
    service.start()

    service.send({ type: 'REQUEST_SECRET' })

    yield* Effect.promise(() => promise)
    yield* expect(contextOnComplete).toEqual({
      revealedSecret: 'the secret',
    })
  })

  it("should only call data expression once when entering root's final state", function*({ expect }) {
    const outputCalls: string[] = []
    const machine = createMachine({
      schemas: {
        events: {
          FINISH: z.object({ value: z.number() }),
        },
      },
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
        },
      },
      output: () => {
        outputCalls.push('called')
      },
    })

    const service = createActor(machine).start()
    service.send({ type: 'FINISH', value: 1 })
    yield* expect(outputCalls).toEqual(['called'])
  })

  it('should use top-level final state output as machine output without root output', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FINISH: z.object({ value: z.number() }),
        },
      },
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
          output: ({ event }) => event.value * 2,
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FINISH', value: 21 })

    yield* expect(actorRef.getSnapshot().output).toBe(42)
  })

  it('should pass top-level final state output to root output mapper', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
          output: 'final output',
        },
      },
      output: ({ output }) => `root: ${output}`,
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FINISH' })

    yield* expect(actorRef.getSnapshot().output).toBe('root: final output')
  })

  it('should keep root output-only behavior unchanged', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
        },
      },
      output: 'root output',
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FINISH' })

    yield* expect(actorRef.getSnapshot().output).toBe('root output')
  })

  it('should leave machine output undefined without final or root output', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FINISH' })

    yield* expect(actorRef.getSnapshot().output).toEqual(undefined)
  })

  it('should use the reached top-level final state output', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            PASS: { target: 'passed' },
            FAIL: { target: 'failed' },
          },
        },
        passed: {
          type: 'final',
          output: { status: 'passed' },
        },
        failed: {
          type: 'final',
          output: { status: 'failed' },
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FAIL' })

    yield* expect(actorRef.getSnapshot().output).toEqual({ status: 'failed' })
  })

  it('should populate top-level final state output through pure transition', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
          output: 'done',
        },
      },
    })

    const [initialSnapshot] = initialTransition(machine, undefined)
    const [nextSnapshot] = transition(machine, initialSnapshot, {
      type: 'FINISH',
    })

    yield* expect(nextSnapshot.output).toBe('done')
  })

  it('should populate top-level final state output through pure initialTransition', function*({ expect }) {
    const machine = createMachine({
      initial: 'end',
      states: {
        end: {
          type: 'final',
          output: 'done',
        },
      },
    })

    const [initialSnapshot] = initialTransition(machine, undefined)

    yield* expect(initialSnapshot.output).toBe('done')
  })

  it('should persist and restore top-level final state output', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
          output: 'persisted output',
        },
      },
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FINISH' })
    const persistedSnapshot = actorRef.getPersistedSnapshot()

    const persistedOutput = persistedSnapshot.output

    const restoredActorRef = createActor(machine, {
      snapshot: persistedSnapshot,
    }).start()

    yield* expect({
      persistedOutput,
      restoredOutput: restoredActorRef.getSnapshot().output,
    }).toEqual({
      persistedOutput: 'persisted output',
      restoredOutput: 'persisted output',
    })
  })

  it('should resolve top-level final state output once on completion', function*({ expect }) {
    const finalOutputCalls: string[] = []
    const finalOutput = () => {
      finalOutputCalls.push('called')
      return 'final output'
    }

    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            FINISH: { target: 'end' },
          },
        },
        end: {
          type: 'final',
          output: finalOutput,
        },
      },
      output: ({ output }) => output,
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FINISH' })
    actorRef.getSnapshot()
    actorRef.getSnapshot()

    yield* expect({
      finalOutputCalls,
      output: actorRef.getSnapshot().output,
    }).toEqual({
      finalOutputCalls: ['called'],
      output: 'final output',
    })
  })

  it('output mapper should receive self', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        output: z.object({
          selfRef: z.any(),
        }),
      },
      initial: 'done',
      states: {
        done: {
          type: 'final',
        },
      },
      output: ({ self }) => ({ selfRef: self }),
    })

    const actor = createActor(machine).start()
    yield* expect(typeof actor.getSnapshot().output!.selfRef.send).toEqual('function')
  })

  it(
    'state output should be able to use context updated by the entry action of the reached final state',
    function*({ expect }) {
      const onDoneOutputs: unknown[] = []
      const machine = createMachine({
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        context: {
          count: 0,
        },
        initial: 'a',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                on: {
                  NEXT: { target: 'a2' },
                },
              },
              a2: {
                type: 'final',
                entry: () => ({
                  context: {
                    count: 1,
                  },
                }),
                output: ({ context }) => context.count,
              },
            },
            onDone: ({ event }, enq) =>
              enq((output: unknown) => {
                onDoneOutputs.push(output)
              }, event.output),
          },
        },
      })
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })

      yield* expect(onDoneOutputs).toEqual([1])
    },
  )

  it(
    'should emit a done state event for a parallel state when its parallel children reach their final states',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'first',
        states: {
          first: {
            type: 'parallel',
            states: {
              alpha: {
                type: 'parallel',
                states: {
                  one: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_one_alpha: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                  two: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_two_alpha: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                },
              },
              beta: {
                type: 'parallel',
                states: {
                  third: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_three_beta: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                  fourth: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_four_beta: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                },
              },
            },
            onDone: { target: 'done' },
          },
          done: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine).start()

      actorRef.send({
        type: 'finish_one_alpha',
      })
      actorRef.send({
        type: 'finish_two_alpha',
      })
      actorRef.send({
        type: 'finish_three_beta',
      })
      actorRef.send({
        type: 'finish_four_beta',
      })

      yield* expect(actorRef.getSnapshot().status).toBe('done')
    },
  )

  it(
    'should emit a done state event for a parallel state when its compound child reaches its final state when the other parallel child region is already in its final state',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'first',
        states: {
          first: {
            type: 'parallel',
            states: {
              alpha: {
                type: 'parallel',
                states: {
                  one: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_one_alpha: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                  two: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_two_alpha: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                },
              },
              beta: {
                initial: 'three',
                states: {
                  three: {
                    on: {
                      finish_beta: { target: 'finish' },
                    },
                  },
                  finish: {
                    type: 'final',
                  },
                },
              },
            },
            onDone: { target: 'done' },
          },
          done: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine).start()

      // reach final state of a parallel state
      actorRef.send({
        type: 'finish_one_alpha',
      })
      actorRef.send({
        type: 'finish_two_alpha',
      })

      // reach final state of a compound state
      actorRef.send({
        type: 'finish_beta',
      })

      yield* expect(actorRef.getSnapshot().status).toBe('done')
    },
  )

  it(
    'should emit a done state event for a parallel state when its parallel child reaches its final state when the other compound child region is already in its final state',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'first',
        states: {
          first: {
            type: 'parallel',
            states: {
              alpha: {
                type: 'parallel',
                states: {
                  one: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_one_alpha: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                  two: {
                    initial: 'start',
                    states: {
                      start: {
                        on: {
                          finish_two_alpha: { target: 'finish' },
                        },
                      },
                      finish: {
                        type: 'final',
                      },
                    },
                  },
                },
              },
              beta: {
                initial: 'three',
                states: {
                  three: {
                    on: {
                      finish_beta: { target: 'finish' },
                    },
                  },
                  finish: {
                    type: 'final',
                  },
                },
              },
            },
            onDone: { target: 'done' },
          },
          done: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine).start()

      // reach final state of a compound state
      actorRef.send({
        type: 'finish_beta',
      })

      // reach final state of a parallel state
      actorRef.send({
        type: 'finish_one_alpha',
      })
      actorRef.send({
        type: 'finish_two_alpha',
      })

      yield* expect(actorRef.getSnapshot().status).toBe('done')
    },
  )

  it(
    'should reach a final state when a parallel state reaches its final state and transitions to a top-level final state in response to that',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            type: 'parallel',
            onDone: { target: 'b' },
            states: {
              a1: {
                type: 'parallel',
                states: {
                  a1a: { type: 'final' },
                  a1b: { type: 'final' },
                },
              },
              a2: {
                initial: 'a2a',
                states: { a2a: { type: 'final' } },
              },
            },
          },
          b: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine).start()

      yield* expect(actorRef.getSnapshot().status).toEqual('done')
    },
  )

  it(
    'should reach a final state when a parallel state nested in a parallel state reaches its final state and transitions to a top-level final state in response to that',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            type: 'parallel',
            onDone: { target: 'b' },
            states: {
              a1: {
                type: 'parallel',
                states: {
                  a1a: { type: 'final' },
                  a1b: { type: 'final' },
                },
              },
              a2: {
                initial: 'a2a',
                states: { a2a: { type: 'final' } },
              },
            },
          },
          b: {
            type: 'final',
          },
        },
      })

      const actorRef = createActor(machine).start()

      yield* expect(actorRef.getSnapshot().status).toEqual('done')
    },
  )
  it(
    'root output should be called with a "xstate.done.state.*" event of the parallel root when a direct final child of that parallel root is reached',
    function*({ expect }) {
      const outputCalls: unknown[] = []
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            type: 'final',
          },
        },
        output: ({ event }) => {
          outputCalls.push(event)
        },
      })

      createActor(machine).start()

      yield* expect(outputCalls).toEqual([
        {
          output: {
            a: undefined,
          },
          stateId: '(machine)',
          type: 'xstate.done.state',
        },
      ])
    },
  )

  it(
    'root output should be called with a "xstate.done.state.*" event of the parallel root when a final child of its compound child is reached',
    function*({ expect }) {
      const outputCalls: unknown[] = []
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'b',
            states: {
              b: {
                type: 'final',
              },
            },
          },
        },
        output: ({ event }) => {
          outputCalls.push(event)
        },
      })

      createActor(machine).start()

      yield* expect(outputCalls).toEqual([
        {
          output: {
            a: undefined,
          },
          stateId: '(machine)',
          type: 'xstate.done.state',
        },
      ])
    },
  )

  it(
    'root output should be called with a "xstate.done.state.*" event of the parallel root when a final descendant is reached 2 parallel levels deep',
    function*({ expect }) {
      const outputCalls: unknown[] = []
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            type: 'parallel',
            states: {
              b: {
                initial: 'c',
                states: {
                  c: {
                    type: 'final',
                  },
                },
              },
            },
          },
        },
        output: ({ event }) => {
          outputCalls.push(event)
        },
      })

      createActor(machine).start()

      yield* expect(outputCalls).toEqual([
        {
          output: {
            a: {
              b: undefined,
            },
          },
          stateId: '(machine)',
          type: 'xstate.done.state',
        },
      ])
    },
  )

  it(
    'onDone of an outer parallel state should be called with its own "xstate.done.state.*" event when its direct parallel child completes',
    function*({ expect }) {
      const onDoneEvents: unknown[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            type: 'parallel',
            states: {
              b: {
                type: 'parallel',
                states: {
                  c: {
                    initial: 'd',
                    states: {
                      d: {
                        type: 'final',
                      },
                    },
                  },
                },
              },
            },
            onDone: ({ event }, enq) =>
              enq((recorded: unknown) => {
                onDoneEvents.push(recorded)
              }, event),
          },
        },
      })
      createActor(machine).start()

      yield* expect(onDoneEvents).toEqual([
        {
          output: {
            b: {
              c: undefined,
            },
          },
          stateId: '(machine).a',
          type: 'xstate.done.state',
        },
      ])
    },
  )

  it('onDone should not be called when the machine reaches its final state', function*({ expect }) {
    const onDoneCalls: string[] = []
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          type: 'parallel',
          states: {
            b: {
              initial: 'c',
              states: {
                c: {
                  type: 'final',
                },
              },
              onDone: (_, enq) => {
                enq(() => {
                  onDoneCalls.push('called')
                })
              },
            },
          },
          onDone: (_, enq) => {
            enq(() => {
              onDoneCalls.push('called')
            })
          },
        },
      },
      onDone: (_, enq) => {
        enq(() => {
          onDoneCalls.push('called')
        })
      },
    })
    createActor(machine).start()

    yield* expect(onDoneCalls).toEqual([])
  })

  it('machine should not complete when a parallel child of a compound state completes', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          type: 'parallel',
          states: {
            b: {
              initial: 'c',
              states: {
                c: {
                  type: 'final',
                },
              },
            },
          },
        },
      },
    })

    const actorRef = createActor(machine).start()

    yield* expect(actorRef.getSnapshot().status).toBe('active')
  })

  it('root output should only be called once when multiple parallel regions complete at once', function*({ expect }) {
    const outputCalls: string[] = []

    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          type: 'final',
        },
        b: {
          type: 'final',
        },
      },
      output: () => {
        outputCalls.push('called')
      },
    })

    createActor(machine).start()

    yield* expect(outputCalls).toEqual(['called'])
  })

  it('should require root output to produce output for a parallel root', function*({ expect }) {
    const withoutRootOutput = createMachine({
      type: 'parallel',
      states: {
        a: {
          type: 'final',
          output: 'a output',
        },
        b: {
          type: 'final',
          output: 'b output',
        },
      },
    })

    const withoutRootOutputResult = createActor(withoutRootOutput).start().getSnapshot().output

    const withRootOutput = createMachine({
      type: 'parallel',
      states: {
        a: {
          type: 'final',
          output: 'a output',
        },
        b: {
          type: 'final',
          output: 'b output',
        },
      },
      output: ({ output }) => output,
    })

    yield* expect({
      withoutRootOutput: withoutRootOutputResult,
      withRootOutput: createActor(withRootOutput).start().getSnapshot().output,
    }).toEqual({
      withoutRootOutput: undefined,
      withRootOutput: {
        a: 'a output',
        b: 'b output',
      },
    })
  })

  it(
    'onDone of a parallel state should only be called once when multiple parallel regions complete at once',
    function*({ expect }) {
      const onDoneCalls: string[] = []

      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            type: 'parallel',
            states: {
              b: {
                type: 'final',
              },
              c: {
                type: 'final',
              },
            },
            onDone: (_, enq) => {
              enq(() => {
                onDoneCalls.push('called')
              })
            },
          },
        },
      })

      createActor(machine).start()

      yield* expect(onDoneCalls).toEqual(['called'])
    },
  )

  it(
    'should call exit actions in reversed document order when the machines reaches its final state',
    function*({ expect }) {
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            on: {
              EV: { target: 'b' },
            },
          },
          b: {
            type: 'final',
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actorRef = createActor(machine).start()
      flushTracked()

      // it's important to send an event here that results in a transition that computes new `state.nodes`
      // and that could impact the order in which exit actions are called
      actorRef.send({ type: 'EV' })

      yield* expect(flushTracked()).toEqual([
        // result of the transition
        'exit: a',
        'enter: b',
        // result of reaching final states
        'exit: b',
        'exit: __root__',
      ])
    },
  )

  it(
    'should call exit actions of parallel states in reversed document order when the machines reaches its final state after earlier region transition',
    function*({ expect }) {
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'child_a1',
            states: {
              child_a1: {
                on: {
                  EV2: { target: 'child_a2' },
                },
              },
              child_a2: {
                type: 'final',
              },
            },
          },
          b: {
            initial: 'child_b1',
            states: {
              child_b1: {
                on: {
                  EV1: { target: 'child_b2' },
                },
              },
              child_b2: {
                type: 'final',
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actorRef = createActor(machine).start()

      // it's important to send an event here that results in a transition as that computes new `state.nodes`
      // and that could impact the order in which exit actions are called
      actorRef.send({ type: 'EV1' })
      flushTracked()
      actorRef.send({ type: 'EV2' })

      yield* expect(flushTracked()).toEqual([
        // result of the transition
        'exit: a.child_a1',
        'enter: a.child_a2',
        // result of reaching final states
        'exit: b.child_b2',
        'exit: b',
        'exit: a.child_a2',
        'exit: a',
        'exit: __root__',
      ])
    },
  )

  it(
    'should call exit actions of parallel states in reversed document order when the machines reaches its final state after later region transition',
    function*({ expect }) {
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'child_a1',
            states: {
              child_a1: {
                on: {
                  EV2: { target: 'child_a2' },
                },
              },
              child_a2: {
                type: 'final',
              },
            },
          },
          b: {
            initial: 'child_b1',
            states: {
              child_b1: {
                on: {
                  EV1: { target: 'child_b2' },
                },
              },
              child_b2: {
                type: 'final',
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actorRef = createActor(machine).start()
      // it's important to send an event here that results in a transition as that computes new `state.nodes`
      // and that could impact the order in which exit actions are called
      actorRef.send({ type: 'EV1' })
      flushTracked()
      actorRef.send({ type: 'EV2' })

      yield* expect(flushTracked()).toEqual([
        // result of the transition
        'exit: a.child_a1',
        'enter: a.child_a2',
        // result of reaching final states
        'exit: b.child_b2',
        'exit: b',
        'exit: a.child_a2',
        'exit: a',
        'exit: __root__',
      ])
    },
  )

  it(
    'should call exit actions of parallel states in reversed document order when the machines reaches its final state after multiple regions transition',
    function*({ expect }) {
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'child_a1',
            states: {
              child_a1: {
                on: {
                  EV: { target: 'child_a2' },
                },
              },
              child_a2: {
                type: 'final',
              },
            },
          },
          b: {
            initial: 'child_b1',
            states: {
              child_b1: {
                on: {
                  EV: { target: 'child_b2' },
                },
              },
              child_b2: {
                type: 'final',
              },
            },
          },
        },
      })

      const flushTracked = trackEntries(machine)

      const actorRef = createActor(machine).start()
      flushTracked()
      // it's important to send an event here that results in a transition as that computes new `state.nodes`
      // and that could impact the order in which exit actions are called
      actorRef.send({ type: 'EV' })

      yield* expect(flushTracked()).toEqual([
        // result of the transition
        'exit: b.child_b1',
        'exit: a.child_a1',
        'enter: a.child_a2',
        'enter: b.child_b2',
        // result of reaching final states
        'exit: b.child_b2',
        'exit: b',
        'exit: a.child_a2',
        'exit: a',
        'exit: __root__',
      ])
    },
  )

  it(
    'should not complete a parallel root immediately when only some of its regions are in their final states (final state reached in a compound region)',
    function*({ expect }) {
      const machine = createMachine({
        type: 'parallel',
        states: {
          A: {
            initial: 'A1',
            states: {
              A1: {
                type: 'final',
              },
            },
          },
          B: {
            initial: 'B1',
            states: {
              B1: {},
              B2: {
                type: 'final',
              },
            },
          },
        },
      })

      const actorRef = createActor(machine).start()

      yield* expect(actorRef.getSnapshot().status).toBe('active')
    },
  )

  it(
    'should not complete a parallel root immediately when only some of its regions are in their final states (a direct final child state reached)',
    function*({ expect }) {
      const machine = createMachine({
        type: 'parallel',
        states: {
          A: {
            type: 'final',
          },
          B: {
            initial: 'B1',
            states: {
              B1: {},
              B2: {
                type: 'final',
              },
            },
          },
        },
      })

      const actorRef = createActor(machine).start()

      yield* expect(actorRef.getSnapshot().status).toBe('active')
    },
  )

  it('should not resolve output of a final state if its parent is a parallel state', function*({ expect }) {
    const outputCalls: string[] = []

    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          type: 'parallel',
          states: {
            B: {
              type: 'final',
              output: () => {
                outputCalls.push('called')
              },
            },
            C: {
              initial: 'C1',
              states: {
                C1: {},
              },
            },
          },
        },
      },
    })

    createActor(machine).start()

    yield* expect(outputCalls).toEqual([])
  })

  it(
    'should only call exit actions once when a child machine reaches its final state and sends an event to its parent that ends up stopping that child',
    function*({ expect }) {
      const exitCalls: string[] = []

      const child = createMachine({
        initial: 'start',
        exit: (_, enq) => {
          enq(() => {
            exitCalls.push('called')
          })
        },
        states: {
          start: {
            on: {
              CANCEL: { target: 'canceled' },
            },
          },
          canceled: {
            type: 'final',
            entry: ({ parent }, enq) => enq.sendTo(parent, { type: 'CHILD_CANCELED' }),
          },
        },
      })
      const parent = createMachine({
        initial: 'start',
        states: {
          start: {
            invoke: {
              id: 'child',
              src: child,
              onDone: { target: 'completed' },
            },
            on: {
              CHILD_CANCELED: { target: 'canceled' },
            },
          },
          canceled: {},
          completed: {},
        },
      })

      const actorRef = createActor(parent).start()

      const childActor = actorRef.getSnapshot().children['child']
      if (childActor === undefined) {
        throw new Error('expected child actor')
      }
      childActor.send({
        type: 'CANCEL',
      })

      yield* expect(exitCalls).toEqual(['called'])
    },
  )

  it(
    'should deliver final outgoing events (from final entry action) to the parent before delivering the `xstate.done.actor.*` event',
    function*({ expect }) {
      const child = createMachine({
        initial: 'start',
        states: {
          start: {
            on: {
              CANCEL: { target: 'canceled' },
            },
          },
          canceled: {
            type: 'final',
            entry: ({ parent }, enq) => enq.sendTo(parent, { type: 'CHILD_CANCELED' }),
          },
        },
      })
      const parent = createMachine({
        initial: 'start',
        states: {
          start: {
            invoke: {
              id: 'child',
              src: child,
              onDone: { target: 'completed' },
            },
            on: {
              CHILD_CANCELED: { target: 'canceled' },
            },
          },
          canceled: {},
          completed: {},
        },
      })

      const actorRef = createActor(parent).start()

      const childActor = actorRef.getSnapshot().children['child']
      if (childActor === undefined) {
        throw new Error('expected child actor')
      }
      childActor.send({
        type: 'CANCEL',
      })

      // if `xstate.done.actor.*` would be delivered first the value would be `completed`
      yield* expect(actorRef.getSnapshot().value).toBe('canceled')
    },
  )

  it(
    'should deliver final outgoing events (from root exit action) to the parent before delivering the `xstate.done.actor.*` event',
    function*({ expect }) {
      const child = createMachine({
        initial: 'start',
        states: {
          start: {
            on: {
              CANCEL: { target: 'canceled' },
            },
          },
          canceled: {
            type: 'final',
          },
        },
        // exit: sendParent({ type: 'CHILD_CANCELED' })
        exit: ({ parent }) => {
          parent?.send({ type: 'CHILD_CANCELED' })
        },
      })
      const parent = createMachine({
        initial: 'start',
        states: {
          start: {
            invoke: {
              id: 'child',
              src: child,
              onDone: { target: 'completed' },
            },
            on: {
              CHILD_CANCELED: { target: 'canceled' },
            },
          },
          canceled: {},
          completed: {},
        },
      })

      const actorRef = createActor(parent).start()

      const childActor = actorRef.getSnapshot().children['child']
      if (childActor === undefined) {
        throw new Error('expected child actor')
      }
      childActor.send({
        type: 'CANCEL',
      })

      // if `xstate.done.actor.*` would be delivered first the value would be `completed`
      yield* expect(actorRef.getSnapshot().value).toBe('canceled')
    },
  )

  it('should be possible to complete with a null output (directly on root)', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      schemas: {
        output: z.null(),
      },
      states: {
        start: {
          on: {
            NEXT: { target: 'end' },
          },
        },
        end: {
          type: 'final',
        },
      },
      output: null,
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })

    yield* expect(actorRef.getSnapshot().output).toBe(null)
  })

  it("should be possible to complete with a null output (resolving with final state's output)", function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            NEXT: { target: 'end' },
          },
        },
        end: {
          type: 'final',
          output: null,
        },
      },
      output: ({ output }) => output,
    })

    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })

    yield* expect(actorRef.getSnapshot().output).toBe(null)
  })

  it('warns when a top-level final state declares invoke, on or after', function*({ expect }) {
    const warned: string[] = []
    const machine = createMachine({
      id: 'm',
      initial: 'done',
      states: {
        done: {
          type: 'final',
          invoke: { src: createMachine({}) },
          on: { go: {} },
          after: { 100: {} },
        },
      },
    })
    createActor(machine, { warn: (message) => warned.push(message) })

    yield* expect(warned).toEqual([
      'State "m.done" is final and declares "invoke", "on", "after"; final states cannot run actors or take transitions.',
    ])
  })

  it('does not start actors invoked by a top-level final state', function*({ expect }) {
    const warned: string[] = []
    const spawned: string[] = []
    const machine = createMachine({
      initial: 'done',
      states: {
        done: {
          type: 'final',
          invoke: {
            src: createCallbackLogic(() => {
              spawned.push('called')
            }),
          },
        },
      },
    })
    const [, effects] = initialTransition(machine)
    const effectTypes = effects.map((effect) => effect.type)

    const actorRef = createActor(machine, { warn: (message) => warned.push(message) }).start()

    yield* expect({
      effectTypes,
      status: actorRef.getSnapshot().status,
      spawned,
      warned,
    }).toEqual({
      effectTypes: ['@xstate.terminate'],
      status: 'done',
      spawned: [],
      warned: [
        'State "(machine).done" is final and declares "invoke"; final states cannot run actors or take transitions.',
      ],
    })
  })

  it('warns when a nested or parallel-region final state declares on', function*({ expect }) {
    const warned: string[] = []
    const warn = (message: string) => warned.push(message)
    const nested = createMachine({
      id: 'nested',
      initial: 'a',
      states: {
        a: {
          initial: 'inner',
          states: {
            inner: { type: 'final', on: { go: {} } },
          },
        },
      },
    })
    const par = createMachine({
      id: 'par',
      type: 'parallel',
      states: {
        region: { type: 'final', on: { go: {} } },
      },
    })
    createActor(nested, { warn })
    createActor(par, { warn })

    yield* expect(warned).toEqual([
      'State "nested.a.inner" is final and declares "on"; final states cannot run actors or take transitions.',
      'State "par.region" is final and declares "on"; final states cannot run actors or take transitions.',
    ])
  })

  it('does not warn for plain final states', function*({ expect }) {
    const warned: string[] = []
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          initial: 'inner',
          states: { inner: { type: 'final' } },
        },
        done: { type: 'final' },
      },
    })
    createActor(machine, { warn: (message) => warned.push(message) })

    yield* expect(warned).toEqual([])
  })

  it('final regions under a parallel state take no transitions and start no actors', function*({ expect }) {
    const warned: string[] = []
    const spawned: string[] = []
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          type: 'final',
          invoke: {
            src: createCallbackLogic(() => {
              spawned.push('called')
            }),
          },
          on: { go: { target: '#b-x' } },
        },
        b: {
          initial: 'idle',
          states: { idle: {}, x: { id: 'b-x' } },
        },
      },
    })

    const actorRef = createActor(machine, { warn: (message) => warned.push(message) }).start()
    actorRef.send({ type: 'go' })

    yield* expect({
      spawned,
      value: actorRef.getSnapshot().value,
      warned,
    }).toEqual({
      spawned: [],
      value: { a: {}, b: 'idle' },
      warned: [
        'State "(machine).a" is final and declares "invoke", "on"; final states cannot run actors or take transitions.',
        'Actor x:0 received event "go" in state {"a":{},"b":"idle"} with no matching transition',
      ],
    })
  })
})
