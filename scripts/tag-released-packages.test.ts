import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)))
const SCRIPT = join(REPO_ROOT, 'scripts', 'tag-released-packages.ts')
const CONFIG = join(REPO_ROOT, 'scripts', 'deno.json')

const decoder = new TextDecoder()

const git = async (cwd: string, args: string[]): Promise<string> => {
  const out = await new Deno.Command('git', { args, cwd }).output()
  if (!out.success) throw new Error(`git ${args.join(' ')} failed: ${decoder.decode(out.stderr)}`)
  return decoder.decode(out.stdout)
}

type Fixture = { root: string; captured: string }

const fixture = async (): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: 'tag-release-root-' })
  const origin = await Deno.makeTempDir({ prefix: 'tag-release-origin-' })
  await git(origin, ['init', '--quiet', '--bare'])
  await git(root, ['init', '--quiet', '--initial-branch=main'])
  await Deno.writeTextFile(join(root, 'tracked.txt'), 'the repo whose release the tag names\n')
  await git(root, ['add', '-A'])
  await git(root, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'init'])
  await git(root, ['remote', 'add', 'origin', origin])
  await git(root, ['push', '--quiet', 'origin', 'main'])

  const captured = join(root, 'captured.json')
  await Deno.writeTextFile(
    captured,
    JSON.stringify([{ name: '@x/a', version: '1.0.0', tag: '@x/a@v1.0.0', changelog: '.changeset/a.md' }]),
  )
  return { root, captured }
}

const drive = async (root: string, captured: string, mode: readonly string[]): Promise<string> => {
  const out = await new Deno.Command('bash', {
    args: [
      '-c',
      'exec "$@"',
      'bash',
      'deno',
      'run',
      '--config',
      CONFIG,
      '--allow-read',
      '--allow-write',
      '--allow-run=git',
      '--allow-net=jsr.io',
      '--allow-import=jsr.io',
      SCRIPT,
      '--captured',
      captured,
      ...mode,
    ],
    cwd: root,
  }).output()
  if (!out.success) {
    throw new Error(`tag-released-packages ${mode.join(' ')} failed:\n${decoder.decode(out.stderr)}`)
  }
  return decoder.decode(out.stdout)
}

Deno.test('create-only mode makes the tag locally and leaves the remote without it', async () => {
  const { root, captured } = await fixture()

  await drive(root, captured, ['--no-push'])

  assertEquals((await git(root, ['tag', '--list'])).trim(), '@x/a@v1.0.0')
  assertEquals((await git(root, ['ls-remote', '--tags', 'origin'])).trim(), '')
})

Deno.test('push mode puts the same tag on the remote', async () => {
  const { root, captured } = await fixture()

  await drive(root, captured, [])

  assertEquals((await git(root, ['tag', '--list'])).trim(), '@x/a@v1.0.0')
  assert(
    (await git(root, ['ls-remote', '--tags', 'origin'])).includes('refs/tags/@x/a@v1.0.0'),
    'the pushed tag did not reach the remote',
  )
})
