import { assertEquals } from '@std/assert'
import { join } from '@std/path'
import { gatePlan, type Refusal, selectShardProjects, type ShardPlan } from './stryker-plan-gate.ts'

interface FixturePackage {
  readonly dir: string
  readonly name: string
  readonly mutates: boolean
}

interface FixtureOptions {
  readonly packages?: readonly FixturePackage[]
  readonly ledger?: string
  readonly plan?: ShardPlan
}

const writeFixture = async (options: FixtureOptions): Promise<{ root: string; planFile: string }> => {
  const root = await Deno.makeTempDir({ prefix: 'stryker-plan-gate-' })
  await Deno.writeTextFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(join(root, 'debt-ledger.yaml'), options.ledger ?? 'entries: []\n')
  for (const pkg of options.packages ?? []) {
    const dir = join(root, pkg.dir)
    await Deno.mkdir(dir, { recursive: true })
    const manifest = {
      name: pkg.name,
      private: true,
      ...(pkg.mutates ? { scripts: { mutation: 'stryker run' } } : {}),
    }
    await Deno.writeTextFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  if (options.plan !== undefined) {
    await Deno.writeTextFile(join(root, 'plan.json'), `${JSON.stringify(options.plan)}\n`)
  }
  return { root, planFile: 'plan.json' }
}

const TWO_PROJECT_PLAN: ShardPlan = {
  version: 1,
  targetSeconds: 900,
  shards: [
    {
      index: 1,
      count: 2,
      predictedSeconds: 5,
      projects: [{ project: 'packages/core', mutants: ['0123456789abcdef'] }],
    },
    {
      index: 2,
      count: 2,
      predictedSeconds: 3,
      projects: [{ project: 'packages/site', mutants: ['fedcba9876543210'] }],
    },
  ],
  matrix: { include: [{ shard: '1/2', predictedSeconds: 5 }, { shard: '2/2', predictedSeconds: 3 }] },
}

Deno.test('a valid plan yields the plan matrix and has-shards', async () => {
  const { root, planFile } = await writeFixture({
    packages: [
      { dir: 'packages/core', name: '@fixture/core', mutates: true },
      { dir: 'packages/site', name: '@fixture/site', mutates: true },
    ],
    plan: TWO_PROJECT_PLAN,
  })
  assertEquals(await gatePlan({ root, planFile }), {
    ok: true,
    result: {
      matrix: { include: [{ shard: '1/2', predictedSeconds: 5 }, { shard: '2/2', predictedSeconds: 3 }] },
      hasShards: true,
      unmutated: [],
    },
  })
})

Deno.test('a shard label selects that shard index and its projects in plan order', async () => {
  const plan: ShardPlan = {
    ...TWO_PROJECT_PLAN,
    shards: [
      TWO_PROJECT_PLAN.shards[0]!,
      {
        index: 2,
        count: 2,
        predictedSeconds: 3,
        projects: [
          { project: 'packages/site', mutants: ['fedcba9876543210'] },
          { project: 'packages/core', mutants: ['00112233445566ff'] },
        ],
      },
    ],
  }
  const { root, planFile } = await writeFixture({ plan })
  assertEquals(await selectShardProjects({ root, planFile, shard: '2/2' }), {
    ok: true,
    selected: { index: 2, projects: ['packages/site', 'packages/core'] },
  })
})

Deno.test('a shard label the plan does not carry is refused with the labels it does carry', async () => {
  const { root, planFile } = await writeFixture({ plan: TWO_PROJECT_PLAN })
  assertEquals(await selectShardProjects({ root, planFile, shard: '2/3' }), {
    ok: false,
    refusal: { _tag: 'ShardUnknown', shard: '2/3', labels: ['1/2', '2/2'] },
  })
})

Deno.test('shard selection without a plan file is refused', async () => {
  const { root, planFile } = await writeFixture({})
  assertEquals(await selectShardProjects({ root, planFile, shard: '1/1' }), {
    ok: false,
    refusal: { _tag: 'PlanMissing', file: join(root, planFile) },
  })
})

Deno.test('a planned project that resolves outside the repository is refused (C13-13)', async () => {
  const { root, planFile } = await writeFixture({
    packages: [{ dir: 'packages/core', name: '@fixture/core', mutates: true }],
    plan: {
      version: 1,
      targetSeconds: 900,
      shards: [
        {
          index: 1,
          count: 1,
          predictedSeconds: 1,
          projects: [
            { project: 'packages/core', mutants: ['0123456789abcdef'] },
            { project: '../../outside', mutants: ['fedcba9876543210'] },
          ],
        },
      ],
      matrix: { include: [{ shard: '1/1', predictedSeconds: 1 }] },
    },
  })
  assertEquals(await gatePlan({ root, planFile }), {
    ok: false,
    refusals: [{ _tag: 'PlannedProjectEscapesRoot', project: '../../outside' }],
  })
})

Deno.test('a mutation package with no scheduled mutants is refused by name (vacuous green)', async () => {
  const { root, planFile } = await writeFixture({
    packages: [
      { dir: 'packages/core', name: '@fixture/core', mutates: true },
      { dir: 'packages/site', name: '@fixture/site', mutates: true },
    ],
    plan: {
      version: 1,
      targetSeconds: 900,
      shards: [
        {
          index: 1,
          count: 1,
          predictedSeconds: 1,
          projects: [{ project: 'packages/core', mutants: ['0123456789abcdef'] }],
        },
      ],
      matrix: { include: [{ shard: '1/1', predictedSeconds: 1 }] },
    },
  })
  assertEquals(await gatePlan({ root, planFile }), {
    ok: false,
    refusals: [{ _tag: 'MutationPackageWithoutMutants', package: '@fixture/site' }],
  })
})

Deno.test('a mutation package with no scheduled mutants is allowed by a ledger entry', async () => {
  const { root, planFile } = await writeFixture({
    packages: [
      { dir: 'packages/core', name: '@fixture/core', mutates: true },
      { dir: 'packages/site', name: '@fixture/site', mutates: true },
    ],
    ledger: 'entries:\n  - rule: XS1\n    scope: "@fixture/site"\n    reason: "not split yet"\n    removedBy: "#42"\n',
    plan: {
      version: 1,
      targetSeconds: 900,
      shards: [
        {
          index: 1,
          count: 1,
          predictedSeconds: 1,
          projects: [{ project: 'packages/core', mutants: ['0123456789abcdef'] }],
        },
      ],
      matrix: { include: [{ shard: '1/1', predictedSeconds: 1 }] },
    },
  })
  assertEquals(await gatePlan({ root, planFile }), {
    ok: true,
    result: {
      matrix: { include: [{ shard: '1/1', predictedSeconds: 1 }] },
      hasShards: true,
      unmutated: [{
        package: '@fixture/site',
        dir: 'packages/site',
        exemption: { rule: 'XS1', scope: '@fixture/site', reason: 'not split yet', removedBy: '#42' },
      }],
    },
  })
})

Deno.test('an empty plan with no ledger exemption is refused', async () => {
  const { root, planFile } = await writeFixture({
    packages: [{ dir: 'packages/core', name: '@fixture/core', mutates: false }],
  })
  assertEquals(await gatePlan({ root, planFile }), { ok: false, refusals: [{ _tag: 'VacuousPlan' }] })
})

Deno.test('an empty plan is allowed by a ledger exemption', async () => {
  const { root, planFile } = await writeFixture({
    packages: [{ dir: 'packages/core', name: '@fixture/core', mutates: false }],
    ledger: 'entries:\n  - rule: XS1\n    scope: "@fixture/core"\n    reason: "not split yet"\n    removedBy: "#42"\n',
  })
  assertEquals(await gatePlan({ root, planFile }), {
    ok: true,
    result: {
      matrix: { include: [] },
      hasShards: false,
      unmutated: [{
        package: '@fixture/core',
        dir: 'packages/core',
        exemption: { rule: 'XS1', scope: '@fixture/core', reason: 'not split yet', removedBy: '#42' },
      }],
    },
  })
})

Deno.test('an empty plan names each member no XS1 entry covers, apart from the ones that are', async () => {
  const { root, planFile } = await writeFixture({
    packages: [
      { dir: 'packages/core', name: '@fixture/core', mutates: false },
      { dir: 'packages/docs', name: '@fixture/docs', mutates: false },
    ],
    ledger: 'entries:\n  - rule: XS1\n    scope: "@fixture/core"\n    reason: "not split yet"\n    removedBy: "#42"\n',
  })
  const outcome = await gatePlan({ root, planFile })
  assertEquals(
    outcome.ok ? outcome.result.unmutated.map((member) => [member.package, member.exemption?.rule]) : outcome,
    [['@fixture/core', 'XS1'], ['@fixture/docs', undefined]],
  )
})

const tagsOf = (refusals: readonly Refusal[]): readonly string[] => refusals.map((refusal) => refusal._tag)

Deno.test('a mutation package without a plan is refused when a plan is required', async () => {
  const { root, planFile } = await writeFixture({
    packages: [{ dir: 'packages/core', name: '@fixture/core', mutates: true }],
  })
  const outcome = await gatePlan({ root, planFile })
  assertEquals(outcome.ok, false)
  assertEquals(outcome.ok === false ? tagsOf(outcome.refusals) : [], ['PlanMissing'])
})
