import { describe, it } from '@systemfsoftware/vitest'
import {
  createAsyncLogic,
  createMachine,
  type EventFrom,
  initialTransition,
  setup,
  type SnapshotFrom,
  transition,
  types,
} from '@systemfsoftware/xstate'
import { getShortestPaths } from '@systemfsoftware/xstate/graph'
import { Cause, Effect, Exit } from 'effect'
import * as Schema from 'effect/Schema'
import * as fc from 'fast-check'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import * as z from 'zod'
import { fromEffectSchemas } from '../src/effect-schema.js'
import {
  describeTestSuite as describeTestSuiteFromGraph,
  parseTestSuite as parseTestSuiteFromGraph,
} from '../src/engine/index.js'
import {
  assertTestCoverage,
  checkLinearizable,
  eventsFromSchemas,
  formatTestCoverage,
  formatTestCoverageHTML,
  formatTestCoverageJUnit,
  generateTestSuite,
  getCurrentScheduler,
  mergeEventGenerators,
  ModelTestFailure,
  pick,
  propertyTest,
  ReplayNotReproducedError,
  replayTest,
  runParallelPropertyCommands,
  serializeTestSuite,
  TestCampaignError,
  testCoverageToJSON,
  type TestFixture,
  testPaths,
  type TestSut,
  withScheduledSut,
} from '../src/index.js'
import { createPlaywrightSut } from '../src/playwright.js'
import { FakePage, FakeTestInfo } from './fakePage.js'

const cartMachine = createMachine({
  id: 'cart',
  schemas: {
    context: types<{ items: Record<string, number> }>(),
    events: {
      ADD: types<{ sku: string }>(),
      REMOVE: types<{ sku: string }>(),
      CHECKOUT: types<{}>(),
    },
  },
  context: { items: {} },
  initial: 'shopping',
  states: {
    shopping: {
      on: {
        ADD: ({ context, event }) => ({
          context: {
            items: {
              ...context.items,
              [event.sku]: (context.items[event.sku] ?? 0) + 1,
            },
          },
        }),
        REMOVE: ({ context, event }) => {
          const { [event.sku]: _removed, ...items } = context.items
          return { context: { items } }
        },
        CHECKOUT: ({ context }) =>
          Boolean(Object.keys(context.items).length)
            ? { target: 'checkedOut' }
            : undefined,
      },
    },
    checkedOut: { type: 'final' },
  },
})

function createCart({ buggy = false } = {}) {
  const items: Record<string, number> = {}
  return {
    add: (sku: string) => {
      items[sku] = (items[sku] ?? 0) + 1
    },
    remove: (sku: string) => {
      if (buggy && sku in items) {
        items[sku] = 0
        return
      }
      delete items[sku]
    },
    items: () => ({ ...items }),
  }
}

const sku = fc.constantFrom('apple', 'pear')
const events = {
  ADD: fc.record({ sku }),
  REMOVE: fc.record({ sku }),
  CHECKOUT: fc.constant({}),
}

function createCartSut({ buggy = false } = {}): TestSut<
  SnapshotFrom<typeof cartMachine>,
  EventFrom<typeof cartMachine>
> {
  return {
    create: () => {
      const cart = createCart({ buggy })
      return {
        send: (event) => {
          if (event.type === 'ADD') {
            cart.add(event.sku)
          }
          if (event.type === 'REMOVE') {
            cart.remove(event.sku)
          }
        },
        read: () => cart.items(),
      }
    },
    projectModel: (snapshot) => snapshot.context.items,
  }
}

const cartSut = createCartSut()

function dimensionLines(report: string): string[] {
  return report.split('\n').filter((line) => / covered \(/.test(line))
}

const rejectionOf = (promise: () => unknown): Effect.Effect<unknown> =>
  Effect.exit(Effect.promise(() => Promise.resolve(promise()))).pipe(
    Effect.flatMap((exit) =>
      Exit.isSuccess(exit)
        ? Effect.die(new Error('expected the call to reject'))
        : Effect.succeed(Cause.squash(exit.cause))
    ),
  )

describe('README: Quick start', () => {
  it('Generate random sequences with propertyTest()', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 100,
        events,
        sut: cartSut,
      })
    )
    const report = formatTestCoverage(coverage)

    yield* expect({
      dimensions: dimensionLines(report).slice(0, 6),
      eventCases: report.includes(
        '  - ADD / default: 154 generated, 115 applicable, 115 executed, 39 ignored\n' +
          '  - CHECKOUT / default: 170 generated, 126 applicable, 126 executed, 44 ignored\n' +
          '  - REMOVE / default: 147 generated, 112 applicable, 112 executed, 35 ignored',
      ),
    }).toEqual({
      dimensions: [
        'states: 2/2 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'stateNodes: 3/3 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'configurations: 2/2 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'statuses: 2/2 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'eventTypes: 4/4 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'transitions: 3/3 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
      ],
      eventCases: true,
    })
  })

  it('Walk the state graph with testPaths()', function*({ expect }) {
    const { coverage, results } = yield* Effect.promise(() =>
      testPaths(cartMachine, {
        pathGenerator: 'simple',
        events,
        sut: cartSut,
        stopWhen: (snapshot) => Object.values(snapshot.context.items).some((qty) => qty >= 2),
      })
    )

    yield* expect({
      resultCount: results.length,
      dimensions: dimensionLines(formatTestCoverage(coverage)).slice(0, 6),
    }).toEqual({
      resultCount: 15,
      dimensions: [
        'states: 2/2 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'stateNodes: 3/3 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'configurations: 2/2 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'statuses: 2/2 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'eventTypes: 4/4 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
        'transitions: 3/3 covered (100.0%), 0 uncovered, 0 unreachable, 0 unknown',
      ],
    })

    const shortest = yield* Effect.promise(() =>
      testPaths(cartMachine, {
        events,
        sut: cartSut,
        stopWhen: (snapshot) => Object.values(snapshot.context.items).some((qty) => qty >= 2),
      })
    )
    yield* expect(shortest.coverage.eventTypes.uncovered).toEqual(['REMOVE'])
  })
})

