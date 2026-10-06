import { assertEquals } from '@std/assert'
import { join } from '@std/path'

import { checkChangeset, packagesNeedingIntent } from './check-changeset.ts'

const release = [
  { dir: 'packages/a', name: '@x/a', version: '1.0.0' },
  { dir: 'apps/site', name: '@x/site', version: '1.0.0' },
]

Deno.test('a changed release-set path needs an intent for every release-set package', () => {
  assertEquals(packagesNeedingIntent(['packages/a/src/index.ts'], release), ['@x/a', '@x/site'])
  assertEquals(packagesNeedingIntent(['apps/site/app/page.tsx'], release), ['@x/a', '@x/site'])
})

Deno.test('a changed path outside every release-set dir needs no intent', () => {
  assertEquals(packagesNeedingIntent(['packages/other/src/index.ts', 'docs/readme.md'], release), [])
})

Deno.test('a workspace with a non-private member fails even with an empty diff', async () => {
  const root = await Deno.makeTempDir({ prefix: 'check-changeset-' })
  await Deno.writeTextFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(join(root, 'release-set.json'), '{ "packages": [] }\n')
  await Deno.mkdir(join(root, 'packages', 'a'), { recursive: true })
  await Deno.writeTextFile(
    join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: '@x/a', version: '1.0.0' }),
  )

  assertEquals(await checkChangeset('HEAD', root), 1)
})
