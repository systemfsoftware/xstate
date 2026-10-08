import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

const ListedFiles = S.Array(S.Struct({ file: S.String, projectName: S.String }))
const UnguardedList = S.Struct({ files: S.Array(S.String) })
const Manifest = S.Struct({ name: S.String, exports: S.Record(S.String, S.Unknown) })
const SourceExport = S.Struct({ '@systemfsoftware/source': S.String })
const ProbeReport = S.Struct({ numTotalTests: S.Number, numPassedTests: S.Number })

const repoRoot = fromFileUrl(new URL('..', import.meta.url))
const vitest = join(repoRoot, 'node_modules/.bin/vitest')
const decoder = new TextDecoder()

const decodeOrThrow = <A>(schema: S.Codec<A>, input: unknown, what: string): A => {
  const decoded = S.decodeUnknownResult(schema)(input)
  if (Result.isFailure(decoded)) throw new Error(`${what}: ${decoded.failure.message}`)
  return decoded.success
}

const members = async (): Promise<readonly string[]> => {
  const names: string[] = []
  for await (const entry of Deno.readDir(join(repoRoot, 'packages'))) {
    if (entry.isDirectory) names.push(entry.name)
  }
  return names.toSorted()
}

const unguardedOf = async (member: string): Promise<readonly string[]> => {
  const list = decodeOrThrow(
    UnguardedList,
    JSON.parse(await Deno.readTextFile(join(repoRoot, 'packages/unguarded-tests.json'))),
    'packages/unguarded-tests.json',
  )
  const prefix = `packages/${member}/`
  return list.files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length)).toSorted()
}

const trackedFiles = async (member: string): Promise<readonly string[]> => {
  const { code, stdout, stderr } = await new Deno.Command('git', {
    args: ['ls-files', '-z', '--', '.'],
    cwd: join(repoRoot, 'packages', member),
  }).output()
  if (code !== 0) throw new Error(`git ls-files failed for ${member}: ${decoder.decode(stderr)}`)
  return decoder.decode(stdout).split('\0').filter((file) => file !== '')
}

const withSandboxCopy = async (member: string, use: (copy: string) => Promise<void>): Promise<void> => {
  const source = join(repoRoot, 'packages', member)
  const sandboxes = join(source, '.stryker-tmp')
  await Deno.mkdir(sandboxes, { recursive: true })
  const copy = await Deno.makeTempDir({ dir: sandboxes, prefix: 'vitest-config-' })
  try {
    for (const file of await trackedFiles(member)) {
      await Deno.mkdir(dirname(join(copy, file)), { recursive: true })
      await Deno.copyFile(join(source, file), join(copy, file))
    }
    await Deno.symlink(await Deno.realPath(join(source, 'node_modules')), join(copy, 'node_modules'))
    await use(copy)
  } finally {
    await Deno.remove(copy, { recursive: true })
    await Deno.remove(sandboxes).catch(() => undefined)
  }
}

interface ListedFile {
  readonly project: string
  readonly path: string
}

const listedFiles = async (packageDir: string): Promise<readonly ListedFile[]> => {
  const { code, stdout, stderr } = await new Deno.Command(vitest, {
    args: ['list', '--filesOnly', '--json'],
    cwd: packageDir,
  }).output()
  if (code !== 0) throw new Error(`vitest list in ${packageDir} exited ${code}: ${decoder.decode(stderr).trim()}`)
  return decodeOrThrow(ListedFiles, JSON.parse(decoder.decode(stdout)), `vitest list in ${packageDir}`)
    .map(({ file, projectName }) => ({ project: projectName, path: relative(packageDir, file) }))
    .toSorted((left, right) => `${left.project} ${left.path}`.localeCompare(`${right.project} ${right.path}`))
}

interface SourceEntry {
  readonly specifier: string
  readonly file: string
}

const sourceEntriesOf = async (packageDir: string): Promise<readonly SourceEntry[]> => {
  const manifest = decodeOrThrow(
    Manifest,
    JSON.parse(await Deno.readTextFile(join(packageDir, 'package.json'))),
    `${packageDir}/package.json`,
  )
  return Object.entries(manifest.exports).flatMap(([key, target]) => {
    const source = S.decodeUnknownResult(SourceExport)(target)
    if (Result.isFailure(source)) return []
    const specifier = key === '.' ? manifest.name : `${manifest.name}/${key.slice('./'.length)}`
    return [{ specifier, file: source.success['@systemfsoftware/source'] }]
  })
}

const probeFile = 'tests/vitest-config-copy.probe.test.ts'

const writeResolutionProbe = async (copy: string, entries: readonly SourceEntry[]): Promise<void> => {
  await Promise.all(
    entries.map(({ file }, index) =>
      Deno.writeTextFile(join(copy, file), `\nexport const vitestConfigCopy${index} = true\n`, { append: true })
    ),
  )
  await Deno.mkdir(join(copy, 'tests'), { recursive: true })
  await Deno.writeTextFile(
    join(copy, probeFile),
    [
      `import { it } from '@systemfsoftware/vitest'`,
      ...entries.map(({ specifier }, index) => `import * as entry${index} from '${specifier}'`),
      `it('imports every export from this copy', function*({ expect }) {`,
      `  yield* expect([${entries.map((_, index) => `Reflect.get(entry${index}, 'vitestConfigCopy${index}')`)}])`,
      `    .toEqual([${entries.map(() => 'true')}])`,
      `})`,
      ``,
    ].join('\n'),
  )
}

const runProbe = async (copy: string): Promise<{ readonly total: number; readonly passed: number }> => {
  const reportFile = join(copy, 'probe-report.json')
  const { stderr } = await new Deno.Command(vitest, {
    args: ['run', probeFile, '--reporter=json', `--outputFile=${reportFile}`],
    cwd: copy,
  }).output()
  const text = await Deno.readTextFile(reportFile).catch(() => undefined)
  if (text === undefined) throw new Error(`vitest run in ${copy} wrote no report: ${decoder.decode(stderr).trim()}`)
  const report = decodeOrThrow(ProbeReport, JSON.parse(text), `vitest run in ${copy}`)
  return { total: report.numTotalTests, passed: report.numPassedTests }
}

for (const member of await members()) {
  Deno.test(`packages/${member} lists the same test files from a copy of the package directory alone`, async () => {
    const source = join(repoRoot, 'packages', member)
    const config = await Deno.stat(join(source, 'vitest.config.ts')).catch(() => undefined)
    assert(config?.isFile === true, `packages/${member} has no vitest.config.ts`)
    await withSandboxCopy(member, async (copy) => {
      const [fromCopy, fromRepo] = await Promise.all([listedFiles(copy), listedFiles(source)])
      assert(fromRepo.length > 0, `packages/${member} lists no test files`)
      assertEquals(fromCopy, fromRepo)
      assertEquals(
        fromRepo.filter(({ project }) => project === 'unguarded').map(({ path }) => path).toSorted(),
        await unguardedOf(member),
      )
    })
  })
}

for (const member of await members()) {
  Deno.test(`packages/${member} tests in a copy of the package directory import every export from that copy`, async () => {
    await withSandboxCopy(member, async (copy) => {
      const entries = await sourceEntriesOf(copy)
      assert(entries.length > 0, `packages/${member} exports no @systemfsoftware/source entry`)
      await writeResolutionProbe(copy, entries)
      assertEquals(await runProbe(copy), { total: 1, passed: 1 })
    })
  })
}
