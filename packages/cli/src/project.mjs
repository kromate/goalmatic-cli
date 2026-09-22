import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { apiRequest } from './api.mjs'
import { authenticatedContext, login } from './auth.mjs'
import { CONFIG_FILE, SETUP_RECEIPT } from './constants.mjs'
import { CliError, assert } from './errors.mjs'
import { readJson, writePrivateJson } from './fs-state.mjs'
import { choose, promptSession, promptText } from './prompts.mjs'
import { collectProjectFiles, scaffoldProject } from './scaffold.mjs'
import { safeProjectPath } from './source-files.mjs'

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeProjectName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!NAME_PATTERN.test(name)) throw new CliError('Project name must use lowercase letters, numbers, and single hyphens', 2)
  return name
}

export async function ensureAuth(origin, output, signal) {
  try {
    return await authenticatedContext(origin, { signal })
  } catch (error) {
    if (error?.exitCode !== 3 || !process.stdin.isTTY) throw error
    output.info('Sign in to continue.')
    await login({ origin, output, signal })
    return authenticatedContext(origin, { signal })
  }
}

export async function selectAccount(me, requested, rl) {
  const accounts = Array.isArray(me?.accounts) ? me.accounts : []
  assert(accounts.length, 'Your user has no accessible Goalmatic accounts')
  if (requested) {
    const idMatch = accounts.find(account => account.id === requested)
    if (idMatch) return idMatch
    const nameMatches = accounts.filter(account => account.name === requested)
    if (nameMatches.length > 1) {
      throw new CliError(`Account name is ambiguous: ${requested}. Use an account ID instead.`, 2)
    }
    if (!nameMatches.length) throw new CliError(`Account not found: ${requested}`, 2)
    return nameMatches[0]
  }
  if (accounts.length === 1) return accounts[0]
  return choose(rl, 'Choose an account', accounts, {
    format: account => `${account.name} (${account.id})${account.id === me.defaultAccountId ? ' [default]' : ''}`,
  })
}

export async function listProjects({ origin, token, accountId, signal }) {
  const projects = []
  let cursor = ''
  do {
    const query = new URLSearchParams({ accountId })
    if (cursor) query.set('cursor', cursor)
    const result = await apiRequest({ origin, token, accountId, path: `/api/cli/v1/projects?${query}`, signal })
    projects.push(...(Array.isArray(result?.projects) ? result.projects : []))
    cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : ''
  } while (cursor)
  return projects
}

