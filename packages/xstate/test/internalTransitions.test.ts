import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createActor, createMachine } from '../src/index.js'

describe('internal transitions', () => {
  it('parent state should enter child state without re-entering self', function*({ expect }) {
    const tracked: string[] = []
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          initial: 'a',
          states: {
            a: {
              entry: (_, enq) => enq(() => tracked.push('enter: foo.a')),
              exit: (_, enq) => enq(() => tracked.push('exit: foo.a')),
            },
            b: {
              entry: (_, enq) => enq(() => tracked.push('enter: foo.b')),
              exit: (_, enq) => enq(() => tracked.push('exit: foo.b')),
            },
          },
          on: {
            CLICK: { target: '.b' },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    tracked.length = 0

    actor.send({
      type: 'CLICK',
    })

    yield* expect({ value: actor.getSnapshot().value, tracked }).toEqual({
      value: { foo: 'b' },
      tracked: ['exit: foo.a', 'enter: foo.b'],
    })
  })

  it(
    'parent state should re-enter self upon transitioning to child state if transition is reentering',
    function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {
            entry: (_, enq) => enq(() => tracked.push('enter: foo')),
            exit: (_, enq) => enq(() => tracked.push('exit: foo')),
            initial: 'left',
            states: {
              left: {
                entry: (_, enq) => enq(() => tracked.push('enter: foo.left')),
                exit: (_, enq) => enq(() => tracked.push('exit: foo.left')),
              },
              right: {
                entry: (_, enq) => enq(() => tracked.push('enter: foo.right')),
                exit: (_, enq) => enq(() => tracked.push('exit: foo.right')),
              },
            },
            on: {
              NEXT: () => ({
                target: '.right',
                reenter: true,
              }),
            },
          },
        },
      })

      const actor = createActor(machine).start()
      tracked.length = 0

      actor.send({
        type: 'NEXT',
      })

      yield* expect({ value: actor.getSnapshot().value, tracked }).toEqual({
        value: { foo: 'right' },
        tracked: [
          'exit: foo.left',
          'exit: foo',
          'enter: foo',
          'enter: foo.right',
        ],
      })
    },
  )

  it('parent state should only exit/reenter if there is an explicit self-transition', function*({ expect }) {
    const tracked: string[] = []
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          entry: (_, enq) => enq(() => tracked.push('enter: foo')),
          exit: (_, enq) => enq(() => tracked.push('exit: foo')),
          initial: 'a',
          states: {
            a: {
              entry: (_, enq) => enq(() => tracked.push('enter: foo.a')),
              exit: (_, enq) => enq(() => tracked.push('exit: foo.a')),
              on: {
                NEXT: { target: 'b' },
              },
            },
            b: {
              entry: (_, enq) => enq(() => tracked.push('enter: foo.b')),
              exit: (_, enq) => enq(() => tracked.push('exit: foo.b')),
            },
          },
          on: {
            RESET: {
              target: 'foo',
              reenter: true,
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({
      type: 'NEXT',
    })
    tracked.length = 0

    actor.send({
      type: 'RESET',
    })

    yield* expect({ value: actor.getSnapshot().value, tracked }).toEqual({
      value: { foo: 'a' },
      tracked: [
        'exit: foo.b',
        'exit: foo',
        'enter: foo',
        'enter: foo.a',
      ],
    })
  })

  it('parent state should only exit/reenter if there is an explicit self-transition (to child)', function*({ expect }) {
    const tracked: string[] = []
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          entry: (_, enq) => enq(() => tracked.push('enter: foo')),
          exit: (_, enq) => enq(() => tracked.push('exit: foo')),
          initial: 'a',
          states: {
            a: {
              entry: (_, enq) => enq(() => tracked.push('enter: foo.a')),
              exit: (_, enq) => enq(() => tracked.push('exit: foo.a')),
            },
            b: {
              entry: (_, enq) => enq(() => tracked.push('enter: foo.b')),
              exit: (_, enq) => enq(() => tracked.push('exit: foo.b')),
            },
          },
          on: {
            RESET_TO_B: {
              target: 'foo.b',
              reenter: true,
            },
          },
        },
      },
    })

    const actor = createActor(machine).start()
    tracked.length = 0

    actor.send({
      type: 'RESET_TO_B',
    })

    yield* expect({ value: actor.getSnapshot().value, tracked }).toEqual({
      value: { foo: 'b' },
      tracked: [
        'exit: foo.a',
        'exit: foo',
        'enter: foo',
        'enter: foo.b',
      ],
    })
  })

  it('should listen to events declared at top state', function*({ expect }) {
    const machine = createMachine({
      initial: 'foo',
      on: {
        CLICKED: { target: '.bar' },
      },
      states: {
        foo: {},
        bar: {},
      },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'CLICKED',
    })

    yield* expect(actor.getSnapshot().value).toEqual('bar')
  })

  it('should work with targetless transitions (in conditional array)', function*({ expect }) {
    const calls: string[] = []
    const recorder = () => {
      calls.push('action')
    }
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          on: {
            TARGETLESS_ARRAY: (_, enq) => void enq(recorder),
          },
        },
      },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'TARGETLESS_ARRAY',
    })
    yield* expect(calls).toEqual(['action'])
  })

  it('should work with targetless transitions (in object)', function*({ expect }) {
    const calls: string[] = []
    const recorder = () => {
      calls.push('action')
    }
    const machine = createMachine({
      initial: 'foo',
      states: {
        foo: {
          on: {
            TARGETLESS_OBJECT: (_, enq) => void enq(recorder),
          },
        },
      },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'TARGETLESS_OBJECT',
    })
    yield* expect(calls).toEqual(['action'])
  })

  it('should work on parent with targetless transitions (in conditional array)', function*({ expect }) {
    const calls: string[] = []
    const recorder = () => {
      calls.push('action')
    }
    const machine = createMachine({
      on: {
        TARGETLESS_ARRAY: (_, enq) => void enq(recorder),
      },
      initial: 'foo',
      states: { foo: {} },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'TARGETLESS_ARRAY',
    })
    yield* expect(calls).toEqual(['action'])
  })

  it('should work on parent with targetless transitions (in object)', function*({ expect }) {
    const calls: string[] = []
    const recorder = () => {
      calls.push('action')
    }
    const machine = createMachine({
      on: {
        TARGETLESS_OBJECT: (_, enq) => void enq(recorder),
      },
      initial: 'foo',
      states: { foo: {} },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'TARGETLESS_OBJECT',
    })
    yield* expect(calls).toEqual(['action'])
  })

  it('should maintain the child state when targetless transition is handled by parent', function*({ expect }) {
    const machine = createMachine({
      initial: 'foo',
      on: {
        PARENT_EVENT: (_, enq) => void enq(() => {}),
      },
      states: {
        foo: {},
      },
    })
    const actor = createActor(machine).start()
    actor.send({
      type: 'PARENT_EVENT',
    })

    yield* expect(actor.getSnapshot().value).toEqual('foo')
  })

  it('should reenter proper descendants of a source state of an internal transition', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          sourceStateEntries: z.number(),
          directDescendantEntries: z.number(),
          deepDescendantEntries: z.number(),
        }),
      },
      context: {
        sourceStateEntries: 0,
        directDescendantEntries: 0,
        deepDescendantEntries: 0,
      },
      initial: 'a1',
      states: {
        a1: {
          initial: 'a11',
          entry: ({ context }) => ({
            context: {
              sourceStateEntries: context.sourceStateEntries + 1,
            },
          }),
          states: {
            a11: {
              initial: 'a111',
              entry: ({ context }) => ({
                context: {
                  directDescendantEntries: context.directDescendantEntries + 1,
                },
              }),
              states: {
                a111: {
                  entry: ({ context }) => ({
                    context: {
                      deepDescendantEntries: context.deepDescendantEntries + 1,
                    },
                  }),
                },
              },
            },
          },
          on: {
            REENTER: { target: '.a11.a111' },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    const contextAfterStart = actor.getSnapshot().context

    actor.send({ type: 'REENTER' })

    yield* expect({
      contextAfterStart,
      contextAfterReenter: actor.getSnapshot().context,
    }).toEqual({
      contextAfterStart: {
        sourceStateEntries: 1,
        directDescendantEntries: 1,
        deepDescendantEntries: 1,
      },
      contextAfterReenter: {
        sourceStateEntries: 1,
        directDescendantEntries: 2,
        deepDescendantEntries: 2,
      },
    })
  })

  it('should exit proper descendants of a source state of an internal transition', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          sourceStateExits: z.number(),
          directDescendantExits: z.number(),
          deepDescendantExits: z.number(),
        }),
      },
      context: {
        sourceStateExits: 0,
        directDescendantExits: 0,
        deepDescendantExits: 0,
      },
      initial: 'a1',
      states: {
        a1: {
          initial: 'a11',
          exit: ({ context }) => ({
            context: {
              sourceStateExits: context.sourceStateExits + 1,
            },
          }),
          states: {
            a11: {
              initial: 'a111',
              exit: ({ context }) => ({
                context: {
                  directDescendantExits: context.directDescendantExits + 1,
                },
              }),
              states: {
                a111: {
                  exit: ({ context }) => ({
                    context: {
                      deepDescendantExits: context.deepDescendantExits + 1,
                    },
                  }),
                },
              },
            },
          },
          on: {
            REENTER: { target: '.a11.a111' },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'REENTER' })

    yield* expect(actor.getSnapshot().context).toEqual({
      sourceStateExits: 0,
      directDescendantExits: 1,
      deepDescendantExits: 1,
    })
  })
})