describe('README: Concepts', () => {
  it('Events', function*({ expect }) {
    const seen: string[] = []
    yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 20,
        events: {
          ADD: [
            { case: 'apple', generate: fc.constant({ sku: 'apple' }) },
            {
              case: 'known-sku',
              generate: fc.constantFrom('apple', 'pear'),
              resolve: ({ generated }) => ({ sku: generated as string }),
              when: ({ snapshot }) => Object.keys(snapshot.context.items).length < 3,
            },
          ],
        },
        sut: {
          create: () => ({
            send: (_event, context) => {
              seen.push(`${context.case?.type}.${context.case?.name}`)
            },
          }),
        },
      })
    )

    yield* expect(new Set(seen)).toEqual(new Set(['ADD.apple', 'ADD.known-sku']))
  })

  it('Events: testPaths() offers unconfigured event types as bare events', function*({
    expect,
  }) {
    const { coverage } = yield* Effect.promise(() =>
      testPaths(cartMachine, {
        events: { ADD: fc.record({ sku: fc.constant('apple') }) },
        stopWhen: (snapshot) => Object.values(snapshot.context.items).some((qty) => qty >= 2),
      })
    )
    yield* expect(coverage.eventTypes.covered).toContain('CHECKOUT')
  })

  it('Events: a non-object payload fails the run', function*({ expect }) {
    const error = yield* rejectionOf(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 5,
        events: { ADD: fc.constant('apple') as never },
      })
    )
    yield* expect(error instanceof Error ? error.message : String(error)).toMatch(
      /ADD/,
    )
  })

  it('The sut option', function*({ expect }) {
    let created = 0
    let disposed = 0
    yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 10,
        events,
        sut: {
          create: () => {
            created++
            const cart = createCart()
            return {
              send: (event) => {
                if (event.type === 'ADD') {
                  cart.add(event.sku)
                }
                if (event.type === 'REMOVE') {
                  cart.remove(event.sku)
                }
              },
              read: () => cart.items(),
              dispose: () => {
                disposed++
              },
            }
          },
          projectModel: (snapshot) => snapshot.context.items,
        },
      })
    )

    yield* expect({ created, disposed }).toEqual({ created: 10, disposed: 10 })
  })

  it('Oracles: states keys match state values and ids', function*({ expect }) {
    const hits = new Set<string>()
    yield* Effect.promise(() =>
      testPaths(cartMachine, {
        events: {
          ADD: [{ case: 'apple', generate: fc.constant({ sku: 'apple' }) }],
        },
        stopWhen: (snapshot) => Object.values(snapshot.context.items).some((qty) => qty >= 2),
        states: {
          shopping: () => {
            hits.add('shopping')
          },
          '#cart.checkedOut': () => {
            hits.add('checkedOut')
          },
        },
      })
    )
    yield* expect(hits).toEqual(new Set(['shopping', 'checkedOut']))
  })

  it("Oracles: '*' and meta.test run on a plain machine", function*({
    expect,
  }) {
    const calls: string[] = []
    const machine = createMachine({
      schemas: {
        meta: types<{
          test: (session: unknown, snapshot: { value: unknown }) => void
        }>(),
      },
      initial: 'idle',
      states: {
        idle: {
          on: { GO: { target: 'done' } },
          meta: {
            test: (session, snapshot) => {
              calls.push(`meta:${String(snapshot.value)}:${typeof session}`)
            },
          },
        },
        done: {},
      },
    })
    yield* Effect.promise(() =>
      testPaths(machine, {
        states: {
          '*': (snapshot) => {
            calls.push(`*:${String(snapshot.value)}`)
          },
        },
      })
    )
    yield* expect({
      metaIdle: calls.includes('meta:idle:undefined'),
      done: calls.includes('*:done'),
    }).toEqual({ metaIdle: true, done: true })
  })
})

const counterMachine = setup({
  schemas: {
    events: {
      INC: z.object({ by: z.number().int().min(1).max(5) }),
      RESET: z.object({}),
    },
  },
}).createMachine({
  context: { count: 0 },
  on: {
    INC: ({ context, event }) => ({
      context: { count: context['count'] + event.by },
    }),
    RESET: () => ({ context: { count: 0 } }),
  },
})

