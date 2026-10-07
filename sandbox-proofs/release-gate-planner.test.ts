import { parse as parseYaml } from '@std/yaml'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'
import { run } from './spawn.ts'

const SANDBOX_ACTION = './.github/actions/sandbox'

interface SandboxStep {
  readonly name: string
  readonly hosts: readonly string[]
  readonly command: string
}

const repoRoot = new URL('..', import.meta.url).pathname

const Workflow = S.Struct({
  jobs: S.Struct({
    plan: S.Struct({
      steps: S.Array(S.Struct({
        name: S.optional(S.String),
        uses: S.optional(S.String),
        with: S.optional(S.Struct({ hosts: S.optional(S.String), command: S.optional(S.String) })),
      })),
    }),
  }),
})

const plannerSteps = async (): Promise<readonly SandboxStep[]> => {
  const decoded = S.decodeUnknownResult(Workflow)(
    parseYaml(await Deno.readTextFile(`${repoRoot}.github/workflows/release-gate.yml`)),
  )
  if (Result.isFailure(decoded)) throw new Error(`release-gate.yml: ${decoded.failure.message}`)
  const workflow = decoded.success
  return workflow.jobs.plan.steps
    .filter((step) => step.uses === SANDBOX_ACTION && step.with?.command?.includes('scripts/stryker-plan-gate.ts'))
    .map((step) => ({
      name: step.name ?? '',
      hosts: (step.with?.hosts ?? '').split('\n').map((host) => host.trim()).filter((host) => host !== ''),
      command: step.with?.command ?? '',
    }))
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
  const root = await Deno.makeTempDir({ prefix: 'release-gate-planner-' })
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
  const steps = await plannerSteps()
  if (steps.length !== 2) {
    throw new Error(`expected the discover and gate steps, found ${steps.map((step) => step.name)}`)
  }
  const root = await writeFixture()
  try {
    for (const step of steps) {
      await Deno.remove(`${root}/.cache/deno`, { recursive: true }).catch(() => undefined)
      const outcome = await run(
        'sandbox',
        [...step.hosts.flatMap((host) => ['--allow-host', host]), '--', 'bash', '-c', step.command],
        { cwd: root, env: { SANDBOX_PROJECT: root } },
      )
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
