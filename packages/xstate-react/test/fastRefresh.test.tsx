import { describe, it } from '@systemfsoftware/vitest'
import { createLogic, createMachine, setup } from '@systemfsoftware/xstate'
import { standardSchemaValidator } from '@systemfsoftware/xstate/validation'
import { act, render } from '@testing-library/react'
import * as React from 'react'
import { vi } from 'vitest'
import { z } from 'zod'
import { useActorRef } from '../src/index.js'

const refresh = vi.hoisted(() => ({ signal: {} as object }))
vi.mock('react', async (importOriginal) => {
  const React = await importOriginal<typeof import('react')>()
  return {
    ...React,
    useMemo: (factory: () => unknown, deps: unknown[]) =>
      deps.length === 0 ? refresh.signal : React.useMemo(factory, deps),
  }
})

function simulateRefresh() {
  refresh.signal = {}
}

function mount(machine: any) {
  let actorRef!: any
  const App = ({ machine }: { machine: any }) => {
    actorRef = useActorRef(machine)
    return null
  }
  const utils = render(<App machine={machine} />)
  return {
    get actorRef() {
      return actorRef
    },
    refreshTo(next: any) {
      simulateRefresh()
      act(() => {
        utils.rerender(<App machine={next} />)
      })
    },
    unmount: utils.unmount,
  }
}

const createEditor = (extra: Record<string, any> = {}) =>
  createMachine({
    id: 'editor',
    context: () => {
      const cyclic: Record<string, unknown> = {}
      cyclic['self'] = cyclic
      return { el: document.createElement('div'), cyclic }
    },
    initial: 'idle',
    states: {
      idle: { on: { NEXT: { target: 'editing' } } },
      editing: { on: { ...extra } },
      ...(extra['DONE'] ? { done: {} } : {}),
    },
  } as any)

