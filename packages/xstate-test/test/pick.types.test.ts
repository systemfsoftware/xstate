import { expectTypeOf, it } from '@systemfsoftware/vitest'
import { createMachine, types } from '@systemfsoftware/xstate'
import * as fc from 'fast-check'
import { pick, propertyTest, testPaths } from '../src/index.js'

const cartMachine = createMachine({
  schemas: {
    context: types<{ items: Record<string, number> }>(),
    events: {
      ADD: types<{ sku: string }>(),
      REMOVE: types<{ sku: string }>(),
    },
  },
  context: { items: {} },
})

it('infers the snapshot and checks the payload of pick()', function*({ expect }) {
  if (false) {
    void propertyTest(cartMachine, {
      events: {
        REMOVE: pick(
          (snapshot) => {
            expectTypeOf(snapshot.context.items).toEqualTypeOf<
              Record<string, number>
            >()
            return Object.keys(snapshot.context.items)
          },
          (sku, snapshot) => {
            expectTypeOf(sku).toEqualTypeOf<string>()
            expectTypeOf(snapshot.context.items).toEqualTypeOf<
              Record<string, number>
            >()
            return { sku }
          },
        ),
        ADD: pick((snapshot) => Object.keys(snapshot.context.items).map((sku) => ({ sku }))),
      },
    })
    void testPaths(cartMachine, {
      events: {
        REMOVE: pick(
          (snapshot) => Object.keys(snapshot.context.items),
          (sku) => ({ sku }),
        ),
      },
    })
    void propertyTest(cartMachine, {
      events: {
        // @ts-expect-error the payload must match the REMOVE event
        REMOVE: pick(
          (snapshot) => Object.keys(snapshot.context.items),
          (sku) => ({ item: sku }),
        ),
      },
    })
  }

  const initial = cartMachine.getInitialSnapshot()
  const withItems = { ...initial, context: { items: { apple: 2, banana: 1 } } }
  const descriptor = pick((snapshot: typeof initial) => Object.keys(snapshot.context.items))
  yield* expect({
    empty: descriptor.resolve({ snapshot: initial, generated: 0 }),
    picked: descriptor.resolve({ snapshot: withItems, generated: 0 }),
    wrapped: descriptor.resolve({ snapshot: withItems, generated: 3 }),
  }).toEqual({ empty: undefined, picked: 'apple', wrapped: 'banana' })
})

it('types the resolved descriptor', function*({ expect }) {
  const descriptor = pick(
    (
      snapshot:
        & { context: { items: string[] } }
        & ReturnType<
          typeof cartMachine.getInitialSnapshot
        >,
    ) => snapshot.context.items,
    (sku) => ({ sku }),
  )
  expectTypeOf(descriptor.resolve).parameter(0).toMatchTypeOf<{
    generated: number
  }>()
  expectTypeOf(descriptor.resolve).returns.toEqualTypeOf<
    { sku: string } | undefined
  >()

  yield* expect({
    keys: Object.keys(descriptor),
    naturalIndex: fc.sample(descriptor.generate, 1).every((index) => Number.isInteger(index) && index >= 0),
  }).toEqual({ keys: ['generate', 'resolve'], naturalIndex: true })
})
