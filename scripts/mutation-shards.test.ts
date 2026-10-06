import { assertEquals, assertStringIncludes } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

import { planMutationShards, renderSummary } from './mutation-shards.ts'

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)))
const SHARED_STRYKER = join(REPO_ROOT, 'stryker.shared.ts')

type Fixture = {
  readonly name: string
  readonly mutation?: boolean
  readonly config?: readonly string[]
  readonly manifestMutate?: readonly string[]
  readonly files?: readonly string[]
  readonly manifest?: string
}

const workspaceOf = async (
  fixtures: readonly Fixture[],
  options: { readonly ledger?: string; readonly workspace?: string; readonly releaseSet?: readonly string[] } = {},
): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: 'mutation-shards-' })
  await Deno.writeTextFile(
    join(root, 'pnpm-workspace.yaml'),
    options.workspace ?? 'packages:\n  - packages/*\n',
  )
  await Deno.writeTextFile(join(root, 'debt-ledger.yaml'), options.ledger ?? 'entries: []\n')
  await Deno.writeTextFile(
    join(root, 'release-set.json'),
    `${JSON.stringify({ packages: options.releaseSet ?? [] }, null, 2)}\n`,
  )
  for (const fixture of fixtures) {
    const dir = join(root, 'packages', fixture.name)
    await Deno.mkdir(join(dir, 'src'), { recursive: true })
    const manifest = fixture.manifest ?? JSON.stringify({
      name: `@fixture/${fixture.name}`,
      version: '1.0.0',
      private: true,
      ...((fixture.mutation ?? fixture.config !== undefined) ? { scripts: { mutation: 'stryker run' } } : {}),
      ...(fixture.manifestMutate === undefined ? {} : { stryker: { mutate: fixture.manifestMutate } }),
    })
    await Deno.writeTextFile(join(dir, 'package.json'), manifest)
    if (fixture.config !== undefined) {
      await Deno.writeTextFile(
        join(dir, 'stryker.config.ts'),
        `import { packageStrykerConfig } from ${JSON.stringify(SHARED_STRYKER)}\n` +
          `export default packageStrykerConfig(${JSON.stringify(fixture.config)})\n`,
      )
    }
    for (const file of fixture.files ?? []) await Deno.writeTextFile(join(dir, file), 'export {}\n')
  }
  return root
}

Deno.test('a workspace with no package is refused as vacuous', async () => {
  const root = await workspaceOf([])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'EmptyWorkspace' }],
  })
})

Deno.test('a package with a mutation script is planned from its config mutate list', async () => {
  const root = await workspaceOf([{ name: 'core', config: ['src/**/*.ts'], files: ['src/order.ts'] }])
  assertEquals(await planMutationShards(root), {
    packages: ['@fixture/core'],
    exempt: [],
    refusals: [],
  })
})

Deno.test('a manifest that carries stryker.mutate beside the config is refused', async () => {
  const root = await workspaceOf([{
    name: 'core',
    config: ['src/**/*.ts'],
    manifestMutate: ['src/**/*.workflow.ts'],
    files: ['src/order.ts'],
  }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{
      _tag: 'ManifestCarriesMutate',
      package: '@fixture/core',
      file: join(root, 'packages', 'core', 'package.json'),
    }],
  })
})

Deno.test('a manifest stryker.mutate with no config is refused', async () => {
  const root = await workspaceOf([{ name: 'core', manifestMutate: ['src/**/*.ts'], files: ['src/order.ts'] }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{
      _tag: 'ManifestCarriesMutate',
      package: '@fixture/core',
      file: join(root, 'packages', 'core', 'package.json'),
    }],
  })
})

Deno.test('a package whose config mutate globs match no file is refused', async () => {
  const root = await workspaceOf([{ name: 'site', config: ['src/**/*.workflow.ts'], files: ['src/page.ts'] }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{
      _tag: 'GlobMatchesNothing',
      package: '@fixture/site',
      dir: 'packages/site',
      mutate: ['src/**/*.workflow.ts'],
    }],
  })
})

Deno.test('a release-set package with neither a mutation script nor a ledger entry is refused', async () => {
  const root = await workspaceOf(
    [{ name: 'loose', mutation: false, files: ['src/order.ts'] }],
    { releaseSet: ['packages/loose'] },
  )
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'PublishableWithoutMutationOrLedger', package: '@fixture/loose' }],
  })
})

Deno.test('the release set decides: a mutation-less package outside it is ignored', async () => {
  const root = await workspaceOf([
    { name: 'listed', mutation: false, files: ['src/order.ts'] },
    { name: 'ignored', mutation: false, files: ['src/order.ts'] },
  ], { releaseSet: ['packages/listed'] })
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'PublishableWithoutMutationOrLedger', package: '@fixture/listed' }],
  })
})