export async function createProjectFlow({ origin, options, directoryArg, output, signal }) {
  const rl = promptSession()
  try {
    if (options.local) return createLocalScaffold({ options, directoryArg, output, rl })
    const { credential, me } = await ensureAuth(origin, output, signal)
    const account = await selectAccount(me, options.account, rl)
    if (options.project) {
      return linkProjectFlow({ origin, options, projectId: options.project, directoryArg, output, signal, context: { credential, me, account }, rl })
    }
    if (!options.type && !options.name && !directoryArg) {
      const projects = await listProjects({ origin, token: credential.accessToken, accountId: account.id, signal })
      if (projects.length) {
        const action = await choose(rl, 'Project setup', ['create', 'link'], { format: value => value === 'create' ? 'Create a new project' : 'Link an existing project' })
        if (action === 'link') {
          const project = await choose(rl, 'Choose a project', projects, { format: item => `${item.name} (${item.type}, ${item.id})` })
          return linkProjectFlow({ origin, options, projectId: project.id, directoryArg, output, signal, context: { credential, me, account }, rl })
        }
      }
    }
    const type = options.type || await choose(rl, 'Project type', ['site', 'app'], { format: value => value === 'site' ? 'Site' : 'App' })
    if (!['site', 'app'].includes(type)) throw new CliError('--type must be site or app', 2)
    const initialDirectory = directoryArg || options.name || ''
    const name = normalizeProjectName(options.name || await promptText(rl, 'Project name', initialDirectory ? basename(resolve(initialDirectory)) : 'my-goalmatic-project'))
    const directory = resolve(initialDirectory || await promptText(rl, 'Directory', name))
    const identity = { name, type, accountId: account.id }
    const existingReceipt = await readJson(join(directory, SETUP_RECEIPT), { optional: true })
    let files
    let receipt
    if (existingReceipt) {
      if (JSON.stringify(existingReceipt.identity) !== JSON.stringify(identity)) {
        throw new CliError('This directory contains a different interrupted Goalmatic setup')
      }
      if (existingReceipt.status === 'complete') {
        const config = await readJson(join(directory, CONFIG_FILE))
        if (config.projectId !== existingReceipt.result?.project?.id || config.accountId !== account.id || config.apiOrigin !== origin) {
          throw new CliError('Completed setup receipt does not match this local project identity')
        }
        output.info(`Project ${existingReceipt.result.project.name} is already created.`)
        return { ...existingReceipt.result, directory }
      }
      files = existingReceipt.submittedFiles
      if (!Array.isArray(files)) throw new CliError('Interrupted setup receipt is missing its submitted source')
      receipt = existingReceipt
      if (receipt.status === 'remote-created') {
        await applyCanonicalFiles(directory, files, receipt.result.files || [])
        await finalizeLocalConfig(directory, { name, type, accountId: account.id, projectId: receipt.result.project.id, apiOrigin: origin })
        const complete = { ...receipt, status: 'complete', completedAt: new Date().toISOString() }
        await writePrivateJson(join(directory, SETUP_RECEIPT), complete)
        output.info(`Finished local setup for ${receipt.result.project.name}.`)
        return { ...receipt.result, directory }
      }
      await verifyFiles(directory, files)
    } else {
      await scaffoldProject({ directory, name, type })
      await finalizeLocalConfig(directory, { name, type, accountId: account.id })
      files = await collectProjectFiles(directory)
      receipt = await prepareScaffold(directory, files, identity, { scaffolded: true })
    }
    if (receipt.result?.project?.id) {
      output.info(`Resumed project ${receipt.result.project.name}.`)
      return receipt.result
    }
    const result = await apiRequest({
      origin,
      token: credential.accessToken,
      accountId: account.id,
      path: '/api/cli/v1/projects',
      method: 'POST',
      headers: { 'Idempotency-Key': receipt.idempotencyKey },
      body: { accountId: account.id, name, type, files },
      signal,
    })
    const projectId = result?.project?.id
    assert(projectId, 'Goalmatic returned an invalid project result')
    const remoteReceipt = { ...receipt, status: 'remote-created', result, remoteCreatedAt: new Date().toISOString() }
    await writePrivateJson(join(directory, SETUP_RECEIPT), remoteReceipt)
    if (Array.isArray(result.files) && result.files.length) {
      await applyCanonicalFiles(directory, files, result.files)
    }
    await finalizeLocalConfig(directory, { name, type, accountId: account.id, projectId, apiOrigin: origin })
    const finalReceipt = { ...receipt, status: 'complete', result, completedAt: new Date().toISOString() }
    await writePrivateJson(join(directory, SETUP_RECEIPT), finalReceipt)
    output.info(`Created ${type} ${result.project.name}.`)
    if (result.editorUrl) output.info(`Editor: ${result.editorUrl}`)
    if (result.previewUrl) output.info(`Preview: ${result.previewUrl}`)
    return { ...result, directory }
  } finally {
    rl?.close()
  }
}

export async function linkProjectFlow({ origin, options, projectId, directoryArg, output, signal, context, rl: suppliedRl }) {
  const ownedRl = suppliedRl ? null : promptSession()
  const rl = suppliedRl || ownedRl
  try {
    const auth = context || await ensureAuth(origin, output, signal)
    const account = context?.account || await selectAccount(auth.me, options.account, rl)
    const projects = await listProjects({ origin, token: auth.credential.accessToken, accountId: account.id, signal })
    const project = projectId
      ? projects.find(item => item.id === projectId)
      : await choose(rl, 'Choose a project', projects, { format: item => `${item.name} (${item.type}, ${item.id})` })
    if (!project) throw new CliError(`Project not found in ${account.name}: ${projectId}`, 2)
    const directory = resolve(directoryArg || await promptText(rl, 'Directory', project.name))
    await assertDirectoryEmpty(directory)
    const snapshot = await apiRequest({
      origin,
      token: auth.credential.accessToken,
      accountId: account.id,
      path: `/api/sites/${encodeURIComponent(project.id)}/source`,
      signal,
    })
    const files = Array.isArray(snapshot?.files) ? snapshot.files : []
    assert(files.length, 'The existing project has no downloadable source')
    await writeFilesSafely(directory, files, { overwrite: false })
    await finalizeLocalConfig(directory, {
      name: project.name,
      type: project.type === 'app' || project.type === 'goalmatic-app' ? 'app' : 'site',
      accountId: account.id,
      projectId: project.id,
      apiOrigin: origin,
    })
    output.info(`Linked ${project.name} without overwriting existing code.`)
    return { project, directory, sourceVersionId: snapshot.latestVersionId || null }
  } finally {
    ownedRl?.close()
  }
}

