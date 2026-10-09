#!/usr/bin/env -S deno run --config=scripts/deno.json --allow-read --allow-write

import { parseArgs } from '@std/cli/parse-args'
import { dirname, join, relative, resolve } from '@std/path'
import { parse as parseYaml } from '@std/yaml'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

export const PlanShardProject = S.Struct({
  project: S.String,
  mutants: S.Array(S.String),
})

export const PlanShard = S.Struct({
  index: S.Int,
  count: S.Int,
  predictedSeconds: S.Finite,
  projects: S.Array(PlanShardProject),
})

const labelOf = (shard: typeof PlanShard.Type): string => `${shard.index}/${shard.count}`

const shardLabelsAreUnique = S.makeFilter(
  (shards: ReadonlyArray<typeof PlanShard.Type>): string | undefined => {
    const seen = new Set<string>()
    for (const shard of shards) {
      const label = labelOf(shard)
      if (seen.has(label)) return `shard plan shards share the label "${label}"`
      seen.add(label)
    }
    return undefined
  },
)

export const ShardPlan = S.Struct({
  version: S.Literal(1),
  targetSeconds: S.Finite,
  shards: S.Array(PlanShard).check(shardLabelsAreUnique),
  matrix: S.Struct({ include: S.Array(S.Struct({ shard: S.String, predictedSeconds: S.Finite })) }),
})

export type ShardPlan = typeof ShardPlan.Type

const Manifest = S.Struct({
  name: S.String,
  scripts: S.optionalKey(S.Record(S.String, S.String)),
})

const LedgerEntry = S.Struct({
  rule: S.String,
  scope: S.String,
  reason: S.String,
  removedBy: S.String,
})

const Ledger = S.Struct({ entries: S.Array(LedgerEntry) })

const MUTATION_EXEMPTION_RULE = 'XS1'

export type Refusal =
  | { readonly _tag: 'MalformedWorkspace'; readonly file: string }
  | { readonly _tag: 'MalformedManifest'; readonly file: string }
  | { readonly _tag: 'MalformedLedger'; readonly file: string }
  | { readonly _tag: 'PlanMissing'; readonly file: string }
  | { readonly _tag: 'PlanUndecodable'; readonly file: string; readonly reason: string }
  | { readonly _tag: 'PlannedProjectEscapesRoot'; readonly project: string }
  | { readonly _tag: 'MutationPackageWithoutMutants'; readonly package: string }
  | { readonly _tag: 'VacuousPlan' }
  | { readonly _tag: 'ShardUnknown'; readonly shard: string; readonly labels: readonly string[] }

export const renderRefusal = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case 'MalformedWorkspace':
      return `malformed pnpm-workspace.yaml (${refusal.file})`
    case 'MalformedManifest':
      return `malformed package manifest (${refusal.file})`
    case 'MalformedLedger':
      return `malformed debt ledger (${refusal.file})`
    case 'PlanMissing':
      return `no shard plan at ${refusal.file}; run \`stryker plan --out\` before the gate`
    case 'PlanUndecodable':
      return `undecodable shard plan at ${refusal.file}: ${refusal.reason}`
    case 'PlannedProjectEscapesRoot':
      return `C13-13: planned project ${JSON.stringify(refusal.project)} resolves outside the repository`
    case 'MutationPackageWithoutMutants':
      return `${refusal.package}: declares a mutation script but stryker plan scheduled no mutants for it, and no ${MUTATION_EXEMPTION_RULE} debt-ledger entry exempts it`
    case 'VacuousPlan':
      return 'stryker plan scheduled no mutants and no debt-ledger entry exempts anything; the release gate refuses a vacuous set'
    case 'ShardUnknown':
      return `unknown shard ${refusal.shard}; plan has ${refusal.labels.join(', ')}`
  }
}

const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(file)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}

const relativePosix = (from: string, to: string): string => relative(from, to).replaceAll('\\', '/')

const escapesRoot = (relativePath: string): boolean =>
  relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('/')

const workspacePatterns = (value: unknown): readonly string[] | undefined => {
  if (typeof value !== 'object' || value === null || !('packages' in value)) return undefined
  const packages = value.packages
  if (!Array.isArray(packages)) return undefined
  const patterns: string[] = []
  for (const entry of packages) {
    if (typeof entry !== 'string') return undefined
    patterns.push(entry)
  }
  return patterns
}

const listDirectories = async (dir: string): Promise<readonly string[]> => {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(dir)) if (entry.isDirectory) names.push(entry.name)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return []
    throw error
  }
  return names.sort()
}

const workspaceMemberDirs = async (root: string, patterns: readonly string[]): Promise<readonly string[]> => {
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\/+$/u, '')
    if (normalized.endsWith('/*')) {
      const base = normalized.slice(0, -2)
      for (const name of await listDirectories(join(root, base))) dirs.add(join(base, name))
    } else {
      dirs.add(normalized)
    }
  }
  return [...dirs].sort()
}

