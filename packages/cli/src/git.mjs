import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { apiRequest } from './api.mjs'
import { loadCredential } from './auth.mjs'
import { openBrowser } from './browser.mjs'
import { CliError } from './errors.mjs'
import { promptSession, choose, confirm, promptText } from './prompts.mjs'
import { trustedBrowserUrl } from './url.mjs'
import { safeProjectPath } from './source-files.mjs'

const SETUP_POLL_MS = 3_000

export async function githubStatus({ origin, project, signal }) {
  const credential = await loadCredential(origin)
  return apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/github/status`,
    signal,
  })
}

export async function githubBranches({ origin, project, signal }) {
  const credential = await loadCredential(origin)
  return apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/github/branches`,
    signal,
  })
}

export async function connectGithub({ origin, project, options, output, signal }) {
  const credential = await loadCredential(origin)
  const rl = promptSession()
  try {
    const siteId = project.config.projectId
    let current = null
    try {
      current = await apiRequest({
        origin,
        token: credential.accessToken,
        accountId: project.config.accountId,
        path: `/api/sites/${encodeURIComponent(siteId)}/github/status`,
        signal,
      })
    } catch (error) {
      if (error?.status !== 404) throw error
    }
    if (current?.connected && current.binding?.sourceAuthority === 'git' && current.binding?.migration?.status === 'ready') {
      validateBoundRepositoryChoice(current.binding, options)
      const local = await attachConnectedBinding({ origin, credential, project, binding: current.binding, signal })
      output.info(`Reused ${current.binding.owner}/${current.binding.repo}; Git source authority is already ready.`)
      output.info(`Local branch ${local.branch} now tracks the fetched commit ${local.commitSha.slice(0, 12)}.`)
      if (!local.clean) output.warn('The local checkout has uncommitted differences. Review and commit them before deploy or publish.')
      return { ...current, local }
    }
    const setup = await apiRequest({
      origin,
      token: credential.accessToken,
      accountId: project.config.accountId,
      path: `/api/sites/${encodeURIComponent(siteId)}/github/setup`,
      method: 'POST',
      signal,
    })
    if (!setup?.state || !setup?.expiresAt) throw new CliError('Goalmatic returned an invalid GitHub setup session')
    if (setup.mode === 'authorize') {
      const continuation = setup.authorizeUrl || setup.installUrl
      const url = trustedBrowserUrl(continuation, origin, { github: true })
      output.info(`Authorize GitHub: ${url}`)
      if (!await openBrowser(url)) output.warn('The browser did not open automatically. Open the URL above.')
    }
    const inventory = await pollRepositories({ origin, credential, project, state: setup.state, expiresAt: setup.expiresAt, signal })
    const repository = await selectRepository({ inventory, options, rl, origin, credential, project, state: setup.state, signal, output })
    const productionBranch = options['production-branch'] || repository.defaultBranch || 'main'
    const previewBranch = options['preview-branch'] || 'preview'
    const selectedCloneUrl = verifyGithubCloneUrl(repository.cloneUrl, repository.owner, repository.name)
    await preflightLocalRepository(project.directory, selectedCloneUrl)
    const result = await apiRequest({
      origin,
      token: credential.accessToken,
      accountId: project.config.accountId,
      path: `/api/sites/${encodeURIComponent(siteId)}/github/connect`,
      method: 'POST',
      body: {
        installationId: repository.installationId,
        owner: repository.owner,
        repo: repository.name,
        branch: previewBranch,
        productionBranch,
        previewBranch,
        setupState: setup.state,
        requireEmpty: true,
        syncMode: 'manual',
      },
      signal,
    })
    const cloneUrl = result?.binding?.cloneUrl || repository.cloneUrl
    if (!cloneUrl) throw new CliError('GitHub connection succeeded, but no clone URL was returned')
    const binding = {
      ...result?.binding,
      cloneUrl,
      owner: result?.binding?.owner || repository.owner,
      repo: result?.binding?.repo || repository.name,
      previewBranch: result?.binding?.previewBranch || previewBranch,
    }
    const local = await attachConnectedBinding({
      origin,
      credential,
      project,
      binding,
      signal,
    })
    output.info(`Connected ${repository.fullName}. Goalmatic migrated source authority to Git.`)
    output.info(`Local branch ${local.branch} now tracks the fetched commit ${local.commitSha.slice(0, 12)}.`)
    if (!local.clean) output.warn('The local checkout has uncommitted differences. Review and commit them before deploy or publish.')
    return { ...result, local }
  } finally {
    rl?.close()
  }
}

