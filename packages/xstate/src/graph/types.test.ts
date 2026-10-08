import { describe } from '@systemfsoftware/vitest'
import z from 'zod'
import { createMachine } from '../index.js'
import { getShortestPaths } from './index.js'

describe('getShortestPath types', (it) => {
  it('`getEvents` should be allowed to return a mutable array', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({}),
          BAR: z.object({}),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: [
        {
          type: 'FOO',
        },
      ],
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`getEvents` should be allowed to return a readonly array', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({}),
          BAR: z.object({}),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: [
        {
          type: 'FOO',
        },
      ],
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`events` should allow known event', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ value: z.number() }),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: [
        {
          type: 'FOO',
          value: 100,
        },
      ],
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`events` should not require all event types (array literal expression)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ value: z.number() }),
          BAR: z.object({ value: z.number() }),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: [{ type: 'FOO', value: 100 }],
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`events` should not require all event types (tuple)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ value: z.number() }),
          BAR: z.object({ value: z.number() }),
        },
      },
    })

    const events = [{ type: 'FOO', value: 100 }] as const

    const paths = getShortestPaths(machine, {
      events,
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`events` should not require all event types (function)', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ value: z.number() }),
          BAR: z.object({ value: z.number() }),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: () => [{ type: 'FOO', value: 100 }] as const,
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`events` should not allow unknown events', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ value: z.number() }),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: [
        {
          // @ts-expect-error
          type: 'UNKNOWN',
          value: 100,
        },
      ],
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`events` should only allow props of a specific event', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: {
          FOO: z.object({ value: z.number() }),
          BAR: z.object({ other: z.string() }),
        },
      },
    })

    const paths = getShortestPaths(machine, {
      events: [
        {
          type: 'FOO',
          // @ts-expect-error
          other: 'nana nana nananana',
        },
      ],
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`serializeEvent` should be allowed to return plain string', function*({ expect }) {
    const machine = createMachine({})

    const paths = getShortestPaths(machine, {
      serializeEvent: () => '',
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })

  it('`serializeState` should be allowed to return plain string', function*({ expect }) {
    const machine = createMachine({})

    const paths = getShortestPaths(machine, {
      serializeState: () => '',
    })

    yield* expect(
      paths.map((path) => path.steps.map((step) => step.event.type)),
    ).toEqual([['@xstate.init']])
  })
})
