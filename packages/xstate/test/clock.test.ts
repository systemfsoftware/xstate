import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine, SimulatedClock } from '../src/index.js'

const messageWhenCalled = (call: () => unknown): string => {
  try {
    call()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw')
}

describe('clock', () => {
  it('runs callbacks at their deadlines and includes newly scheduled intermediate timers', function*({ expect }) {
    const clock = new SimulatedClock()
    const times: number[] = []
    clock.setTimeout(() => {
      times.push(clock.now())
      clock.setTimeout(() => times.push(clock.now()), 1000)
    }, 2000)
    clock.setTimeout(() => times.push(clock.now()), 6000)
    clock.set(6000)

    yield* expect({ times, now: clock.now() }).toEqual({
      times: [2000, 3000, 6000],
      now: 6000,
    })
  })

  it('reconsiders cancellation and equal-deadline ordering after each callback', function*({ expect }) {
    const clock = new SimulatedClock()
    const trace: string[] = []
    clock.setTimeout(() => {
      trace.push('first')
      clock.clearTimeout(late)
      clock.setTimeout(() => trace.push('new'), 0)
    }, 2000)
    clock.setTimeout(() => trace.push('second'), 2000)
    const late = clock.setTimeout(() => trace.push('canceled'), 6000)
    clock.increment(6000)

    yield* expect({
      trace,
      backInTime: messageWhenCalled(() => clock.increment(-1)),
      nonFinite: messageWhenCalled(() => clock.set(NaN)),
    }).toEqual({
      trace: ['first', 'second', 'new'],
      backInTime: 'Clock time must be finite; unable to travel back in time',
      nonFinite: 'Clock time must be finite; unable to travel back in time',
    })
  })

  it(
    'orders large mixed batches while removing cancelled entries and inserting callback timers',
    function*({ expect }) {
      const clock = new SimulatedClock()
      const trace: { index: number; time: number }[] = []
      const ids: number[] = []
      const records = Array.from({ length: 1000 }, (_, index) => ({
        index,
        time: (index * 7919) % 200,
      }))
      clock.setTimeout(() => {
        const first = ids[555]
        const second = ids[556]
        if (first === undefined || second === undefined) {
          throw new Error('expected scheduled timer ids')
        }
        clock.clearTimeout(first)
        clock.clearTimeout(second)
        clock.setTimeout(() => trace.push({ index: 1000, time: clock.now() }), 0)
      }, 0)
      for (const record of records) {
        ids.push(
          clock.setTimeout(
            () => trace.push({ index: record.index, time: clock.now() }),
            record.time,
          ),
        )
      }
      for (let index = 0; index < ids.length; index += 7) {
        const id = ids[index]
        if (id === undefined) throw new Error('expected a scheduled timer id')
        clock.clearTimeout(id)
      }
      clock.set(200)
      const expected = [
        ...records.filter(
          ({ index }) => index % 7 !== 0 && index !== 555 && index !== 556,
        ),
        { index: 1000, time: 0 },
      ].sort((a, b) => a.time - b.time || a.index - b.index)

      yield* expect({ trace, now: clock.now() }).toEqual({ trace: expected, now: 200 })
    },
  )

  it('uses the injected clock time for scheduled timer metadata', function*({ expect }) {
    const clock = new SimulatedClock()
    clock.set(1_000)
    const actor = createActor(
      createMachine({
        initial: 'waiting',
        states: {
          waiting: { after: { 100: { target: 'done' } } },
          done: {},
        },
      }),
      { clock },
    ).start()

    yield* expect(
      Object.values(actor.system.getSnapshot()._scheduledTimers)[0],
    ).toMatchObject({ scheduledAt: 1_000, dueAt: 1_100 })
  })

  it('uses the injected clock time when restoring scheduled timers', function*({ expect }) {
    const clock = new SimulatedClock()
    clock.set(1_000)
    const scheduled: Array<[string, number]> = []
    const actor = createActor(createMachine({}), {
      clock: {
        now: () => clock.now(),
        setTimeout: (fn, timeout) => {
          scheduled.push([typeof fn, timeout])
          return clock.setTimeout(fn, timeout)
        },
        clearTimeout: (id) => clock.clearTimeout(id),
      },
    })

    actor.system._snapshot._scheduledTimers = {
      restored: {
        source: actor,
        id: 'restored',
        delay: 100,
        scheduledAt: 950,
        dueAt: 1_050,
      },
    } as any

    actor.start()

    yield* expect(scheduled).toEqual([['function', 50]])
  })

  it('system clock should be default clock for actors (invoked from machine)', function*({ expect }) {
    const clock = new SimulatedClock()

    const machine = createMachine({
      invoke: {
        id: 'child',
        src: createMachine({
          initial: 'a',
          states: {
            a: {
              after: {
                10_000: { target: 'b' },
              },
            },
            b: {},
          },
        }),
      },
    })

    const actor = createActor(machine, {
      clock,
    }).start()

    const childBefore = actor.getSnapshot().children['child']
    if (childBefore === undefined) throw new Error('expected a child actor')
    const valueBefore = childBefore.getSnapshot().value

    clock.increment(10_000)

    const childAfter = actor.getSnapshot().children['child']
    if (childAfter === undefined) throw new Error('expected a child actor')
    const valueAfter = childAfter.getSnapshot().value

    yield* expect({ valueBefore, valueAfter }).toEqual({ valueBefore: 'a', valueAfter: 'b' })
  })
})

it('continues flushing future timers after a callback throws', function*({ expect }) {
  const clock = new SimulatedClock()
  const firedArgs: Array<Array<unknown>> = []
  const fired = (...args: Array<unknown>) => {
    firedArgs.push(args)
  }
  clock.setTimeout(() => {
    throw new Error('timer failed')
  }, 0)
  const thrown = messageWhenCalled(() => clock.increment(1))
  clock.setTimeout(fired, 0)
  clock.increment(1)

  yield* expect({ thrown, firedArgs }).toEqual({
    thrown: 'timer failed',
    firedArgs: [[]],
  })
})
