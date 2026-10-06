import { assertEquals } from '@std/assert'
import { join } from '@std/path'

import { countPendingIntents } from './pending-intents.ts'

const changesetOf = async (files: Record<string, string>): Promise<string> => {
  const dir = await Deno.makeTempDir({ prefix: 'pending-intents-' })
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), content)
  }
  return dir
}

const intent = (entries: Record<string, string>): string =>
  ['---', ...Object.entries(entries).map(([name, bump]) => `${JSON.stringify(name)}: ${bump}`), '---', '', 'body', '']
    .join('\n')

Deno.test('a fully ledgered intent is not pending', async () => {
  const dir = await changesetOf({
    'a.md': intent({ '@x/a': 'minor' }),
    'ledger.yaml': '"@x/a@1.0.0":\n  dir: packages/a\n  intents: ["a"]\n',
  })
  assertEquals(await countPendingIntents(dir), 0)
})

Deno.test('an intent naming a package absent from the ledger is pending', async () => {
  const dir = await changesetOf({ 'a.md': intent({ '@x/a': 'minor' }) })
  assertEquals(await countPendingIntents(dir), 1)
})

Deno.test('an intent naming two packages, ledgered for only one, is still pending', async () => {
  const dir = await changesetOf({
    'b.md': intent({ '@x/a': 'patch', '@x/b': 'minor' }),
    'ledger.yaml': '"@x/a@1.0.0":\n  dir: packages/a\n  intents: ["b"]\n',
  })
  assertEquals(await countPendingIntents(dir), 1)
})

Deno.test('a README markdown file is never pending', async () => {
  const dir = await changesetOf({ 'README.md': intent({ '@x/a': 'minor' }) })
  assertEquals(await countPendingIntents(dir), 0)
})
