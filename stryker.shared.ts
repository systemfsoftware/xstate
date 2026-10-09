import type { StrykerConfig } from '@systemfsoftware/stryker-js/config'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const slackForAContendedFullSuiteRunMs = 45_000
const heapPerTestRunnerIsolateMb = 2048

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

const scopedMutate = (mutate: ReadonlyArray<string>, scope: string | undefined): string[] => {
  if (scope === undefined) return [...mutate]
  const entries = scope.split(',')
  const project = relative(repoRoot, process.cwd()).replaceAll('\\', '/')
  return entries.includes(project) ? [...mutate] : mutate.filter((file) => entries.includes(`${project}/${file}`))
}

export const packageStrykerConfig = (mutate: ReadonlyArray<string>): StrykerConfig =>
  ({
    checkers: [{ plugin: '@systemfsoftware/stryker-js-typescript-checker' }],
    coverageAnalysis: 'perTest',
    disableBail: true,
    htmlReporter: { fileName: 'reports/mutation-report.html' },
    fileLogLevel: 'info',
    ignorePatterns: ['reports', 'coverage', 'dist'],
    incremental: true,
    incrementalFile: 'reports/stryker-incremental.json',
    ignorers: ['@systemfsoftware/stryker-ignorer-effect-schema-declarations'],
    jsonReporter: { fileName: 'reports/mutation-report.json' },
    mutate: scopedMutate(mutate, process.env['MUTATION_SCOPE']),
    packageManager: 'pnpm',
    reporters: ['progress', 'html', 'json', 'progress-stream'],
    testRunner: {
      plugin: '@systemfsoftware/stryker-js-vitest-runner',
      options: { configFile: 'vitest.config.ts', dir: '.', related: true },
    },
    testRunnerNodeArgs: [`--max-old-space-size=${heapPerTestRunnerIsolateMb}`],
    timeoutMS: slackForAContendedFullSuiteRunMs,
    thresholds: { break: 100, high: 100, low: 100 },
  }) satisfies StrykerConfig
