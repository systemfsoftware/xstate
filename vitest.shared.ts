import { readFileSync } from 'node:fs'

import { defineConfig, type ViteUserConfig } from 'vitest/config'

const sourceCondition = '@systemfsoftware/source'
const guard = '@systemfsoftware/vitest/guard'
const excluded = ['**/.stryker-tmp/**', '**/node_modules/**']

const upstreamSpecifiers = [
  { find: /^xstate(\/.*)?$/, replacement: '@systemfsoftware/xstate$1' },
  { find: /^@xstate\/(effect|react|store|store-react|test)(\/.*)?$/, replacement: '@systemfsoftware/xstate-$1$2' },
]

const stringsAt = (record: object, field: string, file: URL): ReadonlyArray<unknown> => {
  const value: unknown = Reflect.get(record, field)
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${file.pathname}: "${field}" is not an array`)
  return value
}

const fileName = (file: URL) => (entry: unknown): string => {
  if (typeof entry === 'string') return entry
  const port: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'port') : undefined
  if (typeof port === 'string') return port
  throw new Error(`${file.pathname}: an entry is neither a file name nor a { port } record`)
}

const upstreamTestsOf = (packageUrl: string): ReadonlyArray<string> => {
  const file = new URL('./upstream-tests.json', packageUrl)
  const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null) throw new Error(`${file.pathname} is not an object`)
  return [...stringsAt(manifest, 'files', file), ...stringsAt(manifest, 'ported', file)].map(fileName(file))
}

export interface ForkTestOptions {
  readonly environment: 'node' | 'happy-dom'
  readonly inline?: ReadonlyArray<string>
}

// CONST-W3, declared bypass. Reason: statelyai/xstate's verbatim tests register every case with vitest's
// own `it`, which the @systemfsoftware/vitest guard refuses, and XS3 forbids editing an upstream case.
// Scope: the `upstream-verbatim` project, exactly the files upstream-tests.json records.
// Removed by: U4, the oracle lane (PR 3), which moves the upstream suite out of packages/.
export const forkTestConfig = (packageUrl: string, options: ForkTestOptions): ViteUserConfig => {
  const upstream = upstreamTestsOf(packageUrl)
  const browser = options.environment === 'happy-dom'
  return defineConfig({
    resolve: {
      alias: upstreamSpecifiers,
      conditions: browser
        ? ['module', 'development', 'browser', sourceCondition]
        : ['module', 'browser', 'development|production', sourceCondition],
    },
    ssr: { resolve: { conditions: ['module', 'node', 'development|production', sourceCondition] } },
    test: {
      globals: false,
      environment: options.environment,
      exclude: excluded,
      passWithNoTests: true,
      ...(options.inline === undefined ? {} : { server: { deps: { inline: [...options.inline] } } }),
      projects: [
        { extends: true, test: { name: 'upstream-verbatim', globals: true, include: [...upstream] } },
        {
          extends: true,
          test: {
            name: 'own',
            setupFiles: [guard],
            include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
            exclude: [...excluded, ...upstream],
          },
        },
      ],
    },
  })
}
