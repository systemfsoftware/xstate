#!/usr/bin/env -S deno run --config=scripts/deno.json --allow-read --allow-write --allow-env --allow-run=./bin/dprint

import { parseArgs } from '@std/cli/parse-args'
import MagicString from 'magic-string'
import {
  asArray,
  asNode,
  type AstNode,
  calleeInfo,
  casesIn,
  type ExpectChain,
  expectChain,
  nodeChildren,
  parseSource,
} from './asserted-leaves.ts'

const FORK_EXPORTS = new Set([
  'it',
  'test',
  'describe',
  'describeWrapped',
  'layer',
  'flakyTest',
  'prop',
  'law',
  'makeMethods',
  'beforeEach',
  'afterEach',
  'addEqualityTesters',
  'vitestTestContextKey',
  'VitestTestContext',
  'afterAll',
  'assertType',
  'beforeAll',
  'expectTypeOf',
  'inject',
  'onTestFailed',
  'onTestFinished',
  'recordArtifact',
  'vi',
  'vitest',
])

const REFUSED_MATCHERS = new Set([
  'toBeDefined',
  'toBeTruthy',
  'toBeFalsy',
  'toHaveLength',
  'toBeInstanceOf',
  'toHaveProperty',
  'toBeNull',
  'toBeUndefined',
])

const CALL_MATCHERS = new Set([
  'toHaveBeenCalled',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
])

const SNAPSHOT_MATCHERS = new Set(['toMatchSnapshot', 'toMatchInlineSnapshot'])

const VI_TIMERS = new Set([
  'useFakeTimers',
  'useRealTimers',
  'advanceTimersByTime',
  'advanceTimersByTimeAsync',
  'runAllTimers',
  'runAllTimersAsync',
  'runOnlyPendingTimers',
  'setSystemTime',
])

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
])

export type SiteKind =
  | 'refused-matcher'
  | 'snapshot'
  | 'consecutive-checks'
  | 'nested-expect'
  | 'expression-expect'
  | 'expression-callback'
  | 'isolation'
  | 'vi-timer'
  | 'namespace-import'

export interface Site {
  readonly file: string
  readonly line: number
  readonly kind: SiteKind
  readonly detail: string
}

export interface RewriteResult {
  readonly code: string
  readonly sites: readonly Site[]
}

const startOf = (node: AstNode): number => numberAt(node, 'start')
const endOf = (node: AstNode): number => numberAt(node, 'end')

const numberAt = (node: AstNode, key: string): number => {
  const value = node[key]
  if (typeof value !== 'number') throw new Error(`guard-codemod: node ${node.type} has no numeric ${key}`)
  return value
}

const nameAt = (node: AstNode | undefined): string | undefined => {
  const value = node === undefined ? undefined : node.name
  return typeof value === 'string' ? value : undefined
}

const isFunction = (node: AstNode): boolean =>
  node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'

const isExpectRoot = (node: AstNode): boolean => {
  const info = calleeInfo(node.callee)
  return info.root === 'expect' && info.modifiers.length === 0
}

const isBooleanLiteral = (value: unknown): boolean => {
  const node = asNode(value)
  return node !== undefined && node.type === 'Literal' && typeof node.value === 'boolean'
}

const isComputedBoolean = (value: unknown): boolean => {
  const node = asNode(value)
  return (
    node !== undefined &&
    (node.type === 'BinaryExpression' ||
      node.type === 'LogicalExpression' ||
      node.type === 'UnaryExpression' ||
      node.type === 'CallExpression')
  )
}

const lineAt = (source: string, offset: number): number => {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index++) if (source[index] === '\n') line++
  return line
}

const refusedReason = (chain: ExpectChain): { readonly kind: SiteKind; readonly detail: string } | undefined => {
  if (chain.members.includes('resolves') || chain.members.includes('rejects')) {
    return { kind: 'refused-matcher', detail: `${chain.members.join('.')} promise` }
  }
  if (SNAPSHOT_MATCHERS.has(chain.matcher)) return { kind: 'snapshot', detail: chain.matcher }
  if (chain.matcher === 'toThrow') return { kind: 'refused-matcher', detail: 'bare toThrow' }
  if (REFUSED_MATCHERS.has(chain.matcher)) return { kind: 'refused-matcher', detail: chain.matcher }
  if (CALL_MATCHERS.has(chain.matcher)) return { kind: 'refused-matcher', detail: chain.matcher }
  if (chain.matcher === 'toBe' && isBooleanLiteral(chain.args[0]) && isComputedBoolean(chain.actual)) {
    return { kind: 'refused-matcher', detail: 'boolean actual' }
  }
  return undefined
}

interface Check {
  readonly node: AstNode
  readonly chain: ExpectChain | undefined
  readonly converted: boolean
}

