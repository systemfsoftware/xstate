export const changelogSection = (markdown: string, version: string): string | undefined => {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${version}`)
  if (start === -1) return undefined
  const rest = lines.slice(start)
  const next = rest.findIndex((line, index) => index > 0 && line.startsWith('## '))
  const body = (next === -1 ? rest : rest.slice(0, next)).join('\n').trim()
  return body.length === 0 ? undefined : body
}
