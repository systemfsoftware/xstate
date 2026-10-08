import { describe, it } from '@systemfsoftware/vitest'
import { createActor, setup, types } from '../src/index.js'

describe('setup', () => {
  it('exposes schemas', function*({ expect }) {
    const schemas = {
      context: types<{ count: number }>(),
      events: {
        INC: types<{ value: number }>(),
      },
      internalEvents: {
        TICK: types<{ count: number }>(),
      },
      actions: {
        track: {
          params: types<{ key: string }>(),
        },
      },
      guards: {
        hasAccess: {
          params: types<{ role: string }>(),
        },
      },
      emitted: {
        changed: types<{ value: number }>(),
      },
      input: types<{ start: number }>(),
      output: types<{ total: number }>(),
      meta: types<{ label: string }>(),
      tags: types<'active'>(),
      children: {
        child: types<unknown>(),
      },
    }

    const s = setup({ schemas })

    yield* expect({
      identity: s.schemas === schemas,
      defaultSchemas: setup().schemas,
    }).toEqual({
      identity: true,
      defaultSchemas: {},
    })
  })

  it('exposes extended schemas', function*({ expect }) {
    const context = types<{ count: number }>()
    const inc = types<{ value: number }>()
    const reset = types<{}>()
    const track = types<{ key: string }>()
    const notify = types<{ message: string }>()
    const hasAccess = types<{ role: string }>()
    const canReset = types<{ reason: string }>()
    const changed = types<{ value: number }>()
    const notified = types<{ message: string }>()
    const child = types<unknown>()
    const sibling = types<unknown>()
    const input = types<{ start: number }>()
    const output = types<{ total: number }>()
    const meta = types<{ label: string }>()
    const tags = types<'active'>()

    const s = setup({
      schemas: {
        context,
        events: {
          INC: inc,
        },
        actions: {
          track: {
            params: track,
          },
        },
        guards: {
          hasAccess: {
            params: hasAccess,
          },
        },
        emitted: {
          changed,
        },
        input,
        meta,
        children: {
          child,
        },
      },
    }).extend({
      schemas: {
        events: {
          RESET: reset,
        },
        actions: {
          notify: {
            params: notify,
          },
        },
        guards: {
          canReset: {
            params: canReset,
          },
        },
        emitted: {
          notified,
        },
        output,
        tags,
        children: {
          sibling,
        },
      },
    })

    yield* expect({
      contextIs: s.schemas.context === context,
      incIs: s.schemas.events.INC === inc,
      resetIs: s.schemas.events.RESET === reset,
      trackParamsIs: s.schemas.actions.track.params === track,
      notifyParamsIs: s.schemas.actions.notify.params === notify,
      hasAccessParamsIs: s.schemas.guards.hasAccess.params === hasAccess,
      canResetParamsIs: s.schemas.guards.canReset.params === canReset,
      changedIs: s.schemas.emitted.changed === changed,
      notifiedIs: s.schemas.emitted.notified === notified,
      inputIs: s.schemas.input === input,
      outputIs: s.schemas.output === output,
      metaIs: s.schemas.meta === meta,
      tagsIs: s.schemas.tags === tags,
      childIs: s.schemas.children.child === child,
      siblingIs: s.schemas.children.sibling === sibling,
    }).toEqual({
      contextIs: true,
      incIs: true,
      resetIs: true,
      trackParamsIs: true,
      notifyParamsIs: true,
      hasAccessParamsIs: true,
      canResetParamsIs: true,
      changedIs: true,
      notifiedIs: true,
      inputIs: true,
      outputIs: true,
      metaIs: true,
      tagsIs: true,
      childIs: true,
      siblingIs: true,
    })
  })

  it('exposes per-state schemas on the machine state nodes', function*({ expect }) {
    const rootContext = types<{ count: number }>()
    const runningContext = types<{ startedAt: number }>()
    const runningInput = types<{ timeout: number }>()
    const retryingContext = types<{ attempt: number }>()

    const machine = setup({
      schemas: { context: rootContext },
      states: {
        running: {
          schemas: { context: runningContext, input: runningInput },
          states: {
            retrying: {
              schemas: { context: retryingContext },
            },
          },
        },
      },
    }).createMachine({
      context: { count: 0 },
      initial: 'running',
      states: {
        running: {
          initial: 'retrying',
          states: {
            retrying: {},
          },
        },
        done: { type: 'final' },
      },
    })

    const runningState = machine.states['running']
    if (runningState === undefined) {
      throw new Error('expected a running state')
    }

    const retryingState = runningState.states['retrying']
    if (retryingState === undefined) {
      throw new Error('expected a retrying state')
    }

    const doneState = machine.states['done']
    if (doneState === undefined) {
      throw new Error('expected a done state')
    }

    yield* expect({
      rootContextIs: machine.schemas?.context === rootContext,
      runningContextIs: runningState.schemas?.context === runningContext,
      runningInputIs: runningState.schemas?.input === runningInput,
      retryingContextIs: retryingState.schemas?.context === retryingContext,
      doneSchemasIsUndefined: doneState.schemas === undefined,
    }).toEqual({
      rootContextIs: true,
      runningContextIs: true,
      runningInputIs: true,
      retryingContextIs: true,
      doneSchemasIsUndefined: true,
    })
  })

  it('deep-merges repeated nested state contracts through extend', function*({ expect }) {
    const leftInput = types<{ left: number }>()
    const rightInput = types<{ right: boolean }>()

    const s = setup({
      states: {
        parent: {
          type: 'compound',
          initial: 'left',
          states: {
            left: { schemas: { input: leftInput } },
          },
        },
      },
    }).extend({
      states: {
        parent: {
          states: {
            right: { schemas: { input: rightInput } },
          },
        },
      },
    })

    const machine = s.createMachine({
      initial: 'parent',
      states: {
        parent: {
          initial: { target: 'left', input: { left: 1 } },
          states: { left: {}, right: {} },
        },
      },
    })

    const parentState = machine.states['parent']
    if (parentState === undefined) {
      throw new Error('expected a parent state')
    }
    const parentStates = parentState.states
    if (parentStates === undefined) {
      throw new Error('expected parent states')
    }
    const leftState = parentStates['left']
    if (leftState === undefined) {
      throw new Error('expected a left state')
    }
    const rightState = parentStates['right']
    if (rightState === undefined) {
      throw new Error('expected a right state')
    }

    yield* expect({
      leftIs: s.states.parent.states?.left.schemas?.input === leftInput,
      rightIs: s.states.parent.states?.right.schemas?.input === rightInput,
      machineLeftIs: leftState.schemas?.input === leftInput,
      machineRightIs: rightState.schemas?.input === rightInput,
    }).toEqual({
      leftIs: true,
      rightIs: true,
      machineLeftIs: true,
      machineRightIs: true,
    })
  })

  it('uses extension state metadata while preserving base descendants', function*({ expect }) {
    const s = setup({
      states: {
        parent: {
          type: 'compound',
          id: 'base-parent',
          initial: 'left',
          states: { left: {} },
        },
      },
    }).extend({
      states: {
        parent: {
          type: 'compound',
          id: 'extension-parent',
          initial: 'right',
          states: { right: {} },
        },
      },
    })

    s.states.parent.type satisfies 'compound'
    s.states.parent.id satisfies 'extension-parent'
    s.states.parent.initial satisfies 'right'
    s.states.parent.states?.left
    s.states.parent.states?.right

    const machine = s.createMachine({
      initial: 'parent',
      states: { parent: { states: { left: {}, right: {} } } },
    })

    const parentState = machine.states['parent']
    if (parentState === undefined) {
      throw new Error('expected a parent state')
    }

    yield* expect({
      id: parentState.id,
      initial: parentState.config.initial,
    }).toEqual({
      id: 'extension-parent',
      initial: 'right',
    })
  })

  it('extends sources', function*({ expect }) {
    const calls: string[] = []

    const machine = setup({
      actions: {
        base: () => {
          calls.push('base')
        },
      },
      guards: {
        canRun: () => true,
      },
      delays: {
        short: 1,
      },
    })
      .extend({
        actions: {
          extended: () => {
            calls.push('extended')
          },
        },
        guards: {
          canFinish: () => true,
        },
      })
      .createMachine({
        initial: 'idle',
        on: {
          RUN: ({ guards }) => {
            if (guards.canRun() && guards.canFinish()) {
              return { target: '.done' }
            }
            return undefined
          },
        },
        states: {
          idle: {
            entry: ({ actions }, enq) => {
              enq(actions.base)
              enq(actions.extended)
            },
          },
          done: {},
        },
      })

    const actor = createActor(machine).start()
    actor.send({ type: 'RUN' })

    yield* expect({
      calls,
      value: actor.getSnapshot().value,
      shortDelay: machine.sources.delays['short'],
    }).toEqual({
      calls: ['base', 'extended'],
      value: 'done',
      shortDelay: 1,
    })
  })
})