const orderMachine = setup({
  schemas: {
    events: { SUBMIT: types<{}>() },
  },
  actors: {
    chargeCard: createAsyncLogic({
      run: (): Promise<{ id: string }> => Promise.reject(new Error('the real service must not run in tests')),
    }),
  },
}).createMachine({
  id: 'order',
  initial: 'idle',
  states: {
    idle: { on: { SUBMIT: { target: 'charging' } } },
    charging: {
      invoke: {
        src: 'chargeCard',
        onDone: { target: 'confirmed' },
        onError: { target: 'declined' },
      },
      after: { 5000: { target: 'timedOut' } },
    },
    confirmed: { type: 'final' },
    declined: { on: { SUBMIT: { target: 'charging' } } },
    timedOut: { on: { SUBMIT: { target: 'charging' } } },
  },
})

describe('README: How-to guides', () => {
  it('Derive event generators from schemas', function*({ expect }) {
    const counts: number[] = []
    const byValues: number[] = []
    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 30,
        invariant: ({ snapshot, event }) => {
          counts.push(snapshot.context['count'])
          if (event?.type === 'INC') {
            byValues.push(event.by)
          }
        },
      })
    )
    yield* expect({
      hasValues: byValues.length > 0,
      outOfRangeValues: byValues.filter(
        (by) => !(Number.isInteger(by) && by >= 1 && by <= 5),
      ),
      negativeCounts: counts.filter((count) => count < 0),
    }).toEqual({ hasValues: true, outOfRangeValues: [], negativeCounts: [] })

    const merged: number[] = []
    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 10,
        deriveEvents: false,
        events: mergeEventGenerators(eventsFromSchemas(counterMachine), {
          INC: fc.record({ by: fc.constant(1) }),
        }),
        invariant: ({ event }) => {
          if (event?.type === 'INC') {
            merged.push(event.by)
          }
        },
      })
    )
    yield* expect(new Set(merged)).toEqual(new Set([1]))

    const laterCounts: number[] = []
    yield* Effect.promise(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 10,
        deriveEvents: false,
        events: fromEffectSchemas({
          INC: Schema.Struct({
            by: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
          }),
          RESET: Schema.Struct({}),
        }),
        invariant: ({ snapshot }) => {
          laterCounts.push(snapshot.context['count'])
        },
      })
    )
    yield* expect({
      negativeCounts: laterCounts.filter((count) => count < 0),
    }).toEqual({ negativeCounts: [] })
  })

  it('Steer invoked services', function*({ expect }) {
    const fixed = yield* Effect.promise(() =>
      propertyTest(orderMachine, {
        seed: 1,
        numRuns: 20,
        mode: 'executed',
        actors: {
          chargeCard: createAsyncLogic({ run: () => Promise.resolve({ id: 'ch_1' }) }),
        },
        events: { SUBMIT: fc.constant({}) },
      })
    )
    yield* expect(fixed.coverage.stateNodes.covered).toContain(
      'order.confirmed',
    )

    const generated = yield* Effect.promise(() =>
      propertyTest(orderMachine, {
        seed: 1,
        numRuns: 50,
        mode: 'executed',
        outcomes: {
          chargeCard: fc.oneof(
            fc.record({
              ok: fc.constant(true as const),
              output: fc.record({ id: fc.string() }),
            }),
            fc.record({
              ok: fc.constant(false as const),
              error: fc.constant('declined'),
            }),
          ),
        },
        events: { SUBMIT: fc.constant({}) },
      })
    )
    yield* expect(generated.coverage.stateNodes.covered).toEqual(
      expect.arrayContaining(['order.confirmed', 'order.declined']),
    )

    const error = yield* rejectionOf(() =>
      propertyTest(orderMachine, {
        outcomes: { chargeCard: fc.constant({ ok: true as const, output: 1 }) },
      })
    )
    yield* expect(error instanceof Error ? error.message : String(error)).toMatch(
      "require `mode: 'executed'`",
    )

    const paths = yield* Effect.promise(() =>
      testPaths(orderMachine, {
        mode: 'executed',
        outcomes: {
          chargeCard: fc.constant({ ok: true as const, output: { id: 'ch_1' } }),
        },
      })
    )
    yield* expect(paths.coverage.stateNodes.covered).toEqual(
      expect.arrayContaining([
        'order.confirmed',
        'order.declined',
        'order.timedOut',
      ]),
    )

    const pure = yield* Effect.promise(() =>
      testPaths(orderMachine, {
        outcomes: {
          chargeCard: fc.constant({ ok: true as const, output: { id: 'ch_1' } }),
        },
      })
    )
    yield* expect(pure.coverage.stateNodes.covered).toEqual(
      expect.arrayContaining(['order.confirmed', 'order.declined']),
    )
  })

  it('Test delayed transitions', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(orderMachine, {
        seed: 1,
        numRuns: 50,
        mode: 'executed',
        outcomes: {
          chargeCard: fc.constant({ ok: true as const, output: { id: 'ch_1' } }),
        },
        events: { SUBMIT: fc.constant({}) },
        commands: { advance: fc.integer({ min: 1_000, max: 10_000 }) },
      })
    )
    yield* expect(coverage.stateNodes.covered).toContain('order.timedOut')

    const paths = yield* Effect.promise(() => testPaths(orderMachine, { mode: 'executed' }))
    yield* expect(paths.coverage.stateNodes.covered).toContain('order.timedOut')
  })

  it('Test a web page with Playwright', function*({ expect }) {
    const formMachine = createMachine({
      id: 'form',
      schemas: {
        context: types<{ name: string; error: string }>(),
        events: {
          FILL: types<{ value: string }>(),
          NEXT: types<{}>(),
          BACK: types<{}>(),
        },
      },
      context: { name: '', error: '' },
      initial: 'name',
      states: {
        name: {
          on: {
            FILL: ({ event }) => ({
              context: { name: event.value, error: '' },
            }),
            NEXT: ({ context }) =>
              Boolean(context.name)
                ? { target: 'review', context: { error: '' } }
                : { context: { error: 'name is required' } },
          },
        },
        review: {
          on: { BACK: () => ({ target: 'name', context: { error: '' } }) },
        },
      },
    })
    const page = new FakeFormPage()

    yield* Effect.promise(() =>
      propertyTest(formMachine, {
        seed: 1,
        numRuns: 25,
        maxCommands: 8,
        events: {
          FILL: fc.record({
            value: fc.constantFrom('', 'Ada', 'ada@example.com'),
          }),
          NEXT: fc.constant({}),
          BACK: fc.constant({}),
        },
        sut: createPlaywrightSut(page, {
          reset: (page) => page.goto('/'),
          events: {
            FILL: (page, event) => page.fill('#field', event.value),
            NEXT: (page) => page.click('#next'),
            BACK: (page) => page.click('#back'),
          },
          read: (page) =>
            Promise.all([
              page.locator('#step').textContent(),
              page.locator('#error').textContent(),
            ]).then(([step, error]) => ({ step, error })),
          projectModel: (snapshot) => ({
            step: String(snapshot.value),
            error: snapshot.context.error,
          }),
        }),
      })
    )
    yield* expect({
      gotos: page.gotos,
      loadStates: [...new Set(page.loadStates)],
    }).toEqual({ gotos: 25, loadStates: ['load'] })
  })

  it('Test a web page with Playwright: mocks per case', function*({
    expect,
  }) {
    const machine = createMachine({
      schemas: { events: { SUBMIT: types<{}>() } },
      on: { SUBMIT: {} },
    })
    const page = new FakeFormPage()
    const read = () => null
    const projectModel = () => null

    yield* Effect.promise(() =>
      propertyTest(machine, {
        seed: 1,
        numRuns: 10,
        events: {
          SUBMIT: [
            { case: 'ok', generate: fc.constant({}) },
            { case: 'error', generate: fc.constant({}) },
          ],
        },
        sut: createPlaywrightSut(page, {
          events: { SUBMIT: (page) => page.click('#submit') },
          mocks: {
            'SUBMIT.ok': (page) => page.route('**/api/submit', (route: FakeRoute) => route.fulfill({ status: 200 })),
            'SUBMIT.error': (page) => page.route('**/api/submit', (route: FakeRoute) => route.fulfill({ status: 500 })),
          },
          read,
          projectModel,
        }),
      })
    )
    yield* expect({
      hasRoutes: page.routes.length > 0,
      installed: page.installed,
    }).toEqual({ hasRoutes: true, installed: [] })
  })

  it('Gate CI on coverage', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        sut: cartSut,
      })
    )
    assertTestCoverage(coverage, { transitions: 1, stateNodes: 1 })

    const until = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        sut: cartSut,
        until: { transitions: 1 },
        maxRuns: 500,
      })
    )
    yield* expect({
      stoppedBecause: until.coverage.exploration.stoppedBecause,
      markdownTable: formatTestCoverage(coverage, { format: 'markdown' }).includes(
        '|',
      ),
      jsonFormatVersion: JSON.stringify(testCoverageToJSON(coverage)).includes(
        '"formatVersion":1',
      ),
      junitTestcase: formatTestCoverageJUnit(coverage, { suiteName: 'cart' })
        .includes('<testcase'),
      htmlTitle: formatTestCoverageHTML(coverage, { title: 'Cart' }).includes(
        '<title>Cart</title>',
      ),
    }).toEqual({
      stoppedBecause: 'until',
      markdownTable: true,
      jsonFormatVersion: true,
      junitTestcase: true,
      htmlTitle: true,
    })

    const labelled = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        invariant: ({ snapshot, classify }) => {
          classify(Object.keys(snapshot.context.items).length >= 2, 'two-skus')
        },
        expectLabels: { 'two-skus': { min: 0.1 } },
      })
    )
    const twoSkusLabel = labelled.coverage.labels['two-skus']
    if (twoSkusLabel === undefined) {
      throw new Error('expected the two-skus label statistics')
    }
    yield* expect(twoSkusLabel.share).toBeGreaterThanOrEqual(0.1)
  })

  it('Replay a failure', function*({ expect }) {
    const failure = yield* rejectionOf(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        sut: createCartSut({ buggy: true }),
      })
    )
    if (!(failure instanceof ModelTestFailure)) {
      throw new Error(`expected a ModelTestFailure, got ${String(failure)}`)
    }
    yield* expect({
      summary: failure.summary,
      generatorLine: failure.message.includes(
        [
          '2. generator REMOVE {"sku":"pear"} -> {"value":"shopping","context":{"items":{}}}',
          '   sut diverged',
          '     model:    {}',
          '     observed: {"pear":0}',
        ].join('\n'),
      ),
      reproduceLine: failure.message.includes(
        'Reproduce: seed 1, path "1:2:1:2:3", replayPath "N:B"',
      ),
      fixtureFormatVersion: failure.fixture?.formatVersion,
    }).toEqual({
      summary: 'Property observation diverged',
      generatorLine: true,
      reproduceLine: true,
      fixtureFormatVersion: 2,
    })
    const fixture = JSON.parse(JSON.stringify(failure.fixture)) as TestFixture

    const buggyReplay = yield* rejectionOf(() =>
      replayTest(cartMachine, fixture, { sut: createCartSut({ buggy: true }) })
    )
    yield* expect(buggyReplay).toSatisfy(
      (error) => error instanceof ModelTestFailure,
      'replaying the recorded failure under the bug still raises ModelTestFailure',
    )

    const noRepro = yield* rejectionOf(() => replayTest(cartMachine, fixture, { sut: cartSut }))
    yield* expect(noRepro).toSatisfy(
      (error) => error instanceof ReplayNotReproducedError,
      'replaying a fixed failure raises ReplayNotReproducedError',
    )
    yield* Effect.promise(() => replayTest(cartMachine, fixture, { sut: cartSut, expect: 'pass' }))

    const replay = failure.replay
    if (replay === undefined) {
      throw new Error('expected a recorded replay')
    }
    const replayError = yield* rejectionOf(() =>
      propertyTest(cartMachine, {
        events,
        sut: createCartSut({ buggy: true }),
        ...(replay.seed === undefined ? {} : { seed: replay.seed }),
        ...(replay.path === undefined ? {} : { path: replay.path }),
        ...(replay.replayPath === undefined
          ? {}
          : { replayPath: replay.replayPath }),
      })
    )
    yield* expect(replayError).toSatisfy(
      (error) => error instanceof ModelTestFailure,
      'the recorded replay still raises ModelTestFailure',
    )
  })

  it('Record an offline regression suite', function*({ expect }) {
    const suite = yield* Effect.promise(() =>
      generateTestSuite(cartMachine, {
        seed: 1,
        numRuns: 200,
        events,
        sut: cartSut,
      })
    )
    const json = serializeTestSuite(suite)
    const parsed = parseTestSuiteFromGraph(json)

    const registered: string[] = []
    const bodies: (() => Promise<void> | void)[] = []
    describeTestSuiteFromGraph(parsed, cartMachine, {
      invariant: () => {},
      sut: cartSut,
      it: (name, fn) => {
        registered.push(name)
        bodies.push(fn)
      },
      describe: (_name, fn) => fn(),
    })
    yield* expect(registered.length).toEqual(parsed.fixtures.length)
    for (const body of bodies) {
      yield* Effect.promise(() => Promise.resolve(body()))
    }
  })

  it('Test concurrency', function*({ expect }) {
    const schedulerError = yield* rejectionOf(() =>
      propertyTest(counterMachine, {
        seed: 1,
        numRuns: 50,
        scheduler: true,
        deriveEvents: false,
        events: { INC: fc.record({ by: fc.constant(1) }) },
        sut: withScheduledSut({
          create: () => {
            const scheduler = getCurrentScheduler()!
            let count = 0
            return {
              send: () => {
                void scheduler
                  .schedule(Promise.resolve(), 'commit')
                  .then(() => {
                    count++
                  })
              },
              read: () => count,
            }
          },
          projectModel: (snapshot) => snapshot.context['count'],
        }),
      })
    )
    const result = checkLinearizable(
      [
        {
          id: 'a',
          invocation: { type: 'write', value: 1 },
          response: undefined,
          start: 0,
          end: 4,
        },
        {
          id: 'b',
          invocation: { type: 'read' },
          response: 1,
          start: 1,
          end: 5,
        },
      ],
      {
        initial: 0,
        apply: (state: number, event: { type: string; value?: number }) =>
          event.type === 'write'
            ? { state: event.value!, response: undefined }
            : { state, response: state },
      },
    )
    const parallel = yield* Effect.promise(() =>
      runParallelPropertyCommands(counterMachine, {
        prefix: [{ type: 'INC', by: 1 }],
        branches: [[{ type: 'INC', by: 1 }], [{ type: 'INC', by: 2 }]],
        sut: {
          create: () => {
            let count = 0
            return {
              send: (event) => (count += event.type === 'INC' ? event.by : 0),
            }
          },
          projectModel: (snapshot) => snapshot.context['count'],
        },
      })
    )
    yield* expect({
      schedulerFailure: schedulerError instanceof ModelTestFailure,
      linearizable: result.linearizable,
      witness: result.witness?.map((entry) => entry.id),
      parallelLinearizable: parallel.linearizable,
    }).toEqual({
      schedulerFailure: true,
      linearizable: true,
      witness: ['a', 'b'],
      parallelLinearizable: true,
    })
  })

  it('Steer exploration', function*({ expect }) {
    const weighted = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 20,
        events: {
          ADD: { generate: fc.record({ sku }), weight: 5 },
          REMOVE: fc.record({ sku }),
          CHECKOUT: { generate: fc.constant({}), weight: 0.5 },
        },
      })
    )
    const cases = weighted.coverage.eventCases
    yield* expect(Object.values(cases).map(({ weight }) => weight)).toEqual(
      expect.arrayContaining([5, 1, 0.5]),
    )

    const frontier = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        frontiers: {
          paths: getShortestPaths(cartMachine, {
            toState: (snapshot) => Object.keys(snapshot.context.items).length > 0,
            stopWhen: (snapshot) => Object.values(snapshot.context.items).some((qty) => qty >= 2),
          }),
          runsPerFrontier: 50,
        },
      })
    )
    yield* expect(frontier.coverage.exploration.frontiers.length).toBeGreaterThan(
      0,
    )

    const auto = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        frontiers: 'auto',
        until: { transitions: 1 },
        maxRuns: 200,
      })
    )
    yield* expect(auto.coverage.exploration.stoppedBecause).toBe('until')

    const swarm = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 20,
        events,
        swarm: true,
      })
    )
    yield* expect(swarm.coverage.exploration.swarm?.runs).toBeGreaterThan(0)

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        target: ({ snapshot }) => snapshot.context.items['apple'] ?? 0,
        frontiers: { strategy: 'target' },
        until: (coverage) => coverage.exploration.target.best >= 8,
        maxRuns: 400,
      })
    )
    yield* expect(coverage.exploration.target.best).toBeGreaterThan(0)
  })

  it('Start from a snapshot or input', function*({ expect }) {
    const [cartWithApple] = transition(
      cartMachine,
      initialTransition(cartMachine)[0],
      { type: 'ADD', sku: 'apple' },
    )

    const initialItems: unknown[] = []
    yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 5,
        events,
        start: {
          snapshot: cartWithApple,
          serializeSnapshot: (snapshot) => snapshot.context,
        },
        invariant: ({ initialSnapshot }) => {
          initialItems.push(initialSnapshot.context.items)
        },
      })
    )
    yield* expect(initialItems[0]).toEqual({ apple: 1 })
  })
})