function validateBoundRepositoryChoice(binding, options) {
  if (options.owner && options.owner !== binding.owner) {
    throw new CliError(`This project is already bound to ${binding.owner}/${binding.repo}; refusing requested owner ${options.owner}.`, 2)
  }
  if (options.repo && options.repo !== binding.repo) {
    throw new CliError(`This project is already bound to ${binding.owner}/${binding.repo}; refusing requested repository ${options.repo}.`, 2)
  }
}

async function attachConnectedBinding({ origin, credential, project, binding, signal }) {
  if (!binding?.owner || !binding?.repo || !binding?.cloneUrl) {
    throw new CliError('The ready GitHub binding is missing repository identity')
  }
  const branches = await apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/github/branches`,
    signal,
  })
  const expectedPreview = binding.previewBranch || branches?.previewBranch
  const preview = branches?.branches?.find(branch => branch.name === expectedPreview || branch.role === 'preview')
  if (!preview?.headSha) throw new CliError('GitHub connection is ready, but the preview branch head is unavailable')
  return attachLocalRepository({
    directory: project.directory,
    cloneUrl: binding.cloneUrl,
    owner: binding.owner,
    repo: binding.repo,
    branch: preview.name,
    expectedCommitSha: preview.headSha,
  })
}

async function pollRepositories({ origin, credential, project, state, expiresAt, signal }) {
  const deadline = Date.parse(expiresAt)
  while (Date.now() < deadline) {
    try {
      return await apiRequest({
        origin,
        token: credential.accessToken,
        accountId: project.config.accountId,
        path: `/api/sites/${encodeURIComponent(project.config.projectId)}/github/repositories?state=${encodeURIComponent(state)}`,
        signal,
      })
    } catch (error) {
      if (![403, 409].includes(error?.status)) throw error
      await wait(SETUP_POLL_MS, signal)
    }
  }
  throw new CliError('GitHub authorization expired before setup completed')
}

async function selectRepository({ inventory, options, rl, origin, credential, project, state, signal, output }) {
  const repositories = Array.isArray(inventory?.repositories) ? inventory.repositories.filter(repo => repo.selectable) : []
  if (options.owner && options.repo) {
    const existing = repositories.find(repo => repo.owner === options.owner && repo.name === options.repo)
    if (existing) return existing
    if (!options.yes) throw new CliError('Creating a GitHub repository requires --yes with --owner and --repo, or interactive confirmation', 2)
    return createRepository({ inventory, owner: options.owner, name: options.repo, isPrivate: options.private !== false, origin, credential, project, state, signal, output })
  }
  if (options.owner || options.repo) throw new CliError('--owner and --repo must be supplied together', 2)
  if (!rl) throw new CliError('Use --owner and --repo for non-interactive GitHub setup', 2)
  const choices = [...repositories, { create: true, fullName: 'Create a new repository' }]
  const selected = await choose(rl, 'Choose a GitHub repository', choices, { format: item => item.fullName })
  if (!selected.create) return selected
  const owners = (inventory.owners || []).filter(owner => owner.canCreateRepositories)
  const owner = await choose(rl, 'Repository owner', owners, { format: item => `${item.login} (${item.type})` })
  const name = await promptText(rl, 'Repository name', inventory.suggestedRepositoryName)
  const summary = `${owner.login}/${name} as a private repository`
  if (!await confirm(rl, `Create ${summary}?`)) throw new CliError('Repository creation cancelled', 130)
  return createRepository({ inventory, owner: owner.login, name, isPrivate: true, origin, credential, project, state, signal, output })
}

async function createRepository({ inventory, owner, name, isPrivate, origin, credential, project, state, signal, output }) {
  const ownerOption = (inventory.owners || []).find(item => item.login === owner)
  if (!ownerOption?.canCreateRepositories) throw new CliError(`GitHub repository creation is unavailable for ${owner}`)
  output.info(`Creating ${owner}/${name} (${isPrivate ? 'private' : 'public'}) after exact selection.`)
  const result = await apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/github/repositories`,
    method: 'POST',
    body: {
      setupState: state,
      owner,
      name,
      description: inventory.suggestedRepositoryDescription || '',
      private: isPrivate,
    },
    signal,
  })
  if (!result?.repository) throw new CliError('GitHub returned an invalid repository result')
  return result.repository
}