const checkOf = (statement: AstNode): Check | undefined => {
  if (statement.type !== 'ExpressionStatement') return undefined
  const expression = asNode(statement.expression)
  if (expression === undefined) return undefined
  if (expression.type === 'AwaitExpression') {
    const argument = asNode(expression.argument)
    const chain = argument === undefined ? undefined : expectChain(argument)
    return chain === undefined ? undefined : { node: expression, chain, converted: false }
  }
  if (expression.type === 'CallExpression') {
    const chain = expectChain(expression)
    if (chain !== undefined) return { node: expression, chain, converted: false }
    if (isExpectRoot(expression)) return { node: expression, chain: undefined, converted: false }
    return undefined
  }
  if (expression.type === 'YieldExpression') {
    const argument = asNode(expression.argument)
    if (argument !== undefined && expectChain(argument) !== undefined) {
      return { node: expression, chain: undefined, converted: true }
    }
  }
  return undefined
}

const generatorHeader = (callback: AstNode, source: string): string => {
  const params = asArray(callback.params)
  let paramText = ''
  if (params.length > 0) {
    const first = asNode(params[0])
    const last = asNode(params[params.length - 1])
    if (first !== undefined && last !== undefined) paramText = source.slice(startOf(first), endOf(last))
  }
  const parts = paramText === '' ? '{ expect }' : `${paramText}, { expect }`
  const name = callback.type === 'FunctionExpression' ? nameAt(asNode(callback.id)) : undefined
  return name === undefined ? `function* (${parts})` : `function* ${name}(${parts})`
}

const renderEntry = (
  entry: { readonly localName: string; readonly importName: string; readonly isType: boolean },
): string => {
  const name = entry.importName === entry.localName ? entry.localName : `${entry.importName} as ${entry.localName}`
  return `${entry.isType ? 'type ' : ''}${name}`
}

const relativeRepoRoot = new URL('..', import.meta.url)

const formatWithDprint = async (root: string, files: readonly string[]): Promise<void> => {
  const output = await new Deno.Command('./bin/dprint', { args: ['fmt', ...files], cwd: root }).output()
  const stderr = new TextDecoder().decode(output.stderr)
  if (output.code !== 0 && !stderr.includes('No files found to format')) {
    throw new Error(`guard-codemod: dprint failed: ${stderr.trim()}`)
  }
}

