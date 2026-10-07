#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: prepare-source.mjs <workspace-root>')

const HERE = import.meta.dirname

const BUILD_DEV_DEPENDENCIES = new Set([
  '@effect/platform-node',
  '@effect/platform-node-shared',
  '@systemfsoftware/arethetypeswrong',
  '@systemfsoftware/effect-cell-types',
  '@systemfsoftware/tsconfig',
  '@types/node',
  '@types/semver',
  '@types/validate-npm-package-name',
  'effect',
  'tsdown',
])

const PACKAGES = ['apps/arethetypeswrong-cli', 'packages/arethetypeswrong']
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const STRIPPED_FIELDS = ['devDependencies', 'optionalDependencies']
const LOCAL = /^(workspace:|file:|link:)/
const WORKSPACE = /^workspace:/
const STRY = '@systemfsoftware/'

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

for (const dir of PACKAGES) {
  const path = join(root, dir, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  for (const field of STRIPPED_FIELDS) {
    const deps = manifest[field]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      if (!BUILD_DEV_DEPENDENCIES.has(name)) delete deps[name]
    }
  }
  for (const field of DEP_FIELDS) {
    const deps = manifest[field]
    if (!deps) continue
    for (const [name, value] of Object.entries(deps)) {
      if (WORKSPACE.test(value) && fileLocal.has(name)) deps[name] = 'catalog:'
      if (!name.startsWith(STRY)) continue
      if (LOCAL.test(value)) continue
      if (value === 'catalog:' && fileLocal.has(name)) continue
      throw new Error(`${dir}: ${name}@${value} is not a workspace:, file: or link: resolution`)
    }
    if (Object.keys(deps).length === 0) delete manifest[field]
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}
