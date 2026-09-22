import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { CONFIG_FILE } from './constants.mjs'
import { CliError } from './errors.mjs'

export function credentialPath() {
  const base = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), '.config')
  return join(base, 'goalmatic', 'credentials.json')
}

export async function readJson(path, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null
    if (error instanceof SyntaxError) throw new CliError(`Invalid JSON in ${path}`)
    throw error
  }
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function findProjectConfig(start = process.cwd()) {
  let current = resolve(start)
  while (true) {
    const path = join(current, CONFIG_FILE)
    try {
      const file = await stat(path)
      if (file.isFile()) return { path, directory: current, config: await readJson(path) }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function requireProjectConfig(start, { remote = true } = {}) {
  const found = await findProjectConfig(start)
  if (!found) throw new CliError(`No ${CONFIG_FILE} found in this directory or its parents`, 2)
  const { config } = found
  if (config?.schemaVersion !== 1 || !config.name || !['site', 'app'].includes(config.type) || (remote && (!config.projectId || !config.accountId))) {
    throw new CliError(`${found.path} is not a valid Goalmatic project configuration`)
  }
  return found
}
