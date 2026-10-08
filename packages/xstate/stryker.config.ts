import { packageStrykerConfig } from '../../stryker.shared.ts'

export default packageStrykerConfig([
  'src/assert.ts',
  'src/stateMatching.ts',
  'src/mapState.ts',
])