export async function inspectLocalGit(directory) {
  const inside = await runGit(directory, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  const root = (await runGit(directory, ['rev-parse', '--show-toplevel'])).stdout.trim()
  if (await realpath(root) !== await realpath(directory)) return null
  const [branch, commit, status] = await Promise.all([
    runGit(directory, ['branch', '--show-current']),
    runGit(directory, ['rev-parse', 'HEAD']),
    runGit(directory, ['status', '--porcelain']),
  ])
  return { branch: branch.stdout.trim(), commitSha: commit.stdout.trim(), clean: status.stdout.trim() === '' }
}

async function attachLocalRepository({ directory, cloneUrl, owner, repo, branch, expectedCommitSha }) {
  const verifiedUrl = verifyGithubCloneUrl(cloneUrl, owner, repo)
  const localGit = await preflightLocalRepository(directory, verifiedUrl)
  if (!localGit) {
    await runGit(directory, ['init'])
    await runGit(directory, ['remote', 'add', 'origin', verifiedUrl])
  }
  await runGit(directory, ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`])
  const fetched = (await runGit(directory, ['rev-parse', `refs/remotes/origin/${branch}`])).stdout.trim()
  if (fetched !== expectedCommitSha) throw new CliError('Fetched GitHub commit does not match the branch verified by Goalmatic')
  const hasCommit = localGit && (await runGit(directory, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code === 0
  if (hasCommit) {
    const existing = await inspectLocalGit(directory)
    if (!existing || existing.branch !== branch || existing.commitSha !== fetched) {
      throw new CliError(`GitHub is connected. Your existing checkout was preserved; switch to ${branch} and reconcile it with origin/${branch}.`)
    }
    return { ...existing, remote: verifiedUrl }
  }
  if (localGit && (await runGit(directory, ['ls-files', '--stage'])).stdout.trim()) {
    throw new CliError('The existing repository has staged files. Commit or preserve that work before attaching remote history.')
  }
  await materializeMissingGitFiles(directory, fetched)
  await runGit(directory, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  await runGit(directory, ['reset', '--mixed', `refs/remotes/origin/${branch}`])
  await runGit(directory, ['branch', '--set-upstream-to', `origin/${branch}`, branch])
  const status = await runGit(directory, ['status', '--porcelain'])
  return { branch, commitSha: fetched, clean: status.stdout.trim() === '', remote: verifiedUrl }
}

async function preflightLocalRepository(directory, verifiedUrl) {
  const localGit = await lstat(join(directory, '.git')).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!localGit) return null
  if (localGit.isSymbolicLink()) throw new CliError('Refusing a symbolic link for the project Git directory')
  const root = (await runGit(directory, ['rev-parse', '--show-toplevel'])).stdout.trim()
  if (await realpath(root) !== await realpath(directory)) throw new CliError('Existing Git repository root does not match this project directory')
  const remote = await runGit(directory, ['remote', 'get-url', 'origin'], { allowFailure: true })
  if (remote.code !== 0 || normalizeCloneIdentity(remote.stdout.trim()) !== normalizeCloneIdentity(verifiedUrl)) {
    throw new CliError('Existing origin remote does not match the selected GitHub repository')
  }
  return localGit
}

async function materializeMissingGitFiles(directory, commitSha) {
  const tree = await runGitBuffer(directory, ['ls-tree', '-rz', '--full-tree', commitSha])
  const planned = []
  for (const entry of parseGitTree(tree.stdout)) {
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new CliError(`Refusing non-regular Git tree entry: ${entry.path}`)
    }
    const destination = await safeProjectPath(directory, entry.path)
    const existing = await lstat(destination).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (existing) {
      if (!existing.isFile()) throw new CliError(`Expected a regular project file: ${entry.path}`)
      continue
    }
    planned.push({ ...entry, destination })
  }
  for (const entry of planned) {
    const blob = await runGitBuffer(directory, ['cat-file', 'blob', entry.object])
    await mkdir(dirname(entry.destination), { recursive: true })
    await writeFile(entry.destination, blob.stdout, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 })
    if (entry.mode === '100755') await chmod(entry.destination, 0o755)
  }
}

function parseGitTree(buffer) {
  const entries = []
  let start = 0
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index !== buffer.length && buffer[index] !== 0) continue
    if (index === start) break
    const record = buffer.subarray(start, index)
    const tab = record.indexOf(9)
    if (tab === -1) throw new CliError('Git returned an invalid tree entry')
    const metadata = record.subarray(0, tab).toString('ascii').split(' ')
    if (metadata.length !== 3 || !/^[0-9a-f]{40,64}$/i.test(metadata[2])) throw new CliError('Git returned invalid tree metadata')
    let path
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(tab + 1)) } catch {
      throw new CliError('Git tree contains a path that is not valid UTF-8')
    }
    entries.push({ mode: metadata[0], type: metadata[1], object: metadata[2], path })
    start = index + 1
  }
  return entries
}

function verifyGithubCloneUrl(value, owner, repo) {
  let url
  try { url = new URL(value) } catch { throw new CliError('GitHub returned an invalid clone URL') }
  const expectedPath = `/${owner}/${repo}.git`.toLowerCase()
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.pathname.toLowerCase() !== expectedPath) {
    throw new CliError('GitHub returned a clone URL outside the selected repository')
  }
  return url.toString()
}

function normalizeCloneIdentity(value) {
  try {
    const url = new URL(value)
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/i, '').toLowerCase()}`
  } catch {
    return value.trim().replace(/\.git$/i, '').toLowerCase()
  }
}

export async function requirePinnedGit(project, remoteStatus) {
  const local = await inspectLocalGit(project.directory)
  if (!local) throw new CliError('This Git-backed project must be run from its cloned repository. Use the clone URL shown by `goalmatic git status`.')
  if (!local.clean) throw new CliError('Commit or stash local changes before deploying or publishing')
  const binding = remoteStatus?.binding
  if (!binding || binding.sourceAuthority !== 'git') throw new CliError('Git source authority is not ready')
  const expectedBranch = binding.activeBranch || binding.previewBranch || binding.branch
  if (local.branch !== expectedBranch) throw new CliError(`Switch to the pinned ${expectedBranch} branch before continuing`)
  if (!remoteStatus.githubHeadSha || local.commitSha !== remoteStatus.githubHeadSha) {
    throw new CliError('Local HEAD does not match the commit currently visible to Goalmatic. Push, then retry after source status updates.')
  }
  if (remoteStatus.syncState !== 'up-to-date') throw new CliError(`Git source is ${remoteStatus.syncState}; wait for an up-to-date import before continuing`)
  return { ...local, binding }
}

export async function requirePinnedBranch(project, branch) {
  const local = await inspectLocalGit(project.directory)
  if (!local) throw new CliError('This Git-backed project must be run from its cloned repository.')
  if (!local.clean) throw new CliError('Commit or stash local changes before deploying or publishing')
  if (!branch?.name || !branch?.headSha) throw new CliError('Goalmatic could not resolve the required Git branch head')
  if (local.branch !== branch.name) throw new CliError(`Switch to the pinned ${branch.name} branch before continuing`)
  if (local.commitSha !== branch.headSha) throw new CliError(`Local HEAD does not match ${branch.name} on GitHub. Push or pull, then retry.`)
  return local
}

function runGit(directory, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => reject(new CliError(`Could not run git: ${error.message}`)))
    child.once('exit', code => {
      if (code === 0 || allowFailure) resolve({ code, stdout, stderr })
      else reject(new CliError(stderr.trim() || `git ${args[0]} failed`))
    })
  })
}

function runGitBuffer(directory, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', chunk => { stdout.push(chunk) })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => reject(new CliError(`Could not run git: ${error.message}`)))
    child.once('exit', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout) })
      else reject(new CliError(stderr.trim() || `git ${args[0]} failed`))
    })
  })
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CliError('GitHub setup cancelled', 130))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
