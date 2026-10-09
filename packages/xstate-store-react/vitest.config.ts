import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sourceCondition = '@systemfsoftware/source'
const excluded = ['**/.stryker-tmp/**', '**/node_modules/**']
const unguarded = [
  'src/index.test.tsx',
  'src/types.test.tsx',
]

const ownSource = (module: string): string => fileURLToPath(new URL(`./src/${module}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@systemfsoftware\/xstate-store-react$/, replacement: ownSource('index.ts') },
    ],
    conditions: ['module', 'development', 'browser', sourceCondition],
  },
  ssr: { resolve: { conditions: ['module', 'node', 'development|production', sourceCondition] } },
  test: {
    globals: false,
    environment: 'happy-dom',
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
