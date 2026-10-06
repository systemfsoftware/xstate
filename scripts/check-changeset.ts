#!/usr/bin/env -S deno run --config=scripts/deno.json --allow-read --allow-run=git --allow-import --allow-net=jsr.io

import { withoutAll } from '@std/collections/without-all'
import { extractYaml, test } from '@std/front-matter'
import { expandGlob } from '@std/fs/expand-glob'
import { basename } from '@std/path'
import {
  loadReleaseSetOrThrow,
  type ReleasePackage,
  ReleaseSetError,
  renderReleaseSetRefusal,
} from './lib/release-set.ts'
import { run } from './lib/run.ts'

const BUMP: Record<string, true> = { none: true, patch: true, minor: true, major: true }

const intentPackages = (markdown: string) => {
  if (!test(markdown)) return []
  return Object.entries(extractYaml<Record<string, unknown>>(markdown).attrs)
    .filter(([, bump]) => typeof bump === 'string' && BUMP[bump])
    .map(([name]) => name)
}

export const packagesNeedingIntent = (
  changed: readonly string[],
  release: readonly ReleasePackage[],
): readonly string[] => {
  const touched = changed.some((file) => release.some(({ dir }) => file === dir || file.startsWith(`${dir}/`)))
  return touched ? release.map(({ name }) => name) : []
}

const namedIntents = async () => {
  const named: string[] = []
  for await (const file of expandGlob('.changeset/*.md')) {
    if (basename(file.path) === 'README.md') continue
    named.push(...intentPackages(await Deno.readTextFile(file.path)))
  }
  return named
}

export const checkChangeset = async (baseSha: string, root = '.'): Promise<number> => {
  let release: readonly ReleasePackage[]
  try {
    release = await loadReleaseSetOrThrow(root)
  } catch (error) {
    if (error instanceof ReleaseSetError) {
      for (const refusal of error.refusals) console.error(`check-changeset: ${renderReleaseSetRefusal(refusal)}`)
      return 1
    }
    throw error
  }

  const changed = (await run('git', ['diff', '--name-only', `${baseSha}...HEAD`])).split('\n').filter(Boolean)
  const touched = packagesNeedingIntent(changed, release)
  const missing = withoutAll(touched, await namedIntents())

  if (missing.length === 0) {
    console.log(
      touched.length === 0 ? 'no released-package paths in the diff' : `changeset covers: ${touched.join(', ')}`,
    )
    return 0
  }

  console.error(
    `::error::released package(s) changed with no changeset intent: ${
      missing.join(', ')
    }. Author one with \`pnpm change --bump <none|patch|minor|major> --summary "<changelog entry>" ${missing[0]}\`.`,
  )
  return 1
}

const main = async (): Promise<number> => {
  const baseSha = Deno.args[0]
  if (!baseSha) {
    console.error('usage: ./scripts/check-changeset.ts <base-sha>')
    return 2
  }
  return await checkChangeset(baseSha)
}

if (import.meta.main) Deno.exit(await main())
