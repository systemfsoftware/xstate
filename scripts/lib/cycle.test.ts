import { assertEquals } from '@std/assert'
import { join } from '@std/path'

import { isOwed, isTagged, loadWorkspaceCycle, owedPackages, tagOf } from './cycle.ts'
import type { ReleasePackage } from './release-set.ts'

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
  await Deno.writeTextFile(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(join(dir, 'release-set.json'), '{ "packages": ["packages/a"] }\n')
  await Deno.mkdir(join(dir, '.changeset'), { recursive: true })
  await Deno.writeTextFile(join(dir, '.changeset', 'ledger.yaml'), '{}\n')
  for (const name of ['a', 'b']) {
    const dirPath = join(dir, 'packages', name)
    await Deno.mkdir(dirPath, { recursive: true })
    await Deno.writeTextFile(
      join(dirPath, 'package.json'),
      JSON.stringify({ name: `@x/${name}`, version: '1.0.0', private: true }),
    )
    await Deno.writeTextFile(join(dirPath, 'CHANGELOG.md'), `## 1.0.0\n\n- ${name}\n`)
  }
  return dir
}

const ledgerOf = (entries: Record<string, readonly string[]>): string =>
  `${
    Object.entries(entries).map(([key, intents]) =>
      `"${key}":\n  dir: packages/${key.split('/')[1].split('@')[0]}\n  intents: [${
        intents.map((i) => `"${i}"`).join(', ')
      }]\n`
    ).join('')
  }`

const released: ReleasePackage = { dir: 'packages/a', name: '@x/a', version: '1.0.0' }

Deno.test('tagOf renders name@vversion', () => {
  assertEquals(tagOf({ name: '@scope/pkg', version: '1.2.3' }), '@scope/pkg@v1.2.3')
})

Deno.test('a ledgered version with no matching tag is owed', () => {
  assertEquals(isOwed(released, new Set(['@x/a@1.0.0']), new Set()), true)
})

Deno.test('a ledgered version whose tag already exists is not owed', () => {
  assertEquals(isOwed(released, new Set(['@x/a@1.0.0']), new Set(['@x/a@v1.0.0'])), false)
})

Deno.test('a version absent from the ledger is not owed', () => {
  assertEquals(isOwed(released, new Set(['@x/b@1.0.0']), new Set()), false)
})

Deno.test('a version whose package is not in the release set is not owed', () => {
  assertEquals(owedPackages([], new Set(['@x/a@1.0.0']), new Set()), [])
})

Deno.test('a ledgered untagged release-set version is owed, changelog from its dir', async () => {
  const root = await repository()
  await Deno.writeTextFile(join(root, '.changeset', 'ledger.yaml'), ledgerOf({ '@x/a@1.0.0': ['seed'] }))
  assertEquals(await loadWorkspaceCycle(root), [{
    name: '@x/a',
    version: '1.0.0',
    tag: '@x/a@v1.0.0',
    changelog: join(root, 'packages', 'a', 'CHANGELOG.md'),
  }])
})

Deno.test('a ledgered version whose tag already exists is not owed', async () => {
  const root = await repository()
  await Deno.writeTextFile(join(root, '.changeset', 'ledger.yaml'), ledgerOf({ '@x/a@1.0.0': ['seed'] }))
  await git(root, ['tag', '@x/a@v1.0.0'])
  assertEquals(await loadWorkspaceCycle(root), [])
})

Deno.test('a seeded manifest version absent from the ledger is not owed', async () => {
  const root = await repository()
  await Deno.writeTextFile(join(root, '.changeset', 'ledger.yaml'), ledgerOf({ '@x/a@1.0.0': ['seed'] }))
  await Deno.writeTextFile(
    join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: '@x/a', version: '1.0.1', private: true }),
  )
  assertEquals(await loadWorkspaceCycle(root), [])
})

Deno.test('a ledgered untagged package outside the release set is not owed', async () => {
  const root = await repository()
  await Deno.writeTextFile(
    join(root, '.changeset', 'ledger.yaml'),
    ledgerOf({ '@x/a@1.0.0': ['seed'], '@x/b@1.0.0': ['seed'] }),
  )
  await git(root, ['tag', '@x/a@v1.0.0'])
  assertEquals(await loadWorkspaceCycle(root), [])
})

Deno.test('isTagged reads the real tags of the given repository', async () => {
  const dir = await repository()
  await git(dir, ['tag', '@scope/pkg@v1.2.3'])
  assertEquals(await isTagged('@scope/pkg@v1.2.3', dir), true)
  assertEquals(await isTagged('@scope/pkg@v9.9.9', dir), false)
})
