import { assert, assertEquals } from '@std/assert'
import { fromFileUrl, join } from '@std/path'
import { parse as parseToml } from '@std/toml'
import { Schema as S } from 'effect'
import * as Result from 'effect/Result'

const repoRoot = fromFileUrl(new URL('..', import.meta.url))
const SUBTREE = 'repos/xstate-upstream'

const Sha = S.String.check(S.isPattern(/^[0-9a-f]{40}$/))

const PinnedSubtree = S.Struct({ name: S.Literal('xstate-upstream'), commit: Sha, tree: Sha })

const Registry = S.Struct({ repos: S.Array(S.Record(S.String, S.Unknown)) })

const git = async (...args: readonly string[]): Promise<string> => {
  const { code, stdout, stderr } = await new Deno.Command('git', { args: [...args], cwd: repoRoot }).output()
  const decoder = new TextDecoder()
  assertEquals(code, 0, `git ${args.join(' ')}: ${decoder.decode(stderr)}`)
  return decoder.decode(stdout).trim()
}

const decoded = <A>(result: Result.Result<A, S.SchemaError>, what: string): A => {
  assert(Result.isSuccess(result), `${what}: ${Result.isFailure(result) ? result.failure.message : ''}`)
  return result.success
}

const pinned = async (): Promise<typeof PinnedSubtree.Type> => {
  const text = await Deno.readTextFile(join(repoRoot, 'subtrees.toml'))
  const registry = decoded(S.decodeUnknownResult(Registry)(parseToml(text)), 'subtrees.toml')
  const entries = registry.repos.filter((entry) => entry.name === 'xstate-upstream')
  assertEquals(entries.length, 1, `subtrees.toml registers ${SUBTREE} exactly once`)
  return decoded(S.decodeUnknownResult(PinnedSubtree)(entries[0]), `the ${SUBTREE} entry of subtrees.toml`)
}

Deno.test(`${SUBTREE} is byte-identical to the tree subtrees.toml records for the upstream commit`, async () => {
  const { tree } = await pinned()
  assertEquals(await git('rev-parse', `HEAD:${SUBTREE}`), tree)
  assertEquals(await git('status', '--porcelain', '--untracked-files=all', '--', SUBTREE), '')
})

Deno.test(`the squash commit that vendors ${SUBTREE} pins the commit subtrees.toml records`, async () => {
  const { commit } = await pinned()
  assertEquals(
    await git('rev-parse', '--is-shallow-repository'),
    'false',
    `a shallow clone cannot reach the squash commit that vendors ${SUBTREE}`,
  )
  const split = await git(
    'log',
    '-1',
    '--format=%(trailers:key=git-subtree-split,valueonly)',
    '-E',
    `--grep=^git-subtree-dir: ${SUBTREE}/?$`,
    'HEAD',
  )
  assertEquals(split, commit)
})
