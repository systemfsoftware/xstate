import { assertEquals } from '@std/assert'

import { isTagged, owedPackages, type Released, tagOf } from './cycle.ts'

const git = async (cwd: string, args: string[]): Promise<void> => {
  const out = await new Deno.Command('git', { args: ['-C', cwd, ...args] }).output()
  if (!out.success) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`)
}

const repository = async (): Promise<string> => {
  const dir = await Deno.makeTempDir({ prefix: 'cycle-' })
  await git(dir, ['init', '--quiet'])
  await git(dir, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=test',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init',
  ])
  return dir
}

Deno.test('tagOf renders name@vversion', () => {
  assertEquals(tagOf({ name: '@scope/pkg', version: '1.2.3' }), '@scope/pkg@v1.2.3')
})

Deno.test('a version with no matching tag is owed', () => {
  const released: Released[] = [{ name: '@scope/pkg', version: '1.2.3' }]
  assertEquals(owedPackages(released, new Set()), [{ name: '@scope/pkg', version: '1.2.3' }])
})

Deno.test('only the untagged versions are owed', () => {
  const released: Released[] = [
    { name: '@scope/a', version: '1.0.0' },
    { name: '@scope/b', version: '2.0.0' },
  ]
  assertEquals(owedPackages(released, new Set(['@scope/a@v1.0.0'])), [{ name: '@scope/b', version: '2.0.0' }])
})

Deno.test('a version whose tag already exists is not owed', () => {
  const released: Released[] = [{ name: '@scope/pkg', version: '1.2.3' }]
  assertEquals(owedPackages(released, new Set(['@scope/pkg@v1.2.3'])), [])
})

Deno.test('isTagged reads the real tags of the given repository', async () => {
  const dir = await repository()
  await git(dir, ['tag', '@scope/pkg@v1.2.3'])
  assertEquals(await isTagged('@scope/pkg@v1.2.3', dir), true)
  assertEquals(await isTagged('@scope/pkg@v9.9.9', dir), false)
})