describe('Fast Refresh', (it) => {
  it('keeps the running actor and its live context across a refresh', function*({ expect }) {
    const v1 = createEditor()
    const app = mount(v1)

    try {
      const original = app.actorRef
      act(() => original.send({ type: 'NEXT' }))
      const { el, cyclic } = original.getSnapshot().context

      const v2 = createEditor({ DONE: { target: 'done' } })
      app.refreshTo(v2)

      const snapshot = app.actorRef.getSnapshot()
      const kept = {
        sameRef: app.actorRef === original,
        sameLogic: app.actorRef.logic === v2,
        value: snapshot.value,
        sameEl: snapshot.context.el === el,
        sameCyclic: snapshot.context.cyclic === cyclic,
      }

      act(() => app.actorRef.send({ type: 'DONE' }))

      yield* expect({ ...kept, valueAfterDone: app.actorRef.getSnapshot().value }).toEqual({
        sameRef: true,
        sameLogic: true,
        value: 'editing',
        sameEl: true,
        sameCyclic: true,
        valueAfterDone: 'done',
      })
    } finally {
      app.unmount()
    }
  })

  it('starts a fresh actor when the current state no longer exists', function*({ expect }) {
    const v1 = createEditor()
    const app = mount(v1)

    try {
      const original = app.actorRef
      act(() => original.send({ type: 'NEXT' }))

      const v2 = createMachine({
        id: 'editor',
        initial: 'idle',
        states: { idle: {} },
      })
      app.refreshTo(v2)

      yield* expect({
        replaced: app.actorRef !== original,
        sameLogic: app.actorRef.logic === v2,
        value: app.actorRef.getSnapshot().value,
      }).toEqual({ replaced: true, sameLogic: true, value: 'idle' })
    } finally {
      app.unmount()
    }
  })

  it('starts a fresh actor when the context validator rejects the context', function*({ expect }) {
    const v1 = createEditor()
    const app = mount(v1)

    try {
      const original = app.actorRef
      act(() => original.send({ type: 'NEXT' }))

      const v2 = setup({
        validator: standardSchemaValidator(),
        schemas: { context: z.object({ count: z.number() }) },
      }).createMachine({
        id: 'editor',
        context: { count: 0 },
        initial: 'idle',
        states: {
          idle: { on: { NEXT: { target: 'editing' } } },
          editing: {},
        },
      })
      app.refreshTo(v2)

      yield* expect({
        replaced: app.actorRef !== original,
        value: app.actorRef.getSnapshot().value,
        context: app.actorRef.getSnapshot().context,
      }).toEqual({ replaced: true, value: 'idle', context: { count: 0 } })
    } finally {
      app.unmount()
    }
  })

  it('keeps children whose logic is unchanged and restarts the others', function*({ expect }) {
    const stable = createLogic({ context: 0, run: () => undefined })
    const createParent = (other: any) =>
      createMachine({
        id: 'parent',
        actors: { stable, other },
        invoke: [
          { id: 'stable', src: 'stable' },
          { id: 'other', src: 'other' },
        ],
      })

    const app = mount(
      createParent(createLogic({ context: 0, run: () => undefined })),
    )

    try {
      const before = app.actorRef.getSnapshot().children

      app.refreshTo(
        createParent(createLogic({ context: 0, run: () => undefined })),
      )

      const after = app.actorRef.getSnapshot().children
      yield* expect({
        stableKept: after.stable === before.stable,
        otherReplaced: after.other !== before.other,
        afterStatus: after.other.getSnapshot().status,
        beforeStatus: before.other.getSnapshot().status,
      }).toEqual({
        stableKept: true,
        otherReplaced: true,
        afterStatus: 'active',
        beforeStatus: 'stopped',
      })
    } finally {
      app.unmount()
    }
  })

  it('starts a fresh actor when context holds a child that would restart', function*({ expect }) {
    const createParent = (worker: any) =>
      createMachine({
        id: 'parent',
        actors: { worker },
        context: { ref: undefined as any },
        entry: ({ actors }: any, enq: any) => ({
          context: { ref: enq.spawn(actors.worker, { id: 'worker' }) },
        }),
      } as any)

    const app = mount(
      createParent(createLogic({ context: 0, run: () => undefined })),
    )

    try {
      const original = app.actorRef
      const before = original.getSnapshot()
      const refKeptBefore = before.context.ref === before.children.worker

      app.refreshTo(
        createParent(createLogic({ context: 1, run: () => undefined })),
      )

      const snapshot = app.actorRef.getSnapshot()
      yield* expect({
        refKeptBefore,
        replaced: app.actorRef !== original,
        refIsChild: snapshot.context.ref === snapshot.children.worker,
        workerContext: snapshot.children.worker.getSnapshot().context,
      }).toEqual({ refKeptBefore: true, replaced: true, refIsChild: true, workerContext: 1 })
    } finally {
      app.unmount()
    }
  })

  it('delivers snapshots a restarted child emits while starting', function*({ expect }) {
    const seen: unknown[] = []
    const createParent = (child: any) =>
      createMachine({
        id: 'parent',
        actors: { child },
        invoke: {
          id: 'child',
          src: 'child',
          onSnapshot: ({ event }: any) => {
            seen.push(event.snapshot.context)
          },
        },
      } as any)

    const app = mount(
      createParent(createLogic({ context: 'v1', run: () => undefined })),
    )

    try {
      const original = app.actorRef
      seen.length = 0

      app.refreshTo(
        createParent(createLogic({ context: 'v2', run: () => undefined })),
      )

      yield* expect({ sameRef: app.actorRef === original, seen }).toEqual({ sameRef: true, seen: ['v2'] })
    } finally {
      app.unmount()
    }
  })

  it('starts a fresh actor when a remembered history state was removed', function*({ expect }) {
    const createHistoryMachine = (withHistory: boolean) =>
      createMachine({
        id: 'player',
        initial: 'on',
        states: {
          on: {
            initial: 'a',
            states: {
              a: { on: { NEXT: { target: 'b' } } },
              b: {},
              ...(withHistory ? { hist: { type: 'history', target: 'a' } } : {}),
            },
            on: { OFF: { target: 'off' } },
          },
          off: {
            on: {
              ON: { target: withHistory ? 'on.hist' : 'on' },
              NOOP: {},
            },
          },
        },
      } as any)

    const app = mount(createHistoryMachine(true))

    try {
      const original = app.actorRef
      act(() => original.send({ type: 'NEXT' }))
      act(() => original.send({ type: 'OFF' }))
      const historyKeys = Object.keys(original.getSnapshot().historyValue)

      app.refreshTo(createHistoryMachine(false))

      yield* expect({
        historyKeys,
        replaced: app.actorRef !== original,
        value: app.actorRef.getSnapshot().value,
      }).toEqual({ historyKeys: ['player.on.hist'], replaced: true, value: { on: 'a' } })
    } finally {
      app.unmount()
    }
  })

  it('derives the state value when an active state gains substates', function*({ expect }) {
    const v1 = createEditor()
    const app = mount(v1)

    try {
      const original = app.actorRef
      act(() => original.send({ type: 'NEXT' }))

      const v2 = createMachine({
        id: 'editor',
        initial: 'idle',
        states: {
          idle: { on: { NEXT: { target: 'editing' } } },
          editing: { initial: 'typing', states: { typing: {} } },
        },
      })
      app.refreshTo(v2)

      const snapshot = app.actorRef.getSnapshot()
      yield* expect({
        sameRef: app.actorRef === original,
        value: snapshot.value,
        matches: snapshot.matches({ editing: 'typing' }),
      }).toEqual({ sameRef: true, value: { editing: 'typing' }, matches: true })
    } finally {
      app.unmount()
    }
  })

  it('keeps the first machine when the machine changes without a refresh', function*({ expect }) {
    const v1 = createEditor()
    let actorRef!: any
    const App = ({ machine }: { machine: any }) => {
      actorRef = useActorRef(machine)
      return null
    }
    const { rerender, unmount } = render(<App machine={v1} />)

    try {
      const original = actorRef
      rerender(<App machine={createEditor({ DONE: { target: 'done' } })} />)

      yield* expect({ sameRef: actorRef === original, sameLogic: actorRef.logic === v1 }).toEqual({
        sameRef: true,
        sameLogic: true,
      })
    } finally {
      unmount()
    }
  })
})
