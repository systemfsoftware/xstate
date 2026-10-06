#!/usr/bin/env -S deno run --config=scripts/deno.json --allow-read --allow-write --allow-run=git,pnpm --allow-import --allow-net=jsr.io

import { parseArgs } from '@std/cli/parse-args'
import { loadWorkspaceCycle } from './lib/cycle.ts'
import { countPendingIntents } from './lib/pending-intents.ts'
import { ReleaseSetError, renderReleaseSetRefusal } from './lib/release-set.ts'

export type Phase = 'release' | 'version' | 'none'

export const decidePhase = (owed: number, pending: number): Phase =>
  owed > 0 ? 'release' : pending > 0 ? 'version' : 'none'

export const renderOutputs = (phase: Phase, pending: number, owed: number): string =>
  [`phase=${phase}`, `pending_intents=${pending}`, `this_cycle=${owed}`].join('\n')

if (import.meta.main) {
  const pending = await countPendingIntents('.changeset')

  let owed: number
  try {
    owed = (await loadWorkspaceCycle()).length
  } catch (error) {
    if (error instanceof ReleaseSetError) {
      for (const refusal of error.refusals) console.error(`plan-release: ${renderReleaseSetRefusal(refusal)}`)
      Deno.exit(1)
    }
    throw error
  }
  const phase = decidePhase(owed, pending)
  const outputs = renderOutputs(phase, pending, owed)

  console.error(`plan-release: pending_intents=${pending} this_cycle=${owed} -> phase=${phase}`)

  const { output } = parseArgs(Deno.args, { string: ['output'] })
  if (output) await Deno.writeTextFile(output, `${outputs}\n`, { append: true })
  else console.log(outputs)
}
