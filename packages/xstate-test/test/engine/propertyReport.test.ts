import { describe, it } from '@systemfsoftware/vitest'
import { createMachine } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import {
  assertTestCoverage,
  formatTestCoverage,
  formatTestCoverageHTML,
  formatTestCoverageJUnit,
  propertyTest,
  type TestCoverage,
  testCoverageToJSON,
} from '../../src/engine/index.js'
import { constant, randomAdapter } from './propertyTestAdapter.js'

const lightMachine = createMachine({
  id: 'light',
  initial: 'green',
  states: {
    green: {
      on: { NEXT: { target: 'yellow' } },
    },
    yellow: {
      on: { NEXT: { target: 'green' } },
    },
    broken: {
      on: { NEXT: { target: 'green' } },
    },
  },
})

const getCoverage = (): Promise<TestCoverage> =>
  propertyTest(lightMachine, {
    adapter: randomAdapter({ seed: 1, numRuns: 3, maxCommands: 3 }),
    events: { NEXT: constant({}) },
    invariant: () => {},
  }).then(({ coverage }) => coverage)

function thrownBy(run: () => void): Error | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error as Error
  }
}

function entriesOf(dimension: TestCoverage['stateNodes']): number {
  return (
    dimension.covered.length +
    dimension.uncovered.length +
    dimension.unreachable.length +
    dimension.unknown.length
  )
}

const matchingLines = (text: string, match: (line: string) => boolean): string[] => text.split('\n').filter(match)

