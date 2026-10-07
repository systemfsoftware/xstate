import { expectTypeOf } from '@systemfsoftware/vitest'
import { z } from 'zod'
import type { ActorRefFrom, ContextFrom, PersistedSnapshotFrom, SnapshotFrom } from '../src/index.js'
import { createMachine } from '../src/index.js'

const machine = createMachine({
  schemas: { context: z.object({ counter: z.number() }) },
  context: { counter: 0 },
})

expectTypeOf<ContextFrom<typeof machine>>().toEqualTypeOf<{ counter: number }>()
expectTypeOf<SnapshotFrom<ActorRefFrom<typeof machine>>['context']>().toEqualTypeOf<{ counter: number }>()
expectTypeOf<PersistedSnapshotFrom<typeof machine>['context']>().toEqualTypeOf<{ counter: number }>()
