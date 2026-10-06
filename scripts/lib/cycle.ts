import { join } from '@std/path'
import { run } from './run.ts'

export type CycleEntry = {
  name: string
  version: string
  tag: string
  changelog: string
}

type Pkg = {
  name?: string
  version?: string
  private?: boolean
}

export type Released = { name: string; version: string }

const publicPackages = async (): Promise<Released[]> => {
  const pkgs = JSON.parse(await run('pnpm', ['ls', '-r', '--json', '--depth=-1'])) as Pkg[]
  return pkgs
    .filter((pkg): pkg is Pkg & Released => Boolean(pkg.name && pkg.version) && !pkg.private)
    .map(({ name, version }) => ({ name, version }))
}

export const tagOf = ({ name, version }: Released): string => `${name}@v${version}`

export const owedPackages = (released: Released[], taggedTags: ReadonlySet<string>): Released[] =>
  released.filter((pkg) => !taggedTags.has(tagOf(pkg)))

export const isTagged = async (tag: string, repo = '.'): Promise<boolean> =>
  (await run('git', ['-C', repo, 'tag', '--list', tag])).trim() !== ''

export const loadWorkspaceCycle = async (): Promise<CycleEntry[]> => {
  const released = await publicPackages()
  const tagged = await Promise.all(released.map((pkg) => isTagged(tagOf(pkg)).then((t) => t ? tagOf(pkg) : undefined)))
  const taggedTags = new Set(tagged.filter((tag): tag is string => tag !== undefined))
  return owedPackages(released, taggedTags).map((pkg) => ({
    ...pkg,
    tag: tagOf(pkg),
    changelog: join('.changeset', 'changelogs', `${pkg.name.replace('/', '!')}@${pkg.version}.md`),
  }))
}

export const loadCaptured = async (path: string): Promise<CycleEntry[]> => {
  const raw: unknown = JSON.parse(await Deno.readTextFile(path))
  if (!Array.isArray(raw)) throw new Error('captured file must be a JSON array')
  return raw as CycleEntry[]
}
