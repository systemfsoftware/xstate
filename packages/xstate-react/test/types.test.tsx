import { describe, it } from '@systemfsoftware/vitest'
import { type ActorRefFrom, createActor, createMachine } from '@systemfsoftware/xstate'
import { render } from '@testing-library/react'
import z from 'zod'
import { useActor, useActorRef, useMachine, useSelector } from '../src/index.js'

describe('useMachine', (it) => {
  interface YesNoContext {
    value?: number
  }

  interface YesNoEvent {
    type: 'YES'
  }

  const yesNoMachine = createMachine({
    schemas: {
      context: z.object({
        value: z.number().optional(),
      }),
      events: z.object({
        type: z.literal('YES'),
      }) as any,
    },
    context: {
      value: undefined,
    },
    initial: 'no',
    states: {
      no: {
        on: {
          YES: { target: 'yes' },
        },
      },
      yes: {
        type: 'final',
      },
    },
  })

  it('state should not become never after checking state with matches', function*({ expect }) {
    const YesNo = () => {
      const [state] = useMachine(yesNoMachine)

      if (state.matches('no')) {
        return <span>No</span>
      }

      return <span>Yes: {state.context.value}</span>
    }

    const { container, unmount } = render(<YesNo />)

    try {
      yield* expect(container.textContent).toEqual('No')
    } finally {
      unmount()
    }
  })

  // Example from: https://github.com/statelyai/xstate/discussions/1534
  it('spawned actors should be typed correctly', function*({ expect }) {
    const child = createMachine({
      schemas: {
        context: z.object({
          bar: z.number(),
        }),
        events: z.object({
          type: z.literal('FOO'),
          data: z.number(),
        }) as any,
      },
      id: 'myActor',
      context: {
        bar: 1,
      },
      initial: 'ready',
      states: {
        ready: {},
      },
    })

    const m = createMachine({
      initial: 'ready',
      schemas: {
        context: z.object({
          actor: z.custom<ActorRefFrom<typeof child>>().nullable(),
        }),
      },
      context: {
        actor: null,
      },
      states: {
        ready: {
          entry: (_, enq) => ({
            context: {
              actor: enq.spawn(child),
            },
          }),
        },
      },
    })

    interface Props {
      myActor: ActorRefFrom<typeof child>
    }

    function Element({ myActor }: Props) {
      const current = useSelector(myActor, (state) => state)
      const bar: number = current.context['bar']

      // @ts-expect-error
      send({ type: 'WHATEVER' })

      return (
        <>
          {bar}
          <div onClick={() => myActor.send({ type: 'FOO', data: 1 } as any)}>
            click
          </div>
        </>
      )
    }

    function App() {
      const [current] = useMachine(m)

      if (!current.context.actor) {
        return null
      }

      return <Element myActor={current.context.actor} />
    }

    const noop = (_val: any) => {}

    noop(App)

    yield* expect(child.id).toEqual('myActor')
  })
})

describe('useActor', (it) => {
  it('should require input to be specified when defined', function*({ expect }) {
    const withInputMachine = createMachine({
      schemas: {
        input: z.object({
          value: z.number(),
        }),
      },
      initial: 'idle',
      states: {
        idle: {},
      },
    })

    const Component = () => {
      // @ts-expect-error input is required
      const _ = useActor(withInputMachine)
      return <></>
    }

    const { container, unmount } = render(<Component />)

    try {
      yield* expect(container.textContent).toEqual('')
    } finally {
      unmount()
    }
  })

  it('should not require input when not defined', function*({ expect }) {
    const noInputMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {},
      },
    })
    const Component = () => {
      const _ = useActor(noInputMachine)
      return <></>
    }

    const { container, unmount } = render(<Component />)

    try {
      yield* expect(container.textContent).toEqual('')
    } finally {
      unmount()
    }
  })
})

describe('useActorRef', (it) => {
  it('should not require input when restoring a snapshot', function*({ expect }) {
    const machine = createMachine({
      schemas: { input: z.object({ value: z.number() }) },
    })
    const snapshot = createActor(machine, {
      input: { value: 1 },
    }).getPersistedSnapshot()

    const check = () => {
      useActorRef(machine, { snapshot })
      useActor(machine, { snapshot })
      useMachine(machine, { snapshot })
      // @ts-expect-error input or snapshot is required
      useActorRef(machine)
      // @ts-expect-error input or snapshot is required
      useActorRef(machine, {})
    }

    yield* expect(typeof check).toEqual('function')
  })

  it('should require input to be specified when defined', function*({ expect }) {
    const withInputMachine = createMachine({
      schemas: {
        input: z.object({
          value: z.number(),
        }),
      },
      initial: 'idle',
      states: {
        idle: {},
      },
    })

    const Component = () => {
      // @ts-expect-error input is required
      const _ = useActorRef(withInputMachine)
      return <></>
    }

    const { container, unmount } = render(<Component />)

    try {
      yield* expect(container.textContent).toEqual('')
    } finally {
      unmount()
    }
  })

  it('should not require input when not defined', function*({ expect }) {
    const noInputMachine = createMachine({
      initial: 'idle',
      states: {
        idle: {},
      },
    })

    const Component = () => {
      const _ = useActorRef(noInputMachine)
      return <></>
    }

    const { container, unmount } = render(<Component />)

    try {
      yield* expect(container.textContent).toEqual('')
    } finally {
      unmount()
    }
  })
})

it(
  'useMachine types work for machines with a specified id and state with an after property #5008',
  function*({ expect }) {
    // https://github.com/statelyai/xstate/issues/5008
    const cheatCodeMachine = createMachine({
      id: 'cheatCodeMachine',
      initial: 'disabled',
      states: {
        disabled: {
          after: {},
        },
        enabled: {},
      },
    })

    function _useCheatCode(): boolean {
      const [state] = useMachine(cheatCodeMachine)

      return state.matches('enabled')
    }

    yield* expect(createActor(cheatCodeMachine).getSnapshot().value).toEqual('disabled')
  },
)
