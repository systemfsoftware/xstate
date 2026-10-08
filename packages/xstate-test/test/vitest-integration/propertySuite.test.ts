import { createMachine } from '@systemfsoftware/xstate'
import { describe, expect, it } from 'vitest'
import { describeTestSuite, generateTestSuite } from '../../src/engine/index.js'
import { it as modelIt } from '../../src/vitest.js'
import { constant, randomAdapter } from '../engine/propertyTestAdapter.js'

const trafficMachine = createMachine({
  id: 'traffic',
  initial: 'red',
  states: {
    red: { on: { NEXT: { target: 'green' }, STOP: { target: 'red' } } },
    green: { on: { NEXT: { target: 'yellow' }, STOP: { target: 'red' } } },
    yellow: { on: { NEXT: { target: 'red' }, STOP: { target: 'red' } } },
  },
})

const invariant = (
  { snapshot, event }: { snapshot: { value: unknown }; event: { type?: string } | undefined },
) => {
  if (typeof snapshot.value !== 'string') {
    throw new Error(`expected a string state value, got ${String(snapshot.value)}`)
  }
  if (event?.type === 'STOP' && snapshot.value !== 'red') {
    throw new Error(`STOP must park the light on red, got ${snapshot.value}`)
  }
}

const generate = () =>
  generateTestSuite(trafficMachine, {
    adapter: randomAdapter({ seed: 7, numRuns: 20, maxCommands: 6 }),
    events: {
      NEXT: constant({}),
      STOP: constant({}),
    },
    invariant,
  })

// Vitest 5 refuses a suite declared inside a running test, so the suite is declared at collection time with the
// vitest globals: each generated fixture becomes its own case, which passes only when its replay passes.
const globalsSuite = await generate()

describe('describeTestSuite (vitest globals)', () => {
  it('generates fixtures to declare', () => {
    expect(globalsSuite.fixtures.length).toBeGreaterThan(0)
  })

  describeTestSuite(globalsSuite, trafficMachine, { invariant, describe, it: modelIt })
})
