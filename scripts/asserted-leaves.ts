#!/usr/bin/env -S deno run --config=scripts/deno.json --allow-read --allow-write --allow-env --allow-run=git

import { parseArgs } from '@std/cli/parse-args'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'
import { parseSync } from 'oxc-parser'

export type AstNode = { readonly type: string } & Record<string, unknown>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isAstNode = (value: unknown): value is AstNode => isObject(value) && typeof value.type === 'string'

export const asNode = (value: unknown): AstNode | undefined => (isAstNode(value) ? value : undefined)

export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

const str = (object: Record<string, unknown>, key: string): string | undefined => {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

const num = (object: Record<string, unknown>, key: string): number | undefined => {
  const value = object[key]
  return typeof value === 'number' ? value : undefined
}

const stringField = (node: AstNode, key: string): string | undefined => str(node, key)

const numberField = (node: AstNode, key: string): number | undefined => num(node, key)

export const nodeChildren = (node: AstNode): readonly unknown[] => {
  const children: unknown[] = []
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value)
    else if (isAstNode(value)) children.push(value)
  }
  return children
}

export interface SourceComment {
  readonly start: number
  readonly end: number
  readonly value: string
}

const isComment = (value: unknown): value is SourceComment => {
  const node = asNode(value)
  return (
    node !== undefined &&
    (node.type === 'Line' || node.type === 'Block') &&
    typeof node.start === 'number' &&
    typeof node.end === 'number' &&
    typeof node.value === 'string'
  )
}

export interface ImportEntry {
  readonly localName: string
  readonly importName: string
  readonly isType: boolean
}

export interface ImportStatement {
  readonly start: number
  readonly end: number
  readonly source: string
  readonly entries: readonly ImportEntry[]
  readonly namespace: boolean
}

export interface ParsedSource {
  readonly program: AstNode
  readonly comments: readonly SourceComment[]
  readonly imports: readonly ImportStatement[]
}

const languageOf = (filename: string): 'js' | 'jsx' | 'ts' | 'tsx' => {
  if (filename.endsWith('.tsx')) return 'tsx'
  if (filename.endsWith('.jsx')) return 'jsx'
  if (filename.endsWith('.ts') || filename.endsWith('.mts') || filename.endsWith('.cts')) return 'ts'
  return 'js'
}

const importStatements = (module: unknown): readonly ImportStatement[] => {
  if (!isObject(module)) return []
  const container = module
  const imports: ImportStatement[] = []
  for (const raw of asArray(container.staticImports)) {
    if (!isObject(raw)) continue
    const start = num(raw, 'start')
    const end = num(raw, 'end')
    const request = isObject(raw.moduleRequest) ? raw.moduleRequest : undefined
    const source = request === undefined ? undefined : str(request, 'value')
    if (start === undefined || end === undefined || source === undefined) continue
    const entries: ImportEntry[] = []
    let namespace = false
    for (const rawEntry of asArray(raw.entries)) {
      if (!isObject(rawEntry)) continue
      const importName = isObject(rawEntry.importName) ? rawEntry.importName : undefined
      const localName = isObject(rawEntry.localName) ? rawEntry.localName : undefined
      const local = localName === undefined ? undefined : str(localName, 'value') ?? str(localName, 'name')
      if (local === undefined) continue
      if (importName === undefined || str(importName, 'kind') !== 'Name') namespace = true
      const name = importName === undefined ? undefined : str(importName, 'name')
      entries.push({ localName: local, importName: name ?? local, isType: rawEntry.isType === true })
    }
    imports.push({ start, end, source, entries, namespace })
  }
  return imports
}

export const parseSource = (filename: string, source: string): ParsedSource => {
  const result = parseSync(filename, source, { lang: languageOf(filename), range: true })
  const program = result.program as unknown as AstNode
  const comments: SourceComment[] = []
  for (const comment of result.comments) if (isComment(comment)) comments.push(comment)
  return { program, comments, imports: importStatements(result.module) }
}

export interface CalleeInfo {
  readonly root: string | undefined
  readonly modifiers: readonly string[]
}

