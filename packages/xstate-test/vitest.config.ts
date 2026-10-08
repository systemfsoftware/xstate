import { forkTestConfig } from '../../vitest.shared.ts'

const INTEGRATION_DIRECTORY = 'test/vitest-integration/**'
const INTEGRATION_INCLUDE = 'test/vitest-integration/**/*.test.ts'

interface InlineProject {
  test?: { name?: string; exclude?: string[] }
}

const isInlineProject = (value: unknown): value is InlineProject =>
  typeof value === 'object' && value !== null && 'test' in value

const config = forkTestConfig(import.meta.url, {
  environment: 'node',
})

// `@systemfsoftware/xstate-test`'s public vitest integration is its own subject: `@xstate/test/vitest`'s
// `it`/`test` resolve vitest's globals, and `withModelTests()` takes a vitest-`it`-shaped
// `(name, asyncFn, timeout)` base, so these cases must register through vitest's collector — the guard's
// marked-task check does not apply to them.
for (const project of config.test?.projects ?? []) {
  if (isInlineProject(project) && project.test?.name === 'own') {
    project.test.exclude = [...(project.test.exclude ?? []), INTEGRATION_DIRECTORY]
  }
}
config.test?.projects?.push({
  extends: true,
  test: {
    name: 'xstate-test-vitest-integration',
    globals: true,
    include: [INTEGRATION_INCLUDE],
  },
})

export default config
