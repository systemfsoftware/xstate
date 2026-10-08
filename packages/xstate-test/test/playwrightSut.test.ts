import { describe, it } from '@systemfsoftware/vitest'
import type { SnapshotFrom } from '@systemfsoftware/xstate'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import { ModelTestFailure, propertyTest, type TestEventGenerators } from '../src/engine/index.js'
import { createPlaywrightSut } from '../src/playwright.js'
import { FakePage } from './fakePage.js'
import { constant, integer, randomAdapter, type RandomGeneratorKind, record } from './randomAdapter.js'

const counterMachine = createMachine({
  schemas: {
    context: types<{ count: number }>(),
    events: {
      INC: types<{ value: number }>(),
      RESET: types<{}>(),
    },
  },
  context: { count: 0 },
  on: {
    INC: ({ context, event }) => ({
      context: { count: context.count + event.value },
    }),
    RESET: () => ({ context: { count: 0 } }),
  },
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>
type CounterEvent = { type: 'INC'; value: number } | { type: 'RESET' }

function sutFor(page: FakePage) {
  return createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(page, {
    events: {
      INC: (p, event) => p.fill('#amount', String(event.value)),
      RESET: (p) => p.click('#reset'),
    },
    read: (p) => p.locator('#count').textContent().then((text) => Number(text)),
    projectModel: (snapshot) => snapshot.context.count,
    reset: (p) => p.click('#reset'),
  })
}

const awaited = <A>(call: () => A | Promise<A>): Effect.Effect<A> => Effect.promise(() => Promise.resolve().then(call))

const failureOf = <A>(call: () => A | Promise<A>): Effect.Effect<unknown> =>
  Effect.promise(() =>
    Promise.resolve()
      .then(call)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
  )

const adapter = randomAdapter({ seed: 3, numRuns: 10, maxCommands: 6 })
const events = {
  INC: record({ value: integer(1, 3) }),
  RESET: constant({}),
}

describe('createPlaywrightSut', () => {
  it('passes when the page matches the model', function*({ expect }) {
    const page = new FakePage()
    const result = yield* awaited(() =>
      propertyTest(counterMachine, {
        adapter,
        events,
        sut: sutFor(page),
        invariant: () => {},
      })
    )

    yield* expect({
      runs: result.coverage.runs,
      loadStates: page.loadStates,
    }).toEqual({ runs: 10, loadStates: expect.arrayContaining(['load']) })
  })

  it('reports a divergence naming the step for a broken page', function*({ expect }) {
    const page = new FakePage({ broken: true })
    const failure = (yield* failureOf(() =>
      propertyTest(counterMachine, {
        adapter,
        events,
        sut: sutFor(page),
        invariant: () => {},
      })
    )) as ModelTestFailure

    yield* expect({
      failureClass: failure.constructor,
      message: failure.message,
      lastEventType: failure.trace.steps.at(-1)!.event.type,
      finalSut: failure.trace.finalObservation?.sut,
    }).toEqual({
      failureClass: ModelTestFailure,
      message: expect.stringMatching(/diverged/),
      lastEventType: 'INC',
      finalSut: { model: expect.any(Number), observed: expect.any(Number) },
    })
  })

  it('advances page time through the Playwright clock', function*({ expect }) {
    const page = new FakePage({ latency: 5 })
    const result = yield* awaited(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 1, numRuns: 5, maxCommands: 4 }),
        events,
        commands: { advance: constant(5) },
        sut: createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(page, {
          events: {
            INC: (p, event) => p.fill('#amount', String(event.value)).then(() => p.clock.runFor(5)),
            RESET: (p) => p.click('#reset'),
          },
          read: (p) => p.locator('#count').textContent().then((text) => Number(text)),
          projectModel: (snapshot) => snapshot.context.count,
          reset: (p) => p.click('#reset'),
        }),
        invariant: () => {},
      })
    )

    yield* expect(result.coverage.runs).toBe(5)
  })

  it('writes checkpoint screenshots and applies per-case mocks', function*({ expect }) {
    const page = new FakePage()
    const sut = createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(
      page,
      {
        events: {
          INC: (p, event) => p.fill('#amount', String(event.value)),
          RESET: (p) => p.click('#reset'),
        },
        read: (p) => p.locator('#count').textContent().then((text) => Number(text)),
        projectModel: (snapshot) => snapshot.context.count,
        screenshotDir: 'shots',
        mocks: {
          INC: (p) => p.route('**/api/increment', (route) => route.fulfill({ status: 200 })),
        },
      },
    )

    const session = yield* awaited(() =>
      sut.create({
        logic: counterMachine as never,
        input: undefined,
        snapshot: undefined,
        label: () => {},
        classify: () => {},
        target: () => {},
      })
    )
    yield* awaited(() => session.send({ type: 'INC', value: 2 }, { snapshot: undefined! }))
    yield* awaited(() => session.send({ type: 'INC', value: 1 }, { snapshot: undefined! }))
    yield* awaited(() => session.checkpoint!('after inc'))

    yield* expect({ routes: page.routes, screenshots: page.screenshots })
      .toEqual({
        routes: ['**/api/increment'],
        screenshots: ['shots/after-inc.png'],
      })
    const observed = yield* awaited(() => session.read!())
    yield* expect(observed).toBe(3)
  })

  it('throws for an event with no configured action', function*({ expect }) {
    const page = new FakePage()
    const sut = createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(
      page,
      {
        events: {},
        read: (p) => p.locator('#count').textContent().then((text) => Number(text)),
        projectModel: (snapshot) => snapshot.context.count,
      },
    )
    const session = yield* awaited(() =>
      sut.create({
        logic: counterMachine as never,
        input: undefined,
        snapshot: undefined,
        label: () => {},
        classify: () => {},
        target: () => {},
      })
    )

    const error = (yield* failureOf(() => session.send({ type: 'RESET' }, { snapshot: undefined! }))) as Error
    yield* expect({
      errorClass: error.constructor,
      message: error.message,
    }).toEqual({
      errorClass: Error,
      message: 'No Playwright action configured for event "RESET"',
    })
  })
})

