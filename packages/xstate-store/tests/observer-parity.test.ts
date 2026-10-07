import { expectTypeOf } from '@systemfsoftware/vitest'
import type { Observer as CoreObserver } from '@systemfsoftware/xstate'
import type { Observer as StoreObserver } from '@systemfsoftware/xstate-store'

type SharedObserverMember = 'next' | 'error' | 'complete'

expectTypeOf<Pick<StoreObserver<number>, SharedObserverMember>>().toEqualTypeOf<
  Pick<CoreObserver<number>, SharedObserverMember>
>()
expectTypeOf<keyof StoreObserver<number>>().toEqualTypeOf<SharedObserverMember>()
expectTypeOf<keyof CoreObserver<number>>().toEqualTypeOf<SharedObserverMember | 'passive'>()
