import { assertEquals, assertStringIncludes } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

import { planMutationShards, renderSummary } from './mutation-shards.ts'

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)))
const SHARED_STRYKER = join(REPO_ROOT, 'stryker.shared.ts')

type Fixture = {
  readonly name: string
  readonly private?: boolean
  readonly mutation?: boolean
  readonly config?: readonly string[]
  readonly manifestMutate?: readonly string[]
  readonly files?: readonly string[]
  readonly manifest?: string
}

const workspaceOf = async (
  fixtures: readonly Fixture[],
  options: { readonly ledger?: string } = {},
): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: 'mutation-shards-' })
  await Deno.writeTextFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(join(root, 'debt-ledger.yaml'), options.ledger ?? 'entries: []\n')
  for (const fixture of fixtures) {
    const dir = join(root, 'packages', fixture.name)
    await Deno.mkdir(join(dir, 'src'), { recursive: true })
    const manifest = fixture.manifest ?? JSON.stringify({
      name: `@fixture/${fixture.name}`,
      ...(fixture.private === true ? { private: true } : {}),
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

Deno.test('a publishable package with neither a mutation script nor a ledger entry is refused', async () => {
  const root = await workspaceOf([{ name: 'loose', mutation: false, files: ['src/order.ts'] }])
  assertEquals(await planMutationShards(root), {
    packages: [],
    exempt: [],
    refusals: [{ _tag: 'PublishableWithoutMutationOrLedger', package: '@fixture/loose' }],
  })
})

Deno.test('a ledger-exempt package is planned empty and listed in the summary', async () => {
  const root = await workspaceOf([{ name: 'legacy', mutation: false, files: ['src/order.ts'] }], {
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

Deno.test('a private package with neither a script nor a ledger entry is ignored', async () => {
  const root = await workspaceOf([
    { name: 'core', config: ['src/**/*.ts'], files: ['src/order.ts'] },
    { name: 'internal', private: true, mutation: false, files: ['src/order.ts'] },
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
