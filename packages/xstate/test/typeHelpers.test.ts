import { describe, it } from '@systemfsoftware/vitest'
import z from 'zod'
import {
  type ActorLogic,
  type ActorRefFrom,
  type ContextFrom,
  createActor,
  createMachine,
  type EventFrom,
  type MachineSourcesFrom,
  type Snapshot,
  type SnapshotFrom,
  type StateValueFrom,
  type TagsFrom,
} from '../src/index.js'

describe('ContextFrom', () => {
  it('should return context of a machine', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          counter: z.number(),
        }),
      },
      context: {
        counter: 0,
      },
    })

    type MachineContext = ContextFrom<typeof machine>

    const acceptMachineContext = (_event: MachineContext) => {}

    acceptMachineContext({ counter: 100 })
    acceptMachineContext({
      counter: 100,
      // @ts-expect-error
      other: 'unknown',
    })
    const obj = { completely: 'invalid' }
    // @ts-expect-error
    acceptMachineContext(obj)

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })
})

describe('EventFrom', () => {
  it('should return events for a machine', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          UPDATE_NAME: z.object({ value: z.string() }),
          UPDATE_AGE: z.object({ value: z.number() }),
          ANOTHER_EVENT: z.object({}),
        },
      },
    })

    type MachineEvent = EventFrom<typeof machine>

    const acceptMachineEvent = (_event: MachineEvent) => {}

    acceptMachineEvent({ type: 'UPDATE_NAME', value: 'test' })
    acceptMachineEvent({ type: 'UPDATE_AGE', value: 12 })
    acceptMachineEvent({ type: 'ANOTHER_EVENT' })
    acceptMachineEvent({
      // @ts-expect-error
      type: 'UNKNOWN_EVENT',
    })

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })

  it('should return events for an actor', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          UPDATE_NAME: z.object({ value: z.string() }),
          UPDATE_AGE: z.object({ value: z.number() }),
          ANOTHER_EVENT: z.object({}),
        },
      },
    })

    const actor = createActor(machine)

    type ActorEvent = EventFrom<typeof actor>

    const acceptActorEvent = (_event: ActorEvent) => {}

    acceptActorEvent({ type: 'UPDATE_NAME', value: 'test' })
    acceptActorEvent({ type: 'UPDATE_AGE', value: 12 })
    acceptActorEvent({ type: 'ANOTHER_EVENT' })
    acceptActorEvent({
      // @ts-expect-error
      type: 'UNKNOWN_EVENT',
    })

    yield* expect(actor.getSnapshot().status).toEqual('active')
  })
})

describe('MachineSourcesFrom', () => {
  it('should return sources for a machine', function*({ expect }) {
    const machine = createMachine({
      context: {
        count: 100,
      },
      schemas: {
        context: z.object({
          count: z.number(),
        }),
        events: {
          FOO: z.object({}),
          BAR: z.object({ value: z.string() }),
        },
      },
      actions: {
        foo: () => {},
      },
    })

    const acceptMachineSources = (
      _options: MachineSourcesFrom<typeof machine>,
    ) => {}

    acceptMachineSources({
      actions: {
        foo: () => {},
      },
      actors: {},
      guards: {},
      delays: {},
    })

    // @ts-expect-error
    acceptMachineSources(100)

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })

  it('should reject an action that returns an arbitrary (non-void/assignment) value', function*({ expect }) {
    const machine = createMachine({
      actions: {
        // @ts-expect-error an action must return void or { context?, children? }
        foo: () => 'hello',
      },
    })

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })
})

describe('StateValueFrom', () => {
  it('should return any from a machine', function*({ expect }) {
    const machine = createMachine({})

    function matches(_value: StateValueFrom<typeof machine>) {}

    matches('just anything')

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })
})

describe('SnapshotFrom', () => {
  it('should return state type from a service that has concrete event type', function*({ expect }) {
    const service = createActor(
      createMachine({
        schemas: {
          events: {
            FOO: z.object({}),
          },
        },
      }),
    )

    function acceptState(_state: SnapshotFrom<typeof service>) {}

    acceptState(service.getSnapshot())
    // @ts-expect-error
    acceptState("isn't any")

    yield* expect(service.getSnapshot().status).toEqual('active')
  })

  it('should return state from a machine without context', function*({ expect }) {
    const machine = createMachine({})

    function acceptState(_state: SnapshotFrom<typeof machine>) {}

    acceptState(createActor(machine).getSnapshot())
    // @ts-expect-error
    acceptState("isn't any")

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })

  it('should return state from a machine with context', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        context: z.object({
          counter: z.number(),
        }),
      },
      context: {
        counter: 0,
      },
    })

    function acceptState(_state: SnapshotFrom<typeof machine>) {}

    acceptState(createActor(machine).getSnapshot())
    // @ts-expect-error
    acceptState("isn't any")

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })
})

describe('ActorRefFrom', () => {
  it('should return `ActorRef` based on actor logic', function*({ expect }) {
    const logic: ActorLogic<Snapshot<undefined>, { type: 'TEST' }> = {
      transition: (state) => [state, []],
      getInitialSnapshot: () => ({
        status: 'active',
        output: undefined,
        error: undefined,
      }),
      initialTransition: () => [
        {
          status: 'active',
          output: undefined,
          error: undefined,
        },
        [],
      ],
      getPersistedSnapshot: (s) => s,
    }

    function acceptActorRef(actorRef: ActorRefFrom<typeof logic>) {
      actorRef.send({ type: 'TEST' })
    }

    acceptActorRef(createActor(logic).start())

    yield* expect(createActor(logic).start().getSnapshot().status).toEqual(
      'active',
    )
  })
})

describe('tags', () => {
  it('derives string from StateMachine', function*({ expect }) {
    const machine = createMachine({})

    type Tags = TagsFrom<typeof machine>

    const acceptTag = (_tag: Tags) => {}

    acceptTag('a')
    acceptTag('b')
    acceptTag('c')
    acceptTag('d')

    yield* expect(createActor(machine).getSnapshot().status).toEqual('active')
  })
})
