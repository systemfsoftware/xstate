import { basename, common, dirname, join, relative } from '@std/path'
import { parse as parseYaml } from '@std/yaml'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'
import { run } from './spawn.ts'

const SANDBOX_ACTION = './.github/actions/sandbox'

interface SandboxStep {
  readonly name: string
  readonly hosts: readonly string[]
  readonly passEnv: readonly string[]
  readonly command: string
}

const repoRoot = new URL('..', import.meta.url).pathname

const Job = S.Struct({
  needs: S.optional(S.Union([S.String, S.Array(S.String)])),
  steps: S.Array(S.Struct({
    name: S.optional(S.String),
    uses: S.optional(S.String),
    with: S.optional(S.Struct({
      hosts: S.optional(S.String),
      'pass-env': S.optional(S.String),
      command: S.optional(S.String),
      name: S.optional(S.String),
      path: S.optional(S.String),
      pattern: S.optional(S.String),
      'merge-multiple': S.optional(S.Boolean),
    })),
  })),
})

const Workflow = S.Struct({ jobs: S.Struct({ plan: Job, mutation: Job, verdict: Job }) })

type JobName = keyof typeof Workflow.Type.jobs

const lines = (value: string | undefined): readonly string[] =>
  (value ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')

let releaseGateJobsOnce: Promise<typeof Workflow.Type.jobs> | undefined

const releaseGateJobs = (): Promise<typeof Workflow.Type.jobs> =>
  releaseGateJobsOnce ??= (async () => {
    const decoded = S.decodeUnknownResult(Workflow)(
      parseYaml(await Deno.readTextFile(`${repoRoot}.github/workflows/release-gate.yml`)),
    )
    if (Result.isFailure(decoded)) throw new Error(`release-gate.yml: ${decoded.failure.message}`)
    return decoded.success.jobs
  })()

const sandboxSteps = async (job: JobName, runs: string): Promise<readonly SandboxStep[]> =>
  (await releaseGateJobs())[job].steps
    .filter((step) => step.uses === SANDBOX_ACTION && step.with?.command?.includes(runs))
    .map((step) => ({
      name: step.name ?? '',
      hosts: lines(step.with?.hosts),
      passEnv: lines(step.with?.['pass-env']),
      command: step.with?.command ?? '',
    }))

const onlySandboxStep = async (job: JobName, runs: string): Promise<SandboxStep> => {
  const [step, ...others] = await sandboxSteps(job, runs)
  if (step === undefined || others.length > 0) {
    throw new Error(
      `expected one ${job} step running "${runs}", found ${[step, ...others].map((found) => found?.name)}`,
    )
  }
  return step
}

const inSandbox = (step: SandboxStep, root: string, env: Record<string, string> = {}) =>
  run(
    'sandbox',
    [
      ...step.hosts.flatMap((host) => ['--allow-host', host]),
      ...step.passEnv.flatMap((name) => ['--pass-env', name]),
      '--',
      'bash',
      '-c',
      step.command,
    ],
    { cwd: root, env: { ...env, SANDBOX_PROJECT: root } },
  )

const writeStrykerStub = async (root: string, script: string): Promise<void> => {
  await Deno.mkdir(`${root}/node_modules/.bin`, { recursive: true })
  await Deno.writeTextFile(`${root}/node_modules/.bin/stryker`, `#!/usr/bin/env bash\n${script}`, { mode: 0o755 })
}

const STRYKER_DIST = `${repoRoot}node_modules/@systemfsoftware/stryker-js/dist`
const GUARD_REGION = /\/\/#region src\/refuse-local-mutation\.cell\.ts\n([\s\S]*?)\/\/#endregion/g
const GUARD_ENV_READ = /\benvOf(?:\$\d+)?\("([A-Z0-9_]+)"\)/g
const GUARD_OVERRIDE = 'ALLOW_LOCAL_MUTATION'

const guardEnvReads = async (): Promise<ReadonlySet<string>> => {
  const reads = new Set<string>()
  for await (const entry of Deno.readDir(STRYKER_DIST)) {
    if (!entry.name.endsWith('.mjs')) continue
    const bundle = await Deno.readTextFile(`${STRYKER_DIST}/${entry.name}`)
    for (const [, region] of bundle.matchAll(GUARD_REGION)) {
      for (const [, name] of region!.matchAll(GUARD_ENV_READ)) reads.add(name!)
    }
  }
  if (!reads.has(GUARD_OVERRIDE)) {
    throw new Error(`stryker-js's local-mutation guard in ${STRYKER_DIST} reads [${[...reads]}], not ${GUARD_OVERRIDE}`)
  }
  return reads
}

const PROJECT = 'packages/core'
const STREAM_FILE = 'mutation-stream.jsonl'
const UPLOAD_ARTIFACT = 'actions/upload-artifact@v6'
const DOWNLOAD_ARTIFACT = 'actions/download-artifact@v6'
const SHARD_OUT_MARKER = /const SHARD_OUT_MARKER = "([^"]+)"/
const GLOB_SEGMENT = /[*?[]/
const JOB_INDEX = '${{ strategy.job-index }}'

interface Plan {
  readonly version: number
  readonly targetSeconds: number
  readonly shards: ReadonlyArray<{
    readonly index: number
    readonly count: number
    readonly predictedSeconds: number
    readonly projects: ReadonlyArray<{ readonly project: string; readonly mutants: readonly string[] }>
  }>
  readonly matrix: { readonly include: ReadonlyArray<{ readonly shard: string; readonly predictedSeconds: number }> }
}

const flagOf = (command: string, flag: string): string => {
  const value = command.match(new RegExp(`${flag} (\\S+)`))?.[1]
  if (value === undefined) throw new Error(`${JSON.stringify(command)} passes no ${flag}`)
  return value
}

type StepInputs = NonNullable<typeof Job.Type.steps[number]['with']>

const onlyArtifactStep = async (
  job: JobName,
  action: string,
  pick: (inputs: StepInputs) => boolean,
): Promise<StepInputs> => {
  const found = (await releaseGateJobs())[job].steps.flatMap((step) =>
    step.uses === action && step.with !== undefined && pick(step.with) ? [step.with] : []
  )
  if (found.length !== 1) throw new Error(`expected one ${job} step using ${action}, found ${found.length}`)
  return found[0]!
}

const planFileOf = async (): Promise<string> => flagOf((await onlySandboxStep('plan', 'stryker plan')).command, '--out')

const planOf = async (matrix: readonly string[]): Promise<Plan> => {
  const project = relative(dirname(await planFileOf()), PROJECT)
  return {
    version: 1,
    targetSeconds: 900,
    shards: matrix.map((_, at) => ({
      index: at + 1,
      count: matrix.length,
      predictedSeconds: 5,
      projects: [{ project, mutants: [String(at + 1).repeat(16)] }],
    })),
    matrix: { include: matrix.map((shard) => ({ shard, predictedSeconds: 5 })) },
  }
}

const shardOutMarker = async (): Promise<string> => {
  for await (const entry of Deno.readDir(STRYKER_DIST)) {
    if (!entry.name.endsWith('.mjs')) continue
    const marker = (await Deno.readTextFile(`${STRYKER_DIST}/${entry.name}`)).match(SHARD_OUT_MARKER)?.[1]
    if (marker !== undefined) return marker
  }
  throw new Error(`stryker-js in ${STRYKER_DIST} defines no SHARD_OUT_MARKER`)
}

const searchRootOf = (pattern: string): string => {
  const segments = pattern.split('/').filter((segment) => segment !== '' && segment !== '.')
  const firstGlob = segments.findIndex((segment) => GLOB_SEGMENT.test(segment))
  return (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/')
}

const isUnder = (root: string, file: string): boolean => root === '' || file.startsWith(`${root}/`)

const streamOf = (mutants: readonly string[]): string =>
  mutants.map((id) => `${JSON.stringify({ _tag: 'mutant', id, status: 'Killed' })}\n`).join('')

const writePlan = async (root: string, planFile: string, plan: Plan): Promise<void> => {
  await Deno.mkdir(`${root}/${dirname(planFile)}`, { recursive: true })
  await Deno.writeTextFile(`${root}/${planFile}`, `${JSON.stringify(plan)}\n`)
}

const downloadedPlanOf = async (job: JobName): Promise<string> => {
  const download = await onlyArtifactStep(job, DOWNLOAD_ARTIFACT, (inputs) => inputs.name === 'stryker-plan')
  return join(download.path ?? '.', basename(await planFileOf()))
}

const shardArtifactTree = async (plan: Plan): Promise<ReadonlyMap<string, string>> => {
  const shardPlan = flagOf((await onlySandboxStep('mutation', 'stryker run')).command, '--plan')
  const downloadedPlan = await downloadedPlanOf('mutation')
  if (downloadedPlan !== join(shardPlan)) {
    throw new Error(`a shard job downloads the plan to ${downloadedPlan} but runs ${shardPlan}`)
  }
  const upload = await onlyArtifactStep(
    'mutation',
    UPLOAD_ARTIFACT,
    (inputs) => inputs.name?.startsWith('mutation-shard-') ?? false,
  )
  const download = await onlyArtifactStep('verdict', DOWNLOAD_ARTIFACT, (inputs) => inputs.pattern !== undefined)
  const roots = lines(upload.path).map(searchRootOf)
  const artifactRoot = common(roots)
  const marker = await shardOutMarker()
  const matches = new RegExp(`^${(download.pattern ?? '').replaceAll('*', '.*')}$`)
  const jobs = plan.matrix.include.map((entry) => entry.shard)
  const names = jobs.map((_, job) => (upload.name ?? '').replace(JOB_INDEX, String(job)))
  const downloaded = names.filter((name) => matches.test(name))
  const into = (name: string): string =>
    download['merge-multiple'] === true || downloaded.length === 1
      ? download.path ?? '.'
      : join(download.path ?? '.', name)
  const tree = new Map<string, string>()
  for (const shard of plan.shards) {
    const name = names[jobs.indexOf(`${shard.index}/${shard.count}`)]!
    if (!downloaded.includes(name)) continue
    for (const project of shard.projects) {
      const written = join(dirname(shardPlan), marker, String(shard.index), project.project, STREAM_FILE)
      if (!roots.some((root) => isUnder(root, written))) continue
      const inArtifact = artifactRoot === '' ? written : relative(artifactRoot, written)
      tree.set(join(into(name), inArtifact), streamOf(project.mutants))
    }
  }
  return tree
}

const writeFixture = async (): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: 'release-gate-' })
  await Deno.mkdir(`${root}/scripts`)
  for (const file of ['deno.json', 'deno.lock', 'stryker-plan-gate.ts']) {
    await Deno.copyFile(`${repoRoot}scripts/${file}`, `${root}/scripts/${file}`)
  }
  await Deno.writeTextFile(`${root}/pnpm-workspace.yaml`, 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(
    `${root}/debt-ledger.yaml`,
    'entries:\n  - rule: XS1\n    scope: "@fixture/docs"\n    reason: "docs rewrite pending"\n    removedBy: "U99"\n',
  )
  await Deno.mkdir(`${root}/packages/docs`, { recursive: true })
  await Deno.writeTextFile(`${root}/packages/docs/package.json`, `${JSON.stringify({ name: '@fixture/docs' })}\n`)
  await Deno.mkdir(`${root}/packages/core`, { recursive: true })
  await Deno.writeTextFile(
    `${root}/packages/core/package.json`,
    `${JSON.stringify({ name: '@fixture/core', scripts: { mutation: 'stryker run' } })}\n`,
  )
  await Deno.mkdir(`${root}/.cache`, { recursive: true })
  await writePlan(root, await planFileOf(), await planOf(['1/1']))
  return root
}

