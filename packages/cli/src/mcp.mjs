import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { openBrowser } from './browser.mjs'
import { CliError } from './errors.mjs'
import { credentialPath, readJson, writePrivateJson } from './fs-state.mjs'
import { VERSION } from './constants.mjs'

export const DEFAULT_MCP_URL = 'https://goalmatic.io/mcp'
const SCOPES = 'goalmatic:read goalmatic:write goalmatic:run'
const LOGIN_TIMEOUT_MS = 10 * 60_000

// stdout carries JSON-RPC in `goalmatic mcp`, so every human message goes to stderr.
const log = message => process.stderr.write(`[goalmatic mcp] ${message}\n`)

export function normalizeMcpUrl(value) {
  const raw = value || process.env.GOALMATIC_MCP_URL || DEFAULT_MCP_URL
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new CliError(`Invalid MCP URL: ${raw}`, 2)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new CliError('The MCP URL must use HTTPS, or HTTP on a loopback address', 2)
  }
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function mcpCredentialPath() {
  return join(dirname(credentialPath()), 'mcp.json')
}

async function readMcpCredential(mcpUrl) {
  const saved = await readJson(mcpCredentialPath(), { optional: true })
  return saved?.mcpUrl === mcpUrl ? saved : null
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { redirect: 'error', ...init })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  return { response, body }
}

async function discover(mcpUrl) {
  const origin = new URL(mcpUrl).origin
  const { response, body } = await fetchJson(`${origin}/.well-known/oauth-authorization-server`)
  if (!response.ok || !body?.token_endpoint || !body?.authorization_endpoint) {
    throw new CliError(`Could not read Goalmatic's sign-in configuration from ${origin}`)
  }
  return body
}

function form(values) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(values).toString(),
  }
}

function waitForCallback(server, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliError('Timed out waiting for Goalmatic sign-in')), LOGIN_TIMEOUT_MS)
    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const done = (status, message) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><title>Goalmatic</title><body style="font-family:system-ui;padding:40px"><h1>${message}</h1><p>You can close this tab and return to your AI tool.</p></body>`)
      }
      if (url.searchParams.get('state') !== state) {
        done(400, 'This sign-in link does not match. Start again.')
        return
      }
      clearTimeout(timer)
      if (url.searchParams.get('error')) {
        done(200, 'Connection cancelled')
        reject(new CliError(url.searchParams.get('error_description') || 'Goalmatic sign-in was cancelled'))
        return
      }
      done(200, 'Goalmatic is connected')
      resolve(url.searchParams.get('code'))
    })
  })
}

/**
 * Connects the CLI as an MCP client through goalmatic.io's OAuth flow with a
 * loopback redirect. The browser opens once; afterwards refresh tokens keep
 * the connection alive without asking again.
 */
export async function mcpLogin({ mcpUrl, output = { info: log } } = {}) {
  const metadata = await discover(mcpUrl)
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`
  try {
    const saved = await readJson(mcpCredentialPath(), { optional: true })
    let clientId = saved?.mcpUrl === mcpUrl ? saved.clientId : null
    if (!clientId) {
      const { response, body } = await fetchJson(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Goalmatic CLI',
          redirect_uris: ['http://127.0.0.1/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          software_id: 'goalmatic-cli',
          software_version: VERSION,
        }),
      })
      if (!response.ok || !body?.client_id) throw new CliError(body?.error_description || 'Could not register the Goalmatic CLI')
      clientId = body.client_id
    }
    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(24).toString('base64url')
    const authorize = new URL(metadata.authorization_endpoint)
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      scope: SCOPES,
      resource: mcpUrl,
    })) authorize.searchParams.set(key, value)

    const callback = waitForCallback(server, state)
    output.info(`Opening Goalmatic to connect this computer: ${authorize}`)
    if (!await openBrowser(authorize.toString())) output.info('Open the link above in your browser to continue.')
    const code = await callback
    const { response, body } = await fetchJson(metadata.token_endpoint, form({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }))
    if (!response.ok || !body?.access_token) throw new CliError(body?.error_description || 'Goalmatic did not issue a token')
    const credential = {
      mcpUrl,
      clientId,
      tokenEndpoint: metadata.token_endpoint,
      revocationEndpoint: metadata.revocation_endpoint || null,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
      scope: body.scope,
    }
    await writePrivateJson(mcpCredentialPath(), credential)
    return credential
  } finally {
    server.close()
  }
}

async function refresh(credential) {
  const { response, body } = await fetchJson(credential.tokenEndpoint, form({
    grant_type: 'refresh_token',
    refresh_token: credential.refreshToken,
    client_id: credential.clientId,
  }))
  if (!response.ok || !body?.access_token) return null
  const next = {
    ...credential,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || credential.refreshToken,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    scope: body.scope || credential.scope,
  }
  await writePrivateJson(mcpCredentialPath(), next)
  return next
}

export async function mcpLogout({ mcpUrl }) {
  const credential = await readMcpCredential(mcpUrl)
  if (!credential) return { hadCredential: false, remoteRevoked: false }
  let remoteRevoked = false
  if (credential.revocationEndpoint && credential.refreshToken) {
    try {
      const { response } = await fetchJson(credential.revocationEndpoint, form({ token: credential.refreshToken, client_id: credential.clientId }))
      remoteRevoked = response.ok
    } catch {
      remoteRevoked = false
    }
  }
  await rm(mcpCredentialPath(), { force: true })
  return { hadCredential: true, remoteRevoked }
}

export function mcpClientConfig(mcpUrl) {
  return {
    remote: {
      claudeCode: `claude mcp add --transport http goalmatic ${mcpUrl}`,
      json: { mcpServers: { goalmatic: { type: 'http', url: mcpUrl } } },
    },
    local: {
      claudeCode: 'claude mcp add goalmatic -- npx -y goalmatic mcp',
      json: { mcpServers: { goalmatic: { command: 'npx', args: ['-y', 'goalmatic', 'mcp'] } } },
    },
  }
}

/**
 * Runs a stdio MCP server that forwards each JSON-RPC message to the hosted
 * Goalmatic MCP server, refreshing or re-connecting as needed.
 */
export async function runMcpProxy({ mcpUrl, input = process.stdin, write = line => process.stdout.write(`${line}\n`) } = {}) {
  let credential = await readMcpCredential(mcpUrl)
  let authenticating = null

  async function ensureCredential(force = false) {
    if (!force && credential && credential.expiresAt - 60_000 > Date.now()) return credential
    authenticating ||= (async () => {
      const refreshed = credential?.refreshToken ? await refresh(credential).catch(() => null) : null
      credential = refreshed || await mcpLogin({ mcpUrl })
      return credential
    })().finally(() => { authenticating = null })
    return authenticating
  }

  async function forward(message, retried = false) {
    const current = await ensureCredential()
    const response = await fetch(mcpUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${current.accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify(message),
    })
    if (response.status === 401 && !retried) {
      await ensureCredential(true)
      return forward(message, true)
    }
    if (response.status === 202 || response.status === 204) return null
    const text = await response.text()
    if (!response.ok) throw new Error(`Goalmatic returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    return text
  }

  const lines = createInterface({ input, crlfDelay: Infinity })
  const pending = new Set()
  for await (const line of lines) {
    if (!line.trim()) continue
    const task = (async () => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
        return
      }
      try {
        const reply = await forward(message)
        if (reply) write(reply.trim().replace(/\n/g, ''))
      } catch (error) {
        log(error.message)
        if (message && message.id !== undefined) {
          write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }))
        }
      }
    })()
    pending.add(task)
    task.finally(() => pending.delete(task))
  }
  await Promise.all(pending)
}
