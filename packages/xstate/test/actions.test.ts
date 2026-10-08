import { describe, it } from '@systemfsoftware/vitest'
import { Effect } from 'effect'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import { type CallbackActorLogic, type CallbackActorRef, createCallbackLogic } from '../src/actors/callback.js'
import {
  type ActorFromLogic,
  type ActorRefFromLogic,
  createActor,
  createMachine,
  type EventObject,
  type EventRejection,
} from '../src/index.js'

const recorder = () => {
  const calls: Array<Array<unknown>> = []
  const record = (...args: Array<unknown>) => {
    calls.push(args)
  }
  return Object.assign(record, { calls })
}

const recorderReturning = <A extends Array<unknown>, R>(impl: (...args: A) => R) => {
  const calls: Array<Array<unknown>> = []
  const record = (...args: A): R => {
    calls.push(args)
    return impl(...args)
  }
  return Object.assign(record, { calls })
}
describe('entry/exit actions', () => {
  describe('State.actions', () => {
    it('should return the entry actions of an initial state', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        entry: (_, enq) => enq(() => tracked.push('enter: __root__')),
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
          },
        },
      })
      createActor(machine).start()
      yield* expect(tracked).toEqual(['enter: __root__', 'enter: green'])
    })
    it('should return the entry actions of an initial state (deep)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        entry: (_, enq) => enq(() => tracked.push('enter: __root__')),
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => enq(() => tracked.push('enter: a')),
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                on: {
                  NEXT: { target: 'a2' },
                },
              },
              a2: {},
            },
            on: { CHANGE: { target: 'b' } },
          },
          b: {},
        },
      })
      createActor(machine).start()
      yield* expect(tracked).toEqual(['enter: __root__', 'enter: a', 'enter: a.a1'])
    })
    it('should return the entry actions of an initial state (parallel)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        entry: (_, enq) => enq(() => tracked.push('enter: __root__')),
        type: 'parallel',
        states: {
          a: {
            entry: (_, enq) => enq(() => tracked.push('enter: a')),
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
              },
            },
          },
          b: {
            entry: (_, enq) => enq(() => tracked.push('enter: b')),
            initial: 'b1',
            states: {
              b1: {
                entry: (_, enq) => enq(() => tracked.push('enter: b.b1')),
              },
            },
          },
        },
      })
      createActor(machine).start()
      yield* expect(tracked).toEqual([
        'enter: __root__',
        'enter: a',
        'enter: a.a1',
        'enter: b',
        'enter: b.b1',
      ])
    })
    it('should return the entry and exit actions of a transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              TIMER: { target: 'yellow' },
            },
          },
          yellow: {
            entry: (_, enq) => enq(() => tracked.push('enter: yellow')),
            exit: (_, enq) => enq(() => tracked.push('exit: yellow')),
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'TIMER' })
      yield* expect(tracked).toEqual(['exit: green', 'enter: yellow'])
    })
    it('should return the entry and exit actions of a deep transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              TIMER: { target: 'yellow' },
            },
          },
          yellow: {
            entry: (_, enq) => enq(() => tracked.push('enter: yellow')),
            exit: (_, enq) => enq(() => tracked.push('exit: yellow')),
            initial: 'speed_up',
            states: {
              speed_up: {
                entry: (_, enq) => enq(() => tracked.push('enter: yellow.speed_up')),
                exit: (_, enq) => enq(() => tracked.push('exit: yellow.speed_up')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'TIMER' })
      yield* expect(tracked).toEqual([
        'exit: green',
        'enter: yellow',
        'enter: yellow.speed_up',
      ])
    })
    it('should return the entry and exit actions of a nested transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            initial: 'walk',
            states: {
              walk: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.walk')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.walk')),
                on: {
                  PED_COUNTDOWN: { target: 'wait' },
                },
              },
              wait: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.wait')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.wait')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'PED_COUNTDOWN' })
      yield* expect(tracked).toEqual(['exit: green.walk', 'enter: green.wait'])
    })
    it('should not have actions for unhandled events (shallow)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'FAKE' })
      yield* expect(tracked).toEqual([])
    })
    it('should not have actions for unhandled events (deep)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            initial: 'walk',
            states: {
              walk: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.walk')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.walk')),
              },
              wait: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.wait')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.wait')),
              },
              stop: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.stop')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.stop')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'FAKE' })
      yield* expect(tracked).toEqual([])
    })
    it('should exit and enter the state for reentering self-transitions (shallow)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              RESTART: {
                target: 'green',
                reenter: true,
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'RESTART' })
      yield* expect(tracked).toEqual(['exit: green', 'enter: green'])
    })
    it('should exit and enter the state for reentering self-transitions (deep)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              RESTART: {
                target: 'green',
                reenter: true,
              },
            },
            initial: 'walk',
            states: {
              walk: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.walk')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.walk')),
              },
              wait: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.wait')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.wait')),
              },
              stop: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.stop')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.stop')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'RESTART' })
      yield* expect(tracked).toEqual([
        'exit: green.walk',
        'exit: green',
        'enter: green',
        'enter: green.walk',
      ])
    })
    it('should return actions for parallel machines', function*({ expect }) {
      const actual: string[] = []
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                on: {
                  // CHANGE: {
                  //   target: 'a2',
                  //   actions: [
                  //     () => actual.push('do_a2'),
                  //     () => actual.push('another_do_a2')
                  //   ]
                  // }
                  CHANGE: (_, enq) => {
                    enq(() => actual.push('do_a2'))
                    enq(() => actual.push('another_do_a2'))
                    return {
                      target: 'a2',
                    }
                  },
                },
                // entry: () => actual.push('enter_a1'),
                entry: (_, enq) => enq(() => actual.push('enter_a1')),
                // exit: () => actual.push('exit_a1')
                exit: (_, enq) => enq(() => actual.push('exit_a1')),
              },
              a2: {
                // entry: () => actual.push('enter_a2'),
                // exit: () => actual.push('exit_a2')
                entry: (_, enq) => enq(() => actual.push('enter_a2')),
                exit: (_, enq) => enq(() => actual.push('exit_a2')),
              },
            },
            // entry: () => actual.push('enter_a'),
            // exit: () => actual.push('exit_a')
            entry: (_, enq) => enq(() => actual.push('enter_a')),
            exit: (_, enq) => enq(() => actual.push('exit_a')),
          },
          b: {
            initial: 'b1',
            states: {
              b1: {
                on: {
                  // CHANGE: { target: 'b2', actions: () => actual.push('do_b2') }
                  CHANGE: (_, enq) => {
                    enq(() => actual.push('do_b2'))
                    return {
                      target: 'b2',
                    }
                  },
                },
                // entry: () => actual.push('enter_b1'),
                entry: (_, enq) => enq(() => actual.push('enter_b1')),
                // exit: () => actual.push('exit_b1')
                exit: (_, enq) => enq(() => actual.push('exit_b1')),
              },
              b2: {
                // entry: () => actual.push('enter_b2'),
                // exit: () => actual.push('exit_b2')
                entry: (_, enq) => enq(() => actual.push('enter_b2')),
                exit: (_, enq) => enq(() => actual.push('exit_b2')),
              },
            },
            // entry: () => actual.push('enter_b'),
            entry: (_, enq) => enq(() => actual.push('enter_b')),
            // exit: () => actual.push('exit_b')
            exit: (_, enq) => enq(() => actual.push('exit_b')),
          },
        },
      })
      const actor = createActor(machine).start()
      actual.length = 0
      actor.send({ type: 'CHANGE' })
      yield* expect(actual).toEqual([
        'exit_b1', // reverse document order
        'exit_a1',
        'do_a2',
        'another_do_a2',
        'do_b2',
        'enter_a2',
        'enter_b2',
      ])
    })
    it('should return nested actions in the correct (child to parent) order', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => enq(() => tracked.push('enter: a')),
            exit: (_, enq) => enq(() => tracked.push('exit: a')),
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
              },
            },
            on: { CHANGE: { target: 'b' } },
          },
          b: {
            entry: (_, enq) => enq(() => tracked.push('enter: b')),
            exit: (_, enq) => enq(() => tracked.push('exit: b')),
            initial: 'b1',
            states: {
              b1: {
                entry: (_, enq) => enq(() => tracked.push('enter: b.b1')),
                exit: (_, enq) => enq(() => tracked.push('exit: b.b1')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'CHANGE' })
      yield* expect(tracked).toEqual([
        'exit: a.a1',
        'exit: a',
        'enter: b',
        'enter: b.b1',
      ])
    })
    it('should ignore parent state actions for same-parent substates', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                on: {
                  NEXT: { target: 'a2' },
                },
              },
              a2: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a2')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a2')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'NEXT' })
      yield* expect(tracked).toEqual(['exit: a.a1', 'enter: a.a2'])
    })
    it('should work with function actions', function*({ expect }) {
      const entrySpy = recorder()
      const exitSpy = recorder()
      const transitionSpy = recorder()
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                on: {
                  NEXT_FN: { target: 'a3' },
                },
              },
              a2: {
                entry: (_, enq) => {
                  enq(() => tracked.push('enter: a.a2'))
                },
                exit: (_, enq) => enq(() => tracked.push('exit: a.a2')),
              },
              a3: {
                entry: (_, enq) => {
                  enq(() => tracked.push('enter: a.a3'))
                  enq(entrySpy)
                },
                exit: (_, enq) => {
                  enq(() => tracked.push('exit: a.a3'))
                  enq(exitSpy)
                },
                on: {
                  // NEXT: {
                  //   target: 'a2',
                  //   actions: [transitionSpy]
                  // }
                  NEXT: (_, enq) => {
                    enq(transitionSpy)
                    return {
                      target: 'a2',
                    }
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'NEXT_FN' })
      const afterNextFn = [...tracked]
      const entryCalls = [...entrySpy.calls]
      tracked.length = 0
      actor.send({ type: 'NEXT' })
      const afterNext = [...tracked]
      const exitCalls = [...exitSpy.calls]
      const transitionCalls = [...transitionSpy.calls]
      yield* expect({
        afterNextFn,
        afterNext,
        entryCalls,
        exitCalls,
        transitionCalls,
      }).toEqual({
        afterNextFn: ['exit: a.a1', 'enter: a.a3'],
        afterNext: ['exit: a.a3', 'enter: a.a2'],
        entryCalls: [[]],
        exitCalls: [[]],
        transitionCalls: [[]],
      })
    })
    it('should exit children of parallel state nodes', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'B',
        states: {
          A: {
            entry: (_, enq) => enq(() => tracked.push('enter: A')),
            exit: (_, enq) => enq(() => tracked.push('exit: A')),
            on: {
              'to-B': { target: 'B' },
            },
          },
          B: {
            type: 'parallel',
            entry: (_, enq) => enq(() => tracked.push('enter: B')),
            exit: (_, enq) => enq(() => tracked.push('exit: B')),
            on: {
              'to-A': { target: 'A' },
            },
            states: {
              C: {
                entry: (_, enq) => enq(() => tracked.push('enter: B.C')),
                exit: (_, enq) => enq(() => tracked.push('exit: B.C')),
                initial: 'C1',
                states: {
                  C1: {
                    entry: (_, enq) => enq(() => tracked.push('enter: B.C.C1')),
                    exit: (_, enq) => enq(() => tracked.push('exit: B.C.C1')),
                  },
                },
              },
              D: {
                entry: (_, enq) => enq(() => tracked.push('enter: B.D')),
                exit: (_, enq) => enq(() => tracked.push('exit: B.D')),
                initial: 'D1',
                states: {
                  D1: {
                    entry: (_, enq) => enq(() => tracked.push('enter: B.D.D1')),
                    exit: (_, enq) => enq(() => tracked.push('exit: B.D.D1')),
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'to-A' })
      yield* expect(tracked).toEqual([
        'exit: B.D.D1',
        'exit: B.D',
        'exit: B.C.C1',
        'exit: B.C',
        'exit: B',
        'enter: A',
      ])
    })
    it("should reenter targeted ancestor (as it's a descendant of the transition domain)", function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'loaded',
        states: {
          loaded: {
            id: 'loaded',
            entry: (_, enq) => enq(() => tracked.push('enter: loaded')),
            exit: (_, enq) => enq(() => tracked.push('exit: loaded')),
            initial: 'idle',
            states: {
              idle: {
                entry: (_, enq) => enq(() => tracked.push('enter: loaded.idle')),
                exit: (_, enq) => enq(() => tracked.push('exit: loaded.idle')),
                on: {
                  UPDATE: { target: '#loaded' },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'UPDATE' })
      yield* expect(tracked).toEqual([
        'exit: loaded.idle',
        'exit: loaded',
        'enter: loaded',
        'enter: loaded.idle',
      ])
    })
    it('root entry/exit actions should be called on root reentering transitions', function*({ expect }) {
      const entrySpy = recorder()
      const exitSpy = recorder()
      const machine = createMachine({
        id: 'root',
        entry: (_, enq) => enq(entrySpy),
        exit: (_, enq) => enq(exitSpy),
        on: {
          EVENT: {
            target: '#two',
            reenter: true,
          },
        },
        initial: 'one',
        states: {
          one: {},
          two: {
            id: 'two',
          },
        },
      })
      const service = createActor(machine).start()
      const entryCallsBefore = entrySpy.calls.length
      const exitCallsBefore = exitSpy.calls.length
      service.send({ type: 'EVENT' })
      yield* expect({
        entryCalls: entrySpy.calls.slice(entryCallsBefore),
        exitCalls: exitSpy.calls.slice(exitCallsBefore),
      }).toEqual({ entryCalls: [[]], exitCalls: [[]] })
    })
    describe('should ignore same-parent state actions (sparse)', () => {
      it('with a relative transition', function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'ping',
          states: {
            ping: {
              entry: (_, enq) => enq(() => tracked.push('enter: ping')),
              exit: (_, enq) => enq(() => tracked.push('exit: ping')),
              initial: 'foo',
              states: {
                foo: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ping.foo')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ping.foo')),
                  on: {
                    TACK: { target: 'bar' },
                  },
                },
                bar: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ping.bar')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ping.bar')),
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'TACK' })
        yield* expect(tracked).toEqual(['exit: ping.foo', 'enter: ping.bar'])
      })
      it('with an absolute transition', function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          id: 'root',
          initial: 'ping',
          states: {
            ping: {
              entry: (_, enq) => enq(() => tracked.push('enter: ping')),
              exit: (_, enq) => enq(() => tracked.push('exit: ping')),
              initial: 'foo',
              states: {
                foo: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ping.foo')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ping.foo')),
                  on: {
                    ABSOLUTE_TACK: { target: '#root.ping.bar' },
                  },
                },
                bar: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ping.bar')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ping.bar')),
                },
              },
            },
            pong: {
              entry: (_, enq) => enq(() => tracked.push('enter: pong')),
              exit: (_, enq) => enq(() => tracked.push('exit: pong')),
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'ABSOLUTE_TACK' })
        yield* expect(tracked).toEqual(['exit: ping.foo', 'enter: ping.bar'])
      })
    })
  })
  describe('entry/exit actions', () => {
    it('should return the entry actions of an initial state', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        entry: (_, enq) => enq(() => tracked.push('enter: __root__')),
        exit: (_, enq) => enq(() => tracked.push('exit: __root__')),
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
          },
        },
      })
      createActor(machine).start()
      yield* expect(tracked).toEqual(['enter: __root__', 'enter: green'])
    })
    it('should return the entry and exit actions of a transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              TIMER: { target: 'yellow' },
            },
          },
          yellow: {
            entry: (_, enq) => enq(() => tracked.push('enter: yellow')),
            exit: (_, enq) => enq(() => tracked.push('exit: yellow')),
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'TIMER' })
      yield* expect(tracked).toEqual(['exit: green', 'enter: yellow'])
    })
    it('should return the entry and exit actions of a deep transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              TIMER: { target: 'yellow' },
            },
          },
          yellow: {
            entry: (_, enq) => enq(() => tracked.push('enter: yellow')),
            exit: (_, enq) => enq(() => tracked.push('exit: yellow')),
            initial: 'speed_up',
            states: {
              speed_up: {
                entry: (_, enq) => enq(() => tracked.push('enter: yellow.speed_up')),
                exit: (_, enq) => enq(() => tracked.push('exit: yellow.speed_up')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'TIMER' })
      yield* expect(tracked).toEqual([
        'exit: green',
        'enter: yellow',
        'enter: yellow.speed_up',
      ])
    })
    it('should return the entry and exit actions of a nested transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            initial: 'walk',
            states: {
              walk: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.walk')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.walk')),
                on: {
                  PED_COUNTDOWN: { target: 'wait' },
                },
              },
              wait: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.wait')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.wait')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'PED_COUNTDOWN' })
      yield* expect(tracked).toEqual(['exit: green.walk', 'enter: green.wait'])
    })
    it('should keep the same state for unhandled events (shallow)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'FAKE' })
      yield* expect(tracked).toEqual([])
    })
    it('should keep the same state for unhandled events (deep)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            initial: 'walk',
            states: {
              walk: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.walk')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.walk')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'FAKE' })
      yield* expect(tracked).toEqual([])
    })
    it('should exit and enter the state for reentering self-transitions (shallow)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              RESTART: {
                target: 'green',
                reenter: true,
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'RESTART' })
      yield* expect(tracked).toEqual(['exit: green', 'enter: green'])
    })
    it('should exit and enter the state for reentering self-transitions (deep)', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'green',
        states: {
          green: {
            entry: (_, enq) => enq(() => tracked.push('enter: green')),
            exit: (_, enq) => enq(() => tracked.push('exit: green')),
            on: {
              RESTART: {
                target: 'green',
                reenter: true,
              },
            },
            initial: 'walk',
            states: {
              walk: {
                entry: (_, enq) => enq(() => tracked.push('enter: green.walk')),
                exit: (_, enq) => enq(() => tracked.push('exit: green.walk')),
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'RESTART' })
      yield* expect(tracked).toEqual([
        'exit: green.walk',
        'exit: green',
        'enter: green',
        'enter: green.walk',
      ])
    })
    it(
      'should exit current node and enter target node when target is not a descendent or ancestor of current',
      function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'A',
          states: {
            A: {
              entry: (_, enq) => enq(() => tracked.push('enter: A')),
              exit: (_, enq) => enq(() => tracked.push('exit: A')),
              initial: 'A1',
              states: {
                A1: {
                  entry: (_, enq) => enq(() => tracked.push('enter: A.A1')),
                  exit: (_, enq) => enq(() => tracked.push('exit: A.A1')),
                  on: {
                    NEXT: { target: '#sibling_descendant' },
                  },
                },
                A2: {
                  entry: (_, enq) => enq(() => tracked.push('enter: A.A2')),
                  exit: (_, enq) => enq(() => tracked.push('exit: A.A2')),
                  initial: 'A2_child',
                  states: {
                    A2_child: {
                      entry: (_, enq) => enq(() => tracked.push('enter: A.A2.A2_child')),
                      exit: (_, enq) => enq(() => tracked.push('exit: A.A2.A2_child')),
                      id: 'sibling_descendant',
                    },
                  },
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'NEXT' })
        yield* expect(tracked).toEqual([
          'exit: A.A1',
          'enter: A.A2',
          'enter: A.A2.A2_child',
        ])
      },
    )
    it('should exit current node and reenter target node when target is ancestor of current', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'A',
        states: {
          A: {
            entry: (_, enq) => enq(() => tracked.push('enter: A')),
            exit: (_, enq) => enq(() => tracked.push('exit: A')),
            id: 'ancestor',
            initial: 'A1',
            states: {
              A1: {
                entry: (_, enq) => enq(() => tracked.push('enter: A.A1')),
                exit: (_, enq) => enq(() => tracked.push('exit: A.A1')),
                on: {
                  NEXT: { target: 'A2' },
                },
              },
              A2: {
                entry: (_, enq) => enq(() => tracked.push('enter: A.A2')),
                exit: (_, enq) => enq(() => tracked.push('exit: A.A2')),
                initial: 'A2_child',
                states: {
                  A2_child: {
                    entry: (_, enq) => enq(() => tracked.push('enter: A.A2.A2_child')),
                    exit: (_, enq) => enq(() => tracked.push('exit: A.A2.A2_child')),
                    on: {
                      NEXT: { target: '#ancestor' },
                    },
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'NEXT' })
      tracked.length = 0
      actor.send({ type: 'NEXT' })
      yield* expect(tracked).toEqual([
        'exit: A.A2.A2_child',
        'exit: A.A2',
        'exit: A',
        'enter: A',
        'enter: A.A1',
      ])
    })
    it(
      'should enter all descendents when target is a descendent of the source when using an reentering transition',
      function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'A',
          states: {
            A: {
              entry: (_, enq) => enq(() => tracked.push('enter: A')),
              exit: (_, enq) => enq(() => tracked.push('exit: A')),
              initial: 'A1',
              on: {
                NEXT: {
                  reenter: true,
                  target: '.A2',
                },
              },
              states: {
                A1: {
                  entry: (_, enq) => enq(() => tracked.push('enter: A.A1')),
                  exit: (_, enq) => enq(() => tracked.push('exit: A.A1')),
                },
                A2: {
                  entry: (_, enq) => enq(() => tracked.push('enter: A.A2')),
                  exit: (_, enq) => enq(() => tracked.push('exit: A.A2')),
                  initial: 'A2a',
                  states: {
                    A2a: {
                      entry: (_, enq) => enq(() => tracked.push('enter: A.A2.A2a')),
                      exit: (_, enq) => enq(() => tracked.push('exit: A.A2.A2a')),
                    },
                  },
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'NEXT' })
        yield* expect(tracked).toEqual([
          'exit: A.A1',
          'exit: A',
          'enter: A',
          'enter: A.A2',
          'enter: A.A2.A2a',
        ])
      },
    )
    it('should exit deep descendant during a default self-transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => enq(() => tracked.push('enter: a')),
            exit: (_, enq) => enq(() => tracked.push('exit: a')),
            on: {
              EV: { target: 'a' },
            },
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                initial: 'a11',
                states: {
                  a11: {
                    entry: (_, enq) => enq(() => tracked.push('enter: a.a1.a11')),
                    exit: (_, enq) => enq(() => tracked.push('exit: a.a1.a11')),
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'EV' })
      tracked.length = 0
      actor.send({ type: 'EV' })
      yield* expect(tracked).toEqual([
        'exit: a.a1.a11',
        'exit: a.a1',
        'enter: a.a1',
        'enter: a.a1.a11',
      ])
    })
    it('should exit deep descendant during a reentering self-transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => enq(() => tracked.push('enter: a')),
            exit: (_, enq) => enq(() => tracked.push('exit: a')),
            on: {
              EV: {
                target: 'a',
                reenter: true,
              },
            },
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                initial: 'a11',
                states: {
                  a11: {
                    entry: (_, enq) => enq(() => tracked.push('enter: a.a1.a11')),
                    exit: (_, enq) => enq(() => tracked.push('exit: a.a1.a11')),
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'EV' })
      yield* expect(tracked).toEqual([
        'exit: a.a1.a11',
        'exit: a.a1',
        'exit: a',
        'enter: a',
        'enter: a.a1',
        'enter: a.a1.a11',
      ])
    })
    it('should not reenter leaf state during its default self-transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        entry: (_, enq) => enq(() => tracked.push('enter: a')),
        exit: (_, enq) => enq(() => tracked.push('exit: a')),
        initial: 'a',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                on: {
                  EV: { target: 'a1' },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'EV' })
      yield* expect(tracked).toEqual([])
    })
    it('should reenter leaf state during its reentering self-transition', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'a',
        states: {
          a: {
            entry: (_, enq) => enq(() => tracked.push('enter: a')),
            exit: (_, enq) => enq(() => tracked.push('exit: a')),
            initial: 'a1',
            states: {
              a1: {
                entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                on: {
                  EV: {
                    target: 'a1',
                    reenter: true,
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'EV' })
      yield* expect(tracked).toEqual(['exit: a.a1', 'enter: a.a1'])
    })
    it(
      'should not enter exited state when targeting its ancestor and when its former descendant gets selected through initial state',
      function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'a',
          states: {
            a: {
              entry: (_, enq) => enq(() => tracked.push('enter: a')),
              exit: (_, enq) => enq(() => tracked.push('exit: a')),
              id: 'parent',
              initial: 'a1',
              states: {
                a1: {
                  entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                  exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                  on: {
                    EV: { target: 'a2' },
                  },
                },
                a2: {
                  entry: (_, enq) => enq(() => tracked.push('enter: a.a2')),
                  exit: (_, enq) => enq(() => tracked.push('exit: a.a2')),
                  on: {
                    EV: { target: '#parent' },
                  },
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'EV' })
        tracked.length = 0
        actor.send({ type: 'EV' })
        yield* expect(tracked).toEqual([
          'exit: a.a2',
          'exit: a',
          'enter: a',
          'enter: a.a1',
        ])
      },
    )
    it(
      'should not enter exited state when targeting its ancestor and when its latter descendant gets selected through initial state',
      function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'a',
          states: {
            a: {
              entry: (_, enq) => enq(() => tracked.push('enter: a')),
              exit: (_, enq) => enq(() => tracked.push('exit: a')),
              id: 'parent',
              initial: 'a2',
              states: {
                a1: {
                  entry: (_, enq) => enq(() => tracked.push('enter: a.a1')),
                  exit: (_, enq) => enq(() => tracked.push('exit: a.a1')),
                  on: {
                    EV: { target: '#parent' },
                  },
                },
                a2: {
                  entry: (_, enq) => enq(() => tracked.push('enter: a.a2')),
                  exit: (_, enq) => enq(() => tracked.push('exit: a.a2')),
                  on: {
                    EV: { target: 'a1' },
                  },
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'EV' })
        tracked.length = 0
        actor.send({ type: 'EV' })
        yield* expect(tracked).toEqual([
          'exit: a.a1',
          'exit: a',
          'enter: a',
          'enter: a.a2',
        ])
      },
    )

    it('passes the entered/exited state node to entry and exit', function*({ expect }) {
      const log: string[] = []
      const machine = createMachine({
        id: 'm',
        initial: 'a',
        on: { leave: { target: '.b' } },
        states: {
          b: {},
          a: {
            initial: 'a1',
            entry: ({ stateNode }) => {
              log.push(`entry ${stateNode.id} ${stateNode.key}`)
            },
            exit: ({ stateNode }) => {
              log.push(`exit ${stateNode.id} ${stateNode.path.join('.')}`)
            },
            states: {
              a1: {
                entry: ({ stateNode }, enq) => {
                  enq(() => log.push(`entry ${stateNode.id}`))
                },
                exit: ({ stateNode }, enq) => {
                  enq(() => log.push(`exit ${stateNode.id}`))
                },
                on: { next: { target: 'a2' } },
              },
              a2: {},
            },
          },
        },
      })

      const actor = createActor(machine).start()
      actor.send({ type: 'next' })
      actor.send({ type: 'leave' })

      yield* expect(log).toEqual([
        'entry m.a a',
        'entry m.a.a1',
        'exit m.a.a1',
        'exit m.a a',
      ])
    })
  })
  describe('parallel states', () => {
    it('should return entry action defined on parallel state', function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        initial: 'start',
        states: {
          start: {
            entry: (_, enq) => enq(() => tracked.push('enter: start')),
            exit: (_, enq) => enq(() => tracked.push('exit: start')),
            on: { ENTER_PARALLEL: { target: 'p1' } },
          },
          p1: {
            type: 'parallel',
            entry: (_, enq) => enq(() => tracked.push('enter: p1')),
            exit: (_, enq) => enq(() => tracked.push('exit: p1')),
            states: {
              nested: {
                entry: (_, enq) => enq(() => tracked.push('enter: p1.nested')),
                exit: (_, enq) => enq(() => tracked.push('exit: p1.nested')),
                initial: 'inner',
                states: {
                  inner: {
                    entry: (_, enq) => enq(() => tracked.push('enter: p1.nested.inner')),
                    exit: (_, enq) => enq(() => tracked.push('exit: p1.nested.inner')),
                  },
                },
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      actor.send({ type: 'ENTER_PARALLEL' })
      yield* expect(tracked).toEqual([
        'exit: start',
        'enter: p1',
        'enter: p1.nested',
        'enter: p1.nested.inner',
      ])
    })
    it(
      'should reenter parallel region when a parallel state gets reentered while targeting another region',
      function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'ready',
          states: {
            ready: {
              entry: (_, enq) => enq(() => tracked.push('enter: ready')),
              exit: (_, enq) => enq(() => tracked.push('exit: ready')),
              type: 'parallel',
              on: {
                FOO: {
                  target: '#cameraOff',
                  reenter: true,
                },
              },
              states: {
                devicesInfo: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ready.devicesInfo')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ready.devicesInfo')),
                },
                camera: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ready.camera')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ready.camera')),
                  initial: 'on',
                  states: {
                    on: {
                      entry: (_, enq) => enq(() => tracked.push('enter: ready.camera.on')),
                      exit: (_, enq) => enq(() => tracked.push('exit: ready.camera.on')),
                    },
                    off: {
                      entry: (_, enq) => enq(() => tracked.push('enter: ready.camera.off')),
                      exit: (_, enq) => enq(() => tracked.push('exit: ready.camera.off')),
                      id: 'cameraOff',
                    },
                  },
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'FOO' })
        yield* expect(tracked).toEqual([
          'exit: ready.camera.on',
          'exit: ready.camera',
          'exit: ready.devicesInfo',
          'exit: ready',
          'enter: ready',
          'enter: ready.devicesInfo',
          'enter: ready.camera',
          'enter: ready.camera.off',
        ])
      },
    )
    it(
      'should reenter parallel region when a parallel state is reentered while targeting another region',
      function*({ expect }) {
        const tracked: string[] = []
        const machine = createMachine({
          initial: 'ready',
          states: {
            ready: {
              entry: (_, enq) => enq(() => tracked.push('enter: ready')),
              exit: (_, enq) => enq(() => tracked.push('exit: ready')),
              type: 'parallel',
              on: {
                FOO: {
                  target: '#cameraOff',
                  reenter: true,
                },
              },
              states: {
                devicesInfo: {
                  entry: (_, enq) => enq(() => tracked.push('enter: ready.devicesInfo')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ready.devicesInfo')),
                },
                camera: {
                  initial: 'on',
                  entry: (_, enq) => enq(() => tracked.push('enter: ready.camera')),
                  exit: (_, enq) => enq(() => tracked.push('exit: ready.camera')),
                  states: {
                    on: {
                      entry: (_, enq) => enq(() => tracked.push('enter: ready.camera.on')),
                      exit: (_, enq) => enq(() => tracked.push('exit: ready.camera.on')),
                    },
                    off: {
                      entry: (_, enq) => enq(() => tracked.push('enter: ready.camera.off')),
                      exit: (_, enq) => enq(() => tracked.push('exit: ready.camera.off')),
                      id: 'cameraOff',
                    },
                  },
                },
              },
            },
          },
        })
        const actor = createActor(machine).start()
        tracked.length = 0
        actor.send({ type: 'FOO' })
        yield* expect(tracked).toEqual([
          'exit: ready.camera.on',
          'exit: ready.camera',
          'exit: ready.devicesInfo',
          'exit: ready',
          'enter: ready',
          'enter: ready.devicesInfo',
          'enter: ready.camera',
          'enter: ready.camera.off',
        ])
      },
    )
  })
  describe('targetless transitions', () => {
    it("shouldn't exit a state on a parent's targetless transition", function*({ expect }) {
      const tracked: string[] = []
      const parent = createMachine({
        entry: (_, enq) => enq(() => tracked.push('enter: one')),
        exit: (_, enq) => enq(() => tracked.push('exit: one')),
        initial: 'one',
        on: {
          WHATEVER: (_, enq) => {
            enq(() => {})
          },
        },
        states: {
          one: {},
        },
      })
      const actor = createActor(parent).start()
      tracked.length = 0
      actor.send({ type: 'WHATEVER' })
      yield* expect(tracked).toEqual([])
    })
    it("shouldn't exit (and reenter) state on targetless delayed transition", function*({ expect }) {
      const tracked: string[] = []
      const machine = createMachine({
        entry: (_, enq) => enq(() => tracked.push('enter: one')),
        exit: (_, enq) => enq(() => tracked.push('exit: one')),
        initial: 'one',
        states: {
          one: {
            after: {
              10: (_, enq) => {
                enq(() => {
                  /* ... */
                })
              },
            },
          },
        },
      })
      const actor = createActor(machine).start()
      tracked.length = 0
      yield* Effect.promise(() => sleep(50))
      yield* expect(tracked).toEqual([])
    })
  })
  describe('when reaching a final state', () => {
    // https://github.com/statelyai/xstate/issues/1109
    it('exit actions should be called when invoked machine reaches its final state', function*({ expect }) {
      const { resolve, promise } = Promise.withResolvers<void>()
      let exitCalled = false
      let childExitCalled = false
      const childMachine = createMachine({
        exit: (_, enq) => {
          enq(() => (exitCalled = true))
        },
        initial: 'a',
        states: {
          a: {
            type: 'final',
            exit: (_, enq) => {
              enq(() => (childExitCalled = true))
            },
          },
        },
      })
      const parentMachine = createMachine({
        initial: 'active',
        states: {
          active: {
            invoke: {
              src: childMachine,
              onDone: { target: 'finished' },
            },
          },
          finished: {
            type: 'final',
          },
        },
      })
      const actor = createActor(parentMachine)
      actor.subscribe({ complete: () => resolve() })
      actor.start()
      yield* Effect.promise(() => promise)
      yield* expect({ exitCalled, childExitCalled }).toEqual({
        exitCalled: true,
        childExitCalled: true,
      })
    })
  })
  describe('when stopped', () => {
    it('exit actions should not be called when stopping a machine', function*({ expect }) {
      const rootSpy = recorder()
      const childSpy = recorder()
      const machine = createMachine({
        exit: (_, enq) => enq(rootSpy),
        initial: 'a',
        states: {
          a: {
            exit: (_, enq) => enq(childSpy),
          },
        },
      })
      const service = createActor(machine).start()
      service.stop()
      yield* expect({
        rootCalls: [...rootSpy.calls],
        childCalls: [...childSpy.calls],
      }).toEqual({ rootCalls: [], childCalls: [] })
    })
    it(
      'an exit action executed when an interpreter reaches its final state should be called with the last received event',
      function*({ expect }) {
        let receivedEvent
        const machine = createMachine({
          initial: 'a',
          states: {
            a: {
              on: {
                NEXT: { target: 'b' },
              },
            },
            b: {
              type: 'final',
            },
          },
          exit: ({ event }) => {
            receivedEvent = event
          },
        })
        const service = createActor(machine).start()
        service.send({ type: 'NEXT' })
        yield* expect(receivedEvent).toEqual({ type: 'NEXT' })
      },
    )
    // https://github.com/statelyai/xstate/issues/2880
    it(
      'stopping an interpreter that receives events from its children exit handlers should not throw',
      function*({ expect }) {
        const child = createMachine({
          id: 'child',
          initial: 'idle',
          states: {
            idle: {
              // exit: sendParent({ type: 'EXIT' })
              exit: ({ parent }, enq) => {
                enq.sendTo(parent, { type: 'EXIT' })
              },
            },
          },
        })
        const parent = createMachine({
          id: 'parent',
          invoke: {
            src: child,
          },
        })
        const actor = createActor(parent)
        actor.start()
        actor.stop()
        yield* expect(actor.getSnapshot().status).toEqual('stopped')
      },
    )
    // TODO: determine if the sendParent action should execute when the child actor is stopped.
    // If it shouldn't be, we need to clarify whether exit actions in general should be executed on machine stop,
    // since this is contradictory to other tests.
    it.skip(
      'sent events from exit handlers of a stopped child should not be received by the parent',
      function*({ expect }) {
        const child = createMachine({
          id: 'child',
          initial: 'idle',
          states: {
            idle: {
              exit: ({ parent }, enq) => {
                enq.sendTo(parent, { type: 'EXIT' })
              },
            },
          },
        })
        const parent = createMachine({
          // types: {} as {
          //   context: {
          //     child: ActorFromLogic<typeof child>;
          //   };
          // },
          schemas: {
            context: z.object({
              child: z.custom<ActorFromLogic<typeof child>>(),
            }),
          },
          id: 'parent',
          context: ({ spawn }) => ({
            child: spawn(child),
          }),
          on: {
            // STOP_CHILD: {
            //   actions: stopChild(({ context }) => context.child)
            // },
            STOP_CHILD: ({ context }, enq) => {
              enq.stop(context.child)
            },
            // EXIT: {
            //   actions: () => {
            //     throw new Error('This should not be called.');
            //   }
            // }
            EXIT: () => {
              throw new Error('This should not be called.')
            },
          },
        })
        const interpreter = createActor(parent).start()
        interpreter.send({ type: 'STOP_CHILD' })
        yield* expect(interpreter.getSnapshot().status).toEqual('active')
      },
    )
    it('sent events from exit handlers of a done child should be received by the parent ', function*({ expect }) {
      let eventReceived = false
      const child = createMachine({
        id: 'child',
        initial: 'active',
        states: {
          active: {
            on: {
              FINISH: { target: 'done' },
            },
          },
          done: {
            type: 'final',
          },
        },
        // exit: sendParent({ type: 'CHILD_DONE' })
        exit: ({ parent }, enq) => {
          enq.sendTo(parent, { type: 'CHILD_DONE' })
        },
      })
      const parent = createMachine({
        // types: {} as {
        //   context: {
        //     child: ActorRefFromLogic<typeof child>;
        //   };
        // },
        schemas: {
          context: z.object({
            child: z.custom<ActorRefFromLogic<typeof child>>(),
          }),
        },
        id: 'parent',
        context: ({ spawn }) => ({
          child: spawn(child),
        }),
        on: {
          // FINISH_CHILD: {
          //   actions: sendTo(({ context }) => context.child, { type: 'FINISH' })
          // },
          FINISH_CHILD: ({ context }, enq) => {
            enq.sendTo(context.child, { type: 'FINISH' })
          },
          // CHILD_DONE: {
          //   actions: () => {
          //     eventReceived = true;
          //   }
          // }
          CHILD_DONE: (_, enq) => {
            enq(() => (eventReceived = true))
          },
        },
      })
      const actor = createActor(parent).start()
      actor.send({ type: 'FINISH_CHILD' })
      yield* expect({ eventReceived }).toEqual({ eventReceived: true })
    })
    it(
      'sent events from exit handlers of a stopped child should not be received by its children',
      function*({ expect }) {
        const spy = recorder()
        const grandchild = createMachine({
          id: 'grandchild',
          on: {
            STOPPED: (_, enq) => enq(spy),
          },
        })
        const child = createMachine({
          id: 'child',
          invoke: {
            id: 'myChild',
            src: grandchild,
          },
          exit: ({ children }, enq) => {
            enq.sendTo(children['myChild'], { type: 'STOPPED' })
          },
        })
        const parent = createMachine({
          id: 'parent',
          initial: 'a',
          states: {
            a: {
              invoke: {
                src: child,
              },
              on: {
                NEXT: { target: 'b' },
              },
            },
            b: {},
          },
        })
        const actor = createActor(parent).start()
        actor.send({ type: 'NEXT' })
        yield* expect(spy.calls).toEqual([])
      },
    )
    // TODO: figure out order of entry/invoke actions, maybe add defer?
    it.skip('sent events from exit handlers of a done child should be received by its children', function*({ expect }) {
      const spy = recorder()
      const grandchild = createMachine({
        id: 'grandchild',
        on: {
          // STOPPED: {
          //   actions: spy
          // }
          STOPPED: (_, enq) => {
            enq(spy)
          },
        },
      })
      const child = createMachine({
        id: 'child',
        initial: 'a',
        invoke: {
          id: 'myChild',
          src: grandchild,
        },
        states: {
          a: {
            on: {
              FINISH: () => {
                return { target: 'b' }
              },
            },
          },
          b: {
            type: 'final',
          },
        },
        // exit: sendTo('myChild', { type: 'STOPPED' })
        entry: ({ children }, enq) => {
          children
          // enq.sendTo(children.myChild, { type: 'FINISH' });
        },
        exit: ({ children }, enq) => {
          enq.sendTo(children['myChild'], { type: 'STOPPED' })
        },
      })
      const parent = createMachine({
        id: 'parent',
        invoke: {
          id: 'myChild',
          src: child,
        },
        schemas: {
          events: {
            NEXT: z.object({}),
          },
        },
        on: {
          // NEXT: {
          //   actions: sendTo('myChild', { type: 'FINISH' })
          // }
          NEXT: ({ children }, enq) => {
            enq.sendTo(children['myChild'], { type: 'FINISH' })
          },
        },
      })
      const actor = createActor(parent).start()
      actor.send({ type: 'NEXT' })
      yield* expect(spy.calls).toEqual([[]])
    })
    it('actors spawned in exit handlers of a stopped child should not be started', function*({ expect }) {
      const grandchild = createMachine({
        id: 'grandchild',
        entry: () => {
          throw new Error('This should not be called.')
        },
      })
      const parent = createMachine({
        id: 'parent',
        schemas: {
          context: z.object({
            actorRef: z.any().optional(),
          }),
        },
        context: {},
        exit: (_, enq) => ({
          context: {
            actorRef: enq.spawn(grandchild),
          },
        }),
      })
      const actor = createActor(parent).start()
      actor.stop()
      yield* expect(actor.getSnapshot().status).toEqual('stopped')
    })
    it('should note execute referenced custom actions correctly when stopping an interpreter', function*({ expect }) {
      const spy = recorder()
      const parent = createMachine({
        actions: { referencedAction: spy },
        id: 'parent',
        schemas: {
          context: z.object({}),
        },
        context: {},
        exit: ({ actions }, enq) => {
          enq(actions.referencedAction)
        },
      })
      const actor = createActor(parent).start()
      actor.stop()
      yield* expect(spy.calls).toEqual([])
    })
    it('should not execute builtin actions when stopping an interpreter', function*({ expect }) {
      const action = recorder()
      const machine = createMachine({
        exit: (_, enq) => {
          enq(action)
        },
      })
      const actor = createActor(machine).start()
      actor.stop()
      yield* expect(action.calls).toEqual([])
    })
    it('should clear all scheduled events when the interpreter gets stopped', function*({ expect }) {
      const machine = createMachine({
        on: {
          INITIALIZE_SYNC_SEQUENCE: (_, enq) => {
            enq(() => {
              // schedule those 2 events
              service.send({ type: 'SOME_EVENT' })
              service.send({ type: 'SOME_EVENT' })
              // but also immediately stop *while* the `INITIALIZE_SYNC_SEQUENCE` is still being processed
              service.stop()
            })
          },
          SOME_EVENT: (_, enq) => {
            enq(() => {
              throw new Error('This should not be called.')
            })
          },
        },
      })
      const service = createActor(machine).start()
      service.send({ type: 'INITIALIZE_SYNC_SEQUENCE' })
      yield* expect(service.getSnapshot().status).toEqual('stopped')
    })
    it.skip('should execute exit actions of the settled state of the last initiated microstep', function*({ expect }) {
      const exitActions: string[] = []
      const machine = createMachine({
        initial: 'foo',
        states: {
          foo: {
            // exit: () => {
            //   exitActions.push('foo action');
            // },
            exit: (_, enq) => {
              enq(() => exitActions.push('foo action'))
            },
            on: {
              // INITIALIZE_SYNC_SEQUENCE: {
              //   target: 'bar',
              //   actions: [
              //     () => {
              //       // immediately stop *while* the `INITIALIZE_SYNC_SEQUENCE` is still being processed
              //       actor.stop();
              //     },
              //     () => {}
              //   ]
              // }
              INITIALIZE_SYNC_SEQUENCE: (_, enq) => {
                // immediately stop *while* the `INITIALIZE_SYNC_SEQUENCE` is still being processed
                enq(() => {
                  actor.stop()
                })
              },
            },
          },
          bar: {
            exit: (_, enq) => {
              enq(() => exitActions.push('bar action'))
            },
          },
        },
      })
      const actor = createActor(machine).start()
      actor.send({ type: 'INITIALIZE_SYNC_SEQUENCE' })
      yield* expect(exitActions).toEqual(['foo action'])
    })
    it(
      'should not execute exit actions of the settled state of the last initiated microstep after executing all actions from that microstep',
      function*({ expect }) {
        const executedActions: string[] = []
        const machine = createMachine({
          initial: 'foo',
          states: {
            foo: {
              exit: (_, enq) => {
                enq(() => executedActions.push('foo exit action'))
              },
              on: {
                // INITIALIZE_SYNC_SEQUENCE: {
                //   target: 'bar',
                //   actions: [
                //     () => {
                //       // immediately stop *while* the `INITIALIZE_SYNC_SEQUENCE` is still being processed
                //       service.stop();
                //     },
                //     () => {
                //       executedActions.push('foo transition action');
                //     }
                //   ]
                // }
                INITIALIZE_SYNC_SEQUENCE: (_, enq) => {
                  enq(() => {
                    // immediately stop *while* the `INITIALIZE_SYNC_SEQUENCE` is still being processed
                    service.stop()
                  })
                  enq(() => executedActions.push('foo transition action'))
                  return {
                    target: 'bar',
                  }
                },
              },
            },
            bar: {
              exit: (_, enq) => {
                enq(() => executedActions.push('bar exit action'))
              },
            },
          },
        })
        const service = createActor(machine).start()
        service.send({ type: 'INITIALIZE_SYNC_SEQUENCE' })
        yield* expect(executedActions).toEqual([
          'foo exit action',
          'foo transition action',
        ])
      },
    )
  })
})
describe('actions on invalid transition', () => {
  it('should not recall previous actions', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            // STOP: {
            //   target: 'stop',
            //   actions: [spy]
            // }
            STOP: (_, enq) => {
              enq(spy)
              return {
                target: 'stop',
              }
            },
          },
        },
        stop: {},
      },
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'STOP' })
    const afterStop = [...spy.calls]
    actor.send({ type: 'INVALID' })
    const afterInvalid = [...spy.calls]
    yield* expect({ afterStop, afterInvalid }).toEqual({
      afterStop: [[]],
      afterInvalid: [[]],
    })
  })
})
describe('actions config', () => {
  type EventType =
    | {
      type: 'definedAction'
    }
    | {
      type: 'updateContext'
    }
    | {
      type: 'EVENT'
    }
    | {
      type: 'E'
    }
  interface Context {
    count: number
  }
  const definedAction = () => {}
  it('should reference actions defined in actions parameter of machine options (entry actions)', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      initial: 'a',
      actions: {
        definedAction: spy,
      },
      states: {
        a: {
          on: {
            EVENT: () => {
              return { target: 'b' }
            },
          },
        },
        b: {
          entry: ({ actions }, enq) => {
            enq(actions.definedAction)
            enq(
              // @ts-expect-error
              actions.undefinedAction,
            )
          },
        },
      },
      on: {
        E: { target: '.a' },
      },
    }).provide({
      actions: {
        definedAction: spy,
      },
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'EVENT' })
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should reference actions defined in actions parameter of machine options (initial state)', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      actions: {
        definedAction: spy,
      },
      // entry: ['definedAction', { type: 'definedAction' }, 'undefinedAction']
      entry: ({ actions }, enq) => {
        enq(actions.definedAction)
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should be able to reference action sources from action objects', function*({ expect }) {
    const updateContext = (): Context => ({
      count: 10,
    })
    const machine = createMachine({
      // types: {} as { context: Context; events: EventType },
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      initial: 'a',
      context: {
        count: 0,
      },
      states: {
        a: {
          // entry: [
          //   'definedAction',
          //   { type: 'definedAction' },
          //   'undefinedAction'
          // ],
          entry: (_, enq) => {
            enq(definedAction)
            // enq({ type: 'definedAction' });
            return {}
          },
          on: {
            // EVENT: {
            //   target: 'b',
            //   actions: [{ type: 'definedAction' }, { type: 'updateContext' }]
            // }
            EVENT: (_, enq) => {
              enq(definedAction)
              return {
                target: 'b',
                context: updateContext(),
              }
            },
          },
        },
        b: {},
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'EVENT' })
    const snapshot = actorRef.getSnapshot()
    // expect(snapshot.actions).toEqual([
    //   expect.objectContaining({
    //     type: 'definedAction'
    //   }),
    //   expect.objectContaining({
    //     type: 'updateContext'
    //   })
    // ]);
    // TODO: specify which actions other actions came from
    yield* expect(snapshot.context).toEqual({ count: 10 })
  })
  it('should work with anonymous functions (with warning)', function*({ expect }) {
    let entryCalled = false
    let actionCalled = false
    let exitCalled = false
    const anonMachine = createMachine({
      id: 'anon',
      initial: 'active',
      states: {
        active: {
          entry: (_, enq) => enq(() => (entryCalled = true)),
          exit: (_, enq) => enq(() => (exitCalled = true)),
          on: {
            // EVENT: {
            //   target: 'inactive',
            //   actions: [() => (actionCalled = true)]
            // }
            EVENT: (_, enq) => {
              enq(() => (actionCalled = true))
              return {
                target: 'inactive',
              }
            },
          },
        },
        inactive: {},
      },
    })
    const actor = createActor(anonMachine).start()
    actor.send({ type: 'EVENT' })
    yield* expect({ entryCalled, exitCalled, actionCalled }).toEqual({
      entryCalled: true,
      exitCalled: true,
      actionCalled: true,
    })
  })
})
describe('action meta', () => {
  it('should provide the original params', function*({ expect }) {
    const spy = recorder()
    const testMachine = createMachine({
      actions: {
        entryAction: (params) => {
          spy(params)
        },
      },
      id: 'test',
      initial: 'foo',
      states: {
        foo: {
          // entry: {
          //   type: 'entryAction',
          //   params: {
          //     value: 'something'
          //   }
          // }
          entry: ({ actions }, enq) => {
            enq(actions.entryAction, { value: 'something' })
          },
        },
      },
    })
    createActor(testMachine).start()
    yield* expect(spy.calls).toEqual([[{ value: 'something' }]])
  })
  it('should provide the action with resolved params when they are dynamic', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      actions: {
        entryAction: (params) => {
          spy(params)
        },
      },
      // entry: {
      //   type: 'entryAction',
      //   params: () => ({ stuff: 100 })
      // }
      entry: ({ actions }, enq) => {
        enq(actions.entryAction, { stuff: 100 })
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[{ stuff: 100 }]])
  })
  it('should resolve dynamic params using context value', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      schemas: {
        context: z.object({
          secret: z.number(),
        }),
      },
      actions: {
        entryAction: (params) => {
          spy(params)
        },
      },
      context: {
        secret: 42,
      },
      // entry: {
      //   type: 'entryAction',
      //   params: ({ context }) => ({ secret: context.secret })
      // }
      entry: ({ context, actions }, enq) => {
        enq(actions.entryAction, { secret: context.secret })
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[{ secret: 42 }]])
  })
  it('should resolve dynamic params using event value', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ secret: z.number() }),
        },
      },
      actions: {
        myAction: (params) => {
          spy(params)
        },
      },
      on: {
        // FOO: {
        //   actions: {
        //     type: 'myAction',
        //     params: ({ event }) => ({ secret: event.secret })
        //   }
        // }
        FOO: ({ actions, event }, enq) => {
          enq(actions.myAction, { secret: event.secret })
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FOO', secret: 77 })
    yield* expect(spy.calls).toEqual([[{ secret: 77 }]])
  })
})
describe('forwardTo()', () => {
  it('should forward an event to a service', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const child = createMachine({
      // types: {} as {
      //   events: {
      //     type: 'EVENT';
      //     value: number;
      //   };
      // },
      schemas: {
        events: {
          EVENT: z.object({ value: z.number() }),
        },
      },
      id: 'child',
      initial: 'active',
      states: {
        active: {
          on: {
            // EVENT: {
            //   actions: sendParent({ type: 'SUCCESS' }),
            //   guard: ({ event }) => event.value === 42
            // }
            EVENT: ({ event, parent }, enq) => {
              if (event.value === 42) {
                enq.sendTo(parent, { type: 'SUCCESS' })
              }
            },
          },
        },
      },
    })
    const parent = createMachine({
      // types: {} as {
      //   events:
      //     | {
      //         type: 'EVENT';
      //         value: number;
      //       }
      //     | {
      //         type: 'SUCCESS';
      //       };
      // },
      schemas: {
        events: {
          EVENT: z.object({ value: z.number() }),
          SUCCESS: z.object({}),
        },
      },
      id: 'parent',
      initial: 'first',
      states: {
        first: {
          invoke: { src: child, id: 'myChild' },
          on: {
            // EVENT: {
            //   actions: forwardTo('myChild')
            // },
            EVENT: ({ event, children }, enq) => {
              enq.sendTo(children['myChild'], event)
            },
            SUCCESS: () => {
              return { target: 'last' }
            },
          },
        },
        last: {
          type: 'final',
        },
      },
    })
    const service = createActor(parent)
    service.subscribe({ complete: () => resolve() })
    service.start()
    service.send({ type: 'EVENT', value: 42 })
    yield* Effect.promise(() => promise)
    yield* expect(service.getSnapshot().value).toEqual('last')
  })
  it('should forward an event to a service (dynamic)', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const child = createMachine({
      // types: {} as {
      //   events: {
      //     type: 'EVENT';
      //     value: number;
      //   };
      // },
      schemas: {
        events: {
          EVENT: z.object({ value: z.number() }),
        },
      },
      id: 'child',
      initial: 'active',
      states: {
        active: {
          on: {
            EVENT: ({ event, parent }, enq) => {
              if (event.value === 42) {
                enq.sendTo(parent, { type: 'SUCCESS' })
              }
            },
          },
        },
      },
    })
    const parent = createMachine({
      // types: {} as {
      //   context: { child?: AnyActorRef };
      //   events: { type: 'EVENT'; value: number } | { type: 'SUCCESS' };
      // },
      schemas: {
        context: z.object({
          child: z.any(),
        }),
        events: {
          EVENT: z.object({ value: z.number() }),
          SUCCESS: z.object({}),
        },
      },
      id: 'parent',
      initial: 'first',
      context: {
        child: undefined,
      },
      states: {
        first: {
          entry: (_, enq) => ({
            context: {
              child: enq.spawn(child, { id: 'x' }),
            },
          }),
          on: {
            // EVENT: {
            //   actions: forwardTo(({ context }) => context.child!)
            // },
            EVENT: ({ context, event }, enq) => {
              enq.sendTo(context.child, event)
            },
            SUCCESS: { target: 'last' },
          },
        },
        last: {
          type: 'final',
        },
      },
    })
    const service = createActor(parent)
    service.subscribe({ complete: () => resolve() })
    service.start()
    service.send({ type: 'EVENT', value: 42 })
    yield* Effect.promise(() => promise)
    yield* expect(service.getSnapshot().value).toEqual('last')
  })
  it.skip('should not cause an infinite loop when forwarding to undefined', function*({ expect }) {
    const machine = createMachine({
      on: {
        '*': ({ event }, enq) => {
          enq.sendTo(undefined, event)
        },
      },
    })
    const errorSpy = recorder()
    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy,
    })
    actorRef.start()
    actorRef.send({ type: 'TEST' })
    yield* expect(errorSpy.calls.map(([error]) => String(error))).toEqual([
      'Error: Attempted to forward event to undefined actor. This risks an infinite loop in the sender.',
    ])
  })
})
describe('log()', () => {
  it('should log a string', function*({ expect }) {
    const consoleSpy = recorder()
    const machine = createMachine({
      // entry: log('some string', 'string label')
      entry: (_, enq) => {
        enq.log('some string', 'string label')
      },
    })
    createActor(machine, { logger: consoleSpy }).start()
    yield* expect(consoleSpy.calls).toEqual([['some string', 'string label']])
  })
  it('should log an expression', function*({ expect }) {
    const consoleSpy = recorder()
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 42,
      },
      // entry: log(({ context }) => `expr ${context.count}`, 'expr label')
      entry: ({ context }, enq) => {
        enq.log(`expr ${context.count}`, 'expr label')
      },
    })
    createActor(machine, { logger: consoleSpy }).start()
    yield* expect(consoleSpy.calls).toEqual([['expr 42', 'expr label']])
  })
})
describe('enqueueActions', () => {
  it('should execute a simple referenced action', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      entry: (_, enq) => {
        enq(spy)
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should execute multiple different referenced actions', function*({ expect }) {
    const spy1 = recorder()
    const spy2 = recorder()
    const machine = createMachine({
      entry: (_, enq) => {
        enq(spy1)
        enq(spy2)
      },
    })
    createActor(machine).start()
    yield* expect({ spy1: spy1.calls, spy2: spy2.calls }).toEqual({
      spy1: [[]],
      spy2: [[]],
    })
  })
  it('should execute multiple same referenced actions', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      entry: (_, enq) => {
        enq(spy)
        enq(spy)
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[], []])
  })
  it('should execute a parameterized action', function*({ expect }) {
    const spy = recorderReturning((_: { answer: number }) => void 0)
    const machine = createMachine({
      entry: (_, enq) => {
        enq(spy, { answer: 42 })
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[{ answer: 42 }]])
  })
  it('should execute a function', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      entry: (_, enq) => enq(spy),
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should execute a builtin action using its own action creator', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      on: {
        FOO: (_, enq) => {
          enq.raise({ type: 'RAISED' })
        },
        // RAISED: {
        //   actions: spy
        // }
        RAISED: (_, enq) => enq(spy),
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FOO' })
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should execute a builtin action using its bound action creator', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      on: {
        FOO: (_, enq) => {
          enq.raise({ type: 'RAISED' })
        },
        // RAISED: {
        //   actions: spy
        // }
        RAISED: (_, enq) => enq(spy),
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'FOO' })
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should execute assigns when resolving the initial snapshot', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      entry: () => ({
        context: {
          count: 42,
        },
      }),
    })
    const snapshot = createActor(machine).getSnapshot()
    yield* expect(snapshot.context).toEqual({ count: 42 })
  })
  it('should be able to check a simple referenced guard', function*({ expect }) {
    const spy = recorderReturning(() => true)
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      entry: () => {
        if (spy()) {
        }
      },
    })
    createActor(machine)
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should be able to check a parameterized guard', function*({ expect }) {
    const spy = recorderReturning((_: { max: number }) => true)
    const machine = createMachine({
      schemas: {
        context: z.object({
          count: z.number(),
        }),
      },
      context: {
        count: 0,
      },
      entry: () => {
        if (spy({ max: 100 })) {
        }
      },
    })
    createActor(machine)
    yield* expect(spy.calls[0]).toEqual([{ max: 100 }])
  })
  it('should provide self', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let capturedSelf: unknown
    const machine = createMachine({
      entry: ({ self }) => {
        capturedSelf = self
        resolve()
      },
    })
    const actorRef = createActor(machine).start()
    yield* Effect.promise(() => promise)
    yield* expect(capturedSelf).toBe(actorRef)
  })
  it('should be able to communicate with the parent using params', function*({ expect }) {
    const childMachine = createMachine({
      schemas: {
        input: z.object({
          parent: z.any(),
        }),
        context: z.object({
          parent: z.any(),
        }),
        events: {
          foo: z.object({}),
        },
      },
      context: ({ input }) => ({ parent: input.parent }),
      // entry: {
      //   type: 'mySendParent',
      //   params: {
      //     type: 'FOO'
      //   }
      // }
      entry: ({ context }, enq) => {
        enq.sendTo(context.parent, { type: 'FOO' })
      },
    })
    const spy = recorder()
    const parentMachine =
      // setup({
      //   types: {} as { events: ParentEvent },
      //   actors: {
      //     child: childMachine
      //   }
      // }).
      createMachine({
        schemas: {
          events: {
            FOO: z.object({}),
          },
        },
        on: {
          FOO: (_, enq) => {
            enq(spy)
          },
        },
        invoke: {
          src: childMachine,
          input: ({ self }) => ({ parent: self }),
        },
      })
    createActor(parentMachine).start()
    yield* expect(spy.calls).toEqual([[]])
  })
  it('should enqueue.sendParent', function*({ expect }) {
    const childMachine = createMachine({
      entry: ({ parent }, enq) => {
        enq.sendTo(parent, { type: 'PARENT_EVENT' })
      },
    })
    const parentSpy = recorder()
    const parentMachine = createMachine({
      actors: {
        child: childMachine,
      },
      on: {
        // PARENT_EVENT: {
        //   actions: parentSpy
        // }
        PARENT_EVENT: (_, enq) => {
          enq(parentSpy)
        },
      },
      invoke: {
        src: ({ actors }) => actors.child,
      },
    })
    createActor(parentMachine).start()
    yield* expect(parentSpy.calls).toEqual([[]])
  })
})
describe('sendParent', () => {
  // https://github.com/statelyai/xstate/issues/711
  it('TS: should compile for any event', function*({ expect }) {
    const child = createMachine({
      schemas: {
        events: {
          CHILD: z.object({}),
        },
      },
      id: 'child',
      initial: 'start',
      states: {
        start: {
          entry: ({ parent }, enq) => {
            enq.sendTo(parent, { type: 'PARENT' })
          },
        },
      },
    })
    yield* expect(child.id).toEqual('child')
  })
})
describe('sendTo', () => {
  it('should send to an invoked child by its declared id', function*({ expect }) {
    const received = recorder()
    const childMachine = createMachine({
      schemas: {
        events: {
          PING: z.object({ value: z.number() }),
        },
      },
      on: {
        PING: ({ event }) => {
          received(event.value)
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        children: {
          worker: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        },
      },
      invoke: {
        id: 'worker',
        src: childMachine,
      },
      on: {
        SEND: (_, enq) => {
          enq.sendTo('worker', { type: 'PING', value: 42 })
        },
      },
    })

    const parent = createActor(parentMachine).start()
    parent.send({ type: 'SEND' })

    yield* expect(received.calls).toEqual([[42]])
  })

  it('should resolve a child spawned earlier in the same transition', function*({ expect }) {
    const received = recorder()
    const childMachine = createMachine({
      schemas: {
        events: {
          PING: z.object({}),
        },
      },
      on: {
        PING: () => {
          received()
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        children: {
          worker: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        },
      },
      on: {
        START: (_, enq) => {
          enq.spawn(childMachine, { id: 'worker' })
          enq.sendTo('worker', { type: 'PING' })
        },
      },
    })

    const parent = createActor(parentMachine).start()
    parent.send({ type: 'START' })

    yield* expect(received.calls).toEqual([[]])
  })

  it('should send to a child spawned with an empty-string id', function*({ expect }) {
    const received = recorder()
    const rejections: EventRejection[] = []
    const childMachine = createMachine({
      schemas: {
        events: {
          PING: z.object({}),
        },
      },
      on: {
        PING: () => {
          received()
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        children: {
          '': z.custom<ActorRefFromLogic<typeof childMachine>>(),
        },
      },
      on: {
        START: (_, enq) => {
          enq.spawn(childMachine, { id: '' })
        },
        SEND: (_, enq) => {
          enq.sendTo('', { type: 'PING' })
        },
      },
    })

    const parent = createActor(parentMachine, {
      onRejectedEvent: (r) => rejections.push(r),
    }).start()
    parent.send({ type: 'START' })
    parent.send({ type: 'SEND' })

    yield* expect({ received: received.calls, rejections }).toEqual({
      received: [[]],
      rejections: [],
    })
  })

  it('should dead-letter a send to an unknown declared child id', function*({ expect }) {
    const errorSpy = recorder()
    const rejections: EventRejection[] = []
    const childMachine = createMachine({
      schemas: {
        events: {
          PING: z.object({}),
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        children: {
          worker: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        },
      },
      initial: 'active',
      states: {
        active: {
          on: {
            SEND: (_, enq) => {
              enq.sendTo('worker', { type: 'PING' })
            },
          },
          onError: ({ event }) => {
            errorSpy(event.error)
            return { target: 'failed' }
          },
        },
        failed: {},
      },
    })

    const parent = createActor(parentMachine, {
      onRejectedEvent: (r) => rejections.push(r),
    }).start()
    parent.send({ type: 'SEND' })

    yield* expect({
      value: parent.getSnapshot().value,
      errorCalls: errorSpy.calls,
      rejections,
    }).toEqual({
      value: 'active',
      errorCalls: [],
      rejections: [
        expect.objectContaining({ reason: 'missingTarget', targetId: 'worker' }),
      ],
    })
  })

  it('should not resolve inherited properties as declared child ids', function*({ expect }) {
    const errorSpy = recorder()
    const rejections: EventRejection[] = []
    const childMachine = createMachine({
      schemas: {
        events: {
          PING: z.object({}),
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        children: {
          toString: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        },
      },
      initial: 'active',
      states: {
        active: {
          on: {
            SEND: (_, enq) => {
              enq.sendTo('toString', { type: 'PING' })
            },
          },
          onError: ({ event }) => {
            errorSpy(event.error)
            return { target: 'failed' }
          },
        },
        failed: {},
      },
    })

    const parent = createActor(parentMachine, {
      onRejectedEvent: (r) => rejections.push(r),
    }).start()
    parent.send({ type: 'SEND' })

    yield* expect({
      value: parent.getSnapshot().value,
      errorCalls: errorSpy.calls,
      rejections,
    }).toEqual({
      value: 'active',
      errorCalls: [],
      rejections: [
        expect.objectContaining({ reason: 'missingTarget', targetId: 'toString' }),
      ],
    })
  })

  it('should be able to send an event to an actor', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let delivered = false
    const childMachine = createMachine({
      schemas: {
        events: {
          EVENT: z.object({}),
        },
      },
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            // EVENT: {
            //   actions: () => resolve()
            // }
            EVENT: (_, enq) =>
              enq(() => {
                delivered = true
                resolve()
              }),
          },
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          child: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        child: spawn(childMachine),
      }),
      // entry: sendTo(({ context }) => context.child, { type: 'EVENT' })
      entry: ({ context }, enq) => {
        enq.sendTo(context.child, { type: 'EVENT' })
      },
    })
    createActor(parentMachine).start()
    yield* Effect.promise(() => promise)
    yield* expect({ delivered }).toEqual({ delivered: true })
  })
  it('should be able to send an event from expression to an actor', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let delivered = false
    const childMachine = createMachine({
      schemas: {
        events: {
          EVENT: z.object({ count: z.number() }),
        },
      },
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            // EVENT: {
            //   actions: () => resolve()
            // }
            EVENT: (_, enq) =>
              enq(() => {
                delivered = true
                resolve()
              }),
          },
        },
      },
    })
    const parentMachine = createMachine({
      schemas: {
        context: z.object({
          child: z.custom<ActorRefFromLogic<typeof childMachine>>(),
          count: z.number(),
        }),
      },
      context: ({ spawn }) => {
        return {
          child: spawn(childMachine, { id: 'child' }),
          count: 42,
        }
      },
      // entry: sendTo(
      //   ({ context }) => context.child,
      //   ({ context }) => ({ type: 'EVENT', count: context.count })
      // )
      entry: ({ context }, enq) => {
        enq.sendTo(context.child, { type: 'EVENT', count: context.count })
      },
    })
    createActor(parentMachine).start()
    yield* Effect.promise(() => promise)
    yield* expect({ delivered }).toEqual({ delivered: true })
  })
  it('should report a type error for an invalid event', function*({ expect }) {
    const childMachine = createMachine({
      // types: {} as {
      //   events: { type: 'EVENT' };
      // },
      schemas: {
        events: {
          EVENT: z.object({}),
        },
      },
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            EVENT: {},
          },
        },
      },
    })
    const parentMachine = createMachine({
      // types: {} as {
      //   context: {
      //     child: ActorRefFromLogic<typeof childMachine>;
      //   };
      // },
      schemas: {
        context: z.object({
          child: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        child: spawn(childMachine),
      }),
      // entry: sendTo(({ context }) => context.child, {
      //   // @ts-expect-error
      //   type: 'UNKNOWN'
      // })
      entry: ({ context }, enq) => {
        enq.sendTo(context.child, {
          // @ts-expect-error
          type: 'UNKNOWN',
        })
      },
    })
    yield* expect(parentMachine.id).toEqual('(machine)')
  })
  it('should be able to send an event to a named actor', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let delivered = false
    const childMachine = createMachine({
      // types: {} as {
      //   events: { type: 'EVENT' };
      // },
      schemas: {
        events: {
          EVENT: z.object({}),
        },
      },
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            // EVENT: {
            //   actions: () => resolve()
            // }
            EVENT: (_, enq) =>
              enq(() => {
                delivered = true
                resolve()
              }),
          },
        },
      },
    })
    const parentMachine = createMachine({
      // types: {} as {
      //   context: { child: ActorRefFromLogic<typeof childMachine> };
      // },
      schemas: {
        context: z.object({
          child: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        child: spawn(childMachine, { id: 'child' }),
      }),
      // No type-safety for the event yet
      // entry: sendTo('child', { type: 'EVENT' })
      entry: ({ context }, enq) => {
        enq.sendTo(context.child, { type: 'EVENT' })
      },
    })
    createActor(parentMachine).start()
    yield* Effect.promise(() => promise)
    yield* expect({ delivered }).toEqual({ delivered: true })
  })
  it('should be able to send an event directly to an ActorRef', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    let delivered = false
    const childMachine = createMachine({
      // types: {} as {
      //   events: { type: 'EVENT' };
      // },
      schemas: {
        events: {
          EVENT: z.object({}),
        },
      },
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            // EVENT: {
            //   actions: () => resolve()
            // }
            EVENT: (_, enq) =>
              enq(() => {
                delivered = true
                resolve()
              }),
          },
        },
      },
    })
    const parentMachine = createMachine({
      // types: {} as {
      //   context: { child: ActorRefFromLogic<typeof childMachine> };
      // },
      schemas: {
        context: z.object({
          child: z.custom<ActorRefFromLogic<typeof childMachine>>(),
        }),
      },
      context: ({ spawn }) => ({
        child: spawn(childMachine),
      }),
      // entry: sendTo(({ context }) => context.child, { type: 'EVENT' })
      entry: ({ context }, enq) => {
        enq.sendTo(context.child, { type: 'EVENT' })
      },
    })
    createActor(parentMachine).start()
    yield* Effect.promise(() => promise)
    yield* expect({ delivered }).toEqual({ delivered: true })
  })
  it('should be able to read from event', function*({ expect }) {
    let receivedEvent: unknown
    const machine = createMachine({
      // types: {} as {
      //   context: Record<string, CallbackActorRef<EventObject>>;
      //   events: { type: 'EVENT'; value: string };
      // },
      schemas: {
        context: z.record(
          z.custom<ActorRefFromLogic<CallbackActorLogic<any, any, any>>>(),
        ),
        events: {
          EVENT: z.object({ value: z.string() }),
        },
      },
      initial: 'a',
      context: ({ spawn }) => ({
        foo: spawn(
          createCallbackLogic(({ receive }) => {
            receive((event) => {
              receivedEvent = event
            })
          }),
        ),
      }),
      states: {
        a: {
          on: {
            // EVENT: {
            //   actions: sendTo(({ context, event }) => context[event.value], {
            //     type: 'EVENT'
            //   })
            // }
            EVENT: ({ context, event }, enq) => {
              enq.sendTo(context[event.value], { type: 'EVENT' })
            },
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'EVENT', value: 'foo' })
    yield* expect(receivedEvent).toEqual({ type: 'EVENT' })
  })
  it('should error if given a string', function*({ expect }) {
    const machine = createMachine({
      invoke: {
        id: 'child',
        src: createCallbackLogic(() => {}),
      },
      // entry: sendTo('child', 'a string')
      entry: ({ children }, enq) => {
        enq.sendTo(children['child'], 'a string' as any)
      },
    })
    const errorSpy = recorder()
    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy,
    })
    actorRef.start()
    yield* expect(errorSpy.calls.map(([error]) => String(error))).toEqual([
      'Error: Only event objects may be used with sendTo; use sendTo({ type: "a string" }) instead',
    ])
  })
  it(
    'a self-event "handler" of an event sent using sendTo should be able to read updated snapshot of self',
    function*({ expect }) {
      const spy = recorder()
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
            on: { NEXT: { target: 'b' } },
          },
          b: {
            entry: ({ self }, enq) => {
              enq.sendTo(self, { type: 'EVENT' })
              return {
                context: { counter: 1 },
              }
            },
            on: {
              // EVENT: {
              //   actions: ({ self }) => spy(self.getSnapshot().context),
              //   target: 'c'
              // }
              EVENT: ({ self }, enq) => {
                enq(spy, self.getSnapshot().context)
                return {
                  target: 'c',
                }
              },
            },
          },
          c: {},
        },
      })
      const actorRef = createActor(machine).start()
      actorRef.send({ type: 'NEXT' })
      actorRef.send({ type: 'EVENT' })
      yield* expect(spy.calls).toEqual([[{ counter: 1 }]])
    },
  )
  it(
    "should not attempt to deliver a delayed event to the spawned actor's ID that was stopped since the event was scheduled",
    function*({ expect }) {
      const rejections: EventRejection[] = []
      const spy1 = recorder()
      let stoppedChildSessionId: string | undefined
      const child1 = createMachine({
        on: {
          // PING: {
          //   actions: spy1
          // }
          PING: (_, enq) => enq(spy1),
        },
      })
      const spy2 = recorder()
      const child2 = createMachine({
        on: {
          // PING: {
          //   actions: spy2
          // }
          PING: (_, enq) => enq(spy2),
        },
      })
      const machine = createMachine({
        initial: 'a',
        actors: {
          child1,
          child2,
        },
        states: {
          a: {
            on: {
              START: { target: 'b' },
            },
          },
          b: {
            // entry: [
            //   spawnChild('child1', {
            //     id: 'myChild'
            //   }),
            //   sendTo('myChild', { type: 'PING' }, { delay: 1 }),
            //   stopChild('myChild'),
            //   spawnChild('child2', {
            //     id: 'myChild'
            //   })
            // ]
            entry: ({ actors }, enq) => {
              const child1 = enq.spawn(actors.child1, {
                id: 'myChild',
              })
              stoppedChildSessionId = child1.sessionId
              enq.sendTo(child1, { type: 'PING' }, { delay: 1 })
              enq.stop(child1)
              enq.spawn(actors.child2, {
                id: 'myChild',
              })
            },
          },
        },
      })
      const actorRef = createActor(machine, { onRejectedEvent: (r) => rejections.push(r) }).start()
      actorRef.send({ type: 'START' })
      yield* Effect.promise(() => sleep(10))
      yield* expect({
        spy1: spy1.calls,
        spy2: spy2.calls,
        rejections: rejections.map(({ reason, targetId, event }) => ({ reason, targetId, event })),
      }).toEqual({
        spy1: [],
        spy2: [],
        rejections: [{ reason: 'stopped', targetId: 'myChild', event: { type: 'PING' } }],
      })
    },
  )
  // TODO: need to fix stale value problem
  it.skip(
    "should not attempt to deliver a delayed event to the invoked actor's ID that was stopped since the event was scheduled",
    function*({ expect }) {
      const rejections: EventRejection[] = []
      const spy1 = recorder()
      const child1 = createMachine({
        on: {
          // PING: {
          //   actions: spy1
          // }
          PING: (_, enq) => enq(spy1),
        },
      })
      const spy2 = recorder()
      const child2 = createMachine({
        on: {
          // PING: {
          //   actions: spy2
          // }
          PING: (_, enq) => enq(spy2),
        },
      })
      const machine = createMachine({
        actors: {
          child1,
          child2,
        },
        initial: 'a',
        states: {
          a: {
            on: {
              START: { target: 'b' },
            },
          },
          b: {
            // entry: sendTo('myChild', { type: 'PING' }, { delay: 1 }),
            entry: ({ children }, enq) => {
              // TODO: stale closure?
              enq.sendTo(children['myChild'], { type: 'PING' }, { delay: 1 })
            },
            invoke: {
              src: ({ actors }) => actors.child1,
              id: 'myChild',
            },
            on: {
              NEXT: { target: 'c' },
            },
          },
          c: {
            invoke: {
              src: ({ actors }) => actors.child2,
              id: 'myChild',
            },
          },
        },
      })
      const actorRef = createActor(machine, { onRejectedEvent: (r) => rejections.push(r) }).start()
      actorRef.send({ type: 'START' })
      actorRef.send({ type: 'NEXT' })
      yield* Effect.promise(() => sleep(10))
      yield* expect({
        spy1: spy1.calls,
        spy2: spy2.calls,
        rejections: rejections.map(({ reason, targetId, event }) => ({ reason, targetId, event })),
      }).toEqual({
        spy1: [],
        spy2: [],
        rejections: [{ reason: 'stopped', targetId: 'myChild', event: { type: 'PING' } }],
      })
    },
  )
})
describe('raise', () => {
  it('should be able to send a delayed event to itself', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          // entry: raise(
          //   { type: 'EVENT' },
          //   {
          //     delay: 1
          //   }
          // ),
          entry: (_, enq) => {
            enq.raise({ type: 'EVENT' }, { delay: 1 })
          },
          on: {
            TO_B: { target: 'b' },
          },
        },
        b: {
          on: {
            EVENT: { target: 'c' },
          },
        },
        c: {
          type: 'final',
        },
      },
    })
    const service = createActor(machine).start()
    service.subscribe({ complete: () => resolve() })
    // Ensures that the delayed self-event is sent when in the `b` state
    service.send({ type: 'TO_B' })
    yield* Effect.promise(() => promise)
    yield* expect(service.getSnapshot().value).toEqual('c')
  })
  it('should be able to send a delayed event to itself with delay = 0', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          // entry: raise(
          //   { type: 'EVENT' },
          //   {
          //     delay: 0
          //   }
          // ),
          entry: (_, enq) => {
            enq.raise({ type: 'EVENT' }, { delay: 0 })
          },
          on: {
            EVENT: { target: 'b' },
          },
        },
        b: {},
      },
    })
    const service = createActor(machine).start()
    // The state should not be changed yet; `delay: 0` is equivalent to `setTimeout(..., 0)`
    yield* expect(service.getSnapshot().value).toEqual('a')
    yield* Effect.promise(() => sleep(0))
    // The state should be changed now
    yield* expect(service.getSnapshot().value).toEqual('b')
  })
  it('should be able to raise an event and respond to it in the same state', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          // entry: raise({ type: 'TO_B' }),
          entry: (_, enq) => {
            enq.raise({ type: 'TO_B' })
          },
          on: {
            TO_B: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })
    const service = createActor(machine).start()
    yield* expect(service.getSnapshot().value).toEqual('b')
  })
  it('should be able to raise a delayed event and respond to it in the same state', function*({ expect }) {
    const { resolve, promise } = Promise.withResolvers<void>()
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          // entry: raise(
          //   { type: 'TO_B' },
          //   {
          //     delay: 100
          //   }
          // ),
          entry: (_, enq) => {
            enq.raise({ type: 'TO_B' }, { delay: 100 })
          },
          on: {
            TO_B: { target: 'b' },
          },
        },
        b: {
          type: 'final',
        },
      },
    })
    const service = createActor(machine).start()
    service.subscribe({ complete: () => resolve() })
    yield* Effect.promise(() => sleep(50))
    // didn't transition yet
    yield* expect(service.getSnapshot().value).toEqual('a')
    yield* Effect.promise(() => promise)
    yield* expect(service.getSnapshot().value).toEqual('b')
  })
  it('should accept event expression', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            // NEXT: {
            //   actions: raise(() => ({ type: 'RAISED' }))
            // },
            NEXT: (_, enq) => {
              enq.raise({ type: 'RAISED' })
            },
            RAISED: { target: 'b' },
          },
        },
        b: {},
      },
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    yield* expect(actor.getSnapshot().value).toBe('b')
  })
  it('should be possible to access context in the event expression', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          eventType: z.enum(['RAISED', 'NEXT']),
        }),
        events: {
          RAISED: z.object({}),
          NEXT: z.object({}),
        },
      },
      initial: 'a',
      context: {
        eventType: 'RAISED',
      },
      states: {
        a: {
          on: {
            // NEXT: {
            //   actions: raise(({ context }) => ({
            //     type: context.eventType
            //   }))
            // },
            NEXT: ({ context }, enq) => {
              enq.raise({
                type: context.eventType,
              })
            },
            RAISED: { target: 'b' },
          },
        },
        b: {},
      },
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    yield* expect(actor.getSnapshot().value).toBe('b')
  })
  it('should error if given a string', function*({ expect }) {
    const machine = createMachine({
      // entry: raise(
      //   // @ts-ignore
      //   'a string'
      // )
      entry: (_, enq) => {
        enq.raise(
          // @ts-expect-error
          'a string',
        )
      },
    })
    const errorSpy = recorder()
    const actorRef = createActor(machine)
    actorRef.subscribe({
      error: errorSpy,
    })
    actorRef.start()
    yield* expect(errorSpy.calls.map(([error]) => String(error))).toEqual([
      'Error: Only event objects may be used with raise; use raise({ type: "a string" }) instead',
    ])
  })
})
describe('cancel', () => {
  it('should be possible to cancel a raised delayed event', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: {
        a: {
          on: {
            // NEXT: {
            //   actions: raise({ type: 'RAISED' }, { delay: 1, id: 'myId' })
            // },
            NEXT: (_, enq) => {
              enq.raise({ type: 'RAISED' }, { delay: 1, id: 'myId' })
            },
            RAISED: { target: 'b' },
            // CANCEL: {
            //   actions: cancel('myId')
            // }
            CANCEL: (_, enq) => {
              enq.cancel('myId')
            },
          },
        },
        b: {},
      },
    })
    const actor = createActor(machine).start()
    // This should raise the 'RAISED' event after 1ms
    actor.send({ type: 'NEXT' })
    // This should cancel the 'RAISED' event
    actor.send({ type: 'CANCEL' })
    yield* Effect.promise(() => sleep(10))
    yield* expect(actor.getSnapshot().value).toBe('a')
  })
  it(
    'should cancel only the delayed event in the machine that scheduled it when canceling the event with the same ID in the machine that sent it first',
    function*({ expect }) {
      const fooSpy = recorder()
      const barSpy = recorder()
      const machine = createMachine({
        invoke: [
          {
            id: 'foo',
            src: createMachine({
              id: 'foo',
              // entry: raise({ type: 'event' }, { id: 'sameId', delay: 100 }),
              entry: (_, enq) => {
                enq.raise({ type: 'event' }, { id: 'sameId', delay: 100 })
              },
              on: {
                // event: { actions: fooSpy },
                event: (_, enq) => enq(fooSpy),
                // cancel: { actions: cancel('sameId') }
                cancel: (_, enq) => enq.cancel('sameId'),
              },
            }),
          },
          {
            id: 'bar',
            src: createMachine({
              id: 'bar',
              // entry: raise({ type: 'event' }, { id: 'sameId', delay: 100 }),
              entry: (_, enq) => {
                enq.raise({ type: 'event' }, { id: 'sameId', delay: 100 })
              },
              on: {
                // event: { actions: barSpy }
                event: (_, enq) => enq(barSpy),
                // cancel: { actions: cancel('sameId') }
                cancel: (_, enq) => enq.cancel('sameId'),
              },
            }),
          },
        ],
        on: {
          cancelFoo: ({ children }, enq) => enq.sendTo(children['foo'], { type: 'cancel' }),
        },
      })
      const actor = createActor(machine).start()
      yield* Effect.promise(() => sleep(50))
      // This will cause the foo actor to cancel its 'sameId' delayed event
      // This should NOT cancel the 'sameId' delayed event in the other actor
      actor.send({ type: 'cancelFoo' })
      yield* Effect.promise(() => sleep(55))
      yield* expect({ foo: fooSpy.calls, bar: barSpy.calls }).toEqual({
        foo: [],
        bar: [[]],
      })
    },
  )
  it(
    'should cancel only the delayed event in the machine that scheduled it when canceling the event with the same ID in the machine that sent it second',
    function*({ expect }) {
      const fooSpy = recorder()
      const barSpy = recorder()
      const machine = createMachine({
        invoke: [
          {
            id: 'foo',
            src: createMachine({
              id: 'foo',
              // entry: raise({ type: 'event' }, { id: 'sameId', delay: 100 }),
              entry: (_, enq) => {
                enq.raise({ type: 'event' }, { id: 'sameId', delay: 100 })
              },
              on: {
                // event: { actions: fooSpy }
                event: (_, enq) => enq(fooSpy),
              },
            }),
          },
          {
            id: 'bar',
            src: createMachine({
              id: 'bar',
              // entry: raise({ type: 'event' }, { id: 'sameId', delay: 100 }),
              entry: (_, enq) => {
                enq.raise({ type: 'event' }, { id: 'sameId', delay: 100 })
              },
              on: {
                // event: { actions: barSpy }
                event: (_, enq) => enq(barSpy),
                // cancel: { actions: cancel('sameId') }
                cancel: (_, enq) => {
                  enq.cancel('sameId')
                },
              },
            }),
          },
        ],
        on: {
          // cancelBar: {
          //   actions: sendTo('bar', { type: 'cancel' })
          // }
          cancelBar: ({ children }, enq) => {
            enq.sendTo(children['bar'], { type: 'cancel' })
          },
        },
      })
      const actor = createActor(machine).start()
      yield* Effect.promise(() => sleep(50))
      // This will cause the bar actor to cancel its 'sameId' delayed event
      // This should NOT cancel the 'sameId' delayed event in the other actor
      actor.send({ type: 'cancelBar' })
      yield* Effect.promise(() => sleep(55))
      yield* expect({ foo: fooSpy.calls, bar: barSpy.calls }).toEqual({
        foo: [[]],
        bar: [],
      })
    },
  )
  it('should not try to clear an undefined timeout when canceling an unscheduled timer', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      on: {
        // FOO: {
        //   actions: cancel('foo')
        // }
        FOO: (_, enq) => {
          enq.cancel('foo')
        },
      },
    })
    const actorRef = createActor(machine, {
      clock: {
        setTimeout,
        clearTimeout: spy,
      },
    }).start()
    actorRef.send({
      type: 'FOO',
    })
    yield* expect(spy.calls.length).toBe(0)
  })
  it('should be able to cancel a just scheduled delayed event to a just invoked child', function*({ expect }) {
    const spy = recorder()
    const child = createMachine({
      on: {
        // PING: {
        //   actions: spy
        // }
        PING: (_, enq) => enq(spy),
      },
    })
    const machine = createMachine({
      actors: {
        child,
      },
      initial: 'a',
      states: {
        a: {
          on: {
            START: { target: 'b' },
          },
        },
        b: {
          // entry: [
          //   sendTo('myChild', { type: 'PING' }, { id: 'myEvent', delay: 0 }),
          //   cancel('myEvent')
          // ],
          entry: ({ children }, enq) => {
            enq.sendTo(
              children['myChild'],
              { type: 'PING' },
              { id: 'myEvent', delay: 0 },
            )
            enq.cancel('myEvent')
          },
          invoke: {
            src: ({ actors }) => actors.child,
            id: 'myChild',
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({
      type: 'START',
    })
    yield* Effect.promise(() => sleep(10))
    yield* expect(spy.calls.length).toBe(0)
  })
  it('should not be able to cancel a just scheduled non-delayed event to a just invoked child', function*({ expect }) {
    const spy = recorder()
    const child = createMachine({
      on: {
        // PING: {
        //   actions: spy
        // }
        PING: (_, enq) => enq(spy),
      },
    })
    const machine = createMachine({
      initial: 'a',
      actors: {
        child,
      },
      states: {
        a: {
          on: {
            START: { target: 'b' },
          },
        },
        b: {
          // entry: [
          //   sendTo('myChild', { type: 'PING' }, { id: 'myEvent' }),
          //   cancel('myEvent')
          // ],
          entry: ({ children }, enq) => {
            enq.sendTo(children['myChild'], { type: 'PING' }, { id: 'myEvent' })
            enq.cancel('myEvent')
          },
          invoke: {
            src: ({ actors }) => actors.child,
            id: 'myChild',
          },
        },
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({
      type: 'START',
    })
    yield* expect(spy.calls.length).toBe(1)
  })
})
describe('action meta', () => {
  it('should provide self', function*({ expect }) {
    const { promise, resolve } = Promise.withResolvers<void>()
    let capturedSelf: unknown
    const machine = createMachine({
      entry: ({ self }) => {
        capturedSelf = self
        resolve()
      },
    })
    const actorRef = createActor(machine).start()
    yield* Effect.promise(() => promise)
    yield* expect(capturedSelf).toBe(actorRef)
  })
})
describe('actions', () => {
  it('should call transition actions in document order for same-level parallel regions', function*({ expect }) {
    const actual: string[] = []
    const machine = createMachine({
      type: 'parallel',
      states: {
        a: {
          on: {
            // FOO: {
            //   actions: () => actual.push('a')
            // }
            FOO: (_, enq) => {
              enq(() => actual.push('a'))
            },
          },
        },
        b: {
          on: {
            // FOO: {
            //   actions: () => actual.push('b')
            // }
            FOO: (_, enq) => {
              enq(() => actual.push('b'))
            },
          },
        },
      },
    })
    const service = createActor(machine).start()
    service.send({ type: 'FOO' })
    yield* expect(actual).toEqual(['a', 'b'])
  })
  it(
    'should call transition actions in document order for states at different levels of parallel regions',
    function*({ expect }) {
      const actual: string[] = []
      const machine = createMachine({
        type: 'parallel',
        states: {
          a: {
            initial: 'a1',
            states: {
              a1: {
                on: {
                  // FOO: {
                  //   actions: () => actual.push('a1')
                  // }
                  FOO: (_, enq) => {
                    enq(() => actual.push('a1'))
                  },
                },
              },
            },
          },
          b: {
            on: {
              // FOO: {
              //   actions: () => actual.push('b')
              // }
              FOO: (_, enq) => {
                enq(() => actual.push('b'))
              },
            },
          },
        },
      })
      const service = createActor(machine).start()
      service.send({ type: 'FOO' })
      yield* expect(actual).toEqual(['a1', 'b'])
    },
  )
  it('should call an inline action responding to an initial raise with the raised event', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      // entry: raise({ type: 'HELLO' }),
      entry: (_, enq) => {
        enq.raise({ type: 'HELLO' })
      },
      on: {
        // HELLO: {
        //   actions: ({ event }) => {
        //     spy(event);
        //   }
        // }
        HELLO: ({ event }, enq) => {
          enq(spy, event)
        },
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[{ type: 'HELLO' }]])
  })
  it('should call a referenced action responding to an initial raise with the raised event', function*({ expect }) {
    const spy = recorder()
    const machine = createMachine({
      // entry: raise({ type: 'HELLO' }),
      entry: (_, enq) => {
        enq.raise({ type: 'HELLO' })
      },
      on: {
        HELLO: ({ actions, event }, enq) => {
          const action = actions['foo']
          if (action === undefined) {
            throw new Error('expected the foo action to be registered')
          }
          enq(action, event)
        },
      },
      actions: {
        foo: (event) => {
          spy(event)
        },
      },
    })
    createActor(machine).start()
    yield* expect(spy.calls).toEqual([[{ type: 'HELLO' }]])
  })
  it(
    'should call an inline action responding to an initial raise with updated (non-initial) context',
    function*({ expect }) {
      const spy = recorder()
      const machine = createMachine({
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        context: { count: 0 },
        entry: (_, enq) => {
          enq.raise({ type: 'HELLO' })
          return {
            context: { count: 42 },
          }
        },
        on: {
          // HELLO: {
          //   actions: ({ context }) => {
          //     spy(context);
          //   }
          // }
          HELLO: (_, enq) => {
            enq(spy, { count: 42 })
          },
        },
      })
      createActor(machine).start()
      yield* expect(spy.calls).toEqual([[{ count: 42 }]])
    },
  )
  it(
    'should call a referenced action responding to an initial raise with updated (non-initial) context',
    function*({ expect }) {
      const spy = recorder()
      const machine = createMachine({
        schemas: {
          context: z.object({
            count: z.number(),
          }),
        },
        context: { count: 0 },
        entry: (_, enq) => {
          enq.raise({ type: 'HELLO' })
          return {
            context: { count: 42 },
          }
        },
        on: {
          // HELLO: {
          //   actions: 'foo'
          // }
          HELLO: ({ context }, enq) => {
            enq(spy, context)
          },
        },
      })
      createActor(machine).start()
      yield* expect(spy.calls).toEqual([[{ count: 42 }]])
    },
  )
  it('should call inline transition custom action with undefined parametrized action object', function*({ expect }) {
    const spy = recorder()
    const actorRef = createActor(
      createMachine({
        on: {
          // FOO: {
          //   actions: (_, params) => {
          //     spy(params);
          //   }
          // }
          FOO: (_, enq) => {
            enq(spy)
          },
        },
      }),
    ).start()
    actorRef.send({ type: 'FOO' })
    // expect not to have any args
    yield* expect(spy.calls).toEqual([[]])
  })
  it(
    'should call a referenced custom action with undefined params when it has no params and it is referenced using a string',
    function*({ expect }) {
      const spy = recorder()
      createActor(
        createMachine({
          actions: {
            myAction: (params?: unknown) => {
              spy(params)
            },
          },
          entry: ({ actions }) => {
            actions.myAction()
          },
        }),
      ).start()
      yield* expect(spy.calls).toEqual([[undefined]])
    },
  )
  it('should call a referenced custom action with the provided parametrized action object', function*({ expect }) {
    const spy = recorder()
    createActor(
      createMachine({
        actions: {
          myAction: (params) => {
            spy(params)
          },
        },
        entry: ({ actions }) => {
          actions.myAction({ foo: 'bar' })
        },
      }),
    ).start()
    yield* expect(spy.calls).toEqual([[{ foo: 'bar' }]])
  })
  // From https://github.com/statelyai/xstate/pull/5101
  it('a raised event "handler" should be able to read updated snapshot of self', function*({ expect }) {
    const spy = recorder()
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
          on: { NEXT: { target: 'b' } },
        },
        b: {
          // entry: [assign({ counter: 1 }), raise({ type: 'EVENT' })],
          entry: (_, enq) => {
            enq.raise({ type: 'EVENT' })
            return {
              context: {
                counter: 1,
              },
            }
          },
          on: {
            EVENT: ({ self }, enq) => {
              enq(spy, self.getSnapshot().context)
              return {
                target: 'c',
              }
            },
          },
        },
        c: {},
      },
    })
    const actorRef = createActor(machine).start()
    actorRef.send({ type: 'NEXT' })
    actorRef.send({ type: 'EVENT' })
    yield* expect(spy.calls).toEqual([[{ counter: 1 }]])
  })
})
