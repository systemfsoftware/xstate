import type { StrykerConfig } from '@systemfsoftware/stryker-js/config'

const slackForAContendedFullSuiteRunMs = 45_000
const heapPerTestRunnerIsolateMb = 2048

export const packageStrykerConfig = (mutate: ReadonlyArray<string>): StrykerConfig =>
  ({
    checkers: [{ plugin: '@systemfsoftware/stryker-js-typescript-checker' }],
    // At the default of 4 (2 checkers, each driving tsgo), shards on the 16 GB hosted runner exited 3 or lost the VM.
    concurrency: 2,
    coverageAnalysis: 'perTest',
    disableBail: true,
    htmlReporter: { fileName: 'reports/mutation-report.html' },
    ignorePatterns: ['reports', 'coverage', 'dist'],
    incremental: true,
    incrementalFile: 'reports/stryker-incremental.json',
    ignorers: ['@systemfsoftware/stryker-ignorer-effect-schema-declarations'],
    jsonReporter: { fileName: 'reports/mutation-report.json' },
    mutate: [...mutate],
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
