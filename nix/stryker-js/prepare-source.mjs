#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('usage: prepare-source.mjs <workspace-root>')

const HERE = import.meta.dirname

const PACKAGES = [
  'packages/frameworks/interface',
  'packages/ignorers/effect-schema-declarations',
  'packages/ignorers/interface',
  'packages/ignorers/kit',
  'packages/stryker-js',
  'packages/stryker-js-cli-contract',
  'packages/stryker-js-html-reporter',
  'packages/stryker-js-instrumenter',
  'packages/stryker-js-plugin-interface',
  'packages/stryker-js-plugin-runtime',
  'packages/stryker-js-typescript-checker',
  'packages/stryker-js-vitest-runner',
  'packages/toolchain/oxlint-ignorer-config',
  'packages/toolchain/stryker-config',
  'packages/toolchain/tsdown-config',
  'packages/toolchain/vitest-config',
]

const DENIED_DEV = [
  '@systemfsoftware/arethetypeswrong-cli',
  '@systemfsoftware/stryker-ignorer-in-source-vitest-block',
]

const STRYKER_CATALOG = {
  '@systemfsoftware/stryker-ignorer-effect-schema-declarations': 'workspace:^',
  '@systemfsoftware/stryker-js': 'workspace:^',
  '@systemfsoftware/stryker-js-typescript-checker': 'workspace:^',
  '@systemfsoftware/stryker-js-vitest-runner': 'workspace:^',
  'mutation-testing-elements': 'catalog:',
  'mutation-testing-report-schema': 'catalog:',
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const LOCAL = /^(workspace:|file:|link:)/
const TYPECHECK_FREE = '@systemfsoftware/stryker-js'

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
  for (const field of DEP_FIELDS) {
    const deps = manifest[field]
    if (!deps) continue
    if (field === 'devDependencies') { for (const name of DENIED_DEV) delete deps[name] }
    for (const [name, spec] of Object.entries(deps)) {
      if (spec === 'catalog:stryker') {
        const resolved = STRYKER_CATALOG[name]
        if (!resolved) throw new Error(`${dir}: catalog:stryker has no overlay entry for ${name}`)
        deps[name] = resolved
      }
      if (!name.startsWith('@systemfsoftware/')) continue
      const value = deps[name]
      if (LOCAL.test(value)) continue
      if (value === 'catalog:' && fileLocal.has(name)) continue
      throw new Error(`${dir}: ${name}@${value} is not a workspace:, file: or link: resolution`)
    }
    if (Object.keys(deps).length === 0) delete manifest[field]
  }
  if (manifest.name === TYPECHECK_FREE) {
    manifest.scripts.build = manifest.scripts.build.replace('pnpm run typecheck && ', '')
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}