describe('README: Migrating from @xstate/test 0.x and 1.0 beta', () => {
  const signupMachine = createMachine({
    id: 'signup',
    schemas: { events: { SUBMIT: types<{}>() } },
    initial: 'editing',
    states: {
      editing: { on: { SUBMIT: { target: 'submitted' } } },
      submitted: {},
    },
  })

  it('From 1.0 beta', function*({ expect }) {
    const clicked: string[] = []
    const checked: string[] = []
    const page = {
      click: (selector: string) => {
        clicked.push(selector)
      },
    }

    for (const path of getShortestPaths(signupMachine)) {
      yield* Effect.promise(() =>
        testPaths(signupMachine, {
          paths: [path],
          sut: {
            create: () => ({
              send: (event) => event.type === 'SUBMIT' ? page.click('#submit') : undefined,
              states: {
                submitted: () => {
                  checked.push('submitted')
                },
              },
            }),
          },
        })
      )
    }
    yield* expect({ clicked, checked }).toEqual({
      clicked: ['#submit'],
      checked: ['submitted'],
    })
  })

  it('From 0.x', function*({ expect }) {
    const skuMachine = createMachine({
      schemas: {
        context: types<{ skus: string[] }>(),
        events: { ADD: types<{ sku: string }>() },
      },
      context: { skus: [] },
      on: {
        ADD: ({ context, event }) =>
          context.skus.includes(event.sku)
            ? undefined
            : { context: { skus: [...context.skus, event.sku] } },
      },
    })
    const filled: string[] = []
    const page = {
      fill: (_selector: string, value: string) => {
        filled.push(value)
      },
    }

    yield* Effect.promise(() =>
      testPaths(skuMachine, {
        events: {
          ADD: [
            { case: 'apple', generate: fc.constant({ sku: 'apple' }) },
            { case: 'pear', generate: fc.constant({ sku: 'pear' }) },
          ],
        },
        samples: 1,
        sut: {
          create: () => ({ send: (event) => page.fill('#sku', event.sku) }),
        },
      })
    )
    yield* expect(new Set(filled)).toEqual(new Set(['apple', 'pear']))
  })
})

