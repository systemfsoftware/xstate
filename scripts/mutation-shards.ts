#!/usr/bin/env -S deno run --config=scripts/deno.json --allow-read --allow-write --allow-import=jsr.io

import { parseArgs } from '@std/cli/parse-args'
import { expandGlob } from '@std/fs/expand-glob'
import { dirname, join, relative, toFileUrl } from '@std/path'
import { parse as parseYaml } from '@std/yaml'
import { Schema } from 'effect'
import { loadReleaseSet, type ReleaseSetRefusal, renderReleaseSetRefusal } from './lib/release-set.ts'
import { decodeAt, decodeText, readTextAt, readWorkspace } from './lib/workspace.ts'

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-._~]+\/)?[a-z0-9-~][a-z0-9-._~]*$/

const Manifest = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(PACKAGE_NAME_PATTERN, { message: 'expected an npm package name' }),
      Schema.isMaxLength(214, { message: 'expected at most 214 characters' }),
    ),
  ),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  stryker: Schema.optionalKey(Schema.Struct({ mutate: Schema.optionalKey(Schema.Array(Schema.String)) })),
})

const LedgerEntryStruct = Schema.Struct({
  rule: Schema.String,
  scope: Schema.String,
  reason: Schema.String,
  removedBy: Schema.String,
})

type LedgerEntry = (typeof LedgerEntryStruct)['Type']

const Ledger = Schema.Struct({ entries: Schema.Array(LedgerEntryStruct) })

const StrykerConfigModule = Schema.Struct({
  default: Schema.Struct({ mutate: Schema.Array(Schema.String) }),
})

export type Exempt = { readonly package: string; readonly rule: string; readonly removedBy: string }

type MutationRefusal =
  | { readonly _tag: 'EmptyWorkspace' }
  | { readonly _tag: 'VacuousPlan' }
  | { readonly _tag: 'MalformedWorkspace'; readonly file: string }
  | { readonly _tag: 'MalformedManifest'; readonly file: string }
  | { readonly _tag: 'MalformedLedger'; readonly file: string }
  | { readonly _tag: 'MalformedStrykerConfig'; readonly file: string }
  | { readonly _tag: 'ManifestCarriesMutate'; readonly package: string; readonly file: string }
  | { readonly _tag: 'MutationPackageWithoutConfig'; readonly package: string }
  | {
    readonly _tag: 'GlobMatchesNothing'
    readonly package: string
    readonly dir: string
    readonly mutate: readonly string[]
  }
  | { readonly _tag: 'PublishableWithoutMutationOrLedger'; readonly package: string }

export type Refusal = MutationRefusal | ReleaseSetRefusal

export type MutationPlan = {
  readonly packages: readonly string[]
  readonly exempt: readonly Exempt[]
  readonly refusals: readonly Refusal[]
}

export const renderRefusal = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case 'EmptyWorkspace':
      return 'no workspace package was found under pnpm-workspace.yaml'
    case 'VacuousPlan':
      return 'no package mutates and no publishable package is ledger-exempt; the release gate refuses a vacuous set'
    case 'MalformedWorkspace':
      return `malformed pnpm-workspace.yaml (${refusal.file})`
    case 'MalformedManifest':
      return `malformed package manifest (${refusal.file})`
    case 'MalformedLedger':
      return `malformed debt ledger (${refusal.file})`
    case 'MalformedStrykerConfig':
      return `malformed stryker config (${refusal.file})`
    case 'ManifestCarriesMutate':
      return `${refusal.package} (${refusal.file}): package.json declares stryker.mutate; the mutate list lives only in stryker.config.ts`
    case 'MutationPackageWithoutConfig':
      return `${refusal.package}: declares a mutation script but has no stryker.config.ts`
    case 'GlobMatchesNothing':
      return `${refusal.package} (${refusal.dir}): stryker.config.ts mutate ${
        JSON.stringify(refusal.mutate)
      } matches no files`
    case 'PublishableWithoutMutationOrLedger':
      return `${refusal.package}: release-set package without a mutation script and without an XS1 debt-ledger entry`
    case 'MalformedReleaseSet':
    case 'DuplicateReleaseEntry':
    case 'UnknownWorkspaceMember':
    case 'MalformedReleaseManifest':
    case 'ReleasePackageNotPrivate':
    case 'PublishableWorkspaceMember':
      return renderReleaseSetRefusal(refusal)
  }
}

