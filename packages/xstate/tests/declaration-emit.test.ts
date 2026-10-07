import { it } from '@systemfsoftware/vitest'
import { Data, Effect } from 'effect'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const packageDir = path.resolve(import.meta.dirname, '..')
const fixtureDir = 'test/fixtures/declarations'
const typescript = createRequire(import.meta.url).resolve('typescript/package.json')
const tsc = path.join(path.dirname(typescript), 'bin/tsc')

const FIXTURES = ['narrowed-context', 'strict-targets', 'registered-child-parent', 'created-invoke'] as const

const TSC_COMPILE_BUDGET_MS = 60_000
const TSC_CHILD_BUDGET_MARGIN_MS = 5_000
const TSC_CHILD_BUDGET_MS = TSC_COMPILE_BUDGET_MS - TSC_CHILD_BUDGET_MARGIN_MS

const COMPILER_FLAGS = [
  '--ignoreConfig',
  '--strict',
  '--skipLibCheck',
  '--allowImportingTsExtensions',
  '--preserveSymlinks',
  '--target',
  'esnext',
  '--module',
  'nodenext',
  '--moduleResolution',
  'nodenext',
  '--types',
  '',
]

type Compiled = { readonly diagnostics: readonly string[] }

class ChildTimeout extends Data.TaggedError('ChildTimeout')<{
  readonly pid: number
  readonly budgetMs: number
  readonly args: readonly string[]
}> {
  override get message(): string {
    return `Child ${this.pid} timed out after ${this.budgetMs}ms and was killed: ${this.args.join(' ')}`
  }
}

type BoundedSpawn = {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly budgetMs: number
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const spawnBounded = ({ command, args, cwd, budgetMs }: BoundedSpawn) =>
  Effect.callback<string, ChildTimeout>((resume) => {
    const child = execFile(
      command,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, timeout: budgetMs, killSignal: 'SIGKILL' },
      (error, stdout) => {
        if (error?.signal !== 'SIGKILL') {
          resume(Effect.succeed(stdout))
          return
        }
        const pid = child.pid
        if (pid === undefined) {
          resume(Effect.die(new Error('A child killed for overrunning its budget reported no pid')))
          return
        }
        if (isProcessAlive(pid)) {
          resume(Effect.die(new Error(`Child ${pid} survived the kill that ended its ${budgetMs}ms budget`)))
          return
        }
        resume(Effect.fail(new ChildTimeout({ pid, budgetMs, args })))
      },
    )
    // An interrupted case must not leave the child running.
    return Effect.sync(() => {
      child.kill('SIGKILL')
    })
  })

const diagnosticsIn = (stdout: string): readonly string[] =>
  stdout.split('\n').filter((line) => /^\S.*\(\d+,\d+\): error TS/.test(line))

const compile = (cwd: string, args: readonly string[]) =>
  Effect.map(
    spawnBounded({
      command: process.execPath,
      args: [tsc, ...COMPILER_FLAGS, ...args],
      cwd,
      budgetMs: TSC_CHILD_BUDGET_MS,
    }),
    (stdout): Compiled => ({ diagnostics: diagnosticsIn(stdout) }),
  )

const diagnosticsOf = (compiled: Compiled, file: string) =>
  compiled.diagnostics.filter((line) => line.startsWith(`${fixtureDir}/${file}.ts(`))

const manyInvokedStates = (count: number) => {
  const eventKeys = Array.from({ length: count * 8 }, (_, i) => `e${i}`)
  const states = Array.from(
    { length: count },
    (_, i) =>
      `const p${i} = parentSetup.createStateConfig({
  invoke: { src: 'child', input: ({ context }) => ({ token: context.token }) },
  on: { ${eventKeys.slice(i * 8, (i + 1) * 8).map((key) => `${key}: { target: 'p${(i + 1) % count}' }`).join(',')} }
});`,
  )
  return `import { setup, types } from '../../../src/index.js';
import { childMachine } from './registered-child.js';

const parentSetup = setup({
  schemas: {
    context: types<{ token: string }>(),
    events: { ${eventKeys.map((key) => `${key}: types<{ value: string }>()`).join(',')} }
  },
  actors: { child: childMachine }
});

${states.join('\n')}

export const parentMachine = parentSetup.createMachine({
  context: { token: '' },
  initial: 'p0',
  states: { ${Array.from({ length: count }, (_, i) => `p${i}`).join(',')} }
});
`
}

/** Every type name an emitted declaration imports from the package's sources. */
const referencedNames = (declaration: string): readonly string[] => [
  ...new Set([
    ...[...declaration.matchAll(/import\("[^"]*\/src\/[^"]+"\)\.(\w+)/g)].map((match) => match[1]!),
    ...[...declaration.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*"[^"]*\/src\/[^"]+"/g)]
      .flatMap((match) => match[1]!.split(','))
      .map((entry) => entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!)
      .filter((name) => name.length > 0),
  ]),
]

const emitWorkspace = Effect.acquireRelease(
  Effect.promise(async () => {
    const cacheDir = path.join(packageDir, 'node_modules/.cache')
    await mkdir(cacheDir, { recursive: true })
    const root = await mkdtemp(path.join(cacheDir, 'declaration-emit-'))
    await symlink(path.join(packageDir, 'src'), path.join(root, 'src'))
    await cp(path.join(packageDir, fixtureDir), path.join(root, fixtureDir), { recursive: true })
    await writeFile(path.join(root, fixtureDir, 'many-invoked-states.ts'), manyInvokedStates(30))
    return root
  }),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
)

const emitted = (root: string, file: string) =>
  Effect.promise(() => readFile(path.join(root, 'dts', fixtureDir, `${file}.d.ts`), 'utf8').catch(() => ''))