Deno.test('a ledger-exempt package is planned empty and listed in the summary', async () => {
  const root = await workspaceOf([{ name: 'legacy', mutation: false, files: ['src/order.ts'] }], {
    releaseSet: ['packages/legacy'],
    ledger: [
      'entries:',
      '  - rule: XS1',
      '    scope: "@fixture/legacy"',
      '    reason: "the shard is not split yet"',
      '    removedBy: "#42"',
      '',
    ].join('\n'),
  })
  const plan = await planMutationShards(root)
  assertEquals(plan, {
    packages: [],
    exempt: [{ package: '@fixture/legacy', rule: 'XS1', removedBy: '#42' }],
    refusals: [],
  })
  const summary = renderSummary(plan)
  assertStringIncludes(summary, '@fixture/legacy')
  assertStringIncludes(summary, 'XS1')
  assertStringIncludes(summary, '#42')
})

Deno.test('a workspace member outside the release set is ignored', async () => {
  const root = await workspaceOf([
    { name: 'core', config: ['src/**/*.ts'], files: ['src/order.ts'] },
    { name: 'internal', mutation: false, files: ['src/order.ts'] },
  ])
  assertEquals(await planMutationShards(root), {
    packages: ['@fixture/core'],
    exempt: [],
    refusals: [],
  })
})

Deno.test('a malformed package.json is refused by decode with the file named', async () => {
  const root = await workspaceOf([{ name: 'core', manifest: '{ not json', files: ['src/order.ts'] }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'MalformedManifest', file: join(root, 'packages', 'core', 'package.json') }],
  })
})

Deno.test('a malformed debt ledger is refused by decode with the file named', async () => {
  const root = await workspaceOf([{ name: 'core', config: ['src/**/*.ts'], files: ['src/order.ts'] }], {
    ledger: 'entries: nope\n',
  })
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'MalformedLedger', file: join(root, 'debt-ledger.yaml') }],
  })
})

Deno.test('a mutation script without a stryker.config.ts is refused', async () => {
  const root = await workspaceOf([{ name: 'core', mutation: true, files: ['src/order.ts'] }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'MutationPackageWithoutConfig', package: '@fixture/core' }],
  })
})

Deno.test('a stryker config whose import throws is refused with the config named', async () => {
  const root = await workspaceOf([{ name: 'core', mutation: true, files: ['src/order.ts'] }])
  const configFile = join(root, 'packages', 'core', 'stryker.config.ts')
  await Deno.writeTextFile(configFile, "throw new Error('boom')\n")
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'MalformedStrykerConfig', file: configFile }],
  })
})

Deno.test('a stryker config whose default mutate is not a string array is refused with the config named', async () => {
  const root = await workspaceOf([{ name: 'core', mutation: true, files: ['src/order.ts'] }])
  const configFile = join(root, 'packages', 'core', 'stryker.config.ts')
  await Deno.writeTextFile(configFile, "export default { mutate: ['src/**/*.ts', 7] }\n")
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'MalformedStrykerConfig', file: configFile }],
  })
})

Deno.test('an unparseable or wrongly shaped pnpm-workspace.yaml is refused with the file named', async () => {
  for (const workspace of ['[', 'packages: not-a-list\n']) {
    const root = await workspaceOf([], { workspace })
    assertEquals(await planMutationShards(root), {
      packages: [],
      exempt: [],
      refusals: [{ _tag: 'MalformedWorkspace', file: join(root, 'pnpm-workspace.yaml') }],
    })
  }
})

Deno.test('a manifest name with shell metacharacters is refused by decode with the file named', async () => {
  const root = await workspaceOf([{
    name: 'core',
    manifest: JSON.stringify({
      name: 'foo"; touch /tmp/pwn; echo "',
      private: true,
      scripts: { mutation: 'stryker run' },
    }),
    files: ['src/order.ts'],
  }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'MalformedManifest', file: join(root, 'packages', 'core', 'package.json') }],
  })
})

Deno.test('a manifest name that breaks the npm grammar is refused by decode with the file named', async () => {
  for (const name of ['_leading', 'UPPER', 'a'.repeat(215)]) {
    const root = await workspaceOf([{
      name: 'core',
      manifest: JSON.stringify({ name, private: true, scripts: { mutation: 'stryker run' } }),
      files: ['src/order.ts'],
    }])
    assertEquals(await planMutationShards(root), {
      packages: [],
      exempt: [],
      refusals: [{ _tag: 'MalformedManifest', file: join(root, 'packages', 'core', 'package.json') }],
    })
  }
})

Deno.test('a valid scoped manifest name is planned from its config', async () => {
  const root = await workspaceOf([{
    name: 'core',
    manifest: JSON.stringify({ name: '@fixture/valid-name', private: true, scripts: { mutation: 'stryker run' } }),
    config: ['src/**/*.ts'],
    files: ['src/order.ts'],
  }])
  assertEquals(await planMutationShards(root), {
    packages: ['@fixture/valid-name'],
    exempt: [],
    refusals: [],
  })
})
