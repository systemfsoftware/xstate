import { join } from '@std/path'
import { readLedger } from './ledger.ts'
import { loadReleaseSetOrThrow, type ReleasePackage } from './release-set.ts'
import { run } from './run.ts'

export type CycleEntry = {
  name: string
  version: string
  tag: string
  changelog: string
}

export type Released = { name: string; version: string }

export const tagOf = ({ name, version }: Released): string => `${name}@v${version}`

export const ledgerKeyOf = ({ name, version }: Released): string => `${name}@${version}`

export const isOwed = (
  pkg: ReleasePackage,
  ledgered: ReadonlySet<string>,
  taggedTags: ReadonlySet<string>,
): boolean => ledgered.has(ledgerKeyOf(pkg)) && !taggedTags.has(tagOf(pkg))

export const owedPackages = (
  release: readonly ReleasePackage[],
  ledgered: ReadonlySet<string>,
  taggedTags: ReadonlySet<string>,
): ReleasePackage[] => release.filter((pkg) => isOwed(pkg, ledgered, taggedTags))

export const isTagged = async (tag: string, repo = '.'): Promise<boolean> =>
  (await run('git', ['-C', repo, 'tag', '--list', tag])).trim() !== ''

export const loadWorkspaceCycle = async (root = '.'): Promise<CycleEntry[]> => {
  const release = await loadReleaseSetOrThrow(root)
  const ledger = await readLedger(join(root, '.changeset'))
  if (!ledger.ok) throw new Error(`malformed changeset ledger (${ledger.file})`)

  const taggedTags = new Set<string>()
  for (const pkg of release) {
    const tag = tagOf(pkg)
    if (await isTagged(tag, root)) taggedTags.add(tag)
  }

  return owedPackages(release, new Set(ledger.entries.keys()), taggedTags).map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    tag: tagOf(pkg),
    changelog: join(root, pkg.dir, 'CHANGELOG.md'),
  }))
}

export const loadCaptured = async (path: string): Promise<CycleEntry[]> => {
  const raw: unknown = JSON.parse(await Deno.readTextFile(path))
  if (!Array.isArray(raw)) throw new Error('captured file must be a JSON array')
  return raw as CycleEntry[]
}
