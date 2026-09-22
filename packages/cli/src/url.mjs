import { CliError } from './errors.mjs'
import { DEFAULT_API_ORIGIN } from './constants.mjs'

export function normalizeApiOrigin(value = DEFAULT_API_ORIGIN) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new CliError(`Invalid API URL: ${value}`, 2)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new CliError('--api-url must be an origin without a path, credentials, query, or fragment', 2)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('--api-url must use HTTPS, except for loopback HTTP', 2)
  }
  return url.origin
}

export function trustedBrowserUrl(value, apiOrigin, { github = false } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new CliError('The server returned an invalid browser URL')
  }
  const api = new URL(apiOrigin)
  const goalmaticHost = url.hostname === 'goalmatic.site' || url.hostname.endsWith('.goalmatic.site')
    || url.hostname === 'goalmatic.io' || url.hostname.endsWith('.goalmatic.io')
  const allowed = url.origin === api.origin || (url.protocol === 'https:' && (
    goalmaticHost ||
    (github && (url.hostname === 'github.com' || url.hostname.endsWith('.github.com')))
  ))
  if (!allowed || url.username || url.password) throw new CliError('The server returned an untrusted browser URL')
  return url.toString()
}