export const calleeInfo = (callee: unknown): CalleeInfo => {
  const modifiers: string[] = []
  let current = asNode(callee)
  while (current !== undefined) {
    if (current.type === 'Identifier') {
      return { root: stringField(current, 'name'), modifiers: modifiers.slice().reverse() }
    }
    if (current.type === 'MemberExpression' && current.computed !== true) {
      const property = asNode(current.property)
      if (property?.type === 'Identifier') modifiers.push(stringField(property, 'name') ?? '')
      current = asNode(current.object)
      continue
    }
    if (current.type === 'CallExpression') {
      current = asNode(current.callee)
      continue
    }
    break
  }
  return { root: undefined, modifiers: modifiers.slice().reverse() }
}

const isFunction = (node: AstNode): boolean =>
  node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'

export const functionArgument = (args: readonly unknown[]): AstNode | undefined => {
  for (const arg of args) {
    const node = asNode(arg)
    if (node !== undefined && isFunction(node)) return node
  }
  return undefined
}

const templateText = (node: AstNode): string => {
  let text = ''
  for (const quasi of asArray(node.quasis)) {
    const q = asNode(quasi)
    const value = q === undefined ? undefined : asNode(q.value)
    text += value === undefined ? '' : stringField(value, 'raw') ?? ''
  }
  return text
}

const stringArgument = (args: readonly unknown[]): string | undefined => {
  for (const arg of args) {
    const node = asNode(arg)
    if (node === undefined) continue
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value
    if (node.type === 'TemplateLiteral') return templateText(node)
  }
  return undefined
}

export interface CaseLeaves {
  readonly key: string
  readonly leaves: number
  readonly typeLeaves: number
}

interface CaseCall {
  readonly key: string
  readonly callback: AstNode | undefined
}

const registerTest = (args: readonly unknown[], modifiers: readonly string[]): boolean =>
  functionArgument(args) !== undefined || modifiers.includes('todo')

export const casesIn = (parsed: ParsedSource): readonly CaseCall[] => {
  const out: CaseCall[] = []
  const scan = (value: unknown, stack: readonly string[]): void => {
    const node = asNode(value)
    if (node === undefined) {
      for (const item of asArray(value)) scan(item, stack)
      return
    }
    if (node.type === 'CallExpression') {
      const args = asArray(node.arguments)
      const info = calleeInfo(node.callee)
      if (info.root === 'describe') {
        const name = stringArgument(args)
        const callback = functionArgument(args)
        if (callback !== undefined) scan(callback.body, name === undefined ? stack : [...stack, name])
        return
      }
      if ((info.root === 'it' || info.root === 'test') && registerTest(args, info.modifiers)) {
        out.push({ key: [...stack, stringArgument(args) ?? ''].join(' '), callback: functionArgument(args) })
        return
      }
    }
    for (const child of nodeChildren(node)) scan(child, stack)
  }
  scan(parsed.program, [])
  return out
}

const SLOT_MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toMatchObject'])

export interface ExpectChain {
  readonly matcher: string
  readonly members: readonly string[]
  readonly actual: unknown
  readonly args: readonly unknown[]
}

export const expectChain = (call: AstNode): ExpectChain | undefined => {
  const callee = asNode(call.callee)
  if (callee?.type !== 'MemberExpression' || callee.computed === true) return undefined
  const property = asNode(callee.property)
  if (property?.type !== 'Identifier') return undefined
  const matcher = stringField(property, 'name')
  if (matcher === undefined) return undefined
  const members: string[] = []
  let subject = callee.object
  while (true) {
    const node = asNode(subject)
    if (node === undefined) return undefined
    if (node.type === 'MemberExpression' && node.computed !== true) {
      const member = asNode(node.property)
      if (member?.type === 'Identifier') members.push(stringField(member, 'name') ?? '')
      subject = node.object
      continue
    }
    if (node.type === 'CallExpression') {
      const inner = asNode(node.callee)
      if (inner?.type === 'Identifier' && stringField(inner, 'name') === 'expect') {
        return {
          matcher,
          members: members.slice().reverse(),
          actual: asArray(node.arguments)[0],
          args: asArray(call.arguments),
        }
      }
      return undefined
    }
    return undefined
  }
}

