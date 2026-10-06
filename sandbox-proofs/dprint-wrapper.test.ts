import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'

import { type Outcome, run as spawn } from './spawn.ts'

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)))
const BIN = join(ROOT, 'bin/dprint')

const run = (args: readonly string[]): Promise<Outcome> =>
  spawn('sh', ['-c', 'exec "$0" "$@"', BIN, ...args], { cwd: ROOT })

Deno.test("the dprint wrapper hands dprint the caller's arguments unchanged", async (t) => {
  await t.step('--version exits zero and prints the pinned version', async () => {
    const outcome = await run(['--version'])
    assertEquals(outcome.code, 0, outcome.out)
    assert(outcome.out.includes('dprint 0.54.0'), `unexpected version output:\n${outcome.out}`)
  })

  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: '.dprint-wrapper-' })
  const file = join(dir, 'probe.ts')
  const rel = relative(ROOT, file)
  try {
    await Deno.writeTextFile(file, 'const probe={a:1}\n')

    await t.step('check fails and names the unformatted file', async () => {
      const outcome = await run(['check', rel])
      assert(outcome.code !== 0, `check exited zero:\n${outcome.out}`)
      assert(outcome.out.includes(file), `check did not name ${file}:\n${outcome.out}`)
    })

    await t.step("lint-staged's fmt order formats the file", async () => {
      const outcome = await run(['fmt', '--allow-no-files', '--', rel])
      assertEquals(outcome.code, 0, outcome.out)
      assertEquals(await Deno.readTextFile(file), 'const probe = { a: 1 }\n')
    })
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