describe('createPlaywrightSut state assertions', () => {
  it('runs events and state assertions against the page', function*({ expect }) {
    const page = new FakePage()
    let assertions = 0
    const result = yield* awaited(() =>
      propertyTest(counterMachine, {
        adapter,
        events,
        sut: createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(page, {
          events: {
            INC: (p, event) => p.fill('#amount', String(event.value)),
            RESET: (p) => p.click('#reset'),
          },
          states: {
            '*': (p, snapshot) =>
              p.locator('#count').textContent().then((text) => {
                assertions++
                const observed = Number(text)
                if (observed !== snapshot.context.count) {
                  throw new Error(
                    `the page reports ${observed} where the model says ${snapshot.context.count}`,
                  )
                }
              }),
          },
          reset: (p) => p.click('#reset'),
        }),
        invariant: () => {},
      })
    )

    yield* expect({
      runs: result.coverage.runs,
      assertionsPositive: assertions > 0,
    }).toEqual({ runs: 10, assertionsPositive: true })
  })

  it('fails when the page disagrees with the model', function*({ expect }) {
    const page = new FakePage({ broken: true })
    let comparisons = 0
    let divergences = 0
    const failure = (yield* failureOf(() =>
      propertyTest(counterMachine, {
        adapter,
        events,
        sut: createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(
          page,
          {
            events: {
              INC: (p, event) => p.fill('#amount', String(event.value)),
              RESET: (p) => p.click('#reset'),
            },
            states: {
              '*': (p, snapshot) =>
                p.locator('#count').textContent().then((text) => {
                  comparisons++
                  const observed = Number(text)
                  if (observed !== snapshot.context.count) {
                    divergences++
                    throw new Error(
                      `the page reports ${observed} where the model says ${snapshot.context.count}`,
                    )
                  }
                }),
            },
          },
        ),
        invariant: () => {},
      })
    )) as ModelTestFailure

    yield* expect({
      failureClass: failure.constructor,
      comparisonsPositive: comparisons > 0,
      divergencesPositive: divergences > 0,
    }).toEqual({
      failureClass: ModelTestFailure,
      comparisonsPositive: true,
      divergencesPositive: true,
    })
  })
})

