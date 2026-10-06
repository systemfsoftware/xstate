import { join } from '@std/path'
import { parse as parseYaml } from '@std/yaml'
import { Schema } from 'effect'
import { decodeText, readTextAt } from './workspace.ts'

export type LedgerEntry = { readonly dir: string; readonly intents: readonly string[] }

const LedgerFile = Schema.Record(
  Schema.String,
  Schema.Struct({ dir: Schema.String, intents: Schema.Array(Schema.String) }),
)

export type LedgerRead =
  | { readonly ok: true; readonly entries: ReadonlyMap<string, LedgerEntry> }
  | { readonly ok: false; readonly file: string }

export const readLedger = async (changesetDir: string): Promise<LedgerRead> => {
  const file = join(changesetDir, 'ledger.yaml')
  const text = await readTextAt(file)
  if (text === undefined) return { ok: true, entries: new Map() }
  const decoded = decodeText(LedgerFile, text, parseYaml)
  if (!decoded.ok) return { ok: false, file }
  return { ok: true, entries: new Map(Object.entries(decoded.value)) }
}