export const renderSummary = (plan: MutationPlan): string => {
  const rows = plan.exempt.length === 0
    ? ['| — | — | — |']
    : plan.exempt.map((entry) => `| ${entry.package} | ${entry.rule} | ${entry.removedBy} |`)
  return [
    '# Mutation shards',
    '',
    `Mutated packages: \`${JSON.stringify(plan.packages)}\``,
    '',
    '## Ledger-exempt packages',
    '',
    '| Package | Rule | Removing unit |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

const matchesAnyFile = async (dir: string, mutate: readonly string[]): Promise<boolean> => {
  const exclude = ['**/node_modules/**', ...mutate.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1))]
  for (const glob of mutate.filter((glob) => !glob.startsWith('!'))) {
    for await (const _ of expandGlob(glob, { root: dir, exclude, includeDirs: false })) return true
  }
  return false
}

export const planMutationShards = async (root: string): Promise<MutationPlan> => {
  const packages: string[] = []
  const exempt: Exempt[] = []
  const refusals: Refusal[] = []

  const releaseSet = await loadReleaseSet(root)
  if (!releaseSet.ok) return { packages: [], exempt: [], refusals: releaseSet.refusals }
  const releaseNames = new Set(releaseSet.packages.map(({ name }) => name))

  const workspace = await readWorkspace(root)
  if (!workspace.ok) {
    return { packages: [], exempt: [], refusals: [{ _tag: 'MalformedWorkspace', file: workspace.file }] }
  }

  const ledgerFile = join(root, 'debt-ledger.yaml')
  const ledgerText = await readTextAt(ledgerFile)
  let entries: readonly LedgerEntry[] = []
  if (ledgerText !== undefined) {
    const ledger = decodeText(Ledger, ledgerText, parseYaml)
    if (!ledger.ok) {
      return { packages: [], exempt: [], refusals: [{ _tag: 'MalformedLedger', file: ledgerFile }] }
    }
    entries = ledger.value.entries
  }

  const manifests = [...workspace.manifests]
  if (manifests.length === 0) {
    return { packages: [], exempt: [], refusals: [{ _tag: 'EmptyWorkspace' }] }
  }

  for (const manifestFile of manifests) {
    const manifestText = await readTextAt(manifestFile)
    if (manifestText === undefined) {
      refusals.push({ _tag: 'MalformedManifest', file: manifestFile })
      continue
    }
    const manifest = decodeText(Manifest, manifestText, JSON.parse)
    if (!manifest.ok) {
      refusals.push({ _tag: 'MalformedManifest', file: manifestFile })
      continue
    }
    const name = manifest.value.name
    const dir = dirname(manifestFile)

    if (manifest.value.stryker?.mutate !== undefined) {
      refusals.push({ _tag: 'ManifestCarriesMutate', package: name, file: manifestFile })
      continue
    }

    if (manifest.value.scripts?.mutation === undefined) {
      if (releaseNames.has(name)) {
        const entry = entries.find((candidate) => candidate.rule === 'XS1' && candidate.scope === name)
        if (entry === undefined) refusals.push({ _tag: 'PublishableWithoutMutationOrLedger', package: name })
        else exempt.push({ package: name, rule: entry.rule, removedBy: entry.removedBy })
      }
      continue
    }

    const configFile = join(dir, 'stryker.config.ts')
    if ((await readTextAt(configFile)) === undefined) {
      refusals.push({ _tag: 'MutationPackageWithoutConfig', package: name })
      continue
    }

    let imported: unknown
    try {
      imported = await import(toFileUrl(configFile).href)
    } catch {
      refusals.push({ _tag: 'MalformedStrykerConfig', file: configFile })
      continue
    }
    const config = decodeAt(StrykerConfigModule, imported)
    if (!config.ok) {
      refusals.push({ _tag: 'MalformedStrykerConfig', file: configFile })
      continue
    }

    const mutate = config.value.default.mutate
    if (!(await matchesAnyFile(dir, mutate))) {
      refusals.push({ _tag: 'GlobMatchesNothing', package: name, dir: relative(root, dir), mutate })
      continue
    }
    packages.push(name)
  }

  if (packages.length === 0 && exempt.length === 0 && refusals.length === 0) refusals.push({ _tag: 'VacuousPlan' })

  return {
    packages: packages.sort(),
    exempt: exempt.sort((left, right) => left.package.localeCompare(right.package)),
    refusals,
  }
}

if (import.meta.main) {
  const { output, summary, root = '.' } = parseArgs(Deno.args, { string: ['output', 'summary', 'root'] })
  const plan = await planMutationShards(root)
  if (plan.refusals.length > 0) {
    for (const refusal of plan.refusals) console.error(`mutation-shards: ${renderRefusal(refusal)}`)
    Deno.exit(1)
  }
  const line = `packages=${JSON.stringify(plan.packages)}`
  if (output !== undefined) await Deno.writeTextFile(output, `${line}\n`, { append: true })
  else console.log(line)
  if (summary !== undefined) await Deno.writeTextFile(summary, renderSummary(plan))
  console.error(`mutation-shards: ${line}`)
}
