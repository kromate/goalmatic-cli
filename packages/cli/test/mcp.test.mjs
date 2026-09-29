import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mcpCredentialPath, normalizeMcpUrl, runMcpProxy } from '../src/mcp.mjs'
import { writePrivateJson } from '../src/fs-state.mjs'

async function fakeGoalmatic() {
  const state = { validToken: 'gmx_fresh', refreshes: 0, calls: [] }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const origin = `http://127.0.0.1:${server.address().port}`
    if (req.url === '/oauth/token') {
      const form = new URLSearchParams(body)
      assert.equal(form.get('grant_type'), 'refresh_token')
      state.refreshes += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: state.validToken, refresh_token: 'gmxr_next', expires_in: 3600, scope: 'goalmatic:read' }))
      return
    }
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ token_endpoint: `${origin}/oauth/token`, authorization_endpoint: `${origin}/oauth/authorize` }))
      return
    }
    if (req.url === '/mcp') {
      if (req.headers.authorization !== `Bearer ${state.validToken}`) {
        res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
        return
      }
      const message = JSON.parse(body)
      state.calls.push(message.method)
      if (message.id === undefined) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: message.method } }, null, 2))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, state, mcpUrl: `http://127.0.0.1:${server.address().port}/mcp` }
}

test('mcp URLs must be HTTPS or loopback HTTP', () => {
  assert.equal(normalizeMcpUrl('https://goalmatic.io/mcp/'), 'https://goalmatic.io/mcp')
  assert.equal(normalizeMcpUrl('http://127.0.0.1:3010/mcp'), 'http://127.0.0.1:3010/mcp')
  assert.throws(() => normalizeMcpUrl('http://goalmatic.io/mcp'), /HTTPS/)
})

test('the stdio proxy forwards JSON-RPC and refreshes an expired token once', async () => {
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'goalmatic-mcp-'))
  const { server, state, mcpUrl } = await fakeGoalmatic()
  try {
    await writePrivateJson(mcpCredentialPath(), {
      mcpUrl,
      clientId: 'gmcl_test',
      tokenEndpoint: new URL('/oauth/token', mcpUrl).toString(),
      accessToken: 'gmx_stale',
      refreshToken: 'gmxr_old',
      expiresAt: Date.now() + 3_600_000,
    })
    const input = new PassThrough()
    const lines = []
    const done = runMcpProxy({ mcpUrl, input, write: line => lines.push(line) })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    input.write('not json\n')
    input.end()
    await done

    const replies = lines.map(line => JSON.parse(line))
    assert.deepEqual(replies.find(reply => reply.id === 1), { jsonrpc: '2.0', id: 1, result: { echoed: 'initialize' } })
    assert.equal(replies.find(reply => reply.id === null)?.error.code, -32700)
    assert.equal(replies.length, 2, 'notifications produce no reply')
    assert.equal(state.refreshes, 1)
    assert.deepEqual(state.calls.sort(), ['initialize', 'notifications/initialized'])

    const saved = JSON.parse(await readFile(mcpCredentialPath(), 'utf8'))
    assert.equal(saved.accessToken, 'gmx_fresh')
    assert.equal(saved.refreshToken, 'gmxr_next')
    assert.equal((await stat(mcpCredentialPath())).mode & 0o777, 0o600)
  } finally {
    server.close()
  }
})
