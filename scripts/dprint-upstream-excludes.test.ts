import { assertEquals } from '@std/assert'
import { fromFileUrl, globToRegExp, join } from '@std/path'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

const repoRoot = fromFileUrl(new URL('..', import.meta.url))
const PACKAGES = 'packages'
const MANIFEST = 'upstream-tests.json'
const UNWALKED = new Set(['node_modules', 'dist', 'coverage', 'reports', '.turbo'])
const GLOB_SYNTAX = /[*?[\]{}!]/
const TEST_FILE = /\.test\.tsx?$/

const DprintConfig = S.Struct({ excludes: S.Array(S.String) })

const UpstreamManifest = S.Struct({
  files: S.Array(S.String),
  ported: S.optional(S.NullOr(S.Array(S.Struct({ port: S.String })))),
  typecheck: S.Struct({ blob: S.String }),
})

const decoded = <A>(result: Result.Result<A, S.SchemaError>, what: string): A => {
  if (Result.isFailure(result)) throw new Error(`${what}: ${result.failure.message}`)
  return result.success
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await Deno.readTextFile(join(repoRoot, path)))

const dprintExcludes = async (): Promise<readonly string[]> =>
  decoded(S.decodeUnknownResult(DprintConfig)(await readJson('dprint.json')), 'dprint.json').excludes

interface Upstream {
  readonly paths: ReadonlySet<string>
  readonly blobs: ReadonlySet<string>
}

const upstream = async (): Promise<Upstream> => {
  const paths = new Set<string>()
  const blobs = new Set<string>()
  for await (const entry of Deno.readDir(join(repoRoot, PACKAGES))) {
    const file = `${PACKAGES}/${entry.name}/${MANIFEST}`
    if (!entry.isDirectory) continue
    const raw = await readJson(file).catch((error) =>
      error instanceof Deno.errors.NotFound ? undefined : Promise.reject(error)
    )
    if (raw === undefined) continue
    const manifest = decoded(S.decodeUnknownResult(UpstreamManifest)(raw), file)
    for (const path of [...manifest.files, ...(manifest.ported ?? []).map((ported) => ported.port)]) {
      paths.add(`${PACKAGES}/${entry.name}/${path}`)
    }
    blobs.add(manifest.typecheck.blob)
  }
  if (paths.size === 0) throw new Error(`no ${PACKAGES}/*/${MANIFEST} lists an upstream test`)
  return { paths, blobs }
}

const gitBlobId = async (path: string): Promise<string | undefined> => {
  const bytes = await Deno.readFile(join(repoRoot, path)).catch(() => undefined)
  if (bytes === undefined) return undefined
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const object = new Uint8Array(header.length + bytes.length)
  object.set(header)
  object.set(bytes, header.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const packageTests = async (dir: string): Promise<readonly string[]> => {
  const found: string[] = []
  for await (const entry of Deno.readDir(join(repoRoot, dir))) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory && !UNWALKED.has(entry.name)) found.push(...await packageTests(path))
    if (entry.isFile && TEST_FILE.test(entry.name)) found.push(path)
  }
  return found
}

const excludedBy = (pattern: string, path: string): boolean => {
  const matcher = globToRegExp(pattern, { extended: true, globstar: true })
  const segments = path.split('/')
  return segments.some((_, index) => matcher.test(segments.slice(0, index + 1).join('/')))
}

Deno.test("the dprint excludes under packages/ are exactly the upstream manifests' verbatim and ported files, with no glob", async () => {
  const { paths, blobs } = await upstream()
  const excludes = (await dprintExcludes()).filter((exclude) => exclude.startsWith(`${PACKAGES}/`))
  const strangers: string[] = []
  for (const exclude of excludes) {
    const verbatimUpstream = paths.has(exclude) || blobs.has(await gitBlobId(exclude) ?? '')
    if (GLOB_SYNTAX.test(exclude) || !verbatimUpstream) strangers.push(exclude)
  }
  assertEquals(
    { strangers, unexcluded: [...paths].filter((path) => !excludes.includes(path)) },
    { strangers: [], unexcluded: [] },
  )
})

Deno.test('no dprint exclude exempts a package test the upstream manifests do not list', async () => {
  const { paths } = await upstream()
  const excludes = await dprintExcludes()
  const handWritten = (await packageTests(PACKAGES)).filter((path) => !paths.has(path))
  if (handWritten.length === 0) throw new Error(`no hand-written test under ${PACKAGES}/ to check the excludes against`)
  const exempted = handWritten.flatMap((path) =>
    excludes.filter((exclude) => excludedBy(exclude, path)).map((exclude) => `${path} <- ${exclude}`)
  )
  assertEquals(exempted, [])
})
