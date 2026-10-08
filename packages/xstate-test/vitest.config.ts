import { defineConfig } from 'vitest/config'

const sourceCondition = '@systemfsoftware/source'
const excluded = ['**/.stryker-tmp/**', '**/node_modules/**']
const unguarded = [
  'test/advancedPropertyTest.test.ts',
  'test/campaignAssertions.test.ts',
  'test/docsExamples.test.ts',
  'test/effectSchema.test.ts',
  'test/engine/perfPairsDedup.test.ts',
  'test/engine/propertyExecuted.test.ts',
  'test/engine/propertyExploration.test.ts',
  'test/engine/propertyLinearizability.test.ts',
  'test/engine/propertyRegressions.test.ts',
  'test/engine/propertyReplay.test.ts',
  'test/engine/propertyReport.test.ts',
  'test/engine/propertySearch.test.ts',
  'test/engine/propertySuite.test.ts',
  'test/engine/propertyTest.test.ts',
  'test/engine/symmetry.test.ts',
  'test/engine/testPaths.test.ts',
  'test/engine/testPathsInternalEvents.test.ts',
  'test/engine/unifiedTestApi.test.ts',
  'test/executedEffects.test.ts',
  'test/exploration.test.ts',
  'test/failureDatabase.test.ts',
  'test/fastCheckWrappers.test.ts',
  'test/pairsRequirementsWeights.test.ts',
  'test/pick.types.test.ts',
  'test/playwrightArtifacts.test.ts',
  'test/playwrightPage.types.test.ts',
  'test/playwrightSut.test.ts',
  'test/propertyTest.test.ts',
  'test/propertyTest.types.test.ts',
  'test/reachability.test.ts',
  'test/reportingOptions.test.ts',
  'test/scheduler.test.ts',
  'test/schema.test.ts',
  'test/search.test.ts',
  'test/suite.test.ts',
  'test/symmetry.test.ts',
  'test/temporalPayloadsReplay.test.ts',
  'test/vitest.test.ts',
]

const ownSource = (module: string): string => new URL(`./src/${module}`, import.meta.url).pathname

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@systemfsoftware\/xstate-test$/, replacement: ownSource('index.ts') },
      { find: /^@systemfsoftware\/xstate-test\/effect-schema$/, replacement: ownSource('effect-schema.ts') },
      { find: /^@systemfsoftware\/xstate-test\/playwright$/, replacement: ownSource('playwright.ts') },
      { find: /^@systemfsoftware\/xstate-test\/schema$/, replacement: ownSource('schema.ts') },
      { find: /^@systemfsoftware\/xstate-test\/vitest$/, replacement: ownSource('vitest.ts') },
    ],
    conditions: ['module', 'browser', 'development|production', sourceCondition],
  },
  ssr: { resolve: { conditions: ['module', 'node', 'development|production', sourceCondition] } },
  test: {
    globals: false,
    environment: 'node',
    exclude: excluded,
    passWithNoTests: true,
    projects: [
      { extends: true, test: { name: 'unguarded', globals: true, include: unguarded } },
      {
        extends: true,
        test: {
          name: 'own',
          setupFiles: ['@systemfsoftware/vitest/guard'],
          include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
          exclude: [...excluded, ...unguarded],
        },
      },
    ],
  },
})
