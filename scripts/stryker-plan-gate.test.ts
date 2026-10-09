import { assertEquals } from '@std/assert'
import { join } from '@std/path'
import { gatePlan, type Refusal, scopeOf, selectShardProjects, type ShardPlan } from './stryker-plan-gate.ts'

interface FixturePackage {
  readonly dir: string
  readonly name: string
  readonly mutates: boolean
  readonly strykerConfig?: string
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
    if (pkg.strykerConfig !== undefined) await Deno.writeTextFile(join(dir, 'stryker.config.ts'), pkg.strykerConfig)
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
      outOfScope: [],
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
      outOfScope: [],
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
      outOfScope: [],
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

const CORE = { dir: 'packages/core', mutate: ['src/a.ts', 'src/b.ts'] }
const SITE = { dir: 'packages/site', mutate: ['src/page.ts'] }

Deno.test('a change scopes mutation to the declared files it touches and leaves untouched members out', () => {
  assertEquals(scopeOf([CORE, SITE], ['packages/core/src/b.ts', 'README.md']), [
    { _tag: 'ChangedFiles', project: 'packages/core', files: ['src/b.ts'] },
  ])
})

Deno.test('a change to a member file outside its declared set mutates that member whole', () => {
  for (const file of ['tests/a.test.ts', 'src/helper.ts', 'src/a.test.ts', 'stryker.config.ts', 'package.json']) {
    assertEquals(scopeOf([CORE, SITE], ['packages/core/src/a.ts', `packages/core/${file}`]), [
      { _tag: 'WholeSet', project: 'packages/core' },
    ], file)
  }
})

Deno.test('a change to the gate mutates every member whole, touched or not', () => {
  for (
    const file of ['.github/workflows/release-gate.yml', '.github/actions/sandbox/action.yml', 'stryker.shared.ts']
  ) {
    assertEquals(scopeOf([CORE, SITE], [file]), [
      { _tag: 'WholeSet', project: 'packages/core' },
      { _tag: 'WholeSet', project: 'packages/site' },
    ], file)
  }
})

Deno.test('a member directory that only prefixes another is not touched by it', () => {
  assertEquals(scopeOf([CORE], ['packages/core-extra/src/a.ts']), [])
})

const CORE_CONFIG = "export default { mutate: ['src/a.ts'] }\n"

Deno.test('a change that touches no mutated member passes the gate with no plan and names the members it left out', async () => {
  const { root, planFile } = await writeFixture({
    packages: [{ dir: 'packages/core', name: '@fixture/core', mutates: true, strykerConfig: CORE_CONFIG }],
  })
  assertEquals(await gatePlan({ root, planFile, changed: ['docs/notes.md'] }), {
    ok: true,
    result: {
      matrix: { include: [] },
      hasShards: false,
      unmutated: [],
      outOfScope: [{ package: '@fixture/core', dir: 'packages/core' }],
    },
  })
})

Deno.test('a change still refuses a touched mutated member the plan scheduled nothing for', async () => {
  const { root, planFile } = await writeFixture({
    packages: [
      { dir: 'packages/core', name: '@fixture/core', mutates: true, strykerConfig: CORE_CONFIG },
      { dir: 'packages/site', name: '@fixture/site', mutates: true, strykerConfig: CORE_CONFIG },
    ],
    plan: { ...TWO_PROJECT_PLAN, shards: [TWO_PROJECT_PLAN.shards[1]!] },
  })
  const outcome = await gatePlan({ root, planFile, changed: ['packages/core/src/a.ts'] })
  assertEquals(outcome.ok ? outcome : outcome.refusals, [
    { _tag: 'MutationPackageWithoutMutants', package: '@fixture/core' },
  ])
})

Deno.test('a change touching a member whose stryker config declares no mutate list is refused', async () => {
  const { root, planFile } = await writeFixture({
    packages: [{ dir: 'packages/core', name: '@fixture/core', mutates: true, strykerConfig: 'export default {}\n' }],
  })
  const outcome = await gatePlan({ root, planFile, changed: ['packages/core/src/a.ts'] })
  assertEquals(outcome.ok ? [] : tagsOf(outcome.refusals), ['MalformedStrykerConfig'])
})
