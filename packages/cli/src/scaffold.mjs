import { mkdir, readdir, readFile, lstat, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../templates/vue-todo')
const TEMPLATE_FILES = [
  '.gitignore',
  'App.vue',
  'index.html',
  'pages/index.vue',
  'main.js',
  'vite.config.mjs',
  'package.json',
  'package-lock.json',
  'goalmatic.json',
  '.goalmatic/app.json',
]
const OUTPUT_FILES = new Set(TEMPLATE_FILES)

function slugify(value) {
  const slug = String(value || 'goalmatic-todo').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return slug || 'goalmatic-todo'
}

function jsonStringContent(value) {
  return JSON.stringify(String(value)).slice(1, -1)
}

function replaceTemplateTokens(content, values) {
  return content.replaceAll('{{PROJECT_NAME}}', jsonStringContent(values.name))
    .replaceAll('{{PROJECT_SLUG}}', values.slug)
    .replaceAll('{{PROJECT_TYPE}}', values.type)
}

async function pathIsEmptyDirectory(directory) {
  const info = await lstat(directory).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info) return false
  if (info.isSymbolicLink()) throw new Error(`Refusing to scaffold through symbolic link: ${directory}`)
  if (!info.isDirectory()) throw new Error(`Scaffold destination is not a directory: ${directory}`)
  return (await readdir(directory)).length === 0
}

async function assertSafeParents(directory) {
  const absolute = resolve(directory)
  let current = parse(absolute).root
  for (const segment of relative(current, dirname(absolute)).split(sep)) {
    if (!segment) continue
    current = join(current, segment)
    const info = await lstat(current).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (info?.isSymbolicLink()) throw new Error(`Refusing to scaffold through symbolic link: ${current}`)
  }
}

async function templateFiles({ name, type }) {
  const slug = slugify(name)
  const files = []
  for (const path of TEMPLATE_FILES) {
    if (type === 'site' && path === '.goalmatic/app.json') continue
    const sourcePath = path === '.gitignore' ? 'gitignore' : path
    const content = await readFile(join(TEMPLATE_DIRECTORY, sourcePath), 'utf8')
    files.push({ path, content: replaceTemplateTokens(content, { name, slug, type }) })
  }
  return files
}

function assertNpmMetadata(files) {
  const paths = new Set(files.map(file => file.path))
  if (!paths.has('package-lock.json')) throw new Error('The npm starter requires package-lock.json')
  const packageFile = files.find(file => file.path === 'package.json')
  if (!packageFile) throw new Error('The npm starter requires package.json')
  const packageJson = JSON.parse(packageFile.content)
  if (typeof packageJson.packageManager !== 'string' || !packageJson.packageManager.startsWith('npm@')) {
    throw new Error('The npm starter requires package.json to declare packageManager')
  }
}

/** Return only the known, safe starter files from a generated project. */
export async function collectProjectFiles(directory) {
  const absolute = resolve(directory)
  const info = await lstat(absolute)
  if (info.isSymbolicLink()) throw new Error(`Refusing to collect files through symbolic link: ${absolute}`)
  if (!info.isDirectory()) throw new Error(`Project path is not a directory: ${absolute}`)
  const files = []
  for (const path of OUTPUT_FILES) {
    const target = join(absolute, path)
    await assertSafeParents(target)
    const entry = await lstat(target).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (!entry) continue
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Expected a regular starter file: ${target}`)
    files.push({ path, content: await readFile(target, 'utf8') })
  }
  return files
}

/** Create a Vue todo starter and return the exact generated file contents. */
export async function scaffoldProject({ directory, name, type } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('directory is required')
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('name is required')
  if (type !== 'site' && type !== 'app') throw new TypeError("type must be 'site' or 'app'")

  const absolute = resolve(directory)
  await assertSafeParents(absolute)
  const existing = await lstat(absolute).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to scaffold through symbolic link: ${absolute}`)
  if (existing && !existing.isDirectory()) throw new Error(`Scaffold destination is not a directory: ${absolute}`)
  const existsAndEmpty = existing ? await pathIsEmptyDirectory(absolute) : false
  const exists = Boolean(existing)
  if (exists && !existsAndEmpty) throw new Error(`Scaffold destination must be empty: ${absolute}`)
  if (!exists) await mkdir(absolute, { recursive: false })

  const starterFiles = await templateFiles({ name: name.trim(), type })
  const files = starterFiles
  assertNpmMetadata(files)
  for (const file of files) {
    const target = join(absolute, file.path)
    if (!target.startsWith(`${absolute}${sep}`)) throw new Error(`Unsafe generated path: ${file.path}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' })
  }
  return { directory: absolute, files }
}
