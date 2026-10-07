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
  steps: S.Array(S.Struct({
    name: S.optional(S.String),
    uses: S.optional(S.String),
    with: S.optional(S.Struct({
      hosts: S.optional(S.String),
      'pass-env': S.optional(S.String),
      command: S.optional(S.String),
    })),
  })),
})

const Workflow = S.Struct({ jobs: S.Struct({ plan: Job, mutation: Job }) })

const lines = (value: string | undefined): readonly string[] =>
  (value ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')

const sandboxSteps = async (
  job: 'plan' | 'mutation',
  runs: string,
): Promise<readonly SandboxStep[]> => {
  const decoded = S.decodeUnknownResult(Workflow)(
    parseYaml(await Deno.readTextFile(`${repoRoot}.github/workflows/release-gate.yml`)),
  )
  if (Result.isFailure(decoded)) throw new Error(`release-gate.yml: ${decoded.failure.message}`)
  return decoded.success.jobs[job].steps
    .filter((step) => step.uses === SANDBOX_ACTION && step.with?.command?.includes(runs))
    .map((step) => ({
      name: step.name ?? '',
      hosts: lines(step.with?.hosts),
      passEnv: lines(step.with?.['pass-env']),
      command: step.with?.command ?? '',
    }))
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

const PLAN = {
  version: 1,
  targetSeconds: 900,
  shards: [{
    index: 1,
    count: 1,
    predictedSeconds: 5,
    projects: [{ project: '../packages/core', mutants: ['0123456789abcdef'] }],
  }],
  matrix: { include: [{ shard: '1/1', predictedSeconds: 5 }] },
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
  await Deno.mkdir(`${root}/.cache`)
  await Deno.writeTextFile(`${root}/.cache/stryker-plan.json`, `${JSON.stringify(PLAN)}\n`)
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
  const steps = await sandboxSteps('mutation', 'stryker run')
  if (steps.length !== 1) throw new Error(`expected one stryker run step, found ${steps.map((step) => step.name)}`)
  const step = steps[0]!
  const missing = required.filter((name) => !step.passEnv.includes(name))
  if (missing.length > 0 || step.passEnv.includes(GUARD_OVERRIDE)) {
    throw new Error(
      `"${step.name}" passes [${step.passEnv}]; the guard needs [${required}] and never ${GUARD_OVERRIDE}`,
    )
  }
  const root = await writeFixture()
  try {
    await Deno.mkdir(`${root}/node_modules/.bin`, { recursive: true })
    await Deno.writeTextFile(
      `${root}/node_modules/.bin/stryker`,
      '#!/usr/bin/env bash\nenv > .cache/stryker-env.txt\n',
      {
        mode: 0o755,
      },
    )
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
