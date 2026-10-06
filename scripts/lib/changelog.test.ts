import { assertEquals } from '@std/assert'

import { changelogSection } from './changelog.ts'

const changelog = [
  '## 2.0.0',
  '',
  '- add b',
  '',
  '## 1.2.3',
  '',
  '- fix a',
  '',
  '## 1.0.0',
  '',
  '- initial',
  '',
].join('\n')

Deno.test('picks the section for the requested version among several', () => {
  assertEquals(changelogSection(changelog, '1.2.3'), '## 1.2.3\n\n- fix a')
})

Deno.test('picks the newest section', () => {
  assertEquals(changelogSection(changelog, '2.0.0'), '## 2.0.0\n\n- add b')
})

Deno.test('picks the last section, which has no following heading', () => {
  assertEquals(changelogSection(changelog, '1.0.0'), '## 1.0.0\n\n- initial')
})

Deno.test('a missing version has no section', () => {
  assertEquals(changelogSection(changelog, '9.9.9'), undefined)
})

Deno.test('a prerelease heading is not mistaken for its release', () => {
  const markdown = '## 1.0.0-alpha.1\n\n- pre\n\n## 1.0.0\n\n- release\n'
  assertEquals(changelogSection(markdown, '1.0.0'), '## 1.0.0\n\n- release')
})
