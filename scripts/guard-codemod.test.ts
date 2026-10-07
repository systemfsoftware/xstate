import { assert, assertEquals } from '@std/assert'
import { rewrite } from './guard-codemod.ts'

const kindsOf = (source: string): readonly string[] => rewrite(source, 'f.ts').sites.map((site) => site.kind)

Deno.test('a vitest import splits into the fork import, a kept vitest import and a dropped expect', () => {
  const source = [
    "import { describe, expect, it, vi } from 'vitest'",
    "import { beforeEach } from 'vitest'",
    "import { expectTypeOf } from 'vitest'",
    '',
  ].join('\n')
  assertEquals(
    rewrite(source, 'f.ts').code,
    [
      "import { describe, it, vi } from '@systemfsoftware/vitest'",
      "import { beforeEach } from '@systemfsoftware/vitest'",
      "import { expectTypeOf } from '@systemfsoftware/vitest'",
      '',
    ].join('\n'),
  )
})

Deno.test('a name the fork does not re-export stays on vitest', () => {
  const source = "import { expect, it, somethingElse } from 'vitest'\n"
  assertEquals(
    rewrite(source, 'f.ts').code,
    "import { it } from '@systemfsoftware/vitest'\nimport { somethingElse } from 'vitest'\n",
  )
})

Deno.test('a sync callback becomes a generator and its awaits and checks are yielded', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('a', async () => {",
    '  const value = await fetchThing()',
    '  expect(value).toBe(1)',
    '})',
    '',
  ].join('\n')
  assertEquals(
    rewrite(source, 'f.ts').code,
    [
      "import { it } from '@systemfsoftware/vitest'",
      "import { Effect } from 'effect'",
      "it('a', function* ({ expect }) {",
      '  const value = yield* Effect.promise(() => fetchThing())',
      '  yield* expect(value).toBe(1)',
      '})',
      '',
    ].join('\n'),
  )
})

Deno.test('an await expect becomes a yielded check, not a promise', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('a', async () => {",
    '  await expect(save()).resolves.toBe(1)',
    '})',
    '',
  ].join('\n')
  const result = rewrite(source, 'f.ts')
  assert(result.sites.some((site) => site.kind === 'refused-matcher'))
  assert(!result.code.includes('Effect.promise'))
})

Deno.test('running the codemod twice changes nothing', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it.each([[1, 2]])('row %i', (row) => {",
    '  const value = await f(row)',
    '  expect(value).toBe(1)',
    '})',
    '',
  ].join('\n')
  const once = rewrite(source, 'f.ts').code
  assertEquals(rewrite(once, 'f.ts').code, once)
})

Deno.test('a .each row body takes the row first and the checks second', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it.each([[1, 2]])('row %i', (row) => {",
    '  expect(row).toBe(1)',
    '})',
    '',
  ].join('\n')
  assertEquals(
    rewrite(source, 'f.ts').code,
    [
      "import { it } from '@systemfsoftware/vitest'",
      "it.each([[1, 2]])('row %i', function* (row, { expect }) {",
      '  yield* expect(row).toBe(1)',
      '})',
      '',
    ].join('\n'),
  )
})

Deno.test('a check inside a nested callback is reported, never rewritten', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('nested', () => {",
    '  items.forEach((item) => {',
    '    expect(item).toBe(1)',
    '  })',
    '})',
    '',
  ].join('\n')
  const result = rewrite(source, 'f.ts')
  assert(result.sites.some((site) => site.kind === 'nested-expect'))
  assert(result.code.includes('expect(item).toBe(1)'))
  assert(!result.code.includes('yield* expect(item)'))
})

Deno.test('two consecutive checks are reported, never rewritten', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('run', () => { expect(a).toBe(1); expect(b).toBe(2) })",
    '',
  ].join('\n')
  const result = rewrite(source, 'f.ts')
  assertEquals(result.sites.filter((site) => site.kind === 'consecutive-checks').length, 2)
  assert(result.code.includes('expect(a).toBe(1); expect(b).toBe(2)'))
})

Deno.test('a refused matcher is reported, never rewritten', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('r', () => {",
    '  expect(x).toBeDefined()',
    '})',
    '',
  ].join('\n')
  const result = rewrite(source, 'f.ts')
  assertEquals(result.sites.filter((site) => site.kind === 'refused-matcher').map((site) => site.detail), [
    'toBeDefined',
  ])
  assert(result.code.includes('expect(x).toBeDefined()'))
})

Deno.test('a snapshot matcher is reported as a snapshot', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('s', () => {",
    '  expect(x).toMatchSnapshot()',
    '})',
    '',
  ].join('\n')
  assertEquals(kindsOf(source), ['snapshot'])
})

Deno.test('a boolean actual toBe is reported as a refused matcher', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('b', () => {",
    '  expect(a === b).toBe(true)',
    '})',
    '',
  ].join('\n')
  assertEquals(kindsOf(source), ['refused-matcher'])
})

Deno.test('a beforeEach call is reported as isolation', () => {
  const source = [
    "import { beforeEach, expect, it } from 'vitest'",
    'beforeEach(() => {})',
    "it('a', () => {",
    '  expect(1).toBe(1)',
    '})',
    '',
  ].join('\n')
  const result = rewrite(source, 'f.ts')
  assert(result.sites.some((site) => site.kind === 'isolation'))
})

Deno.test('a fake-timer call is reported', () => {
  const source = [
    "import { it, vi } from 'vitest'",
    "it('t', () => {",
    '  vi.useFakeTimers()',
    '  vi.advanceTimersByTime(1)',
    '})',
    '',
  ].join('\n')
  assertEquals(kindsOf(source).filter((kind) => kind === 'vi-timer').length, 2)
})

Deno.test('a namespace import is reported and left alone', () => {
  const source = [
    "import * as vitest from 'vitest'",
    "it('a', () => {})",
    '',
  ].join('\n')
  const result = rewrite(source, 'f.ts')
  assert(result.sites.some((site) => site.kind === 'namespace-import'))
  assert(result.code.includes("import * as vitest from 'vitest'"))
})

Deno.test('an expression-bodied callback is reported, not rewritten', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "it('e', () => expect(1).toBe(1))",
    '',
  ].join('\n')
  assertEquals(kindsOf(source), ['expression-callback'])
})

Deno.test('an existing Effect import is not duplicated', () => {
  const source = [
    "import { expect, it } from 'vitest'",
    "import { Effect } from 'effect'",
    "it('a', async () => {",
    '  expect(await f()).toBe(1)',
    '})',
    '',
  ].join('\n')
  const code = rewrite(source, 'f.ts').code
  assertEquals(code.split("import { Effect } from 'effect'").length, 2)
})
