import { CliError } from './errors.mjs'

const VALUE_OPTIONS = new Set([
  'api-url', 'account', 'name', 'type', 'project', 'owner', 'repo',
  'production-branch', 'preview-branch', 'version-id', 'test-build-id',
])

export function parseOptions(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!value.startsWith('--')) {
      positional.push(value)
      continue
    }
    const separator = value.indexOf('=')
    const key = value.slice(2, separator === -1 ? undefined : separator)
    if (!key) throw new CliError('Invalid empty option')
    if (VALUE_OPTIONS.has(key)) {
      const optionValue = separator === -1 ? argv[++index] : value.slice(separator + 1)
      if (!optionValue || optionValue.startsWith('--')) throw new CliError(`--${key} requires a value`)
      options[key] = optionValue
      continue
    }
    if (!['json', 'yes', 'help', 'version', 'preview', 'private', 'local'].includes(key)) {
      throw new CliError(`Unknown option --${key}`, 2)
    }
    if (separator !== -1) throw new CliError(`--${key} does not accept a value`, 2)
    options[key] = true
  }
  return { positional, options }
}
