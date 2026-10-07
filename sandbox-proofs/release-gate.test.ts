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
  await Deno.writeTextFile(`${root}/debt-ledger.yaml`, 'entries: []\n')
  await Deno.mkdir(`${root}/packages/core`, { recursive: true })
  await Deno.writeTextFile(
    `${root}/packages/core/package.json`,
    `${JSON.stringify({ name: '@fixture/core', scripts: { mutation: 'stryker run' } })}\n`,
  )
  await Deno.mkdir(`${root}/.cache`)
  await Deno.writeTextFile(`${root}/.cache/stryker-plan.json`, `${JSON.stringify(PLAN)}\n`)
  return root
}

Deno.test('each release-gate planner step runs in the sandbox on only the hosts release-gate.yml declares for it', async () => {
  const steps = await sandboxSteps('plan', 'scripts/stryker-plan-gate.ts')
  if (steps.length !== 2) {
    throw new Error(`expected the discover and gate steps, found ${steps.map((step) => step.name)}`)
  }
  const root = await writeFixture()
  try {
    for (const step of steps) {
      await Deno.remove(`${root}/.cache/deno`, { recursive: true }).catch(() => undefined)
      const outcome = await inSandbox(step, root)
      if (outcome.code !== 0) throw new Error(`"${step.name}" exited ${outcome.code}:\n${outcome.out}`)
    }
    const projects = await Deno.readTextFile(`${root}/.cache/mutation-projects.txt`)
    if (projects !== 'packages/core\n') throw new Error(`discover wrote ${JSON.stringify(projects)}`)
    const gate = await Deno.readTextFile(`${root}/.cache/mutation-plan.out`)
    if (!gate.includes('has-shards=true')) throw new Error(`gate wrote ${JSON.stringify(gate)}`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test('the release-gate mutation step hands stryker the GITHUB_ACTIONS flag its main-CI guard admits', async () => {
  const steps = await sandboxSteps('mutation', 'stryker run')
  if (steps.length !== 1) throw new Error(`expected one stryker run step, found ${steps.map((step) => step.name)}`)
  const root = await writeFixture()
  try {
    await Deno.mkdir(`${root}/node_modules/.bin`, { recursive: true })
    await Deno.writeTextFile(
      `${root}/node_modules/.bin/stryker`,
      '#!/usr/bin/env bash\nprintf \'GITHUB_ACTIONS=%s\\nMUTATION_SHARD=%s\\n\' "${GITHUB_ACTIONS-}" "${MUTATION_SHARD-}" > .cache/stryker-env.txt\n',
      { mode: 0o755 },
    )
    const outcome = await inSandbox(steps[0]!, root, { GITHUB_ACTIONS: 'true', MUTATION_SHARD: '1/1' })
    if (outcome.code !== 0) throw new Error(`"${steps[0]!.name}" exited ${outcome.code}:\n${outcome.out}`)
    const seen = await Deno.readTextFile(`${root}/.cache/stryker-env.txt`)
    if (seen !== 'GITHUB_ACTIONS=true\nMUTATION_SHARD=1/1\n') throw new Error(`stryker saw ${JSON.stringify(seen)}`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
