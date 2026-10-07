import { forkTestConfig } from '../../vitest.shared.ts'

export default forkTestConfig(import.meta.url, {
  environment: 'happy-dom',
})
