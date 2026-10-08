import { describe, it } from '@systemfsoftware/vitest'
import type { SnapshotFrom } from '@systemfsoftware/xstate'
import { createMachine, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { ModelTestFailure, propertyTest } from '../src/index.js'
import { createPlaywrightSut, PlaywrightOracleError, type PlaywrightSutConfig } from '../src/playwright.js'
import { FakePage, FakeTestInfo } from './fakePage.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{ value: number }>(), RESET: types<{}>() },
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

const events = {
  INC: fc.record({ value: fc.integer({ min: 1, max: 3 }) }),
  RESET: fc.constant({}),
}

function sutFor(
  page: FakePage,
  config: Partial<
    PlaywrightSutConfig<FakePage, CounterSnapshot, CounterEvent>
  > = {},
) {
  return createPlaywrightSut<FakePage, CounterSnapshot, CounterEvent>(page, {
    events: {
      INC: (p, event) => p.fill('#amount', String(event.value)),
      RESET: (p) => p.click('#reset'),
    },
    read: (p) => p.locator('#count').textContent().then((text) => Number(text)),
    projectModel: (snapshot) => snapshot.context.count,
    reset: (p) => p.click('#reset'),
    ...config,
  })
}

function catchFailure(run: () => Promise<unknown>): Promise<ModelTestFailure> {
  return run().then(
    () => {
      throw new Error('Expected the campaign to fail')
    },
    (error: unknown) => error as ModelTestFailure,
  )
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

const campaign = { seed: 1, numRuns: 30, maxCommands: 5, events }

describe('page oracles', () => {
  it('fails on a console error by default, with the messages in the cause', function*({ expect }) {
    const page = new FakePage()
    const failure = yield* awaited(() =>
      catchFailure(() =>
        propertyTest(counterMachine, {
          ...campaign,
          sut: sutFor(page, {
            events: {
              INC: (p, event) =>
                p.fill('#amount', String(event.value)).then(() => {
                  if (p.app.count >= 4) {
                    p.emitConsole('error', `count is ${p.app.count}`)
                  }
                }),
              RESET: (p) => p.click('#reset'),
            },
          }),
        })
      )
    )

    const cause = failure.cause
    yield* expect({
      failureClass: failure.constructor,
      summary: failure.summary,
      causeClass: cause instanceof PlaywrightOracleError ? cause.constructor : undefined,
      causeMessages: cause instanceof PlaywrightOracleError ? cause.messages : undefined,
      message: failure.message,
      consoleListeners: page.listenerCount('console'),
    }).toEqual({
      failureClass: ModelTestFailure,
      summary: expect.stringMatching(/^SUT check failed after \d+ steps$/),
      causeClass: PlaywrightOracleError,
      causeMessages: [expect.stringMatching(/^console\.error: count is [4-6]$/)],
      message: expect.stringMatching(/The page reported 1 error:/),
      consoleListeners: 0,
    })
  })

  it('collects page errors, rejections, and HTTP errors, but not mocked responses', function*({ expect }) {
    const page = new FakePage()
    const sut = sutFor(page, {
      mocks: {
        INC: (p) => p.route('**/api', (route) => route.fulfill({ status: 500 })),
      },
    })
    const session = yield* awaited(() => sut.create({} as never))

    yield* expect({
      initScripts: page.initScripts.length,
      rejectionScriptFirstLine: page.initScripts[0]?.split('\n')[0],
    }).toEqual({
      initScripts: 1,
      rejectionScriptFirstLine: "window.addEventListener('unhandledrejection', function (event) {",
    })

    yield* awaited(() => session.send({ type: 'INC', value: 1 }, { snapshot: undefined! }))
    page.emitResponse(500, '/api', page.routedRequests[0])
    yield* awaited(() => session.check!())

    page.emit('pageerror', new Error('kaboom'))
    page.emitConsole('error', '[xstate-test] unhandledrejection: nope')
    page.emitConsole('warning', 'ignored at the default level')
    page.emitResponse(404, '/missing')
    const checkFailure = yield* failureOf(() => session.check!())
    yield* expect(checkFailure).toMatchObject({
      messages: [
        'pageerror: kaboom',
        'unhandledrejection: nope',
        'HTTP 404 GET /missing',
      ],
    })
    yield* awaited(() => session.dispose!({ passed: true }))

    yield* awaited(() => Promise.resolve(sut.create({} as never)).then((created) => created.dispose!({ passed: true })))
    yield* expect(page.initScripts.length).toBe(1)
  })

  it('checks only the oracles an object turns on', function*({ expect }) {
    const page = new FakePage()
    const session = yield* awaited(() =>
      sutFor(page, {
        oracles: { console: 'warn', http: 500 },
      }).create({} as never)
    )
    page.emit('pageerror', new Error('ignored'))
    page.emitResponse(404, '/ignored')
    page.emitConsole('warning', 'careful')
    page.emitResponse(503, '/down')
    const checkFailure = yield* failureOf(() => session.check!())

    const messages = checkFailure instanceof PlaywrightOracleError
      ? checkFailure.messages
      : undefined
    yield* expect({ messages, initScripts: page.initScripts }).toEqual({
      messages: ['console.warning: careful', 'HTTP 503 GET /down'],
      initScripts: [],
    })
  })

  it('registers nothing with oracles: false', function*({ expect }) {
    const page = new FakePage()
    yield* awaited(() => sutFor(page, { oracles: false }).create({} as never))
    yield* expect(page.listenerCount('console')).toBe(0)
  })
})

describe('failure artifacts', () => {
  const brokenAt4 = {
    INC: (p: FakePage, event: { value: number }) =>
      p.fill(
        '#amount',
        String(p.app.count >= 3 ? event.value + 1 : event.value),
      ),
    RESET: (p: FakePage) => p.click('#reset'),
  }

  it('attaches the fixture, the trace, and a screenshot of the failing run', function*({ expect }) {
    const page = new FakePage()
    const testInfo = new FakeTestInfo()
    const failure = yield* awaited(() =>
      catchFailure(() =>
        propertyTest(counterMachine, {
          ...campaign,
          sut: sutFor(page, { testInfo, events: brokenAt4 }),
        })
      )
    )
    const starts = page.tracingLog.filter((entry) => entry.startsWith('start'))
    const [fixture, trace, screenshot] = testInfo.attachments
    if (fixture === undefined) {
      throw new Error('expected a fixture attachment')
    }
    if (trace === undefined) {
      throw new Error('expected a trace attachment')
    }
    if (screenshot === undefined) {
      throw new Error('expected a screenshot attachment')
    }

    const body = fixture.body
    yield* expect({
      firstTraceStart: starts[0],
      traceStarts: starts.length,
      tracingLog: page.tracingLog,
      attachmentNames: testInfo.attachments.map(({ name }) => name),
      fixtureBody: typeof body === 'string' ? JSON.parse(body) : undefined,
      tracePath: trace.path,
      traceContentType: trace.contentType,
      screenshotContentType: screenshot.contentType,
    }).toEqual({
      firstTraceStart: 'start {"screenshots":true,"snapshots":true}',
      traceStarts: failure.coverage!.exploration.attemptedRuns,
      tracingLog: expect.arrayContaining([
        'start {"screenshots":true,"snapshots":true}',
        'stop (discarded)',
        'stop test-results/xstate-test-failure-trace.zip',
      ]),
      attachmentNames: ['fixture.json', 'trace', 'failure.png'],
      fixtureBody: failure.fixture,
      tracePath: 'test-results/xstate-test-failure-trace.zip',
      traceContentType: 'application/zip',
      screenshotContentType: 'image/png',
    })
  })

  it('attaches one screenshot per step of the failing run with every-step', function*({ expect }) {
    const page = new FakePage()
    const testInfo = new FakeTestInfo()
    const failure = yield* awaited(() =>
      catchFailure(() =>
        propertyTest(counterMachine, {
          ...campaign,
          sut: sutFor(page, {
            testInfo,
            trace: 'off',
            screenshots: 'every-step',
            events: brokenAt4,
          }),
        })
      )
    )
    const expectedNames = [
      'fixture.json',
      ...failure.trace.steps.map((_, index) => `step-${index}.png`),
    ]

    yield* expect({
      attachmentNames: testInfo.attachments.map(({ name }) => name),
      tracingLog: page.tracingLog,
    }).toEqual({ attachmentNames: expectedNames, tracingLog: [] })
  })

  it("attaches the last run's trace of a passing campaign with trace: 'on'", function*({ expect }) {
    const page = new FakePage()
    const testInfo = new FakeTestInfo()
    yield* awaited(() =>
      propertyTest(counterMachine, {
        ...campaign,
        numRuns: 3,
        sut: sutFor(page, { testInfo, trace: 'on' }),
      })
    )
    yield* expect(testInfo.attachments).toEqual([
      {
        name: 'trace',
        path: 'test-results/xstate-test-trace.zip',
        contentType: 'application/zip',
      },
    ])
  })

  it('requires testInfo for trace and screenshots', function*({ expect }) {
    yield* expect(() => sutFor(new FakePage(), { trace: 'on' })).toThrow(
      "`trace` and `screenshots` attach their files to `testInfo`; pass Playwright's `testInfo` fixture to `createPlaywrightSut()`.",
    )
  })

  it('wraps each event action in step', function*({ expect }) {
    const page = new FakePage()
    const steps: string[] = []
    const session = yield* awaited(() =>
      sutFor(page, {
        step: (name, body) => {
          steps.push(name)
          return body()
        },
      }).create({} as never)
    )
    yield* awaited(() => session.send({ type: 'INC', value: 2 }, { snapshot: undefined! }))
    yield* awaited(() => session.send({ type: 'RESET' }, { snapshot: undefined! }))

    yield* expect({ steps, count: page.app.count }).toEqual({
      steps: ['INC {"value":2}', 'RESET'],
      count: 0,
    })
  })

  it("settles with waitForLoadState('load')", function*({ expect }) {
    const page = new FakePage()
    const session = yield* awaited(() => sutFor(page).create({} as never))
    yield* awaited(() => session.settle!())
    yield* expect(page.loadStates).toEqual(['load'])
  })
})