describe('property coverage reports', () => {
  it('formats coverage as text', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())
    const text = formatTestCoverage(coverage)

    yield* expect({
      header: text.split('\n')[0],
      stateNodes: matchingLines(text, (line) => line.startsWith('stateNodes:')),
      unreachableTitle: matchingLines(
        text,
        (line) => line === 'unreachable stateNodes:',
      ),
      unreachableNodes: matchingLines(
        text,
        (line) => line === '  - light.broken',
      ),
      explorationTitle: matchingLines(text, (line) => line === 'exploration:'),
      explorationRuns: matchingLines(text, (line) => line.startsWith('  runs: configured')),
    }).toEqual({
      header: 'Test coverage',
      stateNodes: [
        expect.stringMatching(
          /^stateNodes: \d+\/\d+ covered \(\d+\.\d%\), \d+ uncovered, \d+ unreachable, \d+ unknown$/,
        ),
      ],
      unreachableTitle: ['unreachable stateNodes:'],
      unreachableNodes: ['  - light.broken'],
      explorationTitle: ['exploration:'],
      explorationRuns: [
        '  runs: configured 3, completed 3, attempted 3',
      ],
    })
  })

  it('formats coverage as markdown tables', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())
    const markdown = formatTestCoverage(coverage, { format: 'markdown' })
    const lines = markdown.split('\n')
    const exactly = (line: string) => lines.filter((candidate) => candidate === line)

    yield* expect({
      header: lines[0],
      dimensionHeader: exactly(
        '| Dimension | Covered | Total | Ratio | Uncovered | Unreachable | Unknown |',
      ),
      outstanding: exactly('## Outstanding'),
      unreachableRow: exactly('| stateNodes | unreachable | light.broken |'),
      exploration: exactly('## Exploration'),
    }).toEqual({
      header: '# Test coverage',
      dimensionHeader: [
        '| Dimension | Covered | Total | Ratio | Uncovered | Unreachable | Unknown |',
      ],
      outstanding: ['## Outstanding'],
      unreachableRow: ['| stateNodes | unreachable | light.broken |'],
      exploration: ['## Exploration'],
    })
  })

  it('renders transition ids readably', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())

    yield* expect(formatTestCoverage(coverage)).toContain('--NEXT--> #0')
  })

  it('produces stable JSON that round-trips', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())
    const json = testCoverageToJSON(coverage)
    const stateNodes = json.dimensions['stateNodes']
    if (stateNodes === undefined) {
      throw new Error('expected a stateNodes dimension')
    }

    yield* expect({
      formatVersion: json.formatVersion,
      roundTrip: JSON.parse(JSON.stringify(json)),
      totalsRuns: json.totals.runs,
      stateNodesTotal: stateNodes.total,
      unreachable: stateNodes.unreachable,
      completedRuns: json.exploration.completedRuns,
    }).toEqual({
      formatVersion: 1,
      roundTrip: json,
      totalsRuns: coverage.runs,
      stateNodesTotal: entriesOf(coverage.stateNodes),
      unreachable: expect.arrayContaining(['light.broken']),
      completedRuns: 3,
    })
  })

  it('produces JUnit XML with one testcase per transition and state node', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())
    const xml = formatTestCoverageJUnit(coverage, { suiteName: 'light' })

    const expectedTests = entriesOf(coverage.transitions) +
      entriesOf(coverage.stateNodes)
    const expectedFailures = coverage.transitions.uncovered.length +
      coverage.stateNodes.uncovered.length
    const expectedSkipped = coverage.transitions.unreachable.length +
      coverage.transitions.unknown.length +
      coverage.stateNodes.unreachable.length +
      coverage.stateNodes.unknown.length

    yield* expect({
      declaration: xml.split('\n')[0],
      suiteTag: xml
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('<testsuite ')),
      testcases: xml.match(/<testcase /g)?.length ?? 0,
      failures: xml.match(/<failure /g)?.length ?? 0,
      skipped: xml.match(/<skipped /g)?.length ?? 0,
      stateNodeCases: xml.match(/classname="stateNodes"/g)?.length ?? 0,
      explorationProperties: xml
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('<property name="exploration.')),
      escapedTransitionIds: xml.match(/--NEXT--&gt; #0/g)?.length ?? 0,
      rawTransitionIds: xml.match(/--NEXT--> #0/g)?.length ?? 0,
    }).toEqual({
      declaration: '<?xml version="1.0" encoding="UTF-8"?>',
      suiteTag:
        `<testsuite name="light" tests="${expectedTests}" failures="${expectedFailures}" skipped="${expectedSkipped}">`,
      testcases: expectedTests,
      failures: expectedFailures,
      skipped: expectedSkipped,
      stateNodeCases: entriesOf(coverage.stateNodes),
      explorationProperties: expect.arrayContaining([
        '<property name="exploration.0" value="runs: configured 3, completed 3, attempted 3" />',
      ]),
      escapedTransitionIds: entriesOf(coverage.transitions),
      rawTransitionIds: 0,
    })
  })

  it('produces self-contained HTML', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())
    const html = formatTestCoverageHTML(coverage, { title: 'Light coverage' })
    const matching = (match: (line: string) => boolean) => matchingLines(html, match)

    yield* expect({
      title: matching((line) => line.includes('<title>')),
      heading: matching((line) => line.includes('<h1>')),
      runs: matching((line) => line.includes('3 runs')),
      unreachableNode: matching((line) => line.includes('light.broken')),
      scriptTag: matching((line) => line.includes('<script')),
      absoluteUrl: matching((line) => line.includes('http://')),
    }).toEqual({
      title: ['<title>Light coverage</title>'],
      heading: ['<h1>Light coverage</h1>'],
      runs: [expect.stringMatching(/^<p>3 runs, \d+ steps, \d+ invariant checks<\/p>$/)],
      unreachableNode: [expect.stringMatching(/light\.broken/)],
      scriptTag: [],
      absoluteUrl: [],
    })
  })

  it('passes and fails coverage thresholds', function*({ expect }) {
    const coverage = yield* Effect.promise(() => getCoverage())

    const starved: TestCoverage = {
      ...coverage,
      stateNodes: {
        ...coverage.stateNodes,
        covered: [],
        uncovered: [...coverage.stateNodes.covered],
      },
    }

    const satisfied = thrownBy(() => assertTestCoverage(coverage, { stateNodes: 1, transitions: 1 }))
    const starvedFailure = thrownBy(() => assertTestCoverage(starved, { stateNodes: 0.5 }))

    yield* expect({
      satisfied,
      starvedThresholdSection: starvedFailure?.message.split('\n\n')[0],
      starvedReportHeader: starvedFailure?.message
        .split('\n\n')[1]
        ?.split('\n')[0],
    }).toEqual({
      satisfied: undefined,
      starvedThresholdSection:
        'Test coverage thresholds not met:\n  - stateNodes: 0.0% covered, below the 50.0% threshold',
      starvedReportHeader: 'Test coverage',
    })
  })
})
