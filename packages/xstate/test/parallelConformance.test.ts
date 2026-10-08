import { describe, it } from '@systemfsoftware/vitest'
import { createActor, createMachine } from '../src/index.js'

describe('parallel state conformance', (it) => {
  // Bug 1 — #5214: transition targeting one region resets sibling regions
  it('a transition targeting one region should not reset sibling regions', function*({ expect }) {
    const machine = createMachine({
      id: 'p',
      type: 'parallel',
      on: {
        ARCHIVE: { target: '#p.phase.archive' },
        EDIT: { target: '#p.mode.edit' },
      },
      states: {
        phase: {
          initial: 'inquiry',
          states: { inquiry: {}, archive: {} },
        },
        mode: {
          initial: 'new',
          states: { new: {}, edit: {} },
        },
      },
    })

    const actor = createActor(machine).start()
    actor.send({ type: 'EDIT' })
    actor.send({ type: 'ARCHIVE' })

    yield* expect(actor.getSnapshot().value).toEqual({
      phase: 'archive',
      mode: 'edit',
    })
  })

  // Bug 2 — #5162: reenter:true in one region re-runs SIBLING region entry actions
  it('reenter in one region should not re-run sibling region entry actions', function*({ expect }) {
    const machine = createMachine({
      id: 'reentrytest',
      type: 'parallel',
      context: { count: 0 },
      states: {
        someStateWithReentry: {
          initial: 'a',
          states: { a: {}, b: {} },
          on: {
            REENTER_A: { target: '.a', reenter: true },
          },
        },
        sibling: {
          entry: ({ context }) => ({ context: { count: context.count + 1 } }),
          initial: 'c',
          states: { c: {}, d: {} },
        },
      },
    })

    const actor = createActor(machine).start()
    const beforeReenter = actor.getSnapshot().context.count

    actor.send({ type: 'REENTER_A' })
    yield* expect({
      beforeReenter: beforeReenter === 1,
      afterReenter: actor.getSnapshot().context.count === 1,
    }).toEqual({ beforeReenter: true, afterReenter: true })
  })

  // Bug 3 — #4793: after a cross-region transition, subsequent events in
  // sibling regions are dropped. Final states are inert, so the transition
  // lives on a non-final state of the region.
  it('sibling region events should still be handled after a cross-region transition', function*({ expect }) {
    const machine = createMachine({
      id: 'question-flow',
      type: 'parallel',
      states: {
        value1: {
          initial: 'x',
          states: {
            x: { on: { NEXT: { target: '#question-flow.value2.shown' } } },
            done: { type: 'final' },
          },
        },
        value2: {
          id: 'value2',
          initial: 'hidden',
          states: {
            shown: { on: { NEXT: { target: '#value3.shown' } } },
            hidden: {},
          },
        },
        value3: {
          id: 'value3',
          initial: 'hidden',
          states: {
            hidden: {},
            shown: { type: 'final' },
          },
        },
      },
    })

    const actor = createActor(machine).start()

    actor.send({ type: 'NEXT' })
    const afterFirstNext = actor.getSnapshot().value

    actor.send({ type: 'NEXT' })
    // A cross-region transition only exits the region containing its
    // targets, so value2 stays 'shown' while value3 advances.
    yield* expect({
      afterFirstNext,
      afterSecondNext: actor.getSnapshot().value,
    }).toEqual({
      afterFirstNext: { value1: 'x', value2: 'shown', value3: 'hidden' },
      afterSecondNext: { value1: 'x', value2: 'shown', value3: 'shown' },
    })
  })

  // Passing guard — a `type: 'final'` region under a parallel root has no
  // outgoing transitions of its own; an event with no matching handler
  // anywhere leaves every region untouched.
  it('a final region under a parallel root should ignore events it does not handle', function*({ expect }) {
    const machine = createMachine({
      id: 'g',
      type: 'parallel',
      states: {
        regionA: {
          type: 'final',
        },
        regionB: {
          initial: 'idle',
          states: { idle: {}, other: {} },
        },
      },
    })

    const actor = createActor(machine).start()
    const beforeGo = actor.getSnapshot().value

    actor.send({ type: 'GO' })
    yield* expect({ beforeGo, afterGo: actor.getSnapshot().value }).toEqual({
      beforeGo: { regionA: {}, regionB: 'idle' },
      afterGo: { regionA: {}, regionB: 'idle' },
    })
  })
})
