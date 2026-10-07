import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

const repoRoot = fromFileUrl(new URL('..', import.meta.url))
const LIST = 'packages/unguarded-tests.json'
const GLOB_SYNTAX = /[*?[\]{}!]/
const MEMBER_TEST_FILE = /^packages\/[^/]+\/.+\.test\.tsx?$/
const VITEST_IMPORT = /\bfrom\s*['"]vitest['"]/
const RELATIVE_IMPORT = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g

const UnguardedList = S.Struct({ files: S.Array(S.String) })

const listedFiles = async (): Promise<readonly string[]> => {
  const decoded = S.decodeUnknownResult(UnguardedList)(JSON.parse(await Deno.readTextFile(join(repoRoot, LIST))))
  if (Result.isFailure(decoded)) throw new Error(`${LIST}: ${decoded.failure.message}`)
  return decoded.success.files
}

const readOrUndefined = (path: string): Promise<string | undefined> =>
  Deno.readTextFile(join(repoRoot, path)).catch(() => undefined)

const sourcesOf = (specifier: string): readonly string[] => [
  specifier.replace(/\.js$/, '.ts'),
  specifier.replace(/\.js$/, '.tsx'),
  specifier,
]

const reachesVitest = async (file: string, visited: Set<string> = new Set()): Promise<boolean> => {
  if (visited.has(file)) return false
  visited.add(file)
  const text = await readOrUndefined(file)
  if (text === undefined) return false
  if (VITEST_IMPORT.test(text)) return true
  for (const [, specifier = ''] of text.matchAll(RELATIVE_IMPORT)) {
    for (const source of sourcesOf(specifier)) {
      const target = relative(repoRoot, join(repoRoot, dirname(file), source))
      if (target.startsWith('packages/') && await reachesVitest(target, visited)) return true
    }
  }
  return false
}

const refusal = async (file: string, seen: ReadonlySet<string>): Promise<string | undefined> => {
  if (GLOB_SYNTAX.test(file)) return 'is a glob, not one file'
  if (seen.has(file)) return 'is listed twice'
  if (!MEMBER_TEST_FILE.test(file)) return 'is not a test file under packages/<member>/'
  const text = await readOrUndefined(file)
  if (text === undefined) return 'does not exist'
  return await reachesVitest(file)
    ? undefined
    : "uses none of vitest's own API, directly or through a local helper, so the guard runs it"
}

Deno.test(`${LIST} lists only exact copied test files the @systemfsoftware/vitest guard refuses`, async () => {
  const files = await listedFiles()
  const refused: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const reason = await refusal(file, seen)
    if (reason !== undefined) refused.push(`${file} ${reason}`)
    seen.add(file)
  }
  assertEquals(refused, [])
})