const payingCartMachine = setup({
  schemas: {
    context: types<{
      items: Record<string, number>
      lastError: string | null
    }>(),
    events: {
      ADD: types<{ sku: string }>(),
      CHECKOUT: types<{}>(),
    },
  },
  actors: {
    pay: createAsyncLogic({ run: () => Promise.resolve({}) }),
  },
}).createMachine({
  id: 'cart',
  context: { items: {}, lastError: null },
  initial: 'shopping',
  states: {
    shopping: {
      on: {
        ADD: ({ context, event }) => ({
          context: {
            ...context,
            items: {
              ...context.items,
              [event.sku]: (context.items[event.sku] ?? 0) + 1,
            },
          },
        }),
        CHECKOUT: ({ context }) =>
          Boolean(Object.keys(context.items).length)
            ? { target: 'paying' }
            : undefined,
      },
    },
    paying: {
      invoke: {
        src: 'pay',
        onDone: { target: 'done' },
        onError: ({ context, event }) => ({
          target: 'shopping',
          context: { ...context, lastError: String(event.error) },
        }),
      },
    },
    done: { type: 'final' },
  },
})

const failuresDir = mkdtempSync(join(tmpdir(), 'xstate-test-docs-'))
afterAll(() => {
  rmSync(failuresDir, { recursive: true, force: true })
})

