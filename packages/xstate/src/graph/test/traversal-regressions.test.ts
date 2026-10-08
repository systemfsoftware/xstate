import { it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { createLogic, createMachine } from '../../index.js'
import { getAdjacencyMap } from '../adjacency.js'
import { getPathsFromEvents } from '../pathFromEvents.js'
import { getShortestPaths } from '../shortestPaths.js'
import { getSimplePaths } from '../simplePaths.js'

const counter = createLogic({
  context: ({ input }: { input: number }) => input,
  run: ({ context, event }) => event.type === 'INC' ? { context: context + 1 } : undefined,
})

it('replays a finite sequence on unbounded logic', function*({ expect }) {
  const [path] = getPathsFromEvents(counter, [{ type: 'INC' }], {
    input: 10,
    limit: 1,
  })
  if (path === undefined) {
    throw new Error('expected a first path')
  }
  yield* expect({ context: path.state.context, weight: path.weight }).toEqual({
    context: 11,
    weight: 1,
  })
})

it('uses input when replaying machine events', function*({ expect }) {
  const machine = createMachine({
    schemas: { input: z.object({ count: z.number() }) },
    context: ({ input }) => input,
  })
  const firstPath = getPathsFromEvents(machine, [], { input: { count: 7 } })[0]
  if (firstPath === undefined) {
    throw new Error('expected a first path')
  }
  yield* expect(firstPath.state.context).toEqual({ count: 7 })
})

it.each([getShortestPaths, getSimplePaths])(
  'initializes custom logic once in a path generator',
  function*(generate, { expect }) {
    let initializations = 0
    const logic = {
      ...counter,
      getInitialSnapshot: (
        ...args: Parameters<typeof counter.getInitialSnapshot>
      ) => ({
        ...counter.getInitialSnapshot(...args),
        context: initializations++,
      }),
    }
    const paths = generate(logic, { input: 0, events: [] })
    yield* expect({ pathCount: paths.length, initializations }).toEqual({
      pathCount: 1,
      initializations: 1,
    })
  },
)

it.each(['constructor', 'toString', '__proto__', ''])(
  'accepts arbitrary serialized state/event keys: %s',
  function*(key, { expect }) {
    const options = {
      input: 0,
      events: [{ type: 'INC' }],
      stopWhen: (state: { context: number }) => state.context === 1,
      serializeState: (state: { context: number }) => state.context === 0 ? key : 'end',
      serializeEvent: () => key,
    }
    const adjacency = getAdjacencyMap(counter, options)
    const adjacencyNode = adjacency[key as keyof typeof adjacency]
    if (adjacencyNode === undefined) {
      throw new Error('expected an adjacency node')
    }
    const results = [getShortestPaths, getSimplePaths].map((generate) => {
      const path = generate(counter, options).find(
        (p) => p.state.context === 1,
      )!
      return { weight: path.weight, stepCount: path.steps.length }
    })
    yield* expect({
      adjacencyKeys: Object.keys(adjacency),
      nodeTransitionKeys: Object.keys(adjacencyNode.transitions),
      results,
    }).toEqual({
      adjacencyKeys: [key, 'end'],
      nodeTransitionKeys: [key],
      results: [
        { weight: 1, stepCount: 2 },
        { weight: 1, stepCount: 2 },
      ],
    })
  },
)

it('honors replay filters, stopping and target predicates', function*({ expect }) {
  const events = [{ type: 'INC' }, { type: 'INC' }]
  const outcomeOf = (run: () => unknown): unknown => {
    try {
      run()
      return 'no error thrown'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  yield* expect({
    filterFailure: outcomeOf(() =>
      getPathsFromEvents(counter, events, {
        input: 0,
        filterEvents: (state) => state.context === 0,
      })
    ),
    stopFailure: outcomeOf(() =>
      getPathsFromEvents(counter, events, {
        input: 0,
        stopWhen: (state) => state.context === 1,
      })
    ),
    targetPaths: getPathsFromEvents(counter, events, {
      input: 0,
      toState: (state) => state.context === 3,
    }),
  }).toEqual({
    filterFailure: expect.stringContaining('Invalid transition'),
    stopFailure: expect.stringContaining('Invalid transition'),
    targetPaths: [],
  })
})

it('replays the last permitted override candidate matching a serialized event', function*({ expect }) {
  const logic = createLogic({
    context: 0,
    run: ({
      context,
      event,
    }: {
      context: number
      event: { type: string; amount: number }
    }) => event.type === 'ADD' ? { context: context + event.amount } : undefined,
  })
  const [path] = getPathsFromEvents(logic, [{ type: 'ADD', amount: 100 }], {
    serializeEvent: (event) => event.type,
    events: [
      { type: 'ADD', amount: 1 },
      { type: 'ADD', amount: 2 },
      { type: 'ADD', amount: 3 },
    ],
    filterEvents: (_, event) => event.amount < 3,
  })
  if (path === undefined) {
    throw new Error('expected a first path')
  }
  const secondStep = path.steps[1]
  if (secondStep === undefined) {
    throw new Error('expected a second step')
  }
  yield* expect({
    context: path.state.context,
    secondEvent: secondStep.event,
  }).toEqual({
    context: 2,
    secondEvent: { type: 'ADD', amount: 100 },
  })
})

it.each(['shortest', 'simple', 'replay'] as const)(
  'initializes a machine once with explicit undefined fromState: %s',
  function*(mode, { expect }) {
    const machine = createMachine({ initial: 'idle', states: { idle: {} } })
    const calls: Array<Parameters<typeof machine.getInitialSnapshot>> = []
    const recording = Object.create(machine) as typeof machine
    recording.getInitialSnapshot = (
      ...args: Parameters<typeof machine.getInitialSnapshot>
    ) => {
      calls.push(args)
      return machine.getInitialSnapshot(...args)
    }
    const options = { fromState: undefined, events: [] }
    const paths = mode === 'replay'
      ? getPathsFromEvents(recording, [], options)
      : (mode === 'shortest' ? getShortestPaths : getSimplePaths)(
        recording,
        options,
      )
    yield* expect({
      pathCount: paths.length,
      initializeCalls: calls.length,
      initializeInputs: calls.map(([, input]) => input),
    }).toEqual({
      pathCount: 1,
      initializeCalls: 1,
      initializeInputs: [undefined],
    })
  },
)
