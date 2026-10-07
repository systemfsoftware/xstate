import { describe, expect, it } from 'vitest'
import { createActor, setup, types } from '../src/index.js'

describe('setup', () => {
  it('exposes schemas', () => {
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

    expect(s.schemas).toBe(schemas)
    expect(setup().schemas).toEqual({})
  })

  it('exposes extended schemas', () => {
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

    expect(s.schemas.context).toBe(context)
    expect(s.schemas.events.INC).toBe(inc)
    expect(s.schemas.events.RESET).toBe(reset)
    expect(s.schemas.actions.track.params).toBe(track)
    expect(s.schemas.actions.notify.params).toBe(notify)
    expect(s.schemas.guards.hasAccess.params).toBe(hasAccess)
    expect(s.schemas.guards.canReset.params).toBe(canReset)
    expect(s.schemas.emitted.changed).toBe(changed)
    expect(s.schemas.emitted.notified).toBe(notified)
    expect(s.schemas.input).toBe(input)
    expect(s.schemas.output).toBe(output)
    expect(s.schemas.meta).toBe(meta)
    expect(s.schemas.tags).toBe(tags)
    expect(s.schemas.children.child).toBe(child)
    expect(s.schemas.children.sibling).toBe(sibling)
  })

  it('exposes per-state schemas on the machine state nodes', () => {
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

    expect(machine.schemas?.context).toBe(rootContext)
    expect(runningState.schemas?.context).toBe(runningContext)
    expect(runningState.schemas?.input).toBe(runningInput)

    const retryingState = runningState.states['retrying']
    if (retryingState === undefined) {
      throw new Error('expected a retrying state')
    }

    expect(retryingState.schemas?.context).toBe(retryingContext)

    const doneState = machine.states['done']
    if (doneState === undefined) {
      throw new Error('expected a done state')
    }

    expect(doneState.schemas).toBeUndefined()
  })

  it('deep-merges repeated nested state contracts through extend', () => {
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

    expect(s.states.parent.states?.left.schemas?.input).toBe(leftInput)
    expect(s.states.parent.states?.right.schemas?.input).toBe(rightInput)

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

    expect(leftState.schemas?.input).toBe(leftInput)
    expect(rightState.schemas?.input).toBe(rightInput)
  })

  it('uses extension state metadata while preserving base descendants', () => {
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

    expect(parentState.id).toBe('extension-parent')
    expect(parentState.config.initial).toBe('right')
  })

  it('extends sources', () => {
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

    expect(calls).toEqual(['base', 'extended'])
    expect(actor.getSnapshot().value).toBe('done')
    expect(machine.sources.delays['short']).toBe(1)
  })
})
