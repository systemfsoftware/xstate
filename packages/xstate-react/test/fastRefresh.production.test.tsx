import { it } from '@systemfsoftware/vitest'
import { createMachine } from '@systemfsoftware/xstate'
import { act, render } from '@testing-library/react'
import { Effect } from 'effect'
import * as React from 'react'
import { vi } from 'vitest'
import { useActorRef } from '../src/index.js'

const refresh = vi.hoisted(() => ({ signal: {} as object }))
vi.mock('react', async (importOriginal) => {
  const reactModule = await importOriginal<typeof React>()
  return {
    ...reactModule,
    useMemo: (factory: () => unknown, deps: unknown[]) =>
      deps.length === 0 ? refresh.signal : reactModule.useMemo(factory, deps),
  }
})
vi.mock('#is-development', () => ({ default: false }))

const createToggle = (extra: Record<string, any> = {}) =>
  createMachine({
    id: 'toggle',
    initial: 'off',
    states: {
      off: { on: { TOGGLE: { target: 'on' } } },
      on: { on: { ...extra } },
      ...(extra['RESET'] ? { reset: {} } : {}),
    },
  } as any)

it('keeps the first machine on a refresh signal in production builds', function*({ expect }) {
  const v1 = createToggle()
  let actorRef!: any
  const App = ({ machine }: { machine: any }) => {
    actorRef = useActorRef(machine)
    return null
  }
  const { rerender, unmount } = render(<App machine={v1} />)
  try {
    const original = actorRef
    act(() => original.send({ type: 'TOGGLE' }))

    refresh.signal = {}
    rerender(<App machine={createToggle({ RESET: { target: 'reset' } })} />)

    yield* expect({ ref: actorRef, logic: actorRef.logic }).toSatisfy(
      (held) => held.ref === original && held.logic === v1,
      'the refresh signal keeps the same actor ref and the same machine logic',
    )

    yield* Effect.sync(() => {
      act(() => actorRef.send({ type: 'RESET' }))
    })

    yield* expect(actorRef.getSnapshot().value).toBe('on')
  } finally {
    unmount()
  }
})