describe('per-case mocks', () => {
  function mockingSutFor(page: FakePage, applied: string[]) {
    return createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(page, {
      events: {
        INC: (p, event) => p.fill('#amount', String(event.value)),
        RESET: (p) => p.click('#reset'),
      },
      read: (p) => p.locator('#count').textContent().then((text) => Number(text)),
      projectModel: (snapshot) => snapshot.context.count,
      reset: (p) => p.click('#reset'),
      mocks: {
        'INC.small': (p) => {
          applied.push('INC.small')
          return p.route('**/api/small', (route) => route.fulfill({ status: 200 }))
        },
        'INC.large': (p) => {
          applied.push('INC.large')
          return p.route('**/api/large', (route) => route.fulfill({ status: 200 }))
        },
      },
    })
  }

  const casedEvents: TestEventGenerators<
    CounterSnapshot,
    CounterEvent,
    RandomGeneratorKind
  > = {
    INC: [
      { case: 'small', generate: record({ value: constant(1) }) },
      { case: 'large', generate: record({ value: constant(3) }) },
    ],
    RESET: constant({}),
  }

  it('resolves mocks by the generated event case', function*({ expect }) {
    const page = new FakePage()
    const applied: string[] = []
    yield* awaited(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 2, numRuns: 8, maxCommands: 6 }),
        events: casedEvents,
        sut: mockingSutFor(page, applied),
        invariant: () => {},
      })
    )

    yield* expect({
      small: applied.filter((entry) => entry === 'INC.small'),
      large: applied.filter((entry) => entry === 'INC.large'),
    }).toEqual({
      small: expect.arrayContaining(['INC.small']),
      large: expect.arrayContaining(['INC.large']),
    })
  })

  it('does not accumulate route handlers across sessions', function*({ expect }) {
    const page = new FakePage()
    const applied: string[] = []
    yield* awaited(() =>
      propertyTest(counterMachine, {
        adapter: randomAdapter({ seed: 2, numRuns: 8, maxCommands: 6 }),
        events: casedEvents,
        sut: mockingSutFor(page, applied),
        invariant: () => {},
      })
    )

    yield* expect({
      appliedMoreThanOne: applied.length > 1,
      installedRoutes: page.installedRoutes,
    }).toEqual({ appliedMoreThanOne: true, installedRoutes: [] })
  })

  const sessionContext = {
    logic: counterMachine as never,
    input: undefined,
    snapshot: undefined,
    label: () => {},
    classify: () => {},
    target: () => {},
  }

  it("unroutes the previous case's routes before applying another case's mock", function*({ expect }) {
    const page = new FakePage()
    const sut = createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(
      page,
      {
        events: {
          INC: (p, event) => p.fill('#amount', String(event.value)),
          RESET: (p) => p.click('#reset'),
        },
        mocks: {
          'INC.small': (p) => {
            p.routeLog.push('mock INC.small')
            return p.route('**/api/small', (route) => route.fulfill({ status: 200 }))
          },
          'INC.large': (p) => {
            p.routeLog.push('mock INC.large')
            return p.route('**/api/large', (route) => route.fulfill({ status: 200 }))
          },
        },
      },
    )

    const session = yield* awaited(() => sut.create(sessionContext))
    yield* awaited(() =>
      session.send(
        { type: 'INC', value: 1 },
        { snapshot: undefined!, case: { type: 'INC', name: 'small' } },
      )
    )
    yield* awaited(() =>
      session.send(
        { type: 'INC', value: 3 },
        { snapshot: undefined!, case: { type: 'INC', name: 'large' } },
      )
    )

    yield* expect({
      routeLog: page.routeLog,
      installedRouteUrls: page.installedRoutes.map((entry) => entry.url),
    }).toEqual({
      routeLog: [
        'mock INC.small',
        'route **/api/small',
        'unroute **/api/small',
        'mock INC.large',
        'route **/api/large',
      ],
      installedRouteUrls: ['**/api/large'],
    })
  })

  it('runs config.dispose when unroute throws, then surfaces the error', function*({ expect }) {
    const page = new FakePage()
    const disposed: string[] = []
    const sut = createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(
      page,
      {
        events: {
          INC: (p, event) => p.fill('#amount', String(event.value)),
          RESET: (p) => p.click('#reset'),
        },
        mocks: {
          INC: (p) => p.route('**/api/increment', (route) => route.fulfill({ status: 200 })),
        },
        dispose: () => {
          disposed.push('dispose')
        },
      },
    )

    const session = yield* awaited(() => sut.create(sessionContext))
    yield* awaited(() => session.send({ type: 'INC', value: 1 }, { snapshot: undefined! }))
    page.unrouteError = new Error('unroute failed')

    const error = (yield* failureOf(() => session.dispose!({ passed: true }))) as Error
    yield* expect({ message: error.message, disposed }).toEqual({
      message: 'unroute failed',
      disposed: ['dispose'],
    })
  })
})
