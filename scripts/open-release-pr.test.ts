import { assert, assertEquals } from '@std/assert'
import { fromFileUrl, join } from '@std/path'

const script = fromFileUrl(new URL('./open-release-pr.sh', import.meta.url))

const decoder = new TextDecoder()

const git = async (cwd: string, args: string[]): Promise<void> => {
  const out = await new Deno.Command('git', { args, cwd }).output()
  if (!out.success) throw new Error(`git ${args.join(' ')} failed: ${decoder.decode(out.stderr)}`)
}

const commit = async (cwd: string, message: string): Promise<void> =>
  git(cwd, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '-m', message])

type Fixture = { root: string; ghLog: string }

const fixture = async ({ bump }: { bump: boolean }): Promise<Fixture> => {
  const root = await Deno.makeTempDir({ prefix: 'release-pr-root-' })
  const origin = await Deno.makeTempDir({ prefix: 'release-pr-origin-' })
  await git(origin, ['init', '--quiet', '--bare'])

  await git(root, ['init', '--quiet', '--initial-branch=main'])
  await Deno.writeTextFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await Deno.writeTextFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await Deno.mkdir(join(root, '.changeset'), { recursive: true })
  await Deno.writeTextFile(join(root, '.changeset', 'README.md'), '# changesets\n')
  await Deno.mkdir(join(root, 'packages', 'a'), { recursive: true })
  await Deno.writeTextFile(
    join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({ name: '@x/a', version: '1.0.0' }),
  )
  await git(root, ['add', '-A'])
  await commit(root, 'init')
  await git(root, ['remote', 'add', 'origin', origin])
  await git(root, ['push', '--quiet', 'origin', 'main'])

  if (bump) {
    await Deno.writeTextFile(
      join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: '@x/a', version: '1.0.1' }),
    )
    await git(root, ['add', '-A'])
    await commit(root, 'chore(release): version packages')
  }

  const bin = await Deno.makeTempDir({ prefix: 'release-pr-bin-' })
  const ghLog = join(bin, 'gh.log')
  await Deno.writeTextFile(ghLog, '')
  await Deno.writeTextFile(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(ghLog)}\nexit 0\n`)
  await Deno.chmod(join(bin, 'gh'), 0o755)

  return { root, ghLog }
}

const drive = async (root: string, ghLog: string): Promise<{ code: number; stdout: string }> => {
  const stub = join(ghLog, '..')
  const out = await new Deno.Command('bash', {
    args: [script],
    cwd: root,
    env: {
      BRANCH: 'changeset-release/main',
      BASE: 'main',
      GH_TOKEN: 'stub-token',
      PATH: `${stub}:${Deno.env.get('PATH') ?? '/usr/bin:/bin'}`,
    },
  }).output()
  return { code: out.code, stdout: decoder.decode(out.stdout) }
}

Deno.test('a run that committed version bumps reaches the PR step', async () => {
  const { root, ghLog } = await fixture({ bump: true })
  const { code, stdout } = await drive(root, ghLog)

  assertEquals(code, 0)
  assert(!stdout.includes('no package.json version bumps'), stdout)

  const lines = (await Deno.readTextFile(ghLog)).split('\n')
  assert(
    lines.some((line) => line.startsWith('pr create ')),
    `gh pr create was not called:\n${lines.join('\n')}`,
  )
  assert(
    lines.some((line) => line.startsWith('label create ')),
    `gh label create was not called:\n${lines.join('\n')}`,
  )
})

Deno.test('a run with no version bump against the base does not open a PR', async () => {
  const { root, ghLog } = await fixture({ bump: false })
  const { code, stdout } = await drive(root, ghLog)

  assertEquals(code, 0)
  assert(stdout.includes('no package.json version bumps'), stdout)

  const log = await Deno.readTextFile(ghLog)
  assert(!log.includes('pr create'), `gh pr create should not have been called:\n${log}`)
})
