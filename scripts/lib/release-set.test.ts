import { assertEquals } from '@std/assert'
import { join } from '@std/path'

import { loadReleaseSet } from './release-set.ts'

type Member = { readonly dir: string; readonly manifest: string }

const workspaceOf = async (
  options: {
    readonly releaseSet?: string
    readonly members?: readonly Member[]
    readonly workspace?: string
  } = {},
): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: 'release-set-' })
  await Deno.writeTextFile(join(root, 'pnpm-workspace.yaml'), options.workspace ?? 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(join(root, 'release-set.json'), options.releaseSet ?? '{ "packages": [] }\n')
  for (const member of options.members ?? []) {
    await Deno.mkdir(join(root, member.dir), { recursive: true })
    await Deno.writeTextFile(join(root, member.dir, 'package.json'), member.manifest)
  }
  return root
}

const manifest = (name: string, version: string, isPrivate: boolean): string =>
  JSON.stringify({ name, version, ...(isPrivate ? { private: true } : {}) })

Deno.test('a valid release set returns dir, name and version for each entry', async () => {
  const root = await workspaceOf({
    releaseSet: '{ "packages": ["packages/a", "packages/b"] }\n',
    members: [
      { dir: 'packages/a', manifest: manifest('@x/a', '1.0.0', true) },
      { dir: 'packages/b', manifest: manifest('@x/b', '2.3.4', true) },
    ],
  })
  assertEquals(await loadReleaseSet(root), {
    ok: true,
    packages: [
      { dir: 'packages/a', name: '@x/a', version: '1.0.0' },
      { dir: 'packages/b', name: '@x/b', version: '2.3.4' },
    ],
  })
})

Deno.test('a malformed release-set.json is refused with the file named', async () => {
  for (const releaseSet of ['{', '{ "packages": "nope" }\n']) {
    const root = await workspaceOf({ releaseSet })
    assertEquals(await loadReleaseSet(root), {
      ok: false,
      refusals: [{ _tag: 'MalformedReleaseSet', file: join(root, 'release-set.json') }],
    })
  }
})

Deno.test('a missing release-set.json is refused with the file named', async () => {
  const root = await workspaceOf({ members: [{ dir: 'packages/a', manifest: manifest('@x/a', '1.0.0', true) }] })
  await Deno.remove(join(root, 'release-set.json'))
  assertEquals(await loadReleaseSet(root), {
    ok: false,
    refusals: [{ _tag: 'MalformedReleaseSet', file: join(root, 'release-set.json') }],
  })
})

Deno.test('a listed dir that is not a workspace member is refused with the dir named', async () => {
  const root = await workspaceOf({
    releaseSet: '{ "packages": ["packages/missing"] }\n',
    members: [{ dir: 'packages/a', manifest: manifest('@x/a', '1.0.0', true) }],
  })
  assertEquals(await loadReleaseSet(root), {
    ok: false,
    refusals: [{ _tag: 'UnknownWorkspaceMember', dir: 'packages/missing' }],
  })
})

Deno.test('a listed package whose manifest is not private is refused with the dir named', async () => {
  const root = await workspaceOf({
    releaseSet: '{ "packages": ["packages/a"] }\n',
    members: [{ dir: 'packages/a', manifest: manifest('@x/a', '1.0.0', false) }],
  })
  assertEquals(await loadReleaseSet(root), {
    ok: false,
    refusals: [{ _tag: 'ReleasePackageNotPrivate', dir: 'packages/a' }],
  })
})

Deno.test('a workspace member that is not private is refused whether or not it is listed', async () => {
  const root = await workspaceOf({
    releaseSet: '{ "packages": ["packages/a"] }\n',
    members: [
      { dir: 'packages/a', manifest: manifest('@x/a', '1.0.0', true) },
      { dir: 'packages/b', manifest: manifest('@x/b', '1.0.0', false) },
    ],
  })
  assertEquals(await loadReleaseSet(root), {
    ok: false,
    refusals: [{ _tag: 'PublishableWorkspaceMember', dir: 'packages/b' }],
  })
})

Deno.test('a duplicate release-set entry is refused once with the dir named', async () => {
  const root = await workspaceOf({
    releaseSet: '{ "packages": ["packages/a", "packages/a"] }\n',
    members: [{ dir: 'packages/a', manifest: manifest('@x/a', '1.0.0', true) }],
  })
  assertEquals(await loadReleaseSet(root), {
    ok: false,
    refusals: [{ _tag: 'DuplicateReleaseEntry', dir: 'packages/a' }],
  })
})
