import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'

import { type Outcome, run as spawn } from './spawn.ts'

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)))
const BIN = join(ROOT, 'bin/dprint')

const run = (args: readonly string[], env?: Record<string, string>): Promise<Outcome> =>
  spawn('sh', ['-c', 'exec "$0" "$@"', BIN, ...args], { cwd: ROOT, env })

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path)
    return true
  } catch {
    return false
  }
}

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

Deno.test('the dprint wrapper replaces a stale real plugin cache directory', async () => {
  const cacheHome = await Deno.makeTempDir({ dir: ROOT, prefix: '.dprint-cache-' })
  const probe = join(cacheHome, 'stale-probe.ts')
  try {
    await run(['--version'], { XDG_CACHE_HOME: cacheHome })

    const entries = []
    for await (const entry of Deno.readDir(join(cacheHome, 'xstate-dprint'))) entries.push(entry.name)
    assertEquals(entries.length, 1, `expected one cache directory, got ${entries.join(', ')}`)
    const pluginCache = join(cacheHome, 'xstate-dprint', entries[0])
    await Deno.remove(pluginCache, { recursive: true })

    const plugins = join(pluginCache, 'plugins')
    const stale = join(plugins, 'stale-plugin.wasm')
    await Deno.mkdir(plugins, { recursive: true })
    await Deno.writeTextFile(stale, 'not a plugin\n')
    await Deno.writeTextFile(probe, 'const stale={b:2}\n')

    const outcome = await run(['fmt', '--allow-no-files', '--', relative(ROOT, probe)], {
      XDG_CACHE_HOME: cacheHome,
    })
    assertEquals(outcome.code, 0, outcome.out)
    assertEquals(await Deno.readTextFile(probe), 'const stale = { b: 2 }\n')
    assert(!(await exists(stale)), `the stale plugin directory survived seeding:\n${outcome.out}`)
    const stat = await Deno.lstat(plugins)
    assert(stat.isDirectory && !stat.isSymlink, 'the seeded plugins entry is not a real directory')
  } finally {
    await Deno.remove(cacheHome, { recursive: true })
  }
})
