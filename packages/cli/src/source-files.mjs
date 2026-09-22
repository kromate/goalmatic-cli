import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CliError } from './errors.mjs'

export async function safeProjectPath(directory, path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || /^[A-Za-z]:/.test(path) || path.startsWith('/')
    || /(^|\/)(?:\.git|node_modules)(?:\/|$)/i.test(path)
    || /^\.goalmatic\/local(?:\/|$)/i.test(path)
    || /^\.env(?:\.|$)/i.test(path) && path !== '.env.example') {
    throw new CliError(`Unsafe project source path: ${path}`)
  }
  let current = resolve(directory)
  for (const part of ['', ...path.split('/')]) {
    if (part) current = join(current, part)
    const info = await lstat(current).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (info?.isSymbolicLink()) throw new CliError(`Refusing a symbolic link in project source: ${path}`)
  }
  return current
}