async function finalizeLocalConfig(directory, values) {
  const path = join(directory, CONFIG_FILE)
  const current = await readJson(path, { optional: true }) || {}
  await writeFile(path, `${JSON.stringify({ ...current, ...values, schemaVersion: 1, framework: 'vue' }, null, 2)}\n`)
}

async function prepareScaffold(directory, files, identity, { scaffolded = false, existingReceipt = null } = {}) {
  await mkdir(directory, { recursive: true })
  const receiptPath = join(directory, SETUP_RECEIPT)
  const fingerprint = createHash('sha256').update(JSON.stringify({ identity, files })).digest('hex')
  const previous = existingReceipt || await readJson(receiptPath, { optional: true })
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new CliError('This directory contains a different interrupted Goalmatic setup')
    await verifyFiles(directory, files)
    return previous
  }
  if (!scaffolded) {
    await assertDirectoryEmpty(directory)
    await writeFilesSafely(directory, files, { overwrite: false })
  }
  const receipt = {
    schemaVersion: 1,
    status: 'pending',
    idempotencyKey: randomUUID(),
    fingerprint,
    identity,
    submittedFiles: files,
    createdAt: new Date().toISOString(),
  }
  await writePrivateJson(receiptPath, receipt)
  return receipt
}

async function applyCanonicalFiles(directory, submittedFiles, canonicalFiles) {
  const submitted = new Map(submittedFiles.map(file => [file.path, file.content]))
  for (const file of canonicalFiles) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new CliError('Goalmatic returned invalid canonical source')
    const destination = await safeProjectPath(directory, file.path)
    let current = null
    try { current = await readFile(destination, 'utf8') } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (current === file.content) continue
    if (current !== null && (!submitted.has(file.path) || current !== submitted.get(file.path))) {
      throw new CliError(`Refusing to replace locally changed file with canonical source: ${file.path}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.content)
  }
}

async function createLocalScaffold({ options, directoryArg, output, rl }) {
  const type = options.type || await choose(rl, 'Project type', ['site', 'app'], { format: value => value === 'site' ? 'Site' : 'App' })
  if (!['site', 'app'].includes(type)) throw new CliError('--type must be site or app', 2)
  const initialDirectory = directoryArg || options.name || ''
  const name = normalizeProjectName(options.name || await promptText(rl, 'Project name', initialDirectory ? basename(resolve(initialDirectory)) : 'my-goalmatic-project'))
  const directory = resolve(initialDirectory || await promptText(rl, 'Directory', name))
  await scaffoldProject({ directory, name, type })
  output.info(`Created local ${type} starter in ${directory}. No Goalmatic project or GitHub repository was created.`)
  return { local: true, directory, name, type }
}

async function assertDirectoryEmpty(directory) {
  try {
    const entries = await readdir(directory)
    if (entries.length) throw new CliError(`Directory is not empty: ${directory}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(directory, { recursive: true })
  }
}

async function writeFilesSafely(directory, files, { overwrite }) {
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new CliError('Source response contains an invalid file')
    const destination = await safeProjectPath(directory, file.path)
    await mkdir(dirname(destination), { recursive: true })
    try {
      const existing = await lstat(destination)
      if (existing.isSymbolicLink()) throw new CliError(`Refusing to write through a symlink: ${file.path}`)
      if (!overwrite) throw new CliError(`Refusing to overwrite existing file: ${file.path}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await writeFile(destination, file.content, { flag: overwrite ? 'w' : 'wx' })
  }
}

async function verifyFiles(directory, files) {
  for (const file of files) {
    const destination = await safeProjectPath(directory, file.path)
    let content
    try { content = await readFile(destination, 'utf8') } catch { throw new CliError(`Interrupted setup cannot resume because ${file.path} is missing`) }
    if (content !== file.content) throw new CliError(`Interrupted setup cannot resume because ${file.path} changed`)
  }
}