describe('README: Concepts (pick)', () => {
  it('Events: pick()', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events: {
          ...events,
          REMOVE: pick(
            (snapshot) => Object.keys(snapshot.context.items),
            (sku) => ({ sku }),
          ),
        },
        sut: cartSut,
      })
    )
    const remove = coverage.eventCases['["event-case","REMOVE","default"]']
    if (remove === undefined) {
      throw new Error('expected the REMOVE event case coverage')
    }
    yield* expect({
      executed: remove.executed > 0,
      ignored: remove.ignored > 0,
    }).toEqual({ executed: true, ignored: true })
  })
})

describe('README: Concepts (events)', () => {
  const checkoutCase = '["event-case","CHECKOUT","default"]'

  it('sends events the current state has no transition for', function*({
    expect,
  }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 10,
        events: { CHECKOUT: fc.constant({}) },
        sut: cartSut,
      })
    )
    const checkout = coverage.eventCases[checkoutCase]
    if (checkout === undefined) {
      throw new Error('expected the CHECKOUT event case coverage')
    }
    yield* expect({
      executed: checkout.executed > 0,
      ignored: checkout.ignored,
    }).toEqual({ executed: true, ignored: 0 })
  })

  it('skips unhandled events with snapshot.can(event)', function*({ expect }) {
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        numRuns: 10,
        events: {
          CHECKOUT: {
            generate: fc.constant({}),
            when: ({ snapshot, event }) => snapshot.can(event),
          },
        },
        sut: cartSut,
      })
    )
    const checkout = coverage.eventCases[checkoutCase]
    if (checkout === undefined) {
      throw new Error('expected the CHECKOUT event case coverage')
    }
    yield* expect({
      generated: checkout.generated > 0,
      executed: checkout.executed,
      ignored: checkout.ignored,
    }).toEqual({
      generated: true,
      executed: 0,
      ignored: checkout.generated,
    })
  })
})

