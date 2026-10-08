import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'

describe('logger', () => {
  it('system logger should be default logger for actors (invoked from machine)', function*({
    expect,
  }) {
    const logged: string[] = []
    const machine = createMachine({
      invoke: {
        src: createMachine({
          entry: (_, enq) => {
            enq.log('hello')
          },
        }),
      },
    })

    const actor = createActor(machine, {
      logger: (arg) => {
        logged.push(arg)
      },
    }).start()

    actor.start()

    yield* expect(logged).toEqual(['hello'])
  })

  it('system logger should be default logger for actors (spawned from machine)', function*({
    expect,
  }) {
    const logged: string[] = []
    const machine = createMachine({
      entry: (_, enq) =>
        void enq.spawn(
          createMachine({
            entry: (_, enq) => {
              enq.log('hello')
            },
          }),
        ),
    })

    const actor = createActor(machine, {
      logger: (arg) => {
        logged.push(arg)
      },
    }).start()

    actor.start()

    yield* expect(logged).toEqual(['hello'])
  })
})
