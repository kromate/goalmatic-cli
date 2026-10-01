import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, relative } from 'node:path'

const root = fileURLToPath(new URL('../goalmatic/', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'))
const mcp = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'))
const openai = manifest.extensions['com.openai']

test('portable package has a stable identity and a single production remote MCP', () => {
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  assert.equal(manifest.name, 'goalmatic')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(mcp.mcpServers, { goalmatic: { type: 'streamable-http', url: 'https://goalmatic.io/mcp/plugins' } })
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
  for (const field of ['apps', 'hooks', 'test_credentials', 'reviewer_instructions']) assert.equal(openai[field], undefined)
})

test('submission metadata meets documented limits and references packaged assets', async () => {
  const listing = openai.interface
  for (const [field, limit] of [['displayName', 30], ['shortDescription', 30], ['longDescription', 4000], ['developerName', 80]]) {
    assert.ok(listing[field].length > 0 && listing[field].length <= limit, field)
  }
  for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    const url = new URL(listing[field])
    assert.equal(url.protocol, 'https:')
    assert.equal(url.username + url.password, '')
  }
  assert.ok(listing.defaultPrompt.length <= 3)
  for (const prompt of listing.defaultPrompt) assert.ok(prompt.length <= 128 && !prompt.includes('@'))
  for (const asset of [listing.logo, listing.composerIcon, openai.onboardingSkill]) {
    assert.ok(asset.startsWith('./'))
    assert.ok(!relative(root, resolve(root, asset)).startsWith('..'))
    assert.ok((await lstat(resolve(root, asset))).isFile())
  }
  const svg = await readFile(resolve(root, listing.logo), 'utf8')
  assert.match(svg, /width="256" height="256"/)
})

test('review cases cover five successful workflows and three safety boundaries', () => {
  assert.equal(openai.review.test_cases.positive.length, 5)
  assert.equal(openai.review.test_cases.negative.length, 3)
  for (const entry of openai.review.test_cases.positive) {
    for (const field of ['description', 'prompt', 'tools_triggered', 'expected_behavior']) assert.ok(entry[field]?.trim(), field)
    assert.ok(!entry.tools_triggered.includes('execute_operation'))
  }
  assert.equal(openai.review.commerce, false)
})

test('bundle consists only of reviewed text/assets without symlinks or hidden credential files', async () => {
  const allowed = new Set(['plugin.json', 'mcp.json', 'assets/icon.svg', 'skills/get-started/SKILL.md', 'skills/build-project/SKILL.md'])
  const found = []
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false)
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else {
        const name = relative(root, path)
        assert.ok(allowed.has(name), `Unexpected bundle file: ${name}`)
        const text = await readFile(path, 'utf8')
        assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gmxr?_[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}/)
        found.push(name)
      }
    }
  }
  await visit(root)
  assert.deepEqual(found.sort(), [...allowed].sort())
})

test('skills keep publication consent and unavailable capabilities explicit', async () => {
  const skill = await readFile(join(root, 'skills/build-project/SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: build-project\ndescription: .+\n---/)
  for (const phrase of ['baseVersionId', 'idempotency', 'approval_required', 'untrusted data', 'get_deployment']) assert.ok(skill.includes(phrase))
  assert.ok(!skill.includes('execute_operation'))
})
