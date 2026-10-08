import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sourceCondition = '@systemfsoftware/source'
const excluded = ['**/.stryker-tmp/**', '**/node_modules/**']

const ownSource = (module: string): string => fileURLToPath(new URL(`./src/${module}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@systemfsoftware\/xstate-store$/, replacement: ownSource('index.ts') },
      { find: /^@systemfsoftware\/xstate-store\/persist$/, replacement: ownSource('persist.ts') },
      { find: /^@systemfsoftware\/xstate-store\/reset$/, replacement: ownSource('reset.ts') },
      { find: /^@systemfsoftware\/xstate-store\/undo$/, replacement: ownSource('undo.ts') },
      { find: /^@systemfsoftware\/xstate-store\/validate$/, replacement: ownSource('validate.ts') },
    ],
    conditions: ['module', 'development', 'browser', sourceCondition],
  },
  ssr: { resolve: { conditions: ['module', 'node', 'development|production', sourceCondition] } },
  test: {
    globals: false,
    environment: 'happy-dom',
    exclude: excluded,
    passWithNoTests: true,
    server: { deps: { inline: ['@statelyai/inspect'] } },
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