const literalLeaves = (value: unknown): number => {
  const node = asNode(value)
  if (node === undefined) return 1
  if (node.type === 'ObjectExpression') {
    let total = 0
    for (const property of asArray(node.properties)) {
      const p = asNode(property)
      if (p !== undefined && p.type !== 'SpreadElement') total += literalLeaves(p.value)
    }
    return total === 0 ? 1 : total
  }
  if (node.type === 'ArrayExpression') {
    let total = 0
    for (const element of asArray(node.elements)) {
      const e = asNode(element)
      if (e !== undefined && e.type !== 'SpreadElement') total += literalLeaves(e)
    }
    return total === 0 ? 1 : total
  }
  return 1
}

const isExpectRoot = (call: AstNode): boolean => {
  const info = calleeInfo(call.callee)
  return info.root === 'expect' && info.modifiers.length === 0
}

export const countLeaves = (
  callback: AstNode | undefined,
  comments: readonly SourceComment[],
): { readonly leaves: number; readonly typeLeaves: number } => {
  if (callback === undefined) return { leaves: 0, typeLeaves: 0 }
  let leaves = 0
  let typeLeaves = 0
  const walk = (value: unknown): void => {
    const node = asNode(value)
    if (node === undefined) {
      for (const item of asArray(value)) walk(item)
      return
    }
    if (node.type === 'CallExpression') {
      const info = calleeInfo(node.callee)
      if (info.root === 'expectTypeOf') {
        typeLeaves++
        return
      }
      const chain = expectChain(node)
      if (chain !== undefined) {
        leaves += SLOT_MATCHERS.has(chain.matcher)
          ? Math.max(1, literalLeaves(chain.actual), literalLeaves(chain.args[0]))
          : 1
        return
      }
      if (isExpectRoot(node)) {
        leaves++
        return
      }
    }
    for (const child of nodeChildren(node)) walk(child)
  }
  walk(callback)
  const start = numberField(callback, 'start')
  const end = numberField(callback, 'end')
  if (start !== undefined && end !== undefined) {
    for (const comment of comments) {
      if (comment.start >= start && comment.end <= end && comment.value.trimStart().startsWith('@ts-expect-error')) {
        typeLeaves++
      }
    }
  }
  return { leaves, typeLeaves }
}

export const caseLeavesIn = (parsed: ParsedSource): readonly CaseLeaves[] =>
  casesIn(parsed).map((kase) => {
    const counts = countLeaves(kase.callback, parsed.comments)
    return { key: kase.key, leaves: counts.leaves, typeLeaves: counts.typeLeaves }
  })

const AssertionResultSchema = S.Struct({ fullName: S.String, status: S.String })
const TestFileResultSchema = S.Struct({ name: S.String, assertionResults: S.Array(AssertionResultSchema) })
const VitestReportSchema = S.Struct({ testResults: S.Array(TestFileResultSchema) })

export type VitestReport = typeof VitestReportSchema.Type

export const decodeReport = (text: string): Result.Result<VitestReport, string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return Result.fail(`not JSON: ${String(error)}`)
  }
  const decoded = S.decodeUnknownResult(VitestReportSchema)(parsed)
  return Result.isFailure(decoded) ? Result.fail(decoded.failure.message) : Result.succeed(decoded.success)
}

const posix = (path: string): string => path.replaceAll('\\', '/')