export interface Member {
  readonly dir: string
  readonly name: string
  readonly mutates: boolean
}

export type Discovery =
  | { readonly ok: true; readonly members: readonly Member[] }
  | { readonly ok: false; readonly refusal: Refusal }

export const discoverMembers = async (root: string): Promise<Discovery> => {
  const workspaceFile = join(root, 'pnpm-workspace.yaml')
  const workspaceText = await readText(workspaceFile)
  if (workspaceText === undefined) return { ok: false, refusal: { _tag: 'MalformedWorkspace', file: workspaceFile } }
  let parsed: unknown
  try {
    parsed = parseYaml(workspaceText)
  } catch {
    return { ok: false, refusal: { _tag: 'MalformedWorkspace', file: workspaceFile } }
  }
  const patterns = workspacePatterns(parsed)
  if (patterns === undefined) return { ok: false, refusal: { _tag: 'MalformedWorkspace', file: workspaceFile } }

  const members: Member[] = []
  for (const dir of await workspaceMemberDirs(root, patterns)) {
    const manifestFile = join(root, dir, 'package.json')
    const text = await readText(manifestFile)
    if (text === undefined) continue
    let manifest: unknown
    try {
      manifest = JSON.parse(text)
    } catch {
      return { ok: false, refusal: { _tag: 'MalformedManifest', file: manifestFile } }
    }
    const decoded = S.decodeUnknownResult(Manifest)(manifest)
    if (Result.isFailure(decoded)) return { ok: false, refusal: { _tag: 'MalformedManifest', file: manifestFile } }
    members.push({
      dir: relativePosix(root, join(root, dir)),
      name: decoded.success.name,
      mutates: decoded.success.scripts?.mutation !== undefined,
    })
  }
  return { ok: true, members }
}

type LedgerRead =
  | { readonly ok: true; readonly entries: ReadonlyArray<typeof LedgerEntry.Type> }
  | { readonly ok: false; readonly refusal: Refusal }

const readLedger = async (root: string): Promise<LedgerRead> => {
  const file = join(root, 'debt-ledger.yaml')
  const text = await readText(file)
  if (text === undefined) return { ok: true, entries: [] }
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    return { ok: false, refusal: { _tag: 'MalformedLedger', file } }
  }
  const decoded = S.decodeUnknownResult(Ledger)(parsed)
  return Result.isFailure(decoded)
    ? { ok: false, refusal: { _tag: 'MalformedLedger', file } }
    : { ok: true, entries: decoded.success.entries }
}

const EMPTY_PLAN: ShardPlan = { version: 1, targetSeconds: 0, shards: [], matrix: { include: [] } }

type PlanRead =
  | { readonly ok: true; readonly plan: ShardPlan }
  | { readonly ok: false; readonly refusal: Refusal }

const decodePlan = (file: string, text: string): PlanRead => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, refusal: { _tag: 'PlanUndecodable', file, reason: String(error) } }
  }
  const decoded = S.decodeUnknownResult(ShardPlan)(parsed)
  return Result.isFailure(decoded)
    ? { ok: false, refusal: { _tag: 'PlanUndecodable', file, reason: decoded.failure.message } }
    : { ok: true, plan: decoded.success }
}

export interface GateInput {
  readonly root: string
  readonly planFile: string
}

export interface Unmutated {
  readonly package: string
  readonly dir: string
  readonly exemption: typeof LedgerEntry.Type | undefined
}

export interface GateResult {
  readonly matrix: ShardPlan['matrix']
  readonly hasShards: boolean
  readonly unmutated: readonly Unmutated[]
}

export const renderUnmutated = (member: Unmutated): string =>
  member.exemption === undefined
    ? `0 mutants for ${member.package} (${member.dir}): no mutation script and no ${MUTATION_EXEMPTION_RULE} debt-ledger entry`
    : `0 mutants for ${member.package} (${member.dir}): accepted by ${MUTATION_EXEMPTION_RULE} debt-ledger entry "${member.exemption.reason}", removed by ${member.exemption.removedBy}`

export type GateOutcome =
  | { readonly ok: true; readonly result: GateResult }
  | { readonly ok: false; readonly refusals: readonly Refusal[] }