export const rewrite = (source: string, filename: string): RewriteResult => {
  const parsed = parseSource(filename, source)
  const magic = new MagicString(source)
  const sites: Site[] = []
  let effectNeeded = false

  const report = (offset: number, kind: SiteKind, detail: string): void => {
    sites.push({ file: filename, line: lineAt(source, offset), kind, detail })
  }

  for (const statement of parsed.imports) {
    if (statement.source !== 'vitest') continue
    if (statement.namespace) {
      report(statement.start, 'namespace-import', "import from 'vitest' is not a named import list")
      continue
    }
    const kept = statement.entries.filter((entry) => entry.localName !== 'expect')
    const fork = kept.filter((entry) => FORK_EXPORTS.has(entry.localName))
    const rest = kept.filter((entry) => !FORK_EXPORTS.has(entry.localName))
    const lines: string[] = []
    if (fork.length > 0) lines.push(`import { ${fork.map(renderEntry).join(', ')} } from '@systemfsoftware/vitest'`)
    if (rest.length > 0) lines.push(`import { ${rest.map(renderEntry).join(', ')} } from 'vitest'`)
    magic.overwrite(statement.start, statement.end, lines.join('\n'))
  }

  const scanNested = (node: AstNode): void => {
    const walk = (value: unknown): void => {
      const child = asNode(value)
      if (child === undefined) {
        for (const item of asArray(value)) walk(item)
        return
      }
      if (child.type === 'CallExpression' && (expectChain(child) !== undefined || isExpectRoot(child))) {
        report(startOf(child), 'nested-expect', 'check inside a nested function')
        return
      }
      for (const grandchild of nodeChildren(child)) walk(grandchild)
    }
    walk(node)
  }

  const scanStatement = (value: unknown, inLoop: boolean): void => {
    const node = asNode(value)
    if (node === undefined) {
      for (const item of asArray(value)) scanStatement(item, inLoop)
      return
    }
    if (isFunction(node)) {
      scanNested(node)
      return
    }
    if (LOOP_TYPES.has(node.type)) {
      for (const child of nodeChildren(node)) scanStatement(child, true)
      return
    }
    if (node.type === 'AwaitExpression') {
      const argument = asNode(node.argument)
      if (argument !== undefined && expectChain(argument) === undefined && !isExpectRoot(argument)) {
        effectNeeded = true
        magic.overwrite(startOf(node), startOf(argument), 'yield* Effect.promise(() => ')
        magic.appendRight(endOf(node), ')')
      }
      return
    }
    if (node.type === 'CallExpression' && (expectChain(node) !== undefined || isExpectRoot(node))) {
      report(startOf(node), inLoop ? 'nested-expect' : 'expression-expect', 'check is not a top-level statement')
      return
    }
    for (const child of nodeChildren(node)) scanStatement(child, inLoop)
  }

  const scanAwaits = (value: unknown): void => {
    const node = asNode(value)
    if (node === undefined) {
      for (const item of asArray(value)) scanAwaits(item)
      return
    }
    if (isFunction(node)) {
      scanNested(node)
      return
    }
    if (node.type === 'AwaitExpression') {
      const argument = asNode(node.argument)
      if (argument !== undefined && expectChain(argument) === undefined && !isExpectRoot(argument)) {
        effectNeeded = true
        magic.overwrite(startOf(node), startOf(argument), 'yield* Effect.promise(() => ')
        magic.appendRight(endOf(node), ')')
        return
      }
      scanAwaits(node.argument)
      return
    }
    for (const child of nodeChildren(node)) scanAwaits(child)
  }

  const rewriteCheck = (check: Check): void => {
    if (check.node.type === 'AwaitExpression') {
      const argument = asNode(check.node.argument)
      if (argument === undefined) return
      magic.overwrite(startOf(check.node), startOf(argument), 'yield* ')
      scanAwaits(argument)
      return
    }
    magic.prependLeft(startOf(check.node), 'yield* ')
    scanAwaits(check.node)
  }

  const processStatements = (statements: readonly unknown[], inLoop: boolean): void => {
    let index = 0
    while (index < statements.length) {
      const statement = asNode(statements[index])
      if (statement === undefined) {
        index++
        continue
      }
      const check = checkOf(statement)
      if (check === undefined) {
        scanStatement(statement, inLoop)
        index++
        continue
      }
      let end = index
      while (end < statements.length) {
        const next = asNode(statements[end])
        if (next === undefined || checkOf(next) === undefined) break
        end++
      }
      const run = end - index
      for (let cursor = index; cursor < end; cursor++) {
        const current = checkOf(asNode(statements[cursor]) as AstNode)
        if (current === undefined || current.converted) continue
        if (inLoop) {
          report(startOf(current.node), 'nested-expect', 'check inside a loop')
          continue
        }
        if (current.chain === undefined) {
          report(startOf(current.node), 'expression-expect', 'bare expect')
          continue
        }
        const refused = refusedReason(current.chain)
        if (refused !== undefined) {
          report(startOf(current.node), refused.kind, refused.detail)
          continue
        }
        if (run >= 2) {
          report(startOf(current.node), 'consecutive-checks', 'merge these checks over one state')
          continue
        }
        rewriteCheck(current)
      }
      index = end
    }
  }

  for (const kase of casesIn(parsed)) {
    const callback = kase.callback
    if (callback === undefined || callback.generator === true) continue
    const body = asNode(callback.body)
    if (body === undefined || body.type !== 'BlockStatement') {
      report(startOf(callback), 'expression-callback', 'body is not a block; convert it by hand')
      continue
    }
    magic.overwrite(startOf(callback), startOf(body), `${generatorHeader(callback, source)} `)
    processStatements(asArray(body.body), false)
  }

  const scanFile = (value: unknown): void => {
    const node = asNode(value)
    if (node === undefined) {
      for (const item of asArray(value)) scanFile(item)
      return
    }
    if (node.type === 'CallExpression') {
      const info = calleeInfo(node.callee)
      if (info.root === 'beforeEach' || info.root === 'afterEach') {
        report(startOf(node), 'isolation', `${info.root} shares state; move setup into the body or a layer`)
      }
      if (info.root === 'vi' && info.modifiers.some((modifier) => VI_TIMERS.has(modifier))) {
        report(startOf(node), 'vi-timer', `vi.${info.modifiers.join('.')}`)
      }
    }
    for (const child of nodeChildren(node)) scanFile(child)
  }
  scanFile(parsed.program)

  const hasEffectImport = parsed.imports.some(
    (statement) => statement.source === 'effect' && statement.entries.some((entry) => entry.localName === 'Effect'),
  )
  if (effectNeeded && !hasEffectImport) {
    const insertAt = parsed.imports.length === 0 ? 0 : Math.max(...parsed.imports.map((statement) => statement.end))
    magic.appendRight(insertAt, "\nimport { Effect } from 'effect'")
  }

  sites.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
  return { code: magic.toString(), sites }
}

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const renderReport = (sites: readonly Site[]): string =>
  [
    '| File | Line | Kind | Detail |',
    '| --- | --- | --- | --- |',
    ...sites.map((site) => `| ${site.file} | ${site.line} | ${site.kind} | ${site.detail} |`),
  ].join('\n')

const main = async (): Promise<number> => {
  const args = parseArgs(Deno.args, { boolean: ['json'] })
  const files = args._.map(String)
  if (files.length === 0) {
    console.error('guard-codemod: needs test file paths')
    return 2
  }
  const root = relativeRepoRoot.pathname
  const sites: Site[] = []
  const changed: string[] = []
  for (const file of files) {
    const source = await Deno.readTextFile(file)
    const result = rewrite(source, file)
    if (result.code !== source) {
      await Deno.writeTextFile(file, result.code)
      changed.push(file)
    }
    sites.push(...result.sites)
  }
  if (changed.length > 0) await formatWithDprint(root, changed)
  if (args.json) console.log(JSON.stringify({ changed, sites }, null, 2))
  else if (sites.length === 0) console.log('guard-codemod: no manual work reported')
  else console.log(renderReport(sites))
  return 0
}

if (import.meta.main) Deno.exit(await main())