Deno.test('each release-gate planner step runs in the sandbox on only its declared hosts, and the gate logs every XS1 entry it accepted', async () => {
  const steps = await sandboxSteps('plan', 'scripts/stryker-plan-gate.ts')
  if (steps.length !== 2) {
    throw new Error(`expected the discover and gate steps, found ${steps.map((step) => step.name)}`)
  }
  const root = await writeFixture()
  try {
    const logs: string[] = []
    for (const step of steps) {
      await Deno.remove(`${root}/.cache/deno`, { recursive: true }).catch(() => undefined)
      const outcome = await inSandbox(step, root)
      if (outcome.code !== 0) throw new Error(`"${step.name}" exited ${outcome.code}:\n${outcome.out}`)
      logs.push(outcome.out)
    }
    const accepted =
      '@fixture/docs (packages/docs): accepted by XS1 debt-ledger entry "docs rewrite pending", removed by U99'
    if (!logs[1]!.includes(accepted)) throw new Error(`the gate step's log does not name the XS1 entry:\n${logs[1]}`)
    const projects = await Deno.readTextFile(`${root}/.cache/mutation-projects.txt`)
    if (projects !== 'packages/core\n') throw new Error(`discover wrote ${JSON.stringify(projects)}`)
    const gate = await Deno.readTextFile(`${root}/.cache/mutation-plan.out`)
    if (!gate.includes('has-shards=true')) throw new Error(`gate wrote ${JSON.stringify(gate)}`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('the release-gate mutation step passes stryker every variable its main-CI guard reads, and never the local override', async () => {
  const required = [...await guardEnvReads()].filter((name) => name !== GUARD_OVERRIDE)
  const step = await onlySandboxStep('mutation', 'stryker run')
  const missing = required.filter((name) => !step.passEnv.includes(name))
  if (missing.length > 0 || step.passEnv.includes(GUARD_OVERRIDE)) {
    throw new Error(
      `"${step.name}" passes [${step.passEnv}]; the guard needs [${required}] and never ${GUARD_OVERRIDE}`,
    )
  }
  const root = await writeFixture()
  try {
    await writeStrykerStub(root, 'env > .cache/stryker-env.txt\n')
    const runner = Object.fromEntries([...required, GUARD_OVERRIDE].map((name) => [name, `runner-${name}`]))
    const outcome = await inSandbox(step, root, { ...runner, MUTATION_SHARD: '1/1' })
    if (outcome.code !== 0) throw new Error(`"${step.name}" exited ${outcome.code}:\n${outcome.out}`)
    const seen = new Map(
      (await Deno.readTextFile(`${root}/.cache/stryker-env.txt`)).split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    const lost = required.filter((name) => seen.get(name) !== runner[name])
    if (lost.length > 0 || seen.has(GUARD_OVERRIDE)) {
      throw new Error(`stryker lost [${lost}]${seen.has(GUARD_OVERRIDE) ? ` and saw ${GUARD_OVERRIDE}` : ''}`)
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

const verdictFixture = async (plan: Plan, mergeExitCode: number): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: 'release-gate-verdict-' })
  await Deno.mkdir(`${root}/.cache`, { recursive: true })
  await writePlan(root, await downloadedPlanOf('verdict'), plan)
  for (const [file, stream] of await shardArtifactTree(plan)) {
    await Deno.mkdir(`${root}/${dirname(file)}`, { recursive: true })
    await Deno.writeTextFile(`${root}/${file}`, stream)
  }
  await writeStrykerStub(
    root,
    `mkdir -p .cache\nprintf '%s\\n' "$*" >> .cache/stryker-calls.txt\n[ "$1" = merge ] && exit ${mergeExitCode}\nexit 0\n`,
  )
  return root
}

const verdictStep = async (): Promise<SandboxStep> => {
  const needs = (await releaseGateJobs()).verdict.needs
  if (![needs ?? []].flat().includes('mutation')) {
    throw new Error(`the verdict job needs ${JSON.stringify(needs)}, not every mutation shard`)
  }
  return await onlySandboxStep('verdict', 'stryker merge')
}

const strykerCalls = async (root: string): Promise<readonly string[]> =>
  lines(await Deno.readTextFile(`${root}/.cache/stryker-calls.txt`))

const decodeStreamLine = S.decodeUnknownResult(S.fromJsonString(S.Struct({ id: S.String })))

const mergeArgsOf = (call: string): { readonly plan: string; readonly dirs: string[] } => {
  const [verb, ...args] = call.split(' ')
  if (verb !== 'merge') throw new Error(`expected a merge call, got ${JSON.stringify(call)}`)
  const merge = { plan: '', dirs: [] as string[] }
  for (let at = 0; at < args.length; at++) {
    if (args[at] === '--plan') merge.plan = args[++at]!
    else if (args[at] === '--out') at++
    else merge.dirs.push(args[at]!)
  }
  return merge
}

const unmergedMutants = async (root: string, plan: Plan, dirs: readonly string[]): Promise<readonly string[]> => {
  if (dirs.length !== plan.shards.length) {
    throw new Error(`merge got ${dirs.length} shard directories for ${plan.shards.length} shards: ${dirs}`)
  }
  const missing: string[] = []
  for (const [at, shard] of plan.shards.entries()) {
    for (const project of shard.projects) {
      const stream = await Deno.readTextFile(join(root, dirs[at]!, project.project, STREAM_FILE)).catch(() => '')
      const reported = new Set(
        lines(stream).flatMap((line) => {
          const decoded = decodeStreamLine(line)
          return Result.isSuccess(decoded) ? [decoded.success.id] : []
        }),
      )
      missing.push(...project.mutants.filter((id) => !reported.has(id)))
    }
  }
  return missing
}

for (
  const [label, matrix] of [
    ['one shard', ['1/1']],
    ['two shards whose matrix lists them in reverse plan order', ['2/2', '1/2']],
  ] as const
) {
  Deno.test(`the release-gate verdict merges, for ${label}, each shard's report directory where the shard job wrote and uploaded it, and gates the merged report with no accepted survivor`, async () => {
    const step = await verdictStep()
    const plan = await planOf(matrix)
    const root = await verdictFixture(plan, 0)
    try {
      const outcome = await inSandbox(step, root)
      if (outcome.code !== 0) throw new Error(`"${step.name}" exited ${outcome.code}:\n${outcome.out}`)
      const [mergeCall, gateCall, ...rest] = await strykerCalls(root)
      const merge = mergeArgsOf(mergeCall ?? '')
      if (merge.plan !== await downloadedPlanOf('verdict')) throw new Error(`merge read the plan at ${merge.plan}`)
      const missing = await unmergedMutants(root, plan, merge.dirs)
      if (missing.length > 0) {
        throw new Error(`planned mutant(s) missing from the shard reports: ${missing.join(', ')} (merge ${mergeCall})`)
      }
      if (gateCall !== 'gate --baseline .cache/no-survivors.json' || rest.length > 0) {
        throw new Error(`after the merge stryker ran ${JSON.stringify([gateCall, ...rest])}`)
      }
      const baseline = await Deno.readTextFile(`${root}/.cache/no-survivors.json`)
      if (JSON.stringify(JSON.parse(baseline)) !== '{"schemaVersion":1,"survivors":[]}') {
        throw new Error(`the gate's baseline accepts survivors: ${baseline}`)
      }
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
}

Deno.test('a failed shard-report merge fails the verdict step before the gate reads a merged report', async () => {
  const step = await verdictStep()
  const root = await verdictFixture(await planOf(['2/2', '1/2']), 3)
  try {
    const outcome = await inSandbox(step, root)
    if (outcome.code === 0) throw new Error(`"${step.name}" passed after the merge failed:\n${outcome.out}`)
    const calls = await strykerCalls(root)
    if (calls.some((call) => call.startsWith('gate'))) throw new Error(`the gate ran after the merge failed: ${calls}`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