it('Should_EmitEveryFixtureDeclarationWithoutDiagnostics_When_TypeScript7CompilesThem', function*({ expect }) {
  const root = yield* emitWorkspace
  const sources = [...FIXTURES, 'many-invoked-states', 'created-invoke-inference'].map((file) =>
    `${fixtureDir}/${file}.ts`
  )
  const compiled = yield* compile(root, [
    '--declaration',
    '--emitDeclarationOnly',
    '--rootDir',
    '.',
    '--outDir',
    'dts',
    ...sources,
    'src/index.ts',
  ])
  const declarations = yield* Effect.forEach(FIXTURES, (file) => emitted(root, file))
  const parent = yield* emitted(root, 'registered-child-parent')
  const many = yield* emitted(root, 'many-invoked-states')
  yield* expect({
    diagnostics: Object.fromEntries(
      [...FIXTURES, 'many-invoked-states', 'created-invoke-inference'].map((file) => [
        file,
        diagnosticsOf(compiled, file),
      ]),
    ),
    emitted: Object.fromEntries(FIXTURES.map((file, index) => [file, declarations[index]!.length > 0])),
    parentUnderBudget: Buffer.byteLength(parent) < 500_000,
    parentC0Members: parent.match(/readonly c0: \{/g)?.length ?? 0,
    manyUnderBudget: many.length > 0 && Buffer.byteLength(many) < 100_000,
    manyP0Members: many.match(/readonly p0: \{/g)?.length ?? 0,
  }).toEqual({
    diagnostics: {
      'narrowed-context': [],
      'strict-targets': [],
      'registered-child-parent': [],
      'created-invoke': [],
      'many-invoked-states': [],
      'created-invoke-inference': [],
    },
    emitted: {
      'narrowed-context': true,
      'strict-targets': true,
      'registered-child-parent': true,
      'created-invoke': true,
    },
    parentUnderBudget: true,
    parentC0Members: 1,
    manyUnderBudget: true,
    manyP0Members: 1,
  })
}, TSC_COMPILE_BUDGET_MS)

it('Should_NameOnlyEntryPointExports_When_ADeclarationReachesIntoTheSources', function*({ expect }) {
  const root = yield* emitWorkspace
  yield* compile(root, [
    '--declaration',
    '--emitDeclarationOnly',
    '--rootDir',
    '.',
    '--outDir',
    'dts',
    ...FIXTURES.map((file) => `${fixtureDir}/${file}.ts`),
    'src/index.ts',
  ])
  const declarations = yield* Effect.forEach(FIXTURES, (file) => emitted(root, file))
  const names = [...new Set(declarations.flatMap(referencedNames))].toSorted()
  const probe = path.join(root, fixtureDir, 'entry-point-names.ts')
  yield* Effect.promise(() =>
    writeFile(
      probe,
      `import type {\n${names.map((name) => `  ${name},`).join('\n')}\n} from '../../../src/index.js'\n`,
    )
  )
  const compiled = yield* compile(root, ['--noEmit', `${fixtureDir}/entry-point-names.ts`])
  yield* expect({ named: names.length > 0, missing: diagnosticsOf(compiled, 'entry-point-names') }).toEqual({
    named: true,
    missing: [],
  })
}, TSC_COMPILE_BUDGET_MS)

it('Should_CompileTheConsumer_When_ItSeesOnlyTheEmittedParentDeclaration', function*({ expect }) {
  const root = yield* emitWorkspace
  yield* compile(root, [
    '--declaration',
    '--emitDeclarationOnly',
    '--rootDir',
    '.',
    '--outDir',
    'dts',
    `${fixtureDir}/registered-child-parent.ts`,
    'src/index.ts',
  ])
  const parentSource = path.join(root, fixtureDir, 'registered-child-parent.ts')
  const parentDeclaration = path.join(root, 'dts', fixtureDir, 'registered-child-parent.d.ts')
  yield* Effect.promise(() => cp(parentDeclaration, path.join(root, fixtureDir, 'registered-child-parent.d.ts')))
  yield* Effect.promise(() => rm(parentSource))
  const compiled = yield* compile(root, ['--noEmit', `${fixtureDir}/registered-child-consumer.ts`])
  yield* expect({
    seesSource: compiled.diagnostics.some((line) => line.includes('registered-child-parent.ts(')),
    diagnostics: diagnosticsOf(compiled, 'registered-child-consumer'),
  }).toEqual({ seesSource: false, diagnostics: [] })
}, TSC_COMPILE_BUDGET_MS)

const HANGING_CHILD = "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1_000)"

const HANGING_CHILD_BUDGET_MS = 250
const HANGING_CHILD_CASE_BUDGET_MS = 5_000

it('Should_KillTheChildAndNameTheBudgetTimeout_When_TheChildOutlivesItsBudget', function*({ expect }) {
  const failure = yield* Effect.flip(
    spawnBounded({
      command: process.execPath,
      args: ['-e', HANGING_CHILD],
      cwd: packageDir,
      budgetMs: HANGING_CHILD_BUDGET_MS,
    }),
  )
  yield* expect({
    tag: failure._tag,
    namesTheTimeout: failure.message.includes(`timed out after ${HANGING_CHILD_BUDGET_MS}ms`),
    pidIsPositive: failure.pid > 0,
    killedChildIsGone: !isProcessAlive(failure.pid),
    livenessProbeSeesALivingProcess: isProcessAlive(process.pid),
  }).toEqual({
    tag: 'ChildTimeout',
    namesTheTimeout: true,
    pidIsPositive: true,
    killedChildIsGone: true,
    livenessProbeSeesALivingProcess: true,
  })
}, HANGING_CHILD_CASE_BUDGET_MS)
