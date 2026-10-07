import { assertEquals } from '@std/assert'
import {
  type CaseLeaves,
  caseLeavesIn,
  countLeaves,
  decodeReport,
  leavesComparison,
  packageRelative,
  parity,
  parseSource,
  type VitestReport,
} from './asserted-leaves.ts'

const leaves = (source: string): readonly CaseLeaves[] => caseLeavesIn(parseSource('sample.test.ts', source))

Deno.test('a merged object literal asserts one leaf per field', () => {
  const cases = leaves([
    "import { expect, it } from 'vitest'",
    "it('merges', () => {",
    '  expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 2 })',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'merges', leaves: 2, typeLeaves: 0 }])
})

Deno.test('a non-literal actual and expected count one leaf', () => {
  const cases = leaves([
    "import { expect, it } from 'vitest'",
    "it('one', () => {",
    '  expect(value).toEqual(other)',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'one', leaves: 1, typeLeaves: 0 }])
})

Deno.test('an expected literal asserts one leaf per field when the actual is not a literal', () => {
  const cases = leaves([
    "it('id', () => {",
    '  expect(record).toEqual({ a: 1, b: 2, c: 3 })',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'id', leaves: 3, typeLeaves: 0 }])
})

Deno.test('two literals count the larger field set', () => {
  const cases = leaves([
    "it('max', () => {",
    '  expect({ a: 1 }).toEqual({ a: 1, b: 2, c: 3 })',
    '  expect({ a: 1, b: 2, c: 3 }).toStrictEqual({ a: 1 })',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'max', leaves: 6, typeLeaves: 0 }])
})

Deno.test('a non-slot matcher with a literal argument stays one leaf', () => {
  const cases = leaves([
    "it('toBe', () => {",
    '  expect(value).toBe({ a: 1, b: 2 })',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'toBe', leaves: 1, typeLeaves: 0 }])
})

Deno.test('a nested literal counts its leaves recursively', () => {
  const cases = leaves([
    "it('nested', () => {",
    "  expect({ onSubscribe, afterClick, n }).toEqual({ onSubscribe: ['a'], afterClick: ['a', 'b'], n: 2 })",
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'nested', leaves: 4, typeLeaves: 0 }])
})

Deno.test('an empty object literal counts one leaf', () => {
  const cases = leaves([
    "it('empty', () => {",
    '  expect(record).toEqual({})',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'empty', leaves: 1, typeLeaves: 0 }])
})

Deno.test('an objectContaining call counts one leaf', () => {
  const cases = leaves([
    "it('containing', () => {",
    '  expect(record).toEqual(expect.objectContaining({ a: 1, b: 2 }))',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'containing', leaves: 1, typeLeaves: 0 }])
})

Deno.test('an array literal actual counts one leaf per element', () => {
  const cases = leaves([
    "it('arr', () => {",
    '  expect([a, b, ...rest]).toEqual([1, 2])',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'arr', leaves: 2, typeLeaves: 0 }])
})

Deno.test('checks inside loops and closures count lexically', () => {
  const cases = leaves([
    "it('loops', () => {",
    '  for (const x of xs) {',
    '    expect(x).toBe(1)',
    '  }',
    '  xs.map((x) => expect(x).toBe(2))',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'loops', leaves: 2, typeLeaves: 0 }])
})

Deno.test('a case key joins the describe names and the test name', () => {
  const cases = leaves([
    "describe('outer', () => {",
    "  describe('inner', () => {",
    "    it('does a thing', () => {})",
    '  })',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases.map((kase) => kase.key), ['outer inner does a thing'])
})

Deno.test('an .each case uses its name template', () => {
  const cases = leaves([
    "it.each([[1, 2]])('row %i', (row) => {",
    '  expect(row).toBe(1)',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'row %i', leaves: 1, typeLeaves: 0 }])
})

Deno.test('modifier forms are still cases', () => {
  const cases = leaves([
    "it.skip('skipped', () => {})",
    "it.todo('todo')",
    "it.only('only', () => {})",
    "it.fails('fails', () => {})",
    "it.skipIf(true)('cond', () => {})",
    "it.runIf(true)('run', () => {})",
    "it.live('live', () => {})",
    '',
  ].join('\n'))
  assertEquals(cases.map((kase) => kase.key), [
    'skipped',
    'todo',
    'only',
    'fails',
    'cond',
    'run',
    'live',
  ])
})

Deno.test('expectTypeOf chains and @ts-expect-error comments are type leaves', () => {
  const cases = leaves([
    "it('types', () => {",
    '  // @ts-expect-error the name is wrong',
    '  expectTypeOf<string>().toEqualTypeOf<number>()',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'types', leaves: 0, typeLeaves: 2 }])
})