describe('README: How-to guides (oracles, failures, and Vitest)', () => {
  it('Test a web page with Playwright: page oracles', function*({ expect }) {
    const page = new FakePage()
    const sut = createPlaywrightSut(page, {
      events: { INC: (page) => page.click('#inc') },
      read: (page) => page.app.count,
      projectModel: () => 0,
      oracles: {
        pageError: true,
        console: 'warn',
        http: 500,
        unhandledRejection: true,
      },
    })
    const session = yield* Effect.promise(() => Promise.resolve(sut.create({} as never)))
    page.emitResponse(404, '/missing')
    page.emitConsole('warning', 'careful')
    const oracleError = yield* rejectionOf(() => session.check!())
    yield* expect(oracleError).toMatchObject({
      name: 'PlaywrightOracleError',
      messages: ['console.warning: careful'],
    })
    yield* Effect.promise(() => Promise.resolve(session.dispose!({ passed: true })))
  })

  it('Test a web page with Playwright: failure artifacts', function*({
    expect,
  }) {
    const counterMachine = createMachine({
      schemas: {
        context: types<{ count: number }>(),
        events: { INC: types<{}>() },
      },
      context: { count: 0 },
      on: { INC: ({ context }) => ({ context: { count: context.count + 1 } }) },
    })
    const page = new FakePage({ broken: true })
    const testInfo = new FakeTestInfo()
    const steps: string[] = []
    const test = {
      step: (name: string, body: () => Promise<void>) => {
        steps.push(name)
        return body()
      },
    }

    const error = yield* rejectionOf(() =>
      propertyTest(counterMachine, {
        seed: 1,
        events: { INC: fc.constant({}) },
        sut: createPlaywrightSut(page, {
          reset: (page) => page.click('#reset'),
          events: { INC: (page) => page.click('#inc') },
          read: (page) => page.app.count,
          projectModel: (snapshot) => snapshot.context.count,
          testInfo,
          step: (name, body) => test.step(name, body),
        }),
      })
    )
    yield* expect({
      isModelTestFailure: error instanceof ModelTestFailure,
      hasIncStep: steps.includes('INC'),
      attachments: testInfo.attachments.map(({ name }) => name),
    }).toEqual({
      isModelTestFailure: true,
      hasIncStep: true,
      attachments: ['fixture.json', 'trace', 'failure.png'],
    })
  })

  it('Check liveness and reachability', function*({ expect }) {
    const sku = fc.constantFrom('apple', 'pear')
    const whileShopping = ({
      snapshot,
    }: {
      snapshot: SnapshotFrom<typeof payingCartMachine>
    }) => snapshot.matches('shopping')

    const { coverage } = yield* Effect.promise(() =>
      propertyTest(payingCartMachine, {
        seed: 1,
        events: {
          ADD: { generate: fc.record({ sku }), when: whileShopping },
          CHECKOUT: { generate: fc.constant({}), when: whileShopping },
        },
        mode: 'executed',
        outcomes: {
          pay: fc.oneof(
            fc.constant({ ok: true as const, output: {} }),
            fc.constant({ ok: false as const, error: 'declined' }),
          ),
        },
        temporal: [
          {
            type: 'respond',
            id: 'payment-settles',
            within: 1,
            trigger: ({ snapshot }) => snapshot.matches('paying'),
            response: ({ snapshot }) => !snapshot.matches('paying'),
          },
          {
            type: 'sometimes',
            id: 'declined',
            predicate: ({ snapshot }) => snapshot.context.lastError !== null,
          },
        ],
        reachable: ['#cart.done'],
      })
    )
    yield* expect(coverage.temporal.satisfied).toEqual([
      'declined',
      'payment-settles',
      'reachable:#cart.done',
    ])

    const campaignError = yield* rejectionOf(() =>
      propertyTest(payingCartMachine, {
        seed: 1,
        events: { ADD: fc.record({ sku }) },
        mode: 'executed',
        outcomes: { pay: fc.constant({ ok: true as const, output: {} }) },
        temporal: [
          {
            type: 'sometimes',
            id: 'declined',
            predicate: ({ snapshot }) => snapshot.context.lastError !== null,
          },
        ],
        reachable: ['#cart.done'],
      })
    )
    yield* expect({
      isTestCampaignError: campaignError instanceof TestCampaignError,
      message: campaignError instanceof Error
        ? campaignError.message
        : String(campaignError),
    }).toEqual({
      isTestCampaignError: true,
      message: [
        'Campaign assertions failed:',
        '  - sometimes "declined" did not hold in 100 run(s)',
        '  - reachable "#cart.done" was not entered in 100 run(s)',
      ].join('\n'),
    })

    const vacuous = yield* Effect.promise(() =>
      propertyTest(payingCartMachine, {
        seed: 1,
        maxCommands: 10,
        events: { ADD: fc.record({ sku }) },
        temporal: [
          {
            type: 'eventually',
            id: 'checks-out',
            within: 20,
            predicate: ({ snapshot }) => snapshot.matches('done'),
          },
        ],
      })
    )
    yield* expect(formatTestCoverage(vacuous.coverage)).toContain(
      '  warning: eventually "checks-out" has within 20, but the longest sequence is 10 steps, so it can never fail',
    )
  })

  it('Inspect the distribution of generated data', function*({ expect }) {
    const reports: string[] = []
    yield* Effect.promise(() =>
      propertyTest(cartMachine, {
        seed: 1,
        events,
        statistics: (report) => {
          reports.push(report)
        },
        invariant: ({ snapshot, classify }) => {
          classify(Object.keys(snapshot.context.items).length >= 2, 'two-skus')
        },
      })
    )
    yield* expect(reports).toEqual([STATISTICS_OUTPUT])
  })

  it('Save failures and replay them first', function*({ expect }) {
    const dir = join(failuresDir, '.xstate-test')
    const options = {
      seed: 1,
      events,
      failures: { dir, key: 'cart-store' },
    }
    const failure = yield* rejectionOf(() =>
      propertyTest(cartMachine, {
        ...options,
        sut: createCartSut({ buggy: true }),
      })
    )
    if (!(failure instanceof ModelTestFailure)) {
      throw new Error(`expected a ModelTestFailure, got ${String(failure)}`)
    }
    yield* expect(failure.message).toMatch(
      new RegExp(`\nSaved: ${dir}/cart-store/[0-9a-f]{12}\\.json\n`),
    )
    const [saved] = readdirSync(join(dir, 'cart-store'))
    if (saved === undefined) {
      throw new Error('expected a saved failure file')
    }

    const replayed = yield* rejectionOf(() =>
      propertyTest(cartMachine, {
        ...options,
        sut: createCartSut({ buggy: true }),
      })
    )
    yield* expect(
      replayed instanceof Error ? replayed.message : String(replayed),
    ).toContain(
      `Property observation diverged (replayed from ${join(dir, 'cart-store', saved)})`,
    )

    yield* Effect.promise(() => propertyTest(cartMachine, { ...options, sut: cartSut }))
    yield* expect(readdirSync(join(dir, 'cart-store'))).toEqual([])
  })
})

