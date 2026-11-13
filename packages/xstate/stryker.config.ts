import { packageStrykerConfig } from '../../stryker.shared.ts'

export default packageStrykerConfig([
  'src/assert.ts',
  'src/stateMatching.ts',
  'src/mapState.ts',
  'src/fsm.ts',
  'src/graph/actorScope.ts',
  'src/graph/adjacency.ts',
  'src/graph/alterPath.ts',
  'src/graph/graph.ts',
  'src/graph/pathFromEvents.ts',
  'src/graph/shortestPaths.ts',
  'src/graph/simplePaths.ts',
  'src/transitionGuards.ts',
  'src/historyRecall.ts',
  'src/stateNodePredicates.ts',
])