export const gatePlan = async ({ root, planFile }: GateInput): Promise<GateOutcome> => {
  const discovery = await discoverMembers(root)
  if (!discovery.ok) return { ok: false, refusals: [discovery.refusal] }
  const ledger = await readLedger(root)
  if (!ledger.ok) return { ok: false, refusals: [ledger.refusal] }

  const resolvedPlanFile = resolve(root, planFile)
  const planText = await readText(resolvedPlanFile)
  const mutationMembers = discovery.members.filter((member) => member.mutates)
  if (planText === undefined && mutationMembers.length > 0) {
    return { ok: false, refusals: [{ _tag: 'PlanMissing', file: resolvedPlanFile }] }
  }
  const read = planText === undefined ? { ok: true as const, plan: EMPTY_PLAN } : decodePlan(resolvedPlanFile, planText)
  if (!read.ok) return { ok: false, refusals: [read.refusal] }
  const plan = read.plan

  const refusals: Refusal[] = []
  const planDirectory = dirname(resolvedPlanFile)
  const scheduled = new Map<string, number>()
  for (const shard of plan.shards) {
    for (const entry of shard.projects) {
      const projectDir = relativePosix(root, resolve(planDirectory, entry.project))
      if (escapesRoot(projectDir)) {
        refusals.push({ _tag: 'PlannedProjectEscapesRoot', project: entry.project })
        continue
      }
      scheduled.set(projectDir, (scheduled.get(projectDir) ?? 0) + entry.mutants.length)
    }
  }

  const exemption = (name: string): typeof LedgerEntry.Type | undefined =>
    ledger.entries.find((entry) => entry.rule === MUTATION_EXEMPTION_RULE && entry.scope === name)

  for (const member of mutationMembers) {
    if ((scheduled.get(member.dir) ?? 0) === 0 && exemption(member.name) === undefined) {
      refusals.push({ _tag: 'MutationPackageWithoutMutants', package: member.name })
    }
  }

  const scheduledTotal = [...scheduled.values()].reduce((total, count) => total + count, 0)
  if (scheduledTotal === 0 && ledger.entries.length === 0) refusals.push({ _tag: 'VacuousPlan' })

  if (refusals.length > 0) return { ok: false, refusals }
  const unmutated = discovery.members
    .filter((member) => (scheduled.get(member.dir) ?? 0) === 0)
    .map((member) => ({ package: member.name, dir: member.dir, exemption: exemption(member.name) }))
  return { ok: true, result: { matrix: plan.matrix, hasShards: plan.matrix.include.length > 0, unmutated } }
}

export interface ShardProjects {
  readonly index: number
  readonly projects: readonly string[]
}

export type ShardSelection =
  | { readonly ok: true; readonly selected: ShardProjects }
  | { readonly ok: false; readonly refusal: Refusal }

export const selectShardProjects = async (
  { root, planFile, shard }: { readonly root: string; readonly planFile: string; readonly shard: string },
): Promise<ShardSelection> => {
  const resolvedPlanFile = resolve(root, planFile)
  const planText = await readText(resolvedPlanFile)
  if (planText === undefined) return { ok: false, refusal: { _tag: 'PlanMissing', file: resolvedPlanFile } }
  const read = decodePlan(resolvedPlanFile, planText)
  if (!read.ok) return read
  const found = read.plan.shards.find((candidate) => labelOf(candidate) === shard)
  return found === undefined
    ? { ok: false, refusal: { _tag: 'ShardUnknown', shard, labels: read.plan.shards.map(labelOf) } }
    : { ok: true, selected: { index: found.index, projects: found.projects.map((entry) => entry.project) } }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ['root', 'plan', 'out', 'shard'],
    default: { root: '.' },
  })
  const mode = args._[0]
  const emit = async (text: string): Promise<void> => {
    if (args.out === undefined) console.log(text.trimEnd())
    else await Deno.writeTextFile(args.out, text)
  }

  if (mode === 'projects') {
    const discovery = await discoverMembers(args.root)
    if (!discovery.ok) {
      console.error(`stryker-plan-gate: ${renderRefusal(discovery.refusal)}`)
      Deno.exit(1)
    }
    const projects = discovery.members.filter((member) => member.mutates).map((member) => member.dir).sort()
    await emit(`${projects.join(',')}\n`)
    Deno.exit(0)
  }

  if (mode === 'shard') {
    if (args.plan === undefined || args.shard === undefined) {
      console.error('stryker-plan-gate: shard needs --plan <file> --shard <index/count>')
      Deno.exit(2)
    }
    const selection = await selectShardProjects({ root: args.root, planFile: args.plan, shard: args.shard })
    if (!selection.ok) {
      console.error(`stryker-plan-gate: ${renderRefusal(selection.refusal)}`)
      Deno.exit(2)
    }
    const { index, projects } = selection.selected
    await emit(projects.map((project) => `${index}\t${project}\n`).join(''))
    Deno.exit(0)
  }

  if (args.plan === undefined) {
    console.error('stryker-plan-gate: gate needs --plan <file>')
    Deno.exit(2)
  }
  const outcome = await gatePlan({ root: args.root, planFile: args.plan })
  if (!outcome.ok) {
    for (const refusal of outcome.refusals) console.error(`stryker-plan-gate: ${renderRefusal(refusal)}`)
    Deno.exit(1)
  }
  for (const member of outcome.result.unmutated) console.error(`stryker-plan-gate: ${renderUnmutated(member)}`)
  console.error(`stryker-plan-gate: ${outcome.result.matrix.include.length} shard(s)`)
  await emit(`matrix=${JSON.stringify(outcome.result.matrix)}\nhas-shards=${outcome.result.hasShards}\n`)
  Deno.exit(0)
}
