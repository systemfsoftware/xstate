import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { fromFileUrl, join } from '@std/path'

const repoRoot = fromFileUrl(new URL('..', import.meta.url))
const guard = join(repoRoot, 'nix/from-source/assert-local-sfs.awk')

const runGuard = async (lockfile: string): Promise<{ code: number; stdout: string }> => {
  const { code, stdout } = await new Deno.Command('awk', { args: ['-f', guard, lockfile] }).output()
  return { code, stdout: new TextDecoder().decode(stdout) }
}

const committedLockfiles = async (): Promise<readonly string[]> => {
  const instances = await Array.fromAsync(Deno.readDir(join(repoRoot, 'nix')))
  const candidates = instances
    .filter((entry) => entry.isDirectory)
    .map((entry) => join(repoRoot, 'nix', entry.name, 'pnpm-lock.yaml'))
  const present = await Promise.all(
    candidates.map((path) => Deno.stat(path).then(() => path, () => undefined)),
  )
  return [join(repoRoot, 'pnpm-lock.yaml'), ...present.filter((path) => path !== undefined)]
}

Deno.test('a lockfile resolving an @systemfsoftware/* package from registry.npmjs.org fails the guard', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'assert-local-sfs-' })
  const lockfile = join(dir, 'pnpm-lock.yaml')
  await Deno.writeTextFile(
    lockfile,
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@systemfsoftware/effect-cell-types':",
      '        specifier: 12.0.0',
      '        version: 12.0.0',
      '',
      'packages:',
      '',
      "  '@systemfsoftware/effect-cell-types@12.0.0':",
      '    resolution: {integrity: sha512-3pmbmzGrUe//NOacyRToZZtv/ow+DREFxL05LiS7Z8ZhPriIKwpvCBACWQ8kPFzkcSAIVPZV+XMx56LkU266EQ==}',
      '',
    ].join('\n'),
  )
  const { code, stdout } = await runGuard(lockfile)
  assertEquals(code, 1)
  assertStringIncludes(stdout, `${lockfile}:13: @systemfsoftware/effect-cell-types@12.0.0`)
})

Deno.test('every committed pnpm-lock.yaml resolves @systemfsoftware/* only from local tarballs', async () => {
  const lockfiles = await committedLockfiles()
  assert(lockfiles.length > 1, 'the root lockfile and at least one from-source instance lockfile')
  for (const lockfile of lockfiles) {
    assertEquals(await runGuard(lockfile), { code: 0, stdout: '' }, lockfile)
  }
})
