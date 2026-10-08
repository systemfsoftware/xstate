import { createMachine, type EventFrom, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import * as fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it as vitestIt } from 'vitest'
import { type TestSut } from '../../src/index.js'
import { it as modelIt, withModelTests } from '../../src/vitest.js'

const cartMachine = createMachine({
  id: 'cart',
  schemas: {
    context: types<{ items: Record<string, number> }>(),
    events: {
      ADD: types<{ sku: string }>(),
      REMOVE: types<{ sku: string }>(),
      CHECKOUT: types<{}>(),
    },
  },
  context: { items: {} },
  initial: 'shopping',
  states: {
    shopping: {
      on: {
        ADD: ({ context, event }) => ({
          context: {
            items: {
              ...context.items,
              [event.sku]: (context.items[event.sku] ?? 0) + 1,
            },
          },
        }),
        REMOVE: ({ context, event }) => {
          const { [event.sku]: _removed, ...items } = context.items
          return { context: { items } }
        },
        CHECKOUT: ({ context }) =>
          Boolean(Object.keys(context.items).length)
            ? { target: 'checkedOut' }
            : undefined,
      },
    },
    checkedOut: { type: 'final' },
  },
})

function createCart({ buggy = false } = {}) {
  const items: Record<string, number> = {}
  return {
    add: (sku: string) => {
      items[sku] = (items[sku] ?? 0) + 1
    },
    remove: (sku: string) => {
      if (buggy && sku in items) {
        items[sku] = 0
        return
      }
      delete items[sku]
    },
    items: () => ({ ...items }),
  }
}

const sku = fc.constantFrom('apple', 'pear')
const events = {
  ADD: fc.record({ sku }),
  REMOVE: fc.record({ sku }),
  CHECKOUT: fc.constant({}),
}

function createCartSut({ buggy = false } = {}): TestSut<
  SnapshotFrom<typeof cartMachine>,
  EventFrom<typeof cartMachine>
> {
  return {
    create: () => {
      const cart = createCart({ buggy })
      return {
        send: (event) => {
          if (event.type === 'ADD') {
            cart.add(event.sku)
          }
          if (event.type === 'REMOVE') {
            cart.remove(event.sku)
          }
        },
        read: () => cart.items(),
      }
    },
    projectModel: (snapshot) => snapshot.context.items,
  }
}

const cartSut = createCartSut()

const failuresDir = mkdtempSync(join(tmpdir(), 'xstate-test-docs-'))
afterAll(() => {
  rmSync(failuresDir, { recursive: true, force: true })
})

describe('README: How-to guides (oracles, failures, and Vitest)', () => {
  describe('Run model tests with Vitest', () => {
    modelIt.model('the cart matches the model', cartMachine, {
      seed: 1,
      events,
      sut: cartSut,
    })

    modelIt.paths('every path matches the model', cartMachine, {
      pathGenerator: 'simple',
      events,
      sut: cartSut,
      stopWhen: (snapshot) => Object.values(snapshot.context.items).some((qty) => qty >= 2),
    })

    const buggyOptions = {
      seed: 1,
      events,
      sut: createCartSut({ buggy: true }),
      failures: { dir: join(failuresDir, 'vitest') },
    }
    modelIt.model.fails('finds the remove bug', cartMachine, buggyOptions, {
      message: /Property observation diverged/,
    })

    const it = withModelTests(vitestIt)
    it.model('withModelTests wraps Vitest’s own it', cartMachine, {
      seed: 1,
      events,
      sut: cartSut,
      failures: false,
    })
  })
})
