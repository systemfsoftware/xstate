import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sourceCondition = '@systemfsoftware/source'
const excluded = ['**/.stryker-tmp/**', '**/node_modules/**']

const ownSource = (module: string): string => fileURLToPath(new URL(`./src/${module}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@systemfsoftware\/xstate-effect$/, replacement: ownSource('index.ts') },
      { find: /^@systemfsoftware\/xstate-effect\/atom$/, replacement: ownSource('atom.ts') },
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
      {
        extends: true,
        test: {
          name: 'own',
          setupFiles: ['@systemfsoftware/vitest/guard'],
          include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
          exclude: excluded,
        },
      },
    ],
  },
})
