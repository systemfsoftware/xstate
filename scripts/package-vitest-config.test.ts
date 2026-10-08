import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

const ListedFiles = S.Array(S.Struct({ file: S.String, projectName: S.String }))
const UnguardedList = S.Struct({ files: S.Array(S.String) })

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

const copyAlone = async (member: string): Promise<string> => {
  const source = join(repoRoot, 'packages', member)
  const copy = join(await Deno.makeTempDir({ prefix: `vitest-config-${member}-` }), member)
  for (const file of await trackedFiles(member)) {
    await Deno.mkdir(dirname(join(copy, file)), { recursive: true })
    await Deno.copyFile(join(source, file), join(copy, file))
  }
  await Deno.symlink(await Deno.realPath(join(source, 'node_modules')), join(copy, 'node_modules'))
  return copy
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

for (const member of await members()) {
  Deno.test(`packages/${member} lists the same test files from a copy of the package directory alone`, async () => {
    const source = join(repoRoot, 'packages', member)
    const config = await Deno.stat(join(source, 'vitest.config.ts')).catch(() => undefined)
    assert(config?.isFile === true, `packages/${member} has no vitest.config.ts`)
    const copy = await copyAlone(member)
    try {
      const [fromCopy, fromRepo] = await Promise.all([listedFiles(copy), listedFiles(source)])
      assert(fromRepo.length > 0, `packages/${member} lists no test files`)
      assertEquals(fromCopy, fromRepo)
      assertEquals(
        fromRepo.filter(({ project }) => project === 'unguarded').map(({ path }) => path).toSorted(),
        await unguardedOf(member),
      )
    } finally {
      await Deno.remove(dirname(copy), { recursive: true })
    }
  })
}
