export interface Outcome {
  readonly code: number
  readonly out: string
}

const decoder = new TextDecoder()

const ENV_A_SCOPED_ALLOW_RUN_CAN_SPAWN = Object.fromEntries(
  Object.entries(Deno.env.toObject()).filter(([name]) => !/^(LD|DYLD)_/.test(name)),
)

export const run = async (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string>; readonly stdin?: string } = {},
): Promise<Outcome> => {
  const child = new Deno.Command(command, {
    args: [...args],
    cwd: options.cwd,
    clearEnv: true,
    env: { ...ENV_A_SCOPED_ALLOW_RUN_CAN_SPAWN, ...options.env },
    stdin: options.stdin === undefined ? 'null' : 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn()
  if (options.stdin !== undefined) {
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(options.stdin))
    await writer.close()
  }
  const { code, stdout, stderr } = await child.output()
  return { code, out: decoder.decode(stdout) + decoder.decode(stderr) }
}