export const packageRelative = (name: string, repoRoot: string, packageDir: string): string | undefined => {
  const path = posix(name)
  const root = posix(repoRoot).replace(/\/+$/u, '')
  const pkg = posix(packageDir).replace(/^\.\//u, '').replace(/\/+$/u, '')
  let relative: string | undefined
  if (path === root || path.startsWith(`${root}/`)) {
    relative = path.slice(root.length + 1)
  } else {
    const marker = `/${pkg}/`
    const index = path.indexOf(marker)
    if (index === -1) return undefined
    relative = path.slice(index + 1)
  }
  return relative.startsWith(`${pkg}/`) ? relative : undefined
}

type CaseMap = ReadonlyMap<string, string>

const statusCount = (cases: CaseMap, statuses: readonly string[]): number =>
  [...cases.values()].filter((status) => statuses.includes(status)).length

const fileCases = (report: VitestReport, repoRoot: string, packageDir: string): ReadonlyMap<string, CaseMap> => {
  const files = new Map<string, Map<string, string>>()
  for (const file of report.testResults) {
    const relative = packageRelative(file.name, repoRoot, packageDir)
    if (relative === undefined) continue
    const cases = files.get(relative) ?? new Map<string, string>()
    for (const assertion of file.assertionResults) cases.set(assertion.fullName, assertion.status)
    files.set(relative, cases)
  }
  return files
}

export interface ParityRow {
  readonly file: string
  readonly casesBefore: number
  readonly casesAfter: number
  readonly passedBefore: number
  readonly passedAfter: number
  readonly skippedBefore: number
  readonly skippedAfter: number
  readonly todoBefore: number
  readonly todoAfter: number
  readonly identical: boolean
}

export interface ParityOutcome {
  readonly ok: boolean
  readonly rows: readonly ParityRow[]
  readonly failures: readonly string[]
}

const SKIPPED = ['skipped', 'pending']

export const parity = (
  before: VitestReport,
  after: VitestReport,
  repoRoot: string,
  packageDir: string,
): ParityOutcome => {
  const beforeFiles = fileCases(before, repoRoot, packageDir)
  const afterFiles = fileCases(after, repoRoot, packageDir)
  const names = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()
  const rows: ParityRow[] = []
  const failures: string[] = []
  for (const file of names) {
    const beforeCases = beforeFiles.get(file) ?? new Map<string, string>()
    const afterCases = afterFiles.get(file) ?? new Map<string, string>()
    for (const key of beforeCases.keys()) {
      if (!afterCases.has(key)) failures.push(`${file}: case missing after: ${key}`)
    }
    for (const key of afterCases.keys()) {
      if (!beforeCases.has(key)) failures.push(`${file}: case added after: ${key}`)
    }
    for (const [key, status] of beforeCases) {
      const afterStatus = afterCases.get(key)
      if (afterStatus !== undefined && afterStatus !== status) {
        failures.push(`${file}: status changed: ${key}: ${status} -> ${afterStatus}`)
      }
    }
    rows.push({
      file,
      casesBefore: beforeCases.size,
      casesAfter: afterCases.size,
      passedBefore: statusCount(beforeCases, ['passed']),
      passedAfter: statusCount(afterCases, ['passed']),
      skippedBefore: statusCount(beforeCases, SKIPPED),
      skippedAfter: statusCount(afterCases, SKIPPED),
      todoBefore: statusCount(beforeCases, ['todo']),
      todoAfter: statusCount(afterCases, ['todo']),
      identical: failures.length === 0,
    })
  }
  const ok = failures.length === 0
  return { ok, rows: rows.map((row) => ({ ...row, identical: ok })), failures }
}

export interface LeavesRow {
  readonly file: string
  readonly key: string
  readonly leavesBefore: number
  readonly leavesAfter: number
  readonly typeBefore: number
  readonly typeAfter: number
}

export interface LeavesOutcome {
  readonly ok: boolean
  readonly rows: readonly LeavesRow[]
  readonly failures: readonly string[]
}

export const leavesComparison = (
  file: string,
  before: readonly CaseLeaves[],
  after: readonly CaseLeaves[],
): LeavesOutcome => {
  const afterByKey = new Map(after.map((kase) => [kase.key, kase]))
  const rows: LeavesRow[] = []
  const failures: string[] = []
  for (const baseCase of before) {
    const headCase = afterByKey.get(baseCase.key)
    if (headCase === undefined) {
      failures.push(`${file}: case missing from the head: ${baseCase.key}`)
      continue
    }
    if (headCase.leaves < baseCase.leaves) {
      failures.push(`${file}: ${baseCase.key}: leaves fell from ${baseCase.leaves} to ${headCase.leaves}`)
    }
    if (headCase.typeLeaves < baseCase.typeLeaves) {
      failures.push(`${file}: ${baseCase.key}: type leaves fell from ${baseCase.typeLeaves} to ${headCase.typeLeaves}`)
    }
    rows.push({
      file,
      key: baseCase.key,
      leavesBefore: baseCase.leaves,
      leavesAfter: headCase.leaves,
      typeBefore: baseCase.typeLeaves,
      typeAfter: headCase.typeLeaves,
    })
  }
  return { ok: failures.length === 0, rows, failures }
}

const markdownTable = (headers: readonly string[], rows: readonly (readonly string[])[]): string =>
  [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')

const renderParity = (outcome: ParityOutcome): string =>
  markdownTable(
    [
      'File',
      'Cases before',
      'Cases after',
      'Passed before',
      'Passed after',
      'Skipped before',
      'Skipped after',
      'Todo before',
      'Todo after',
      'Identical',
    ],
    outcome.rows.map((row) => [
      row.file,
      String(row.casesBefore),
      String(row.casesAfter),
      String(row.passedBefore),
      String(row.passedAfter),
      String(row.skippedBefore),
      String(row.skippedAfter),
      String(row.todoBefore),
      String(row.todoAfter),
      row.identical ? 'yes' : 'no',
    ]),
  )

const renderLeaves = (rows: readonly LeavesRow[]): string =>
  markdownTable(
    ['File', 'Case', 'Leaves before', 'Leaves after', 'Type before', 'Type after'],
    rows.map((row) => [
      row.file,
      row.key,
      String(row.leavesBefore),
      String(row.leavesAfter),
      String(row.typeBefore),
      String(row.typeAfter),
    ]),
  )

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const runGit = async (args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const output = await new Deno.Command('git', { args: [...args], stdout: 'piped', stderr: 'piped' }).output()
  return { code: output.code, stdout: decodeUtf8(output.stdout), stderr: decodeUtf8(output.stderr) }
}

const repoRoot = async (): Promise<string> => {
  const { code, stdout } = await runGit(['rev-parse', '--show-toplevel'])
  if (code !== 0) throw new Error('asserted-leaves: not inside a git repository')
  return stdout.trim()
}

const readSourceAt = async (ref: string, path: string): Promise<string> => {
  const { code, stdout, stderr } = await runGit(['show', `${ref}:${path}`])
  if (code !== 0) throw new Error(`asserted-leaves: git show ${ref}:${path} failed: ${stderr.trim()}`)
  return stdout
}

const loadReport = async (path: string): Promise<VitestReport> => {
  const decoded = decodeReport(await Deno.readTextFile(path))
  if (Result.isFailure(decoded)) throw new Error(`asserted-leaves: ${path}: ${decoded.failure}`)
  return decoded.success
}

const emit = (text: string): void => console.log(text)

const main = async (): Promise<number> => {
  const args = parseArgs(Deno.args, {
    string: ['before', 'after', 'package', 'base'],
    boolean: ['json'],
  })

  if (args.base !== undefined) {
    const files = args._.map(String)
    if (files.length === 0) {
      console.error('asserted-leaves: mode (b) needs test file paths')
      return 2
    }
    const root = await repoRoot()
    const rows: LeavesRow[] = []
    const failures: string[] = []
    for (const file of files) {
      const path = file.startsWith(root) ? posix(file).slice(root.length + 1) : posix(file)
      const beforeSource = await readSourceAt(args.base, path)
      const afterSource = await Deno.readTextFile(file)
      const outcome = leavesComparison(
        path,
        caseLeavesIn(parseSource(path, beforeSource)),
        caseLeavesIn(parseSource(path, afterSource)),
      )
      rows.push(...outcome.rows)
      failures.push(...outcome.failures)
    }
    if (args.json) emit(JSON.stringify({ ok: failures.length === 0, rows, failures }, null, 2))
    else emit(renderLeaves(rows))
    if (failures.length > 0) {
      for (const failure of failures) console.error(`asserted-leaves: ${failure}`)
      return 1
    }
    return 0
  }

  if (args.before === undefined || args.after === undefined || args.package === undefined) {
    console.error('asserted-leaves: mode (a) needs --before <json> --after <json> --package <dir>')
    return 2
  }
  const root = await repoRoot()
  const packageDir = posix(args.package).replace(/^\.\//u, '').replace(/\/+$/u, '')
  const outcome = parity(await loadReport(args.before), await loadReport(args.after), root, packageDir)
  if (args.json) emit(JSON.stringify(outcome, null, 2))
  else emit(renderParity(outcome))
  if (!outcome.ok) {
    for (const failure of outcome.failures) console.error(`asserted-leaves: ${failure}`)
    return 1
  }
  return 0
}

if (import.meta.main) Deno.exit(await main())
