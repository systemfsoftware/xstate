import { describe, it } from '@systemfsoftware/vitest'
import { createMachine } from '../src/index.js'
import { createInertActorScope } from '../src/inertActorScope.js'

describe('machine.microstep()', () => {
  it('should return an array of states from all microsteps', function*({ expect }) {
    const machine = createMachine({
      initial: 'start',
      states: {
        start: {
          on: {
            GO: { target: 'a' },
          },
        },
        a: {
          entry: (_, enq) => {
            enq.raise({ type: 'NEXT' })
          },
          on: {
            NEXT: { target: 'b' },
          },
        },
        b: {
          always: { target: 'c' },
        },
        c: {
          entry: (_, enq) => {
            enq.raise({ type: 'NEXT' })
          },
          on: {
            NEXT: { target: 'd' },
          },
        },
        d: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.getInitialSnapshot(actorScope),
      { type: 'GO' },
      actorScope,
    )

    yield* expect(states.map((s) => s.value)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('should return the states from microstep (transient)', function*({ expect }) {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            TRIGGER: { target: 'second' },
          },
        },
        second: {
          always: { target: 'third' },
        },
        third: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.resolveState({ value: 'first' }),
      { type: 'TRIGGER' },
      actorScope,
    )

    yield* expect(states.map((s) => s.value)).toEqual(['second', 'third'])
  })

  it('should return the states from microstep (raised event)', function*({ expect }) {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            TRIGGER: (_, enq) => {
              enq.raise({ type: 'RAISED' })
              return { target: 'second' }
            },
          },
        },
        second: {
          on: {
            RAISED: { target: 'third' },
          },
        },
        third: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.resolveState({ value: 'first' }),
      { type: 'TRIGGER' },
      actorScope,
    )

    yield* expect(states.map((s) => s.value)).toEqual(['second', 'third'])
  })

  it('should return a single-item array for normal transitions', function*({ expect }) {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            TRIGGER: { target: 'second' },
          },
        },
        second: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.getInitialSnapshot(actorScope),
      { type: 'TRIGGER' },
      actorScope,
    )

    yield* expect(states.map((s) => s.value)).toEqual(['second'])
  })

  it('each state should preserve their internal queue', function*({ expect }) {
    const machine = createMachine({
      initial: 'first',
      states: {
        first: {
          on: {
            TRIGGER: (_, enq) => {
              enq.raise({ type: 'FOO' })
              enq.raise({ type: 'BAR' })
              return { target: 'second' }
            },
          },
        },
        second: {
          on: {
            FOO: {
              target: 'third',
            },
          },
        },
        third: {
          on: {
            BAR: {
              target: 'fourth',
            },
          },
        },
        fourth: {
          always: { target: 'fifth' },
        },
        fifth: {},
      },
    })

    const actorScope = createInertActorScope(machine)
    const states = machine.microstep(
      machine.getInitialSnapshot(actorScope),
      { type: 'TRIGGER' },
      actorScope,
    )

    yield* expect(states.map((s) => s.value)).toEqual([
      'second',
      'third',
      'fourth',
      'fifth',
    ])
  })
})
