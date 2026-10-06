import { assertEquals } from '@std/assert'

import { decidePhase, renderOutputs } from './plan-release.ts'

Deno.test('owed versions pick the release phase', () => {
  assertEquals(decidePhase(2, 3), 'release')
})

Deno.test('pending intents with nothing owed pick the version phase', () => {
  assertEquals(decidePhase(0, 1), 'version')
})

Deno.test('nothing pending and nothing owed picks none', () => {
  assertEquals(decidePhase(0, 0), 'none')
})

Deno.test('the emitted output carries the phase literal the release workflow gates on', () => {
  assertEquals(renderOutputs('release', 4, 2), 'phase=release\npending_intents=4\nthis_cycle=2')
  assertEquals(renderOutputs('version', 2, 0), 'phase=version\npending_intents=2\nthis_cycle=0')
  assertEquals(renderOutputs('none', 0, 0), 'phase=none\npending_intents=0\nthis_cycle=0')
})
