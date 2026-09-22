import { createHash, randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { apiRequest } from './api.mjs'
import { openBrowser } from './browser.mjs'
import { credentialPath, readJson, writePrivateJson } from './fs-state.mjs'
import { CliError } from './errors.mjs'
import { normalizeApiOrigin, trustedBrowserUrl } from './url.mjs'

const CLIENT_NAME = 'Goalmatic CLI'

function expiryMs(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

export async function loadCredential(origin, { required = true } = {}) {
  const envToken = process.env.GOALMATIC_TOKEN?.trim()
  if (envToken) {
    const tokenOrigin = normalizeApiOrigin(process.env.GOALMATIC_API_URL)
    if (origin !== tokenOrigin) throw new CliError('GOALMATIC_TOKEN belongs to GOALMATIC_API_URL, which defaults to https://goalmatic.site. The project cannot change that origin.', 3)
    return { accessToken: envToken, apiOrigin: tokenOrigin, source: 'environment' }
  }
  const saved = await readJson(credentialPath(), { optional: true })
  if (!saved) {
    if (required) throw new CliError('Not signed in. Run `goalmatic login` or set GOALMATIC_TOKEN.', 3)
    return null
  }
  if (saved.apiOrigin !== origin) {
    throw new CliError(`Saved credentials belong to ${saved.apiOrigin}. Use that --api-url or run login for ${origin}.`, 3)
  }
  if (!saved.accessToken || expiryMs(saved.expiresAt) <= Date.now() + 30_000) {
    throw new CliError('The saved Goalmatic session has expired. Run `goalmatic login`.', 3)
  }
  return { ...saved, source: 'file' }
}

export async function login({ origin, output, signal }) {
  if (process.env.GOALMATIC_TOKEN) throw new CliError('GOALMATIC_TOKEN is already set. Unset it to use browser login.', 2)
  const codeVerifier = randomBytes(48).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const device = await apiRequest({
    origin,
    path: '/api/cli/v1/auth/device',
    method: 'POST',
    body: { codeChallenge, clientName: CLIENT_NAME },
    signal,
  })
  if (!device?.deviceCode || !device?.userCode || !device?.verificationUri || !device?.expiresAt) {
    throw new CliError('Goalmatic returned an invalid device-login response')
  }
  const verificationUrl = trustedBrowserUrl(device.verificationUri, origin)
  output.info(`Open ${verificationUrl}`)
  output.info(`Enter code: ${device.userCode}`)
  if (!await openBrowser(verificationUrl)) output.warn('The browser did not open automatically. Open the URL above.')

  const deadline = expiryMs(device.expiresAt)
  let intervalMs = Math.max(1_000, Number(device.interval || 5) * 1_000)
  while (Date.now() < deadline) {
    await wait(intervalMs, signal)
    let result
    try {
      result = await apiRequest({
        origin,
        path: '/api/cli/v1/auth/token',
        method: 'POST',
        body: { deviceCode: device.deviceCode, codeVerifier },
        signal,
      })
    } catch (error) {
      const status = error?.details?.status || error?.details?.error
      if (status === 'pending' || error?.status === 428) continue
      if (status === 'slow_down' || error?.status === 429) {
        intervalMs += 5_000
        continue
      }
      throw error
    }
    if (result?.status === 'pending') continue
    if (result?.status === 'slow_down') {
      intervalMs += 5_000
      continue
    }
    if (result?.status === 'denied') throw new CliError('Login was denied.', 3)
    if (result?.status !== 'approved' || !result.accessToken || !result.expiresAt) {
      throw new CliError('Goalmatic returned an invalid login result')
    }
    const credential = {
      schemaVersion: 1,
      apiOrigin: origin,
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      user: result.user,
      accounts: result.accounts || [],
      defaultAccountId: result.defaultAccountId || null,
    }
    await writePrivateJson(credentialPath(), credential)
    return credential
  }
  throw new CliError('Login expired before approval. Run `goalmatic login` again.', 3)
}

export async function logout({ origin, output, signal }) {
  const envToken = process.env.GOALMATIC_TOKEN?.trim()
  if (envToken) throw new CliError('Unset GOALMATIC_TOKEN to sign out of this shell.', 2)
  const saved = await readJson(credentialPath(), { optional: true })
  const credential = saved
  let remoteRevoked = !credential?.accessToken
  if (credential?.accessToken) {
    try {
      await apiRequest({ origin: credential.apiOrigin || origin, token: credential.accessToken, path: '/api/cli/v1/auth/revoke', method: 'POST', signal })
      remoteRevoked = true
    } catch (error) {
      output.warn(`Remote revoke failed: ${error.message}`)
    }
  }
  await rm(credentialPath(), { force: true })
  return { signedOutLocally: true, hadCredential: Boolean(credential?.accessToken), remoteRevoked }
}

export async function authenticatedContext(origin, { signal } = {}) {
  const credential = await loadCredential(origin)
  const me = await apiRequest({ origin, token: credential.accessToken, path: '/api/cli/v1/me', signal })
  return { credential, me }
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CliError('Login cancelled', 130))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