Deno.test('countLeaves counts a callback with no body as zero', () => {
  assertEquals(countLeaves(undefined, []), { leaves: 0, typeLeaves: 0 })
})

Deno.test('a leaf count table is drawn from source text', () => {
  const cases = leaves([
    "it('a', () => {",
    '  expect(1).toBe(1)',
    '})',
    '',
  ].join('\n'))
  assertEquals(cases, [{ key: 'a', leaves: 1, typeLeaves: 0 }])
})

Deno.test('a base case missing from the head fails the comparison', () => {
  const before: readonly CaseLeaves[] = [{ key: 'a', leaves: 1, typeLeaves: 0 }]
  const outcome = leavesComparison('f.ts', before, [])
  assertEquals(outcome.ok, false)
  assertEquals(outcome.failures, ['f.ts: case missing from the head: a'])
})

Deno.test('fewer leaves after fails the comparison', () => {
  const before: readonly CaseLeaves[] = [{ key: 'a', leaves: 2, typeLeaves: 0 }]
  const after: readonly CaseLeaves[] = [{ key: 'a', leaves: 1, typeLeaves: 0 }]
  const outcome = leavesComparison('f.ts', before, after)
  assertEquals(outcome.ok, false)
  assertEquals(outcome.failures, ['f.ts: a: leaves fell from 2 to 1'])
})

Deno.test('fewer type leaves after fails the comparison', () => {
  const before: readonly CaseLeaves[] = [{ key: 'a', leaves: 1, typeLeaves: 2 }]
  const after: readonly CaseLeaves[] = [{ key: 'a', leaves: 1, typeLeaves: 1 }]
  const outcome = leavesComparison('f.ts', before, after)
  assertEquals(outcome.failures, ['f.ts: a: type leaves fell from 2 to 1'])
})

Deno.test('an equal or strengthened case passes the comparison', () => {
  const before: readonly CaseLeaves[] = [{ key: 'a', leaves: 1, typeLeaves: 1 }]
  const after: readonly CaseLeaves[] = [{ key: 'a', leaves: 3, typeLeaves: 2 }]
  assertEquals(leavesComparison('f.ts', before, after).ok, true)
})

Deno.test('a report name relativises against the repo root or the package segment', () => {
  assertEquals(packageRelative('/repo/packages/x/src/a.test.ts', '/repo', 'packages/x'), 'packages/x/src/a.test.ts')
  assertEquals(
    packageRelative('/elsewhere/wt/packages/x/src/a.test.ts', '/repo', 'packages/x'),
    'packages/x/src/a.test.ts',
  )
  assertEquals(packageRelative('/repo/packages/y/src/a.test.ts', '/repo', 'packages/x'), undefined)
})

const report = (name: string, cases: ReadonlyArray<readonly [string, string]>): VitestReport => ({
  testResults: [{ name, assertionResults: cases.map(([fullName, status]) => ({ fullName, status })) }],
})

Deno.test('identical reports pass the parity check', () => {
  const before = report('/repo/packages/x/src/a.test.ts', [['a', 'passed'], ['b', 'skipped'], ['c', 'todo']])
  const outcome = parity(before, before, '/repo', 'packages/x')
  assertEquals(outcome.ok, true)
  assertEquals(outcome.rows, [{
    file: 'packages/x/src/a.test.ts',
    casesBefore: 3,
    casesAfter: 3,
    passedBefore: 1,
    passedAfter: 1,
    skippedBefore: 1,
    skippedAfter: 1,
    todoBefore: 1,
    todoAfter: 1,
    identical: true,
  }])
})

Deno.test('a changed status fails the parity check', () => {
  const before = report('/repo/packages/x/src/a.test.ts', [['a', 'passed']])
  const after = report('/repo/packages/x/src/a.test.ts', [['a', 'skipped']])
  const outcome = parity(before, after, '/repo', 'packages/x')
  assertEquals(outcome.ok, false)
  assertEquals(outcome.failures, ['packages/x/src/a.test.ts: status changed: a: passed -> skipped'])
})

Deno.test('a missing case fails the parity check', () => {
  const before = report('/repo/packages/x/src/a.test.ts', [['a', 'passed'], ['b', 'passed']])
  const after = report('/repo/packages/x/src/a.test.ts', [['a', 'passed']])
  assertEquals(parity(before, after, '/repo', 'packages/x').failures, [
    'packages/x/src/a.test.ts: case missing after: b',
  ])
})

Deno.test('an unreadable report decodes to a failure', () => {
  const decoded = decodeReport('{ not json')
  assertEquals(decoded._tag, 'Failure')
})
