#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [dir, out] = process.argv.slice(2)
if (!dir || !out) throw new Error('usage: pack.mjs <package-dir> <out-dir>')

const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const unscoped = manifest.name.replace(/^@[^/]+\//, '')
const staged = mkdtempSync(join(tmpdir(), 'from-source-pack-'))
try {
  execFileSync('pnpm', ['pack', '--pack-destination', staged], { cwd: dir, stdio: 'inherit' })
  const files = readdirSync(staged)
  if (files.length !== 1) throw new Error(`pnpm pack produced ${files.length} files for ${manifest.name}`)
  const target = join(out, `${unscoped}-${manifest.version}.tgz`)
  copyFileSync(join(staged, files[0]), target)
  process.stdout.write(`${manifest.name}@${manifest.version} -> ${target}\n`)
} finally {
  rmSync(staged, { force: true, recursive: true })
}
