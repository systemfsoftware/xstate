import { describe } from '@systemfsoftware/vitest'
import { createActor, createCallbackLogic, createMachine, setup, types } from '@systemfsoftware/xstate'
import { render, within } from '@testing-library/react'
import * as React from 'react'
import { useMachine } from '../src/index.js'

describe('lifecycle', (it) => {
  it('#5272 an invoked callback starts once under StrictMode', function*({ expect }) {
    let starts = 0
    let cleanups = 0
    const appMachine = createMachine({
      invoke: {
        src: createCallbackLogic(() => {
          starts++
          return () => {
            cleanups++
          }
        }),
      },
    })

    function App() {
      useMachine(appMachine)
      return null
    }

    const { unmount } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    try {
      yield* expect({ starts, cleanups }).toEqual({ starts: 1, cleanups: 0 })
    } finally {
      unmount()
    }
  })

  it('#5074 system.get resolves a sibling invoked actor under StrictMode', function*({ expect }) {
    const results: string[] = []
    const feedbackMachine = createMachine({})
    const rootMachine = setup({
      actors: {
        feedback: feedbackMachine,
        alert: createCallbackLogic(({ system }) => {
          results.push(system.get('feedback') ? 'ok' : 'missing')
        }),
      },
    }).createMachine({
      invoke: [{ src: 'feedback', registryKey: 'feedback' }, { src: 'alert' }],
    })

    function App() {
      useMachine(rootMachine)
      return null
    }

    const { unmount } = render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    try {
      yield* expect(results).toEqual(['ok'])
    } finally {
      unmount()
    }
  })

  it('#3270 an event sent from a callback ref survives the StrictMode remount', function*({ expect }) {
    const counterMachine = createMachine({
      schemas: {
        events: { INCREMENT: types<{}>() },
      },
      context: { count: 0 },
      on: {
        INCREMENT: ({ context }) => ({
          context: { count: context.count + 1 },
        }),
      },
    })

    function Counter() {
      const [current, send] = useMachine(counterMachine)
      const ref = React.useCallback(
        (node: HTMLElement | null) => {
          if (node) {
            send({ type: 'INCREMENT' })
          }
        },
        [send],
      )
      return <div ref={ref}>count: {current.context.count}</div>
    }

    const { container, unmount } = render(
      <React.StrictMode>
        <Counter />
      </React.StrictMode>,
    )
    try {
      yield* expect(within(container).getByText(/count:/).textContent).toBe('count: 2')
    } finally {
      unmount()
    }
  })
})

describe('types', (it) => {
  it('#5480 useMachine accepts persisted and live snapshots', function*({ expect }) {
    const machine = createMachine({
      initial: 'a',
      states: { a: { on: { NEXT: { target: 'b' } } }, b: {} },
    })
    const actor = createActor(machine).start()
    actor.send({ type: 'NEXT' })
    const persisted = actor.getPersistedSnapshot()
    const live = actor.getSnapshot()
    const fromStorage = JSON.parse(JSON.stringify(persisted))

    function App() {
      const [a] = useMachine(machine, { snapshot: persisted })
      const [b] = useMachine(machine, { snapshot: live })
      const [c] = useMachine(machine, { snapshot: fromStorage })
      return <div data-testid='values'>{[a.value, b.value, c.value].join(',')}</div>
    }

    const { container, unmount } = render(<App />)
    try {
      yield* expect(within(container).getByTestId('values').textContent).toBe('b,b,b')
    } finally {
      unmount()
    }
  })
})
