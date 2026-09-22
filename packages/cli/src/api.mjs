import { CliError } from './errors.mjs'

function apiErrorMessage(payload, status) {
  return payload?.message || payload?.statusMessage || payload?.error_description || payload?.error || `Request failed with HTTP ${status}`
}

export async function apiRequest({ origin, token, accountId, path, method = 'GET', body, headers = {}, signal }) {
  const requestUrl = new URL(path, origin)
  if (requestUrl.origin !== origin) throw new CliError('Refusing to send a request outside the configured API origin')
  const requestHeaders = { Accept: 'application/json', ...headers }
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json'
  if (token) requestHeaders.Authorization = `Bearer ${token}`
  if (accountId) requestHeaders['X-Goalmatic-Account-Id'] = accountId
  let response
  const timeout = AbortSignal.timeout(method === 'GET' ? 30_000 : 90_000)
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    response = await fetch(requestUrl, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: combinedSignal,
    })
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      if (signal?.aborted) throw new CliError('Request cancelled', 130)
      throw new CliError(`Request to ${requestUrl.pathname} timed out`)
    }
    throw new CliError(`Could not reach ${origin}: ${error?.message || error}`)
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CliError('The API attempted to redirect an authenticated request; no credential was forwarded')
  }
  const text = await response.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch { payload = { message: text.slice(0, 500) } }
  }
  if (!response.ok) {
    const error = new CliError(apiErrorMessage(payload, response.status), response.status === 401 ? 3 : 1, payload)
    error.status = response.status
    throw error
  }
  return payload
}