const STATISTICS_OUTPUT = [
  'Test statistics (100 runs)',
  '',
  'event cases (share of executed events):',
  '   32.6%  ADD / default: 115 executed, 39 ignored',
  '   35.7%  CHECKOUT / default: 126 executed, 44 ignored',
  '   31.7%  REMOVE / default: 112 executed, 35 ignored',
  '',
  'labels (share of runs):',
  '   14.0%  two-skus: 26 recorded',
].join('\n')

interface FakeRoute {
  fulfill: (response: { status: number }) => void
}

class FakeFormPage {
  public gotos = 0
  public readonly loadStates: string[] = []
  public readonly routes: string[] = []
  public installed: unknown[] = []
  private step = 'name'
  private name = ''
  private error = ''
  private field = ''

  public goto(_url: string): Promise<void> {
    this.gotos++
    this.step = 'name'
    this.name = ''
    this.error = ''
    this.field = ''
    return Promise.resolve()
  }

  public fill(_selector: string, value: string): Promise<void> {
    this.field = value
    if (this.step === 'name') {
      this.name = value
      this.error = ''
    }
    return Promise.resolve()
  }

  public click(selector: string): Promise<void> {
    if (selector === '#next' && this.step === 'name') {
      if (Boolean(this.name)) {
        this.step = 'review'
        this.error = ''
      } else {
        this.error = 'name is required'
      }
    } else if (selector === '#back' && this.step === 'review') {
      this.step = 'name'
      this.error = ''
    }
    return Promise.resolve()
  }

  public locator(selector: string) {
    return {
      textContent: (): Promise<string | null> =>
        Promise.resolve(
          selector === '#step'
            ? this.step
            : selector === '#error'
            ? this.error
            : this.field,
        ),
    }
  }

  public waitForLoadState(state?: string): Promise<void> {
    this.loadStates.push(state ?? 'load')
    return Promise.resolve()
  }

  public route(
    url: string,
    handler: (route: FakeRoute) => void,
  ): Promise<void> {
    this.routes.push(url)
    this.installed.push(handler)
    return Promise.resolve()
  }

  public unroute(_url: string, handler?: unknown): Promise<void> {
    this.installed = this.installed.filter((entry) => entry !== handler)
    return Promise.resolve()
  }
}
