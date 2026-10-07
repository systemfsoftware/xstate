#!/usr/bin/env -S deno run --allow-read=../unguarded-tests.json --allow-run=./node_modules/.bin/effect-tsgo --allow-env=TSGO_FORMAT

const HELD_RULE = 'asyncFunction'
const listFile = new URL('../packages/unguarded-tests.json', import.meta.url)
const repoRoot = new URL('..', import.meta.url).pathname

interface Diagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly severity: string
  readonly name: string
  readonly message: string
}

const fieldOf = (value: unknown, field: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined

const decodeDiagnostic = (value: unknown): Diagnostic => {
  const [file, line, column, severity, name, message] = ['file', 'line', 'column', 'severity', 'name', 'message']
    .map((field) => fieldOf(value, field))
  if (
    typeof file !== 'string' || typeof line !== 'number' || typeof column !== 'number' ||
    typeof severity !== 'string' || typeof name !== 'string' || typeof message !== 'string'
  ) throw new Error(`effect-tsgo emitted a diagnostic without file, line, column, severity, name and message`)
  return { file, line, column, severity, name, message }
}

const decodeList = (value: unknown): ReadonlySet<string> => {
  const files = fieldOf(value, 'files')
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
    throw new Error(`${listFile.pathname}: "files" is not an array of strings`)
  }
  return new Set(files)
}

const render = (format: string, diagnostic: Diagnostic, path: string): string =>
  format === 'github-actions'
    ? `::${
      diagnostic.severity === 'error' ? 'error' : 'warning'
    } file=${path},line=${diagnostic.line},col=${diagnostic.column}::effect(${diagnostic.name}): ${diagnostic.message}`
    : `${path}(${diagnostic.line},${diagnostic.column}): ${diagnostic.severity} effect(${diagnostic.name}): ${diagnostic.message}`

const main = async (): Promise<number> => {
  const held = decodeList(JSON.parse(await Deno.readTextFile(listFile)))
  const run = await new Deno.Command('./node_modules/.bin/effect-tsgo', {
    args: ['diagnostics', '--project', 'tsconfig.test.json', '--format', 'json'],
    stdout: 'piped',
  }).output()
  const diagnostics = fieldOf(JSON.parse(new TextDecoder().decode(run.stdout)), 'diagnostics')
  if (!Array.isArray(diagnostics)) throw new Error('effect-tsgo emitted no diagnostics array')
  const format = Deno.env.get('TSGO_FORMAT') ?? 'text'
  let errors = 0
  let heldCount = 0
  for (const diagnostic of diagnostics.map(decodeDiagnostic)) {
    const path = diagnostic.file.startsWith(repoRoot) ? diagnostic.file.slice(repoRoot.length) : diagnostic.file
    if (diagnostic.name === HELD_RULE && held.has(path)) {
      heldCount += 1
      continue
    }
    if (diagnostic.severity === 'error') errors += 1
    console.log(render(format, diagnostic, path))
  }
  console.log(
    `${errors} error(s); ${heldCount} ${HELD_RULE} finding(s) held in files listed by packages/unguarded-tests.json`,
  )
  return errors === 0 ? 0 : 1
}

if (import.meta.main) Deno.exit(await main())
