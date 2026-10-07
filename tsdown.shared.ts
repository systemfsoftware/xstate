const rolldownPluginDtsTypeScript7Notice = /TypeScript 7\.0 does not yet have a stable API/

export const quietBuild = {
  logLevel: 'warn' as const,
  suppressWarnings: [rolldownPluginDtsTypeScript7Notice],
}
