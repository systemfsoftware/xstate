import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

const ListedFiles = S.Array(S.Struct({ file: S.String, projectName: S.String }))

const repoRoot = fromFileUrl(new URL('..', import.meta.url))
const vitest = join(repoRoot, 'node_modules/.bin/vitest')
const decoder = new TextDecoder()

const members = async (): Promise<readonly string[]> => {
  const names: string[] = []
  for await (const entry of Deno.readDir(join(repoRoot, 'packages'))) {
    const config = await Deno.stat(join(repoRoot, 'packages', entry.name, 'vitest.config.ts')).catch(() => undefined)
    if (entry.isDirectory && config?.isFile === true) names.push(entry.name)
  }
  return names.toSorted()
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

const listedFiles = async (packageDir: string): Promise<readonly string[]> => {
  const { code, stdout, stderr } = await new Deno.Command(vitest, {
    args: ['list', '--filesOnly', '--json'],
    cwd: packageDir,
  }).output()
  if (code !== 0) return [`vitest list exited ${code}: ${decoder.decode(stderr).trim().split('\n')[0]}`]
  const decoded = S.decodeUnknownResult(ListedFiles)(JSON.parse(decoder.decode(stdout)))
  if (Result.isFailure(decoded)) return [`vitest list printed an unexpected shape: ${decoded.failure.message}`]
  return decoded.success.map(({ file, projectName }) => `${projectName} ${relative(packageDir, file)}`).toSorted()
}

for (const member of await members()) {
  Deno.test(`packages/${member} lists the same test files from a copy of the package directory alone`, async () => {
    const copy = await copyAlone(member)
    try {
      assertEquals(await listedFiles(copy), await listedFiles(join(repoRoot, 'packages', member)))
    } finally {
      await Deno.remove(dirname(copy), { recursive: true })
    }
  })
}
