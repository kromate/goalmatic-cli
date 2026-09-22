import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apiRequest } from './api.mjs'
import { loadCredential } from './auth.mjs'
import { CliError } from './errors.mjs'
import { githubBranches, githubStatus, requirePinnedBranch, requirePinnedGit } from './git.mjs'

export async function projectStatus({ origin, project, signal }) {
  const credential = await loadCredential(origin)
  const metadata = await apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/cli/v1/projects/${encodeURIComponent(project.config.projectId)}`,
    signal,
  })
  let git = null
  try { git = await githubStatus({ origin, project, signal }) } catch (error) {
    if (error?.status !== 404) throw error
  }
  const app = project.config.type === 'app'
    ? await apiRequest({ origin, token: credential.accessToken, accountId: project.config.accountId, path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/releases`, signal })
    : null
  return { project: metadata.project || metadata, sourceVersionId: metadata.sourceVersionId || null, deployment: metadata.deployment || null, git, ...(app ? { app } : {}) }
}

export async function deployPreview({ origin, project, options, signal }) {
  if (!options.preview) throw new CliError('The deploy command currently requires --preview', 2)
  if (project.config.type === 'app') return createAppTestBuild({ origin, project, signal })
  const credential = await loadCredential(origin)
  const status = await githubStatus({ origin, project, signal })
  let versionId = options['version-id'] || null
  if (status?.binding?.sourceAuthority === 'git') {
    const pinned = await requirePinnedGit(project, status)
    versionId = versionId || pinned.binding.lastSyncedVersionId
    if (!versionId) throw new CliError('The pinned Git commit has no imported source version yet')
  }
  return apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/deployments`,
    method: 'POST',
    body: { environment: 'preview', versionId },
    signal,
  })
}

export async function publishProject({ origin, project, options, signal }) {
  const credential = await loadCredential(origin)
  const status = await githubStatus({ origin, project, signal })
  const usesGit = status?.binding?.sourceAuthority === 'git'
  if (project.config.type === 'site') {
    const pinned = usesGit ? await requirePinnedGit(project, status) : null
    const published = await apiRequest({
      origin,
      token: credential.accessToken,
      accountId: project.config.accountId,
      path: `/api/sites/${encodeURIComponent(project.config.projectId)}/publish`,
      method: 'POST',
      body: pinned
        ? { expectedPreviewCommitSha: pinned.commitSha }
        : { versionId: options['version-id'] || null },
      signal,
    })
    const deployment = published?.deployment
    if (!deployment?.id || deployment.status !== 'running') return published
    const terminal = await waitForDeployment({ origin, credential, project, deployment, signal })
    return { ...published, deployment: terminal }
  }
  let productionCommitSha = null
  if (usesGit) {
    const branches = await githubBranches({ origin, project, signal })
    const production = branches.branches?.find(branch => branch.role === 'production' || branch.name === branches.productionBranch)
    const pinned = await requirePinnedBranch(project, production)
    productionCommitSha = pinned.commitSha
  }
  const manifest = await readManifest(project.directory)
  const body = {
    manifest,
    ...(options['version-id'] ? { versionId: options['version-id'] } : {}),
    ...(options['test-build-id'] ? { testBuildId: options['test-build-id'] } : {}),
    ...(productionCommitSha ? { expectedMainCommitSha: productionCommitSha } : {}),
  }
  return apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/publish`,
    method: 'POST',
    body,
    signal,
  })
}

export async function createAppTestBuild({ origin, project, signal }) {
  if (project.config.type !== 'app') throw new CliError('Private test builds are available only for Apps', 2)
  const credential = await loadCredential(origin)
  const status = await githubStatus({ origin, project, signal })
  const pinned = status?.binding?.sourceAuthority === 'git' ? await requirePinnedGit(project, status) : null
  return apiRequest({
    origin,
    token: credential.accessToken,
    accountId: project.config.accountId,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/builds`,
    method: 'POST',
    body: { manifest: await readManifest(project.directory), ...(pinned ? { expectedPreviewCommitSha: pinned.commitSha } : {}) },
    signal,
  })
}

export function runDev(project) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(command, ['run', 'dev'], { cwd: project.directory, stdio: 'inherit' })
    child.once('error', error => reject(new CliError(`Could not start npm run dev: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (signal) reject(new CliError(`Development server stopped by ${signal}`, 130))
      else resolve(code || 0)
    })
  })
}

async function readManifest(directory) {
  try { return JSON.parse(await readFile(join(directory, '.goalmatic/app.json'), 'utf8')) }
  catch (error) {
    if (error instanceof SyntaxError) throw new CliError('Invalid JSON in .goalmatic/app.json')
    throw new CliError('App manifest not found at .goalmatic/app.json')
  }
}

async function waitForDeployment({ origin, credential, project, deployment, signal }) {
  const deadline = Date.now() + 90_000
  let current = deployment
  while (current.status === 'running' && Date.now() < deadline) {
    await delay(2_000, signal)
    const result = await apiRequest({
      origin,
      token: credential.accessToken,
      accountId: project.config.accountId,
      path: `/api/sites/${encodeURIComponent(project.config.projectId)}/deployments/${encodeURIComponent(deployment.id)}`,
      signal,
    })
    current = result?.deployment || result
  }
  return current
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CliError('Deployment wait cancelled', 130))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
