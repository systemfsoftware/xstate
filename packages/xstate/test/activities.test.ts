import { describe } from '@systemfsoftware/vitest'
import z from 'zod'
import { createCallbackLogic } from '../src/actors/index.js'
import { createActor, createMachine } from '../src/index.js'
describe('invocations (activities)', (it) => {
  it('identifies initial root invocations', function*({ expect }) {
    let active = false
    const machine = createMachine({
      invoke: {
        src: createCallbackLogic(() => {
          active = true
        }),
      },
    })
    createActor(machine).start()
    yield* expect({ active }).toEqual({ active: true })
  })
  it('identifies initial invocations', function*({ expect }) {
    let active = false
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createCallbackLogic(() => {
              active = true
            }),
          },
        },
      },
    })
    createActor(machine).start()
    yield* expect({ active }).toEqual({ active: true })
  })
  it('identifies initial deep invocations', function*({ expect }) {
    let active = false
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          initial: 'a1',
          states: {
            a1: {
              invoke: {
                src: createCallbackLogic(() => {
                  active = true
                }),
              },
            },
          },
        },
      },
    })
    createActor(machine).start()
    yield* expect({ active }).toEqual({ active: true })
  })
  it('identifies start invocations', function*({ expect }) {
    let active = false
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            TIMER: { target: 'b' },
          },
        },
        b: {
          invoke: {
            src: createCallbackLogic(() => {
              active = true
            }),
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'TIMER' })
    yield* expect({ active }).toEqual({ active: true })
  })
  it('identifies start invocations for child states and active invocations', function*({ expect }) {
    let active = false
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            TIMER: { target: 'b' },
          },
        },
        b: {
          initial: 'b1',
          states: {
            b1: {
              on: {
                TIMER: { target: 'b2' },
              },
            },
            b2: {
              invoke: {
                src: createCallbackLogic(() => {
                  active = true
                }),
              },
            },
          },
        },
      },
    })
    const service = createActor(machine)
    service.start()
    service.send({ type: 'TIMER' })
    service.send({ type: 'TIMER' })
    yield* expect({ active }).toEqual({ active: true })
  })
  it('identifies stop invocations for child states', function*({ expect }) {
    let active = false
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            TIMER: { target: 'b' },
          },
        },
        b: {
          initial: 'b1',
          states: {
            b1: {
              on: {
                TIMER: { target: 'b2' },
              },
            },
            b2: {
              invoke: {
                src: createCallbackLogic(() => {
                  active = true
                  return () => (active = false)
                }),
              },
              on: {
                TIMER: { target: 'b3' },
              },
            },
            b3: {},
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'TIMER' })
    service.send({ type: 'TIMER' })
    service.send({ type: 'TIMER' })
    yield* expect({ active }).toEqual({ active: false })
  })
  it('identifies multiple stop invocations for child and parent states', function*({ expect }) {
    let active1 = false
    let active2 = false
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            TIMER: { target: 'b' },
          },
        },
        b: {
          initial: 'b1',
          invoke: {
            src: createCallbackLogic(() => {
              active1 = true
              return () => (active1 = false)
            }),
          },
          states: {
            b1: {
              invoke: {
                src: createCallbackLogic(() => {
                  active2 = true
                  return () => (active2 = false)
                }),
              },
            },
          },
          on: {
            TIMER: { target: 'a' },
          },
        },
      },
    })
    const service = createActor(machine)
    service.start()
    service.send({ type: 'TIMER' })
    service.send({ type: 'TIMER' })
    yield* expect({ active1, active2 }).toEqual({ active1: false, active2: false })
  })
  it('should activate even if there are subsequent always but blocked transition', function*({ expect }) {
    let active = false
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            E: { target: 'B' },
          },
        },
        B: {
          invoke: {
            src: createCallbackLogic(() => {
              active = true
              return () => (active = false)
            }),
          },
          always: () => {
            if (1 + 1 !== 2) {
              return { target: 'A' }
            }
            return undefined
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'E' })
    yield* expect({ active }).toEqual({ active: true })
  })
  it('should remember the invocations even after an ignored event', function*({ expect }) {
    const cleanupCalls: unknown[][] = []
    let active = false
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          on: {
            E: { target: 'B' },
          },
        },
        B: {
          invoke: {
            src: createCallbackLogic(() => {
              active = true
              return () => {
                active = false
                cleanupCalls.push([])
              }
            }),
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'E' })
    service.send({ type: 'IGNORE' })
    yield* expect({ active, cleanupCalls }).toEqual({
      active: true,
      cleanupCalls: [],
    })
  })
  it('should remember the invocations when transitioning within the invoking state', function*({ expect }) {
    const cleanupCalls: unknown[][] = []
    let active = false
    const machine = createMachine({
      initial: 'A',
      states: {
        A: {
          invoke: {
            src: createCallbackLogic(() => {
              active = true
              return () => {
                active = false
                cleanupCalls.push([])
              }
            }),
          },
          initial: 'A1',
          states: {
            A1: {
              on: {
                E: { target: 'A2' },
              },
            },
            A2: {},
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'E' })
    yield* expect({ active, cleanupCalls }).toEqual({
      active: true,
      cleanupCalls: [],
    })
  })
  it(
    'should start a new actor when leaving an invoking state and entering a new one that invokes the same actor type',
    function*({ expect }) {
      let counter = 0
      const actual: string[] = []
      const fooActor = createCallbackLogic(() => {
        let localId = counter
        counter++
        actual.push(`start ${localId}`)
        return () => {
          actual.push(`stop ${localId}`)
        }
      })
      const machine = createMachine({
        actors: {
          fooActor,
        },
        initial: 'a',
        states: {
          a: {
            invoke: {
              src: ({ actors }) => actors.fooActor,
            },
            on: {
              NEXT: { target: 'b' },
            },
          },
          b: {
            invoke: {
              src: ({ actors }) => actors.fooActor,
            },
          },
        },
      })
      const service = createActor(machine).start()
      service.send({ type: 'NEXT' })
      yield* expect(actual).toEqual(['start 0', 'stop 0', 'start 1'])
    },
  )
  it(
    'should start a new actor when reentering the invoking state during a reentering self transition',
    function*({ expect }) {
      let counter = 0
      const actual: string[] = []
      const fooActor = createCallbackLogic(() => {
        let localId = counter
        counter++
        actual.push(`start ${localId}`)
        return () => {
          actual.push(`stop ${localId}`)
        }
      })
      const machine = createMachine({
        actors: {
          fooActor,
        },
        initial: 'a',
        states: {
          a: {
            invoke: {
              src: ({ actors }) => actors.fooActor,
            },
            on: {
              NEXT: {
                target: 'a',
                reenter: true,
              },
            },
          },
        },
      })
      const service = createActor(machine).start()
      service.send({ type: 'NEXT' })
      yield* expect(actual).toEqual(['start 0', 'stop 0', 'start 1'])
    },
  )
  it('should have stopped after automatic transitions', function*({ expect }) {
    let active = false
    const machine = createMachine({
      schemas: {
        context: z.object({
          counter: z.number(),
        }),
      },
      context: {
        counter: 0,
      },
      initial: 'a',
      states: {
        a: {
          invoke: {
            src: createCallbackLogic(() => {
              active = true
              return () => (active = false)
            }),
          },
          always: ({ context }) => {
            if (context.counter !== 0) {
              return { target: 'b' }
            }
            return undefined
          },
          on: {
            INC: ({ context }) => ({
              context: {
                counter: context.counter + 1,
              },
            }),
          },
        },
        b: {},
      },
    })
    const actor = createActor(machine).start()
    const beforeInc = active
    actor.send({ type: 'INC' })
    yield* expect({ beforeInc, afterInc: active }).toEqual({ beforeInc: true, afterInc: false })
  })
})
