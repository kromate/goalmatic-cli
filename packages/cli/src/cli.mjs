import { apiRequest } from './api.mjs'
import { authenticatedContext, loadCredential, login, logout } from './auth.mjs'
import { HELP, VERSION } from './constants.mjs'
import { CliError } from './errors.mjs'
import { requireProjectConfig } from './fs-state.mjs'
import { connectGithub, githubStatus } from './git.mjs'
import { parseOptions } from './options.mjs'
import { createOutput } from './output.mjs'
import { createProjectFlow, linkProjectFlow, listProjects, selectAccount } from './project.mjs'
import { confirmDefaultYes, promptSession } from './prompts.mjs'
import { deployPreview, projectStatus, publishProject, runDev } from './release.mjs'
import { normalizeApiOrigin } from './url.mjs'

export async function main(argv = [], runtime = {}) {
  const { positional, options } = parseOptions(argv)
  const output = runtime.output || createOutput({ json: options.json })
  if (options.version || positional[0] === 'version') return output.result(options.json ? { version: VERSION } : VERSION)
  if (options.help || !positional.length || positional[0] === 'help') return output.result(options.json ? { help: HELP } : HELP)

  const command = positional[0]
  const abortController = new AbortController()
  const onInterrupt = () => abortController.abort()
  process.once('SIGINT', onInterrupt)
  try {
    if (command === 'login') {
      const origin = normalizeApiOrigin(options['api-url'])
      const result = await login({ origin, output, signal: abortController.signal })
      return output.result(options.json ? publicLogin(result) : `Signed in as ${result.user?.email || result.user?.id || 'Goalmatic user'}.`)
    }
    if (command === 'logout') {
      const origin = normalizeApiOrigin(options['api-url'])
      const result = await logout({ origin, output, signal: abortController.signal })
      const message = !result.hadCredential
        ? 'No saved Goalmatic credential was present.'
        : result.remoteRevoked
        ? 'Signed out locally and revoked the remote credential.'
        : 'Signed out locally. The remote credential could not be revoked and may remain active until it expires.'
      return output.result(options.json ? result : message)
    }
    if (command === 'whoami' || command === 'accounts') {
      const origin = normalizeApiOrigin(options['api-url'])
      const { me } = await authenticatedContext(origin, { signal: abortController.signal })
      if (command === 'whoami') return output.result(options.json ? me : formatUser(me))
      return output.result(options.json ? { accounts: me.accounts || [], defaultAccountId: me.defaultAccountId || null } : formatAccounts(me))
    }
    if (command === 'projects') {
      const origin = normalizeApiOrigin(options['api-url'])
      const { credential, me } = await authenticatedContext(origin, { signal: abortController.signal })
      const rl = promptSession()
      try {
        const account = await selectAccount(me, options.account, rl)
        const projects = await listProjects({ origin, token: credential.accessToken, accountId: account.id, signal: abortController.signal })
        return output.result(options.json ? { account, projects } : formatProjects(account, projects))
      } finally { rl?.close() }
    }
    if (command === 'create') {
      const origin = normalizeApiOrigin(options['api-url'])
      const result = await createProjectFlow({ origin, options, directoryArg: positional[1], output, signal: abortController.signal })
      const connected = await maybeConnectAfterCreate({ origin, result, options, output, signal: abortController.signal })
      const finalResult = connected ? { ...result, github: connected } : result
      if (options.json) output.result(finalResult)
      return finalResult
    }
    if (command === 'link') {
      const projectId = positional[1] || options.project
      if (!projectId) throw new CliError('Usage: goalmatic link <project-id> [directory]', 2)
      const origin = normalizeApiOrigin(options['api-url'])
      const result = await linkProjectFlow({ origin, options, projectId, directoryArg: positional[2], output, signal: abortController.signal })
      const connected = await maybeConnectAfterCreate({ origin, result, options, output, signal: abortController.signal })
      const finalResult = connected ? { ...result, github: connected } : result
      if (options.json) output.result(finalResult)
      return finalResult
    }

    const project = await requireProjectConfig(undefined, { remote: command !== 'dev' })
    const origin = normalizeApiOrigin(options['api-url'] || project.config.apiOrigin)
    if (command === 'git') {
      const action = positional[1]
      if (action === 'connect') {
        const result = await connectGithub({ origin, project, options, output, signal: abortController.signal })
        if (options.json) output.result(result)
        return result
      }
      if (action === 'status') {
        const result = await githubStatus({ origin, project, signal: abortController.signal })
        return output.result(options.json ? result : formatGitStatus(result))
      }
      throw new CliError('Usage: goalmatic git <connect|status>', 2)
    }
    if (command === 'status') {
      const result = await projectStatus({ origin, project, signal: abortController.signal })
      return output.result(options.json ? result : formatStatus(result))
    }
    if (command === 'dev') {
      if (options.json) throw new CliError('--json is not available for the interactive dev command', 2)
      const code = await runDev(project)
      if (code) throw new CliError(`npm run dev exited with status ${code}`, code)
      return
    }
    if (command === 'deploy') {
      const result = await deployPreview({ origin, project, options, signal: abortController.signal })
      if ((result.deployment || result)?.status === 'failed') throw new CliError('Preview deployment failed. Run goalmatic status --json for details.')
      if (project.config.type === 'app') {
        return output.result(options.json ? result : `Private test build ${result.buildId || result.id || ''} is ${result.status || 'created'}.`)
      }
      return output.result(options.json ? result : formatDeployment(result.deployment || result))
    }
    if (command === 'publish') {
      const result = await publishProject({ origin, project, options, signal: abortController.signal })
      if ((result.deployment || result)?.status === 'failed') throw new CliError('Publication failed. Run goalmatic status --json for details.')
      if (project.config.type === 'app') {
        const status = result.status || result.orchestrationStatus || 'submitted'
        return output.result(options.json ? result : `App release ${result.releaseId || ''} was submitted. Current status: ${status}.`)
      }
      return output.result(options.json ? result : formatPublication(result))
    }
    throw new CliError(`Unknown command: ${command}. Run goalmatic --help.`, 2)
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}

async function maybeConnectAfterCreate({ origin, result, options, output, signal }) {
  if (result.local) return null
  const project = await requireProjectConfig(result.directory)
  try {
    const existing = await githubStatus({ origin, project, signal })
    if (existing.connected) {
      output.info('GitHub source authority is already connected.')
      return existing
    }
  } catch (error) {
    if (error?.status !== 404) throw error
  }
  let shouldConnect = false
  if (options.yes) {
    shouldConnect = Boolean(options.owner && options.repo)
    if (!shouldConnect) output.warn('Skipped GitHub setup: --yes requires explicit --owner and --repo.')
  } else {
    const rl = promptSession()
    try {
      shouldConnect = await confirmDefaultYes(rl, 'Connect this project to GitHub now? (recommended)')
    } finally { rl?.close() }
    if (!rl) output.warn('Skipped GitHub setup in a non-interactive terminal. Run `goalmatic git connect`.')
  }
  return shouldConnect ? connectGithub({ origin, project, options, output, signal }) : null
}

export async function runCreate(argv = []) {
  return main(['create', ...argv])
}

function publicLogin(result) {
  return { user: result.user, accounts: result.accounts, defaultAccountId: result.defaultAccountId, expiresAt: result.expiresAt, apiOrigin: result.apiOrigin }
}

function formatUser(me) {
  const user = me.user || me
  return `${user.email || user.id}\nAccounts: ${(me.accounts || []).length}`
}

function formatAccounts(me) {
  return (me.accounts || []).map(account => `${account.id === me.defaultAccountId ? '*' : ' '} ${account.name} (${account.id})`).join('\n') || 'No accounts.'
}

function formatProjects(account, projects) {
  if (!projects.length) return `No projects in ${account.name}.`
  return projects.map(project => `${project.name} (${project.type}, ${project.id})`).join('\n')
}

function formatGitStatus(status) {
  if (!status.connected) return `GitHub is not connected.${status.appInstallUrl ? `\nSetup: ${status.appInstallUrl}` : ''}`
  const binding = status.binding || {}
  return [
    `Repository: ${binding.owner}/${binding.repo}`,
    `Authority: ${binding.sourceAuthority || 'unknown'}`,
    `Branch: ${binding.activeBranch || binding.branch || 'unknown'}`,
    `Sync: ${status.syncState}`,
    `Commit: ${status.githubHeadSha || 'unavailable'}`,
    binding.cloneUrl ? `Clone: ${binding.cloneUrl}` : null,
    binding.lastError ? `Error: ${binding.lastError}` : null,
  ].filter(Boolean).join('\n')
}

function formatStatus(status) {
  const project = status.project || {}
  const lines = [
    `Project: ${project.name || project.id || 'unknown'} (${project.type || 'unknown'})`,
    `Source version: ${status.sourceVersionId || 'none'}`,
  ]
  if (status.git) lines.push(`Git: ${status.git.connected ? status.git.syncState : 'not connected'}`)
  if (status.deployment) lines.push(`Deployment: ${status.deployment.status || 'unknown'}${status.deployment.url ? ` ${status.deployment.url}` : ''}`)
  return lines.join('\n')
}

function formatDeployment(deployment) {
  return `Preview deployment ${deployment.id || ''}: ${deployment.status || 'created'}${deployment.url ? `\n${deployment.url}` : ''}`
}

function formatPublication(result) {
  const deployment = result.deployment || {}
  if (deployment.status === 'ready') {
    return `Production deployment ${deployment.id || ''} is ready${deployment.url ? `\n${deployment.url}` : ''}`
  }
  if (deployment.status === 'failed') return `Production deployment ${deployment.id || ''} failed: ${deployment.error || 'unknown error'}`
  return `Publication request accepted. Deployment ${deployment.id || ''} is ${deployment.status || 'pending'}; verify status before treating it as live.`
}
