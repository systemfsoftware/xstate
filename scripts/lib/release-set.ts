import { dirname, join, relative } from '@std/path'
import { Schema } from 'effect'
import { decodeText, readTextAt, readWorkspace } from './workspace.ts'

const ReleaseSetFile = Schema.Struct({ packages: Schema.Array(Schema.String) })

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.optionalKey(Schema.Boolean),
})

const MemberManifest = Schema.Struct({ private: Schema.optionalKey(Schema.Boolean) })

export type ReleasePackage = { readonly dir: string; readonly name: string; readonly version: string }

export type ReleaseSetRefusal =
  | { readonly _tag: 'MalformedReleaseSet'; readonly file: string }
  | { readonly _tag: 'MalformedWorkspace'; readonly file: string }
  | { readonly _tag: 'DuplicateReleaseEntry'; readonly dir: string }
  | { readonly _tag: 'UnknownWorkspaceMember'; readonly dir: string }
  | { readonly _tag: 'MalformedReleaseManifest'; readonly dir: string }
  | { readonly _tag: 'ReleasePackageNotPrivate'; readonly dir: string }
  | { readonly _tag: 'PublishableWorkspaceMember'; readonly dir: string }

export type ReleaseSetLoad =
  | { readonly ok: true; readonly packages: readonly ReleasePackage[] }
  | { readonly ok: false; readonly refusals: readonly ReleaseSetRefusal[] }

export const renderReleaseSetRefusal = (refusal: ReleaseSetRefusal): string => {
  switch (refusal._tag) {
    case 'MalformedReleaseSet':
      return `malformed release-set.json (${refusal.file})`
    case 'MalformedWorkspace':
      return `malformed pnpm-workspace.yaml (${refusal.file})`
    case 'DuplicateReleaseEntry':
      return `release-set.json lists ${refusal.dir} more than once`
    case 'UnknownWorkspaceMember':
      return `release-set.json lists ${refusal.dir}, which is not a pnpm workspace member`
    case 'MalformedReleaseManifest':
      return `malformed package manifest for release-set entry ${refusal.dir}`
    case 'ReleasePackageNotPrivate':
      return `${refusal.dir}: release-set package must be "private": true — nothing here is published to npm`
    case 'PublishableWorkspaceMember':
      return `${refusal.dir}: workspace member is not "private": true — nothing here may be npm-publishable`
  }
}

export class ReleaseSetError extends Error {
  readonly refusals: readonly ReleaseSetRefusal[]

  constructor(refusals: readonly ReleaseSetRefusal[]) {
    super(refusals.map(renderReleaseSetRefusal).join('\n'))
    this.name = 'ReleaseSetError'
    this.refusals = refusals
  }
}

const normalizeDir = (root: string, dir: string): string => relative(root, join(root, dir))

const readManifest = async (root: string, dir: string) => {
  const text = await readTextAt(join(root, dir, 'package.json'))
  return text === undefined ? undefined : decodeText(Manifest, text, JSON.parse)
}

export const loadReleaseSet = async (root: string): Promise<ReleaseSetLoad> => {
  const file = join(root, 'release-set.json')
  const text = await readTextAt(file)
  if (text === undefined) return { ok: false, refusals: [{ _tag: 'MalformedReleaseSet', file }] }
  const decoded = decodeText(ReleaseSetFile, text, JSON.parse)
  if (!decoded.ok) return { ok: false, refusals: [{ _tag: 'MalformedReleaseSet', file }] }

  const workspace = await readWorkspace(root)
  if (!workspace.ok) return { ok: false, refusals: [{ _tag: 'MalformedWorkspace', file: workspace.file }] }
  const memberDirs = new Set(workspace.manifests.map((manifest) => relative(root, dirname(manifest))))

  const refusals: ReleaseSetRefusal[] = []
  const seen = new Set<string>()
  const packages: ReleasePackage[] = []
  for (const raw of [...decoded.value.packages].sort()) {
    const dir = normalizeDir(root, raw)
    if (seen.has(dir)) {
      refusals.push({ _tag: 'DuplicateReleaseEntry', dir })
      continue
    }
    seen.add(dir)
    if (!memberDirs.has(dir)) {
      refusals.push({ _tag: 'UnknownWorkspaceMember', dir })
      continue
    }
    const manifest = await readManifest(root, dir)
    if (manifest === undefined || !manifest.ok) {
      refusals.push({ _tag: 'MalformedReleaseManifest', dir })
      continue
    }
    if (manifest.value.private !== true) {
      refusals.push({ _tag: 'ReleasePackageNotPrivate', dir })
      continue
    }
    packages.push({ dir, name: manifest.value.name, version: manifest.value.version })
  }

  for (const manifest of workspace.manifests) {
    const dir = relative(root, dirname(manifest))
    if (seen.has(dir)) continue
    const text = await readTextAt(manifest)
    if (text === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const decodedMember = decodeText(MemberManifest, text, JSON.parse)
    if (!decodedMember.ok || decodedMember.value.private !== true) {
      refusals.push({ _tag: 'PublishableWorkspaceMember', dir })
    }
  }

  if (refusals.length > 0) return { ok: false, refusals }
  return { ok: true, packages }
}

export const loadReleaseSetOrThrow = async (root: string): Promise<readonly ReleasePackage[]> => {
  const set = await loadReleaseSet(root)
  if (!set.ok) throw new ReleaseSetError(set.refusals)
  return set.packages
}
