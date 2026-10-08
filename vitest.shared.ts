import { playwright } from '@vitest/browser-playwright'
import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type ViteUserConfig } from 'vitest/config'

const sourceCondition = '@systemfsoftware/source'
const guard = '@systemfsoftware/vitest/guard'
const excluded = ['**/.stryker-tmp/**', '**/node_modules/**']
const repoRoot = dirname(fileURLToPath(import.meta.url))
const unguardedList = new URL('./packages/unguarded-tests.json', import.meta.url)

export interface ForkTestOptions {
  readonly environment: 'node' | 'happy-dom' | 'chromium'
  readonly inline?: ReadonlyArray<string>
}

const unguardedFiles = (): ReadonlyArray<string> => {
  const decoded: unknown = JSON.parse(readFileSync(unguardedList, 'utf8'))
  const files: unknown = typeof decoded === 'object' && decoded !== null ? Reflect.get(decoded, 'files') : undefined
  if (!Array.isArray(files)) throw new Error(`${unguardedList.pathname}: "files" is not an array`)
  return files.map((file: unknown) => {
    if (typeof file !== 'string') throw new Error(`${unguardedList.pathname}: a "files" entry is not a string`)
    return file
  })
}

export const forkTestConfig = (packageUrl: string, options: ForkTestOptions): ViteUserConfig => {
  const prefix = `${relative(repoRoot, fileURLToPath(new URL('.', packageUrl)))}/`
  const unguarded = unguardedFiles().filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length))
  const browser = options.environment !== 'node'
  return defineConfig({
    resolve: {
      conditions: browser
        ? ['module', 'development', 'browser', sourceCondition]
        : ['module', 'browser', 'development|production', sourceCondition],
    },
    ssr: { resolve: { conditions: ['module', 'node', 'development|production', sourceCondition] } },
    test: {
      globals: false,
      ...(options.environment === 'chromium'
        ? {
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: 'chromium' as const }],
          },
        }
        : { environment: options.environment }),
      exclude: excluded,
      passWithNoTests: true,
      ...(options.inline === undefined ? {} : { server: { deps: { inline: [...options.inline] } } }),
      projects: [
        ...(unguarded.length === 0 ? [] : [
          { extends: true, test: { name: 'unguarded', globals: true, include: [...unguarded] } },
        ]),
        {
          extends: true,
          test: {
            name: 'own',
            setupFiles: [guard],
            include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
            exclude: [...excluded, ...unguarded],
          },
        },
      ],
    },
  })
}
