import { extractYaml, test } from '@std/front-matter'
import { expandGlob } from '@std/fs/expand-glob'
import { basename, join } from '@std/path'
import { type LedgerEntry, readLedger } from './ledger.ts'

const BUMP: Record<string, true> = { none: true, patch: true, minor: true, major: true }

const intentPackages = (markdown: string): string[] => {
  if (!test(markdown)) return []
  return Object.entries(extractYaml<Record<string, unknown>>(markdown).attrs)
    .filter(([, bump]) => typeof bump === 'string' && BUMP[bump])
    .map(([name]) => name)
}

const ledgeredFor = (
  ledger: ReadonlyMap<string, LedgerEntry>,
  name: string,
  intent: string,
): boolean => {
  for (const [key, entry] of ledger) {
    if (key.startsWith(`${name}@`) && entry.intents.includes(intent)) return true
  }
  return false
}

export const countPendingIntents = async (changesetDir: string): Promise<number> => {
  const ledger = await readLedger(changesetDir)
  const entries = ledger.ok ? ledger.entries : new Map<string, LedgerEntry>()

  let pending = 0
  for await (const entry of expandGlob(join(changesetDir, '*.md'))) {
    const intent = basename(entry.path, '.md')
    if (intent === 'README') continue
    const packages = intentPackages(await Deno.readTextFile(entry.path))
    if (packages.some((name) => !ledgeredFor(entries, name, intent))) pending++
  }
  return pending
}
