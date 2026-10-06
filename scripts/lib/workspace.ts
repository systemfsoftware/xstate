import { expandGlob } from '@std/fs/expand-glob'
import { join } from '@std/path'
import { parse as parseYaml } from '@std/yaml'
import { Exit, Schema } from 'effect'

export type Decoded<S extends Schema.ConstraintDecoder<unknown>> =
  | { readonly ok: true; readonly value: S['Type'] }
  | { readonly ok: false }

export const decodeAt = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): Decoded<S> => {
  const decoded = Schema.decodeUnknownExit(schema)(value)
  return Exit.isSuccess(decoded) ? { ok: true, value: decoded.value } : { ok: false }
}

export const readTextAt = async (file: string): Promise<string | undefined> => {
  try {
    return await Deno.readTextFile(file)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}

export const decodeText = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string,
  parse: (text: string) => unknown,
): Decoded<S> => {
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    return { ok: false }
  }
  return decodeAt(schema, parsed)
}

const Workspace = Schema.Struct({ packages: Schema.Array(Schema.String) })

export type WorkspaceRead =
  | { readonly ok: true; readonly manifests: readonly string[] }
  | { readonly ok: false; readonly file: string }

export const readWorkspace = async (root: string): Promise<WorkspaceRead> => {
  const file = join(root, 'pnpm-workspace.yaml')
  const text = await readTextAt(file)
  if (text === undefined) return { ok: false, file }
  const workspace = decodeText(Workspace, text, parseYaml)
  if (!workspace.ok) return { ok: false, file }
  const manifests: string[] = []
  for (const glob of workspace.value.packages) {
    for await (const entry of expandGlob(join(glob, 'package.json'), { root, exclude: ['**/node_modules/**'] })) {
      manifests.push(entry.path)
    }
  }
  manifests.sort()
  return { ok: true, manifests }
}
