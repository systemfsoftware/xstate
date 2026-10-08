import { describe } from '@systemfsoftware/vitest'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('..', import.meta.url))

interface CampaignOutput {
  readonly stdout: string
  readonly stderr: string
  readonly deliveredJson: string
}

class CampaignExited
  extends Data.TaggedError('@systemfsoftware/xstate-test/test/statisticsStdout.test/CampaignExited')<{
    readonly code: number | null
    readonly stderr: string
  }>
{}

const campaignScript = (statisticsOption: string): string =>
  [
    `import { writeSync } from 'node:fs'`,
    `import { createMachine } from '@systemfsoftware/xstate'`,
    `import { propertyTest } from '@systemfsoftware/xstate-test'`,
    `import fc from 'fast-check'`,
    `const delivered = []`,
    `const counter = createMachine({`,
    `  context: { count: 0 },`,
    `  on: { INC: ({ context }) => ({ context: { count: context.count + 1 } }) },`,
    `})`,
    `await propertyTest(counter, {`,
    `  seed: 1,`,
    `  numRuns: 1,`,
    `  maxCommands: 1,`,
    `  events: { INC: fc.constant({}) },`,
    `  ${statisticsOption}`,
    `})`,
    `writeSync(3, JSON.stringify(delivered))`,
  ].join('\n')

const runCampaign = (statisticsOption: string): Effect.Effect<CampaignOutput, CampaignExited> =>
  Effect.callback<CampaignOutput, CampaignExited>((resume) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', campaignScript(statisticsOption)],
      { cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const channel: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdio[3]?.on('data', (chunk: Buffer) => channel.push(chunk))
    child.on('close', (code) => {
      if (code !== 0) {
        resume(Effect.fail(new CampaignExited({ code, stderr: Buffer.concat(stderr).toString('utf8') })))
        return
      }
      resume(Effect.succeed({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        deliveredJson: Buffer.concat(channel).toString('utf8'),
      }))
    })
  })

const oneRunReport = [
  'Test statistics (1 run)',
  '',
  'event cases (share of executed events):',
  '  100.0%  INC / default: 1 executed, 0 ignored',
].join('\n')

describe('statistics on a campaign process stdout', (it) => {
  it('prints the report when statistics is true', function*({ expect }) {
    yield* expect(yield* runCampaign('statistics: true,')).toEqual({
      stdout: `${oneRunReport}\n`,
      stderr: '',
      deliveredJson: '[]',
    })
  })

  it('prints nothing when statistics is left out', function*({ expect }) {
    yield* expect(yield* runCampaign('')).toEqual({ stdout: '', stderr: '', deliveredJson: '[]' })
  })

  it('prints nothing when statistics is false', function*({ expect }) {
    yield* expect(yield* runCampaign('statistics: false,')).toEqual({ stdout: '', stderr: '', deliveredJson: '[]' })
  })

  it('prints nothing and hands the report to a callback', function*({ expect }) {
    yield* expect(yield* runCampaign('statistics: (report) => { delivered.push(report) },')).toEqual({
      stdout: '',
      stderr: '',
      deliveredJson: JSON.stringify([oneRunReport]),
    })
  })
})
