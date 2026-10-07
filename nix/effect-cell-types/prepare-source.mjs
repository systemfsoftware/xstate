#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: prepare-source.mjs <workspace-root>')

const HERE = import.meta.dirname

const BUILD_DEV_DEPENDENCIES = new Set([
  '@systemfsoftware/tsconfig',
  '@types/node',
  'effect',
  'tsdown',
  'typescript',
])

const PACKAGE = 'packages/effect-cell-types'
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const STRIPPED_FIELDS = ['devDependencies', 'optionalDependencies']
const LOCAL = /^(workspace:|file:|link:)/
const WORKSPACE = /^workspace:/
const STRY = '@systemfsoftware/'
const API_GATE = /\s*&&\s*pnpm api:check$/

const fileCatalogNames = () => {
  const yaml = readFileSync(join(HERE, 'pnpm-workspace.yaml'), 'utf8')
  const names = new Set()
  for (const line of yaml.split('\n')) {
    const match = /^\s+"(@systemfsoftware\/[^"]+)":\s+file:/.exec(line)
    if (match) names.add(match[1])
  }
  return names
}

const fileLocal = fileCatalogNames()
const path = join(root, PACKAGE, 'package.json')
const manifest = JSON.parse(readFileSync(path, 'utf8'))

for (const field of STRIPPED_FIELDS) {
  const deps = manifest[field]
  if (!deps) continue
  for (const name of Object.keys(deps)) {
    if (!BUILD_DEV_DEPENDENCIES.has(name)) delete deps[name]
  }
}

manifest.devDependencies = { typescript: 'catalog:', ...manifest.devDependencies }

for (const field of DEP_FIELDS) {
  const deps = manifest[field]
  if (!deps) continue
  for (const [name, value] of Object.entries(deps)) {
    if (value === 'catalog:peers') deps[name] = 'catalog:'
    if (WORKSPACE.test(deps[name]) && fileLocal.has(name)) deps[name] = 'catalog:'
    if (!name.startsWith(STRY)) continue
    const resolved = deps[name]
    if (LOCAL.test(resolved)) continue
    if (resolved === 'catalog:' && fileLocal.has(name)) continue
    throw new Error(`${PACKAGE}: ${name}@${resolved} is not a workspace:, file: or link: resolution`)
  }
  if (Object.keys(deps).length === 0) delete manifest[field]
}

manifest.scripts.build = manifest.scripts.build.replace(API_GATE, '')
if (manifest.scripts.build.includes('api:check')) {
  throw new Error(`${PACKAGE}: build script still runs api:check`)
}

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
