/// <reference types="node" />
import { describe, it } from '@systemfsoftware/vitest'
import { createMachine, type SnapshotFrom, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFailureDatabase, ModelTestFailure, propertyTest, testPaths, type TestSut } from '../src/index.js'

const counterMachine = createMachine({
  id: 'counter',
  schemas: {
    context: types<{ count: number }>(),
    events: { INC: types<{}>(), RESET: types<{}>() },
  },
  context: { count: 0 },
  on: {
    INC: ({ context }) => ({ context: { count: context.count + 1 } }),
    RESET: () => ({ context: { count: 0 } }),
  },
})

type CounterSnapshot = SnapshotFrom<typeof counterMachine>
type CounterEvent = { type: 'INC' } | { type: 'RESET' }

function counterSut(
  buggy: () => boolean,
): TestSut<CounterSnapshot, CounterEvent> {
  return {
    create: () => {
      let count = 0
      return {
        send: (event) => {
          if (event.type === 'RESET') {
            count = 0
          } else if (!(buggy() && count >= 2)) {
            count++
          }
        },
        read: () => count,
      }
    },
    projectModel: (snapshot) => snapshot.context.count,
  }
}

const events = { INC: fc.constant({}), RESET: fc.constant({}) }

function catchFailure(run: () => Promise<unknown>): Promise<ModelTestFailure> {
  return run().then(
    () => {
      throw new Error('Expected the campaign to fail')
    },
    (error) => error as ModelTestFailure,
  )
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'xstate-test-failures-'))
}

describe('failures', () => {
  it('saves a failing fixture, replays it first, and forgets it once fixed', function*({ expect }) {
    const dir = makeTempDir()
    try {
      let buggy = true
      const runs: number[] = []
      const options = {
        seed: 1,
        numRuns: 50,
        maxCommands: 6,
        events,
        sut: counterSut(() => buggy),
        failures: { dir, key: 'counter' },
        collect: (_trace: unknown, { runIndex }: { runIndex: number }) => {
          runs.push(runIndex)
        },
      }

      const first = yield* Effect.promise(() => catchFailure(() => propertyTest(counterMachine, options)))
      const saved = readdirSync(join(dir, 'counter'))
      const savedFirst = saved[0]
      if (savedFirst === undefined) {
        throw new Error('expected a saved failure file')
      }
      const location = join(dir, 'counter', savedFirst)
      const file: unknown = JSON.parse(readFileSync(location, 'utf8'))

      yield* expect({
        firstIsFailure: first instanceof ModelTestFailure,
        savedCount: saved.length,
        messageContainsLocation: first.message.includes(`Saved: ${location}`),
        file,
      }).toMatchObject({
        firstIsFailure: true,
        savedCount: 1,
        messageContainsLocation: true,
        file: {
          formatVersion: 1,
          key: 'counter',
          summary: 'Property observation diverged',
          replay: { engine: 'fast-check', seed: 1 },
          fixture: { formatVersion: 2, machine: { id: 'counter' } },
        },
      })

      runs.length = 0
      const replayed = yield* Effect.promise(() => catchFailure(() => propertyTest(counterMachine, options)))
      yield* expect({
        summary: replayed.summary,
        runs: [...runs],
      }).toEqual({
        summary: `Property observation diverged (replayed from ${location})`,
        runs: [],
      })

      buggy = false
      yield* Effect.promise(() => propertyTest(counterMachine, options))
      yield* expect({
        exists: existsSync(location),
        runsPositive: runs.length > 0,
      }).toEqual({ exists: false, runsPositive: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips the campaign with replay: 'only'", function*({ expect }) {
    const dir = makeTempDir()
    try {
      const { coverage } = yield* Effect.promise(() =>
        propertyTest(counterMachine, {
          events,
          sut: counterSut(() => true),
          failures: { dir, key: 'counter', replay: 'only' },
        })
      )
      yield* expect({
        runs: coverage.runs,
        stoppedBecause: coverage.exploration.stoppedBecause,
      }).toEqual({ runs: 0, stoppedBecause: 'replay' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('saves without replaying with replay: false', function*({ expect }) {
    const dir = makeTempDir()
    try {
      const options = {
        seed: 1,
        numRuns: 50,
        maxCommands: 6,
        events,
        sut: counterSut(() => true),
        failures: { dir, key: 'counter', replay: false as const },
      }
      yield* Effect.promise(() => catchFailure(() => propertyTest(counterMachine, options)))
      const second = yield* Effect.promise(() => catchFailure(() => propertyTest(counterMachine, options)))
      yield* expect(second.summary).toBe('Property observation diverged')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults the key to the machine id and a hash of the options', function*({ expect }) {
    const dir = makeTempDir()
    try {
      const failure = yield* Effect.promise(() =>
        catchFailure(() =>
          propertyTest(counterMachine, {
            seed: 1,
            numRuns: 50,
            maxCommands: 6,
            events,
            sut: counterSut(() => true),
            failures: { dir },
          })
        )
      )
      const [key] = readdirSync(dir)
      if (key === undefined) {
        throw new Error('expected a failure database key')
      }
      yield* expect({
        keyMatches: /^counter-[0-9a-f]{8}$/.test(key),
        messageContains: failure.message.includes(`Saved: ${join(dir, key)}`),
      }).toEqual({ keyMatches: true, messageContains: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('works with testPaths()', function*({ expect }) {
    const dir = makeTempDir()
    try {
      const options = {
        events,
        sut: counterSut(() => true),
        stopWhen: (snapshot: CounterSnapshot) => snapshot.context.count >= 3,
        failures: createFailureDatabase({ dir, key: 'paths' }),
      }
      const first = yield* Effect.promise(() => catchFailure(() => testPaths(counterMachine, options)))
      yield* expect({
        summaryMatches: /^Path \d+ \(.*\) failed/.test(first.summary),
        messageContains: first.message.includes(`Saved: ${join(dir, 'paths')}`),
      }).toEqual({ summaryMatches: true, messageContains: true })

      const replayed = yield* Effect.promise(() => catchFailure(() => testPaths(counterMachine, options)))
      yield* expect(replayed.summary).toMatch(/\(replayed from .*paths/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
