import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { apiRequest } from './api.mjs'
import { loadCredential } from './auth.mjs'
import { CliError } from './errors.mjs'
import { githubBranches, githubStatus, inspectLocalGit, requirePinnedBranch, requirePinnedGit } from './git.mjs'
import { confirm, promptSession } from './prompts.mjs'

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

export async function publishProject({ origin, project, options, output, signal }) {
  validatePublicationOptions(project, options)
  const credential = await loadCredential(origin)
  if (project.config.type === 'app' && options['from-preview']) {
    return publishTestedPreview({ origin, credential, project, options, output, signal })
  }
  if (project.config.type === 'app' && options['release-id']) {
    return publishApprovedRelease({ origin, credential, project, options, output, signal })
  }
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

function validatePublicationOptions(project, options) {
  const fromPreview = Boolean(options['from-preview'])
  const releaseId = options['release-id']
  const dryRun = Boolean(options['dry-run'])
  if (project.config.type !== 'app' && (fromPreview || releaseId || dryRun)) {
    throw new CliError('--from-preview, --release-id, and --dry-run are available only for App publication', 2)
  }
  if (fromPreview && releaseId) throw new CliError('--from-preview and --release-id cannot be combined', 2)
  if (releaseId && options['test-build-id']) throw new CliError('--release-id and --test-build-id cannot be combined', 2)
  if ((fromPreview || releaseId) && options['version-id']) throw new CliError('--version-id cannot be combined with --from-preview or --release-id', 2)
  if (dryRun && !fromPreview && !releaseId) throw new CliError('--dry-run requires --from-preview or --release-id', 2)
}

async function publishTestedPreview({ origin, credential, project, options, output, signal }) {
  const [status, testing, branches] = await Promise.all([
    githubStatus({ origin, project, signal }),
    apiRequest({ origin, token: credential.accessToken, accountId: project.config.accountId, path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/testing`, signal }),
    githubBranches({ origin, project, signal }),
  ])
  const binding = status?.binding
  if (!status?.connected || binding?.sourceAuthority !== 'git' || binding?.migration?.status !== 'ready') {
    throw new CliError('Preview promotion requires ready Git source authority')
  }
  const currentBuildId = String(testing?.track?.currentBuildId || '')
  const testBuildId = String(options['test-build-id'] || currentBuildId)
  if (!testBuildId) throw new CliError('No current private test build is available')
  if (testBuildId !== currentBuildId) throw new CliError('The selected test build is not the current private test build')
  const builds = Array.isArray(testing?.builds) ? testing.builds : []
  const build = builds.find(item => String(item?.buildId || item?.id || '') === testBuildId)
  if (!build || build.status !== 'ready') throw new CliError('Choose a ready current private test build before publishing')
  const source = build.source
  const previewBranch = binding.previewBranch || branches?.previewBranch
  if (source?.kind !== 'git' || source.siteId !== project.config.projectId
    || String(source.owner || '').toLowerCase() !== String(binding.owner || '').toLowerCase()
    || String(source.repository || '').toLowerCase() !== String(binding.repo || '').toLowerCase()
    || source.branch !== previewBranch || !/^[a-f0-9]{40}$/i.test(String(source.commitSha || ''))) {
    throw new CliError('The current test build does not match this project repository and configured preview branch')
  }
  const productionBranch = binding.productionBranch || branches?.productionBranch
  const preview = branches?.branches?.find(branch => branch.name === previewBranch)
  const production = branches?.branches?.find(branch => branch.name === productionBranch)
  if (!preview?.headSha || !production?.headSha) throw new CliError('Goalmatic could not resolve the preview and production branch heads')
  if (preview.name !== previewBranch || production.name !== productionBranch) throw new CliError('GitHub returned branches that do not match the configured App authority')
  if (preview.headSha !== source.commitSha) throw new CliError('The remote preview branch changed after this test build was created')
  const local = await inspectLocalGit(project.directory)
  if (!local || !local.clean || local.branch !== previewBranch || local.commitSha !== source.commitSha) {
    throw new CliError(`Use a clean local ${previewBranch} checkout at the exact tested commit before publishing`)
  }
  const plan = {
    mode: 'tested-preview',
    accountId: project.config.accountId,
    projectId: project.config.projectId,
    repository: `${binding.owner}/${binding.repo}`,
    from: { branch: previewBranch, commitSha: source.commitSha },
    to: { branch: production.name, headSha: production.headSha, testedBaselineSha: build.baseProductionCommitSha || null },
    build: { id: testBuildId, status: build.status, version: build.manifest?.version || null, sourceVersionId: build.sourceVersionId || null },
    artifact: { id: build.artifactId || null, digest: build.artifact?.digest || null },
  }
  if (options['dry-run']) return planOnly(plan)
  await approvePlan({ plan, options, output })
  const result = await publicationWrite({
    origin,
    credential,
    project,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/promote-tested`,
    body: { testBuildId },
    signal,
  })
  return { mode: 'tested-preview', plan, ...result }
}

async function publishApprovedRelease({ origin, credential, project, options, output, signal }) {
  const releaseId = String(options['release-id'])
  const release = await findRelease({ origin, credential, project, releaseId, signal })
  if (!release) throw new CliError(`Release not found: ${releaseId}`, 2)
  if (release.siteId !== project.config.projectId) throw new CliError('The selected release belongs to another project')
  if (!['approved', 'published'].includes(release.status)) {
    throw new CliError(`Release ${releaseId} is ${release.status}; only approved or published releases can be promoted`)
  }
  const plan = {
    mode: 'approved-release',
    accountId: project.config.accountId,
    projectId: project.config.projectId,
    release: {
      id: release.releaseId,
      version: release.version,
      status: release.status,
      buildId: release.buildId || null,
      sourceVersionId: release.sourceVersionId,
      sourceHash: release.sourceHash,
    },
  }
  if (options['dry-run']) return planOnly(plan)
  await approvePlan({ plan, options, output })
  const result = await publicationWrite({
    origin,
    credential,
    project,
    path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/promote`,
    body: { releaseId },
    signal,
  })
  return {
    mode: 'approved-release',
    plan,
    ...result,
    releaseId: result?.releaseId || releaseId,
    releaseStatus: result?.status || release.status,
  }
}

async function findRelease({ origin, credential, project, releaseId, signal }) {
  let cursor = ''
  const seenCursors = new Set()
  do {
    if (cursor && seenCursors.has(cursor)) throw new CliError('Release history returned a repeated pagination cursor')
    if (cursor) seenCursors.add(cursor)
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const response = await apiRequest({
      origin,
      token: credential.accessToken,
      accountId: project.config.accountId,
      path: `/api/sites/${encodeURIComponent(project.config.projectId)}/app/releases${query}`,
      signal,
    })
    const history = response?.history
    const candidates = [history?.currentRelease, history?.stableRelease, history?.pendingRelease, ...(Array.isArray(history?.releases) ? history.releases : [])].filter(Boolean)
    const found = candidates.find(release => release.releaseId === releaseId)
    if (found) return found
    cursor = typeof history?.nextCursor === 'string' ? history.nextCursor : ''
  } while (cursor)
  return null
}

function planOnly(plan) {
  return {
    dryRun: true,
    plan,
    planText: formatPlan(plan),
    note: 'Plan only. The server validates the private runtime, exact source tree, and production baseline during submission.',
  }
}

async function approvePlan({ plan, options, output }) {
  output?.info(formatPlan(plan))
  if (options.yes) return
  if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError('Publication requires --yes in a non-interactive or JSON command', 2)
  }
  const rl = promptSession()
  try {
    if (!await confirm(rl, 'Proceed with this App publication plan?')) throw new CliError('Publication cancelled', 130)
  } finally { rl?.close() }
}

function formatPlan(plan) {
  if (plan.mode === 'tested-preview') {
    return [
      'App publication plan:',
      `  Project: ${plan.projectId} (${plan.accountId})`,
      `  Repository: ${plan.repository}`,
      `  Tested source: ${plan.from.branch}@${plan.from.commitSha}`,
      `  Production target: ${plan.to.branch}@${plan.to.headSha}`,
      `  Tested baseline: ${plan.to.testedBaselineSha || 'unavailable; server will validate'}`,
      `  Build: ${plan.build.id} (${plan.build.status}, version ${plan.build.version || 'unknown'})`,
      `  Artifact: ${plan.artifact.id || 'unknown'} / ${plan.artifact.digest || 'unknown'}`,
    ].join('\n')
  }
  return [
    'Approved App release publication plan:',
    `  Project: ${plan.projectId} (${plan.accountId})`,
    `  Release: ${plan.release.id} (${plan.release.version}, ${plan.release.status})`,
    `  Build: ${plan.release.buildId || 'unknown'}`,
    `  Source version: ${plan.release.sourceVersionId}`,
  ].join('\n')
}

async function publicationWrite({ origin, credential, project, path, body, signal }) {
  try {
    return await apiRequest({ origin, token: credential.accessToken, accountId: project.config.accountId, path, method: 'POST', body, signal })
  } catch (error) {
    const wrapped = new CliError(
      `${error.message}. The publication request was dispatched; run goalmatic status --json before deciding whether to retry.`,
      Number.isInteger(error?.exitCode) ? error.exitCode : 1,
    )
    if (error?.status) wrapped.status = error.status
    throw wrapped
  }
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
