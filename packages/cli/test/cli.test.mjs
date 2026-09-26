import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadCredential } from '../src/auth.mjs'
import { selectAccount } from '../src/project.mjs'
import { scaffoldProject } from '../src/scaffold.mjs'
import { safeProjectPath } from '../src/source-files.mjs'

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageDirectory, 'bin/goalmatic.mjs')

test('direct stable scaffold creates an offline Site with a lockfile and ignored local receipts', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'todo-site')
  const result = await scaffoldProject({ directory, name: 'todo-site', type: 'site' })

  assert.equal(result.directory, directory)
  assert.equal(JSON.parse(await readFile(join(directory, 'goalmatic.json'), 'utf8')).type, 'site')
  assert.equal(JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')).lockfileVersion, 3)
  assert.match(await readFile(join(directory, '.gitignore'), 'utf8'), /^\.goalmatic\/local\/$/m)
  await assert.rejects(readFile(join(directory, '.goalmatic/app.json')), { code: 'ENOENT' })
})

test('safe project files reject traversal, secrets, Git internals, and symbolic-link parents', async () => {
  const root = await tempDirectory()
  await mkdir(join(root, 'real'))
  await symlink(join(root, 'real'), join(root, 'linked'))

  for (const path of ['../escape.txt', '.git/config', '.env', 'node_modules/x.js', '.goalmatic/local/setup.json']) {
    await assert.rejects(safeProjectPath(root, path), /Unsafe project source path/)
  }
  await assert.rejects(safeProjectPath(root, 'linked/file.txt'), /symbolic link/)
  assert.equal(await safeProjectPath(root, '.env.example'), join(root, '.env.example'))
})

test('environment token is bound to GOALMATIC_API_URL', { concurrency: false }, async () => {
  const previous = pickEnvironment(['GOALMATIC_TOKEN', 'GOALMATIC_API_URL'])
  process.env.GOALMATIC_TOKEN = 'gmc_simulated'
  process.env.GOALMATIC_API_URL = 'http://127.0.0.1:41001'
  try {
    const credential = await loadCredential('http://127.0.0.1:41001')
    assert.equal(credential.accessToken, 'gmc_simulated')
    await assert.rejects(loadCredential('http://127.0.0.1:41002'), /belongs to GOALMATIC_API_URL/)
  } finally {
    restoreEnvironment(previous)
  }
})

test('requested duplicate account names require an account ID', async () => {
  const me = {
    accounts: [
      { id: 'acct_one', name: 'Shared' },
      { id: 'acct_two', name: 'Shared' },
    ],
  }
  await assert.rejects(selectAccount(me, 'Shared', null), /ambiguous.*account ID/i)
  assert.equal((await selectAccount(me, 'acct_two', null)).id, 'acct_two')
})

test('simulated protocol create retries one interrupted POST with the same receipt and idempotency key', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'retry-site')
  const requests = []
  let createAttempts = 0
  let submittedFiles
  await withFakeApi(async ({ request, response, body }) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers, body })
    if (request.url === '/api/cli/v1/me') return json(response, 200, singleAccount())
    if (request.url === '/api/cli/v1/projects' && request.method === 'POST') {
      createAttempts += 1
      submittedFiles = body.files
      if (createAttempts === 1) return request.socket.destroy()
      return json(response, 200, createdProject(body, request.headers.host, submittedFiles))
    }
    if (request.url === '/api/sites/site_retry/github/status') return json(response, 200, { connected: false })
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const args = ['create', directory, '--type', 'site', '--name', 'retry-site', '--yes', '--api-url', origin]
    const first = await runCli(args, origin)
    assert.notEqual(first.code, 0)
    const pending = JSON.parse(await readFile(join(directory, '.goalmatic/local/setup.json'), 'utf8'))
    assert.equal(pending.status, 'pending')

    const second = await runCli(args, origin)
    assert.equal(second.code, 0, second.stderr)
    const complete = JSON.parse(await readFile(join(directory, '.goalmatic/local/setup.json'), 'utf8'))
    assert.equal(complete.status, 'complete')
    assert.equal(JSON.parse(await readFile(join(directory, 'goalmatic.json'), 'utf8')).projectId, 'site_retry')
  })

  const posts = requests.filter(item => item.method === 'POST' && item.url === '/api/cli/v1/projects')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key'])
  assert.equal(posts[1].headers.authorization, 'Bearer gmc_simulated')
  assert.equal(posts[1].headers['x-goalmatic-account-id'], 'acct_one')
  assert.deepEqual(posts[0].body.files, posts[1].body.files)
})

test('simulated create does not accept connected Git status without ready authority and local checkout', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'resume-git')
  let setupRequests = 0
  await withFakeApi(async ({ request, response, body }) => {
    if (request.url === '/api/cli/v1/me') return json(response, 200, singleAccount())
    if (request.url === '/api/cli/v1/projects' && request.method === 'POST') {
      return json(response, 200, {
        ...createdProject(body, request.headers.host, body.files),
        project: { id: 'site_resume', name: body.name, type: body.type, accountId: body.accountId },
        files: body.files.map(file => file.path === 'goalmatic.json'
          ? { ...file, content: `${JSON.stringify({ ...JSON.parse(file.content), accountId: 'acct_one', projectId: 'site_resume', apiOrigin: `http://${request.headers.host}` }, null, 2)}\n` }
          : file),
      })
    }
    if (request.url === '/api/sites/site_resume/github/status') {
      return json(response, 200, {
        connected: true,
        githubHeadSha: 'a'.repeat(40),
        binding: { owner: 'example', repo: 'selected', sourceAuthority: 'site-builder', migration: { status: 'legacy' } },
      })
    }
    if (request.url === '/api/sites/site_resume/github/setup') {
      setupRequests += 1
      return json(response, 503, { message: 'simulated retry reached GitHub setup' })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['create', directory, '--type', 'site', '--name', 'resume-git', '--yes', '--api-url', origin], origin)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /simulated retry reached GitHub setup/)
  })
  assert.equal(setupRequests, 1)
})

test('simulated protocol refuses an ambiguous account in a non-interactive create', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'ambiguous')
  let projectPostCount = 0
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/cli/v1/me') {
      return json(response, 200, {
        user: { id: 'user_1', email: 'user@example.test' },
        accounts: [{ id: 'acct_one', name: 'One' }, { id: 'acct_two', name: 'Two' }],
        defaultAccountId: 'acct_one',
      })
    }
    if (request.url === '/api/cli/v1/projects' && request.method === 'POST') projectPostCount += 1
    return json(response, 500, { message: 'unexpected simulated request' })
  }, async origin => {
    const result = await runCli(['create', directory, '--type', 'site', '--name', 'ambiguous', '--yes', '--api-url', origin], origin)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Choose an account requires an explicit option/)
  })
  assert.equal(projectPostCount, 0)
})

test('simulated protocol link refuses traversal without writing outside the destination', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'linked-project')
  const escaped = join(root, 'escaped.txt')
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/cli/v1/me') return json(response, 200, singleAccount())
    if (request.url?.startsWith('/api/cli/v1/projects?')) {
      return json(response, 200, { projects: [{ id: 'site_link', name: 'linked-project', type: 'site' }] })
    }
    if (request.url === '/api/sites/site_link/source') {
      return json(response, 200, { latestVersionId: 'version_1', files: [{ path: '../escaped.txt', content: 'unsafe' }] })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['link', 'site_link', directory, '--yes', '--api-url', origin], origin)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Unsafe project source path/)
  })
  await assert.rejects(readFile(escaped), { code: 'ENOENT' })
})

test('simulated Git connect rejects a mismatched existing origin without changing HEAD or worktree', async () => {
  const root = await tempDirectory()
  const projectDirectory = join(root, 'existing-repo')
  await mkdir(projectDirectory)
  await run('git', ['init', '-b', 'preview'], { cwd: projectDirectory })
  await run('git', ['config', 'user.email', 'cli-test@example.test'], { cwd: projectDirectory })
  await run('git', ['config', 'user.name', 'CLI Test'], { cwd: projectDirectory })
  await writeFile(join(projectDirectory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'existing-repo', type: 'site', framework: 'vue', accountId: 'acct_one', projectId: 'site_git' }))
  await writeFile(join(projectDirectory, 'keep.txt'), 'committed\n')
  await run('git', ['add', '.'], { cwd: projectDirectory })
  await run('git', ['commit', '-m', 'initial'], { cwd: projectDirectory })
  await run('git', ['remote', 'add', 'origin', 'https://github.com/example/different.git'], { cwd: projectDirectory })
  await writeFile(join(projectDirectory, 'keep.txt'), 'user change\n')
  const beforeHead = (await run('git', ['rev-parse', 'HEAD'], { cwd: projectDirectory })).stdout.trim()
  let migrationRequested = false

  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/sites/site_git/github/setup') return json(response, 200, { mode: 'ready', state: 'state_12345678', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    if (request.url?.startsWith('/api/sites/site_git/github/repositories?')) {
      return json(response, 200, { owners: [], repositories: [{ installationId: 7, owner: 'example', name: 'selected', fullName: 'example/selected', defaultBranch: 'main', cloneUrl: 'https://github.com/example/selected.git', selectable: true }] })
    }
    if (request.url === '/api/sites/site_git/github/connect') {
      migrationRequested = true
      return json(response, 200, { connected: true, binding: { cloneUrl: 'https://github.com/example/selected.git' } })
    }
    if (request.url === '/api/sites/site_git/github/branches') {
      return json(response, 200, { productionBranch: 'main', previewBranch: 'preview', branches: [{ name: 'preview', role: 'preview', headSha: 'a'.repeat(40) }] })
    }
    if (request.url === '/api/sites/site_git/source') return json(response, 200, { files: [] })
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['git', 'connect', '--owner', 'example', '--repo', 'selected', '--yes', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /origin remote does not match/)
  })

  assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: projectDirectory })).stdout.trim(), beforeHead)
  assert.equal(migrationRequested, false, 'validate the local repository before changing remote source authority')
  assert.equal(await readFile(join(projectDirectory, 'keep.txt'), 'utf8'), 'user change\n')
  assert.equal((await run('git', ['remote', 'get-url', 'origin'], { cwd: projectDirectory })).stdout.trim(), 'https://github.com/example/different.git')
})

test('simulated fresh Git attachment restores every missing regular file from the verified fetched tree', async () => {
  const root = await tempDirectory()
  const fixture = await createGitFixture(root)
  const projectDirectory = join(root, 'fresh-project')
  await mkdir(projectDirectory)
  await writeFile(join(projectDirectory, 'goalmatic.json'), fixture.localConfig)
  await writeFile(join(projectDirectory, 'existing.txt'), 'keep this local edit\n')

  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/sites/site_fresh/github/setup') return json(response, 200, { mode: 'ready', state: 'state_12345678', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    if (request.url?.startsWith('/api/sites/site_fresh/github/repositories?')) {
      return json(response, 200, { owners: [], repositories: [{ installationId: 7, owner: 'example', name: 'selected', fullName: 'example/selected', defaultBranch: 'main', cloneUrl: 'https://github.com/example/selected.git', selectable: true }] })
    }
    if (request.url === '/api/sites/site_fresh/github/connect') {
      return json(response, 200, { connected: true, binding: { cloneUrl: 'https://github.com/example/selected.git' } })
    }
    if (request.url === '/api/sites/site_fresh/github/branches') {
      return json(response, 200, { productionBranch: 'main', previewBranch: 'preview', branches: [{ name: 'preview', role: 'preview', headSha: fixture.commitSha }] })
    }
    if (request.url === '/api/sites/site_fresh/source') return json(response, 500, { message: 'Git attachment must not depend on the source snapshot' })
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const rewriteKey = `url.${pathToFileURL(fixture.bareRepository).toString()}.insteadOf`
    const result = await runCli(
      ['git', 'connect', '--owner', 'example', '--repo', 'selected', '--yes', '--api-url', origin],
      origin,
      {
        cwd: projectDirectory,
        env: {
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: rewriteKey,
          GIT_CONFIG_VALUE_0: 'https://github.com/example/selected.git',
          GIT_CONFIG_KEY_1: 'protocol.file.allow',
          GIT_CONFIG_VALUE_1: 'always',
        },
      },
    )
    assert.equal(result.code, 0, result.stderr)
  })

  assert.equal(await readFile(join(projectDirectory, 'README.md'), 'utf8'), '# Remote project\n')
  assert.equal(await readFile(join(projectDirectory, 'CONTRIBUTING.md'), 'utf8'), 'Contribute safely.\n')
  assert.equal(await readFile(join(projectDirectory, '.goalmatic/source.json'), 'utf8'), '{"authority":"git"}\n')
  assert.deepEqual(await readFile(join(projectDirectory, 'public/binary.bin')), Buffer.from([0, 255, 1, 128, 10]))
  assert.equal(await readFile(join(projectDirectory, 'existing.txt'), 'utf8'), 'keep this local edit\n')
  const status = (await run('git', ['status', '--porcelain'], { cwd: projectDirectory })).stdout
  assert.doesNotMatch(status, /^ D /m)
  assert.match(status, /existing\.txt/)
})

test('simulated ready binding recovery attaches locally without rerunning GitHub setup or migration', async () => {
  const root = await tempDirectory()
  const fixture = await createGitFixture(root)
  const directory = join(root, 'ready-recovery')
  const mutations = { setup: 0, repositories: 0, connect: 0 }

  await withFakeApi(async ({ request, response, body }) => {
    if (request.url === '/api/cli/v1/me') return json(response, 200, singleAccount())
    if (request.url === '/api/cli/v1/projects' && request.method === 'POST') {
      const files = body.files.map(file => file.path === 'goalmatic.json'
        ? { ...file, content: `${JSON.stringify({ ...JSON.parse(file.content), accountId: 'acct_one', projectId: 'site_ready', apiOrigin: `http://${request.headers.host}` }, null, 2)}\n` }
        : file)
      return json(response, 200, {
        project: { id: 'site_ready', name: body.name, type: body.type, accountId: body.accountId },
        sourceVersionId: 'version_ready',
        files,
      })
    }
    if (request.url === '/api/sites/site_ready/github/status') {
      return json(response, 200, {
        connected: true,
        githubHeadSha: fixture.commitSha,
        binding: {
          owner: 'example',
          repo: 'selected',
          cloneUrl: 'https://github.com/example/selected.git',
          previewBranch: 'preview',
          activeBranch: 'preview',
          sourceAuthority: 'git',
          migration: { status: 'ready', previewCommitSha: fixture.commitSha },
        },
      })
    }
    if (request.url === '/api/sites/site_ready/github/branches') {
      return json(response, 200, { previewBranch: 'preview', branches: [{ name: 'preview', role: 'preview', headSha: fixture.commitSha }] })
    }
    if (request.url === '/api/sites/site_ready/github/setup') mutations.setup += 1
    if (request.url === '/api/sites/site_ready/github/repositories') mutations.repositories += 1
    if (request.url === '/api/sites/site_ready/github/connect') mutations.connect += 1
    return json(response, 500, { message: 'ready binding attempted a forbidden setup or migration request' })
  }, async origin => {
    const result = await runCli(
      ['create', directory, '--type', 'site', '--name', 'ready-recovery', '--owner', 'example', '--repo', 'selected', '--yes', '--api-url', origin],
      origin,
      {
        env: {
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: `url.${pathToFileURL(fixture.bareRepository).toString()}.insteadOf`,
          GIT_CONFIG_VALUE_0: 'https://github.com/example/selected.git',
          GIT_CONFIG_KEY_1: 'protocol.file.allow',
          GIT_CONFIG_VALUE_1: 'always',
        },
      },
    )
    assert.equal(result.code, 0, result.stderr)
  })

  assert.deepEqual(mutations, { setup: 0, repositories: 0, connect: 0 })
  assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim(), fixture.commitSha)
  assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), '# Remote project\n')
  assert.deepEqual(await readFile(join(directory, 'public/binary.bin')), Buffer.from([0, 255, 1, 128, 10]))
})

test('simulated tested-preview publication plans without writes then posts the exact build to master', async () => {
  const root = await tempDirectory()
  const projectDirectory = await createAppCheckout(root, 'site_publish')
  const commitSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: projectDirectory })).stdout.trim()
  const beforeStatus = (await run('git', ['status', '--porcelain'], { cwd: projectDirectory })).stdout
  const writes = []
  const testBuild = {
    buildId: 'build_ready',
    status: 'ready',
    sourceVersionId: 'version_tested',
    baseProductionCommitSha: 'b'.repeat(40),
    manifest: { version: '1.2.3' },
    artifactId: 'artifact_1',
    artifact: { digest: 'd'.repeat(64) },
    source: { kind: 'git', siteId: 'site_publish', owner: 'example', repository: 'app-repo', branch: 'preview', commitSha },
  }
  await withFakeApi(async ({ request, response, body }) => {
    if (request.url === '/api/sites/site_publish/github/status') {
      return json(response, 200, { connected: true, githubHeadSha: commitSha, binding: { owner: 'example', repo: 'app-repo', previewBranch: 'preview', productionBranch: 'master', sourceAuthority: 'git', migration: { status: 'ready' } } })
    }
    if (request.url === '/api/sites/site_publish/app/testing') {
      return json(response, 200, { track: { currentBuildId: 'build_ready' }, builds: [testBuild] })
    }
    if (request.url === '/api/sites/site_publish/github/branches') {
      return json(response, 200, { previewBranch: 'preview', productionBranch: 'master', branches: [{ name: 'preview', role: 'preview', headSha: commitSha }, { name: 'master', role: 'production', headSha: 'c'.repeat(40) }] })
    }
    if (request.url === '/api/sites/site_publish/app/promote-tested' && request.method === 'POST') {
      writes.push(body)
      return json(response, 200, { releaseId: 'release_1', status: 'submitted', promotion: { productionBranch: 'master', productionCommitSha: 'e'.repeat(40), testedCommitSha: commitSha, sourceVersionId: 'version_main' } })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const dryRun = await runCli(['publish', '--from-preview', '--test-build-id', 'build_ready', '--dry-run', '--json', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(dryRun.code, 0, dryRun.stderr)
    const dryResult = JSON.parse(dryRun.stdout)
    assert.equal(dryResult.dryRun, true)
    assert.equal(dryResult.plan.to.branch, 'master')
    assert.equal(dryResult.plan.to.testedBaselineSha, 'b'.repeat(40))
    assert.equal(writes.length, 0)

    const humanDryRun = await runCli(['publish', '--from-preview', '--test-build-id', 'build_ready', '--dry-run', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(humanDryRun.code, 0, humanDryRun.stderr)
    assert.match(humanDryRun.stdout, /Project: site_publish \(acct_one\)/)
    assert.match(humanDryRun.stdout, /Repository: example\/app-repo/)
    assert.match(humanDryRun.stdout, new RegExp(`Tested baseline: ${'b'.repeat(40)}`))
    assert.match(humanDryRun.stdout, new RegExp(`Artifact: artifact_1 / ${'d'.repeat(64)}`))
    assert.match(humanDryRun.stdout, /Plan only\. The server validates/)
    assert.equal(writes.length, 0)

    const missingYes = await runCli(['publish', '--from-preview', '--test-build-id', 'build_ready', '--json', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(missingYes.code, 2)
    assert.match(missingYes.stderr, /requires --yes/)
    assert.equal(writes.length, 0)

    const published = await runCli(['publish', '--from-preview', '--test-build-id', 'build_ready', '--yes', '--json', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(published.code, 0, published.stderr)
    const result = JSON.parse(published.stdout)
    assert.equal(result.releaseId, 'release_1')
    assert.equal(result.status, 'submitted')
    assert.equal(result.plan.artifact.digest, 'd'.repeat(64))

    const human = await runCli(['publish', '--from-preview', '--test-build-id', 'build_ready', '--yes', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(human.code, 0, human.stderr)
    assert.match(human.stdout, new RegExp(`Artifact: artifact_1 / ${'d'.repeat(64)}`))
    assert.match(human.stdout, /App release release_1 status: submitted/)
    assert.match(human.stdout, /not confirmed live/)
    assert.match(human.stdout, /goes live automatically once approved/)
  })
  assert.deepEqual(writes, [{ testBuildId: 'build_ready' }, { testBuildId: 'build_ready' }])
  assert.equal((await run('git', ['rev-parse', 'HEAD'], { cwd: projectDirectory })).stdout.trim(), commitSha)
  assert.equal((await run('git', ['status', '--porcelain'], { cwd: projectDirectory })).stdout, beforeStatus)
})

test('simulated approved release dry run and publication use the exact immutable release', async () => {
  const root = await tempDirectory()
  const projectDirectory = join(root, 'approved-app')
  await mkdir(projectDirectory)
  await writeFile(join(projectDirectory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'approved-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_approved' }))
  const posts = []
  const approved = { releaseId: 'release_approved', packageId: 'package_1', siteId: 'site_approved', version: '2.0.0', status: 'approved', buildId: 'build_2', sourceVersionId: 'version_2', sourceHash: 'f'.repeat(64) }
  await withFakeApi(async ({ request, response, body }) => {
    if (request.url === '/api/sites/site_approved/app/releases') {
      return json(response, 200, { history: { currentRelease: null, stableRelease: null, pendingRelease: approved, releases: [], nextCursor: null }, publication: null })
    }
    if (request.url === '/api/sites/site_approved/app/promote' && request.method === 'POST') {
      posts.push(body)
      return json(response, 200, { releaseId: approved.releaseId, status: 'published', orchestrationId: 'orchestration_1', orchestrationStatus: 'complete', orchestrationStage: 'complete', runtimeUrl: 'https://approved.apps.goalmatic.io' })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const dryRun = await runCli(['publish', '--release-id', approved.releaseId, '--dry-run', '--json', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(dryRun.code, 0, dryRun.stderr)
    assert.equal(JSON.parse(dryRun.stdout).plan.release.status, 'approved')
    assert.equal(posts.length, 0)

    const result = await runCli(['publish', '--release-id', approved.releaseId, '--yes', '--json', '--api-url', origin], origin, { cwd: projectDirectory })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).orchestrationStatus, 'complete')
  })
  assert.deepEqual(posts, [{ releaseId: approved.releaseId }])
})

test('tested-preview publication rejects dirty, stale, and non-current candidates without writes', async () => {
  const root = await tempDirectory()
  const directory = await createAppCheckout(root, 'site_rejected_preview')
  const commitSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()
  const originalApp = await readFile(join(directory, 'App.vue'), 'utf8')
  let stale = false
  let writes = 0
  const build = { buildId: 'build_current', status: 'ready', sourceVersionId: 'version_1', baseProductionCommitSha: 'b'.repeat(40), manifest: { version: '1.0.0' }, artifactId: 'artifact_1', artifact: { digest: 'd'.repeat(64) }, source: { kind: 'git', siteId: 'site_rejected_preview', owner: 'example', repository: 'app-repo', branch: 'preview', commitSha } }
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/sites/site_rejected_preview/github/status') return json(response, 200, { connected: true, binding: { owner: 'example', repo: 'app-repo', previewBranch: 'preview', productionBranch: 'main', sourceAuthority: 'git', migration: { status: 'ready' } } })
    if (request.url === '/api/sites/site_rejected_preview/app/testing') return json(response, 200, { track: { currentBuildId: 'build_current' }, builds: [build] })
    if (request.url === '/api/sites/site_rejected_preview/github/branches') return json(response, 200, { previewBranch: 'preview', productionBranch: 'main', branches: [{ name: 'preview', headSha: stale ? 'f'.repeat(40) : commitSha }, { name: 'main', headSha: 'c'.repeat(40) }] })
    if (request.method === 'POST') writes += 1
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    await writeFile(join(directory, 'App.vue'), `${originalApp}\n<!-- dirty -->\n`)
    const dirty = await runCli(['publish', '--from-preview', '--test-build-id', 'build_current', '--dry-run', '--api-url', origin], origin, { cwd: directory })
    assert.notEqual(dirty.code, 0)
    assert.match(dirty.stderr, /clean local preview checkout/)
    await writeFile(join(directory, 'App.vue'), originalApp)

    const nonCurrent = await runCli(['publish', '--from-preview', '--test-build-id', 'build_other', '--dry-run', '--api-url', origin], origin, { cwd: directory })
    assert.notEqual(nonCurrent.code, 0)
    assert.match(nonCurrent.stderr, /not the current private test build/)

    stale = true
    const staleResult = await runCli(['publish', '--from-preview', '--test-build-id', 'build_current', '--dry-run', '--api-url', origin], origin, { cwd: directory })
    assert.notEqual(staleResult.code, 0)
    assert.match(staleResult.stderr, /remote preview branch changed/)
  })
  assert.equal(writes, 0)
})

test('approved release publication rejects an unapproved release without writes', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'unapproved-app')
  await mkdir(directory)
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'unapproved-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_unapproved' }))
  let writes = 0
  const release = { releaseId: 'release_review', siteId: 'site_unapproved', version: '1.0.0', status: 'in_review', buildId: 'build_1', sourceVersionId: 'version_1', sourceHash: 'a'.repeat(64) }
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/sites/site_unapproved/app/releases') return json(response, 200, { history: { pendingRelease: release, releases: [], nextCursor: null }, publication: null })
    if (request.method === 'POST') writes += 1
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['publish', '--release-id', release.releaseId, '--dry-run', '--api-url', origin], origin, { cwd: directory })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /only approved or published releases/)
  })
  assert.equal(writes, 0)
})

test('new App publication option conflicts fail before remote writes', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'guarded-app')
  await mkdir(directory)
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'guarded-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_guarded' }))
  let requests = 0
  await withFakeApi(async ({ response }) => {
    requests += 1
    return json(response, 500, { message: 'no request expected' })
  }, async origin => {
    const result = await runCli(['publish', '--from-preview', '--release-id', 'release_1', '--yes', '--api-url', origin], origin, { cwd: directory })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /cannot be combined/)
  })
  assert.equal(requests, 0)
})

test('publication-only flags on other commands fail before project or network work', async () => {
  let requests = 0
  await withFakeApi(async ({ response }) => {
    requests += 1
    return json(response, 500, { message: 'no request expected' })
  }, async origin => {
    const result = await runCli(['deploy', '--preview', '--dry-run', '--api-url', origin], origin)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /only with publish/)
  })
  assert.equal(requests, 0)
})

test('approved release lookup rejects a repeated pagination cursor', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'paged-app')
  await mkdir(directory)
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'paged-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_paged' }))
  let requests = 0
  await withFakeApi(async ({ request, response }) => {
    if (request.url?.startsWith('/api/sites/site_paged/app/releases')) {
      requests += 1
      return json(response, 200, { history: { currentRelease: null, stableRelease: null, pendingRelease: null, releases: [], nextCursor: 'repeat' }, publication: null })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['publish', '--release-id', 'missing', '--dry-run', '--json', '--api-url', origin], origin, { cwd: directory })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /repeated pagination cursor/)
  })
  assert.equal(requests, 2)
})

test('human App status reports review and orchestration states without claiming live', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'status-app')
  await mkdir(directory)
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'status-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_status' }))
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/cli/v1/projects/site_status') return json(response, 200, { project: { id: 'site_status', name: 'status-app', type: 'app' }, sourceVersionId: 'version_1' })
    if (request.url === '/api/sites/site_status/github/status') return json(response, 200, { connected: true, syncState: 'up-to-date' })
    if (request.url === '/api/sites/site_status/app/releases') {
      return json(response, 200, {
        history: { pendingRelease: { releaseId: 'release_pending', version: '3.0.0', status: 'in_review' } },
        publication: { promotion: { status: 'reconciling', stage: 'store', lastError: null } },
      })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['status', '--api-url', origin], origin, { cwd: directory })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /App release: 3\.0\.0 \(release_pending, in_review\)/)
    assert.match(result.stdout, /App publication: reconciling at store/)
    assert.doesNotMatch(result.stdout, /Live runtime/)
  })
})

test('failed App publication exits nonzero while JSON preserves release and orchestration evidence', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'failed-app')
  await mkdir(directory)
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'failed-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_failed' }))
  const release = { releaseId: 'release_failed', packageId: 'package_1', siteId: 'site_failed', version: '4.0.0', status: 'approved', buildId: 'build_failed', sourceVersionId: 'version_failed', sourceHash: 'a'.repeat(64) }
  let returnedReleaseStatus = 'approved'
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/sites/site_failed/app/releases') return json(response, 200, { history: { pendingRelease: release, releases: [], nextCursor: null }, publication: null })
    if (request.url === '/api/sites/site_failed/app/promote') {
      return json(response, 200, { releaseId: release.releaseId, status: returnedReleaseStatus, buildId: release.buildId, orchestrationId: 'orchestration_failed', orchestrationStatus: 'failed', orchestrationStage: 'store' })
    }
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    for (const status of ['approved', 'failed']) {
      returnedReleaseStatus = status
      const result = await runCli(['publish', '--release-id', release.releaseId, '--yes', '--json', '--api-url', origin], origin, { cwd: directory })
      assert.notEqual(result.code, 0)
      const evidence = JSON.parse(result.stdout)
      assert.equal(evidence.status, returnedReleaseStatus)
      assert.equal(evidence.releaseId, release.releaseId)
      assert.equal(evidence.buildId, release.buildId)
      assert.equal(evidence.orchestrationId, 'orchestration_failed')
      assert.equal(evidence.orchestrationStatus, 'failed')
      assert.match(result.stderr, /App publication failed/)
    }
  })
})

test('dispatched App publication errors retain server message and require status reconciliation', async () => {
  const root = await tempDirectory()
  const directory = join(root, 'uncertain-app')
  await mkdir(directory)
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: 'uncertain-app', type: 'app', framework: 'vue', accountId: 'acct_one', projectId: 'site_uncertain' }))
  const release = { releaseId: 'release_uncertain', packageId: 'package_1', siteId: 'site_uncertain', version: '5.0.0', status: 'approved', buildId: 'build_uncertain', sourceVersionId: 'version_uncertain', sourceHash: 'b'.repeat(64) }
  await withFakeApi(async ({ request, response }) => {
    if (request.url === '/api/sites/site_uncertain/app/releases') return json(response, 200, { history: { pendingRelease: release, releases: [], nextCursor: null }, publication: null })
    if (request.url === '/api/sites/site_uncertain/app/promote') return json(response, 502, { message: 'simulated upstream timeout' })
    return json(response, 404, { message: 'simulated route not found' })
  }, async origin => {
    const result = await runCli(['publish', '--release-id', release.releaseId, '--yes', '--api-url', origin], origin, { cwd: directory })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /simulated upstream timeout/)
    assert.match(result.stderr, /request was dispatched; run goalmatic status --json before deciding whether to retry/)
  })
})

function singleAccount() {
  return {
    user: { id: 'user_1', email: 'user@example.test' },
    accounts: [{ id: 'acct_one', name: 'One', isDefault: true }],
    defaultAccountId: 'acct_one',
  }
}

function createdProject(body, host, files) {
  const canonical = files.map(file => file.path === 'goalmatic.json'
    ? { ...file, content: `${JSON.stringify({ ...JSON.parse(file.content), accountId: 'acct_one', projectId: 'site_retry', apiOrigin: `http://${host}` }, null, 2)}\n` }
    : file)
  return {
    project: { id: 'site_retry', name: body.name, type: body.type, accountId: body.accountId },
    sourceVersionId: 'version_retry',
    editorUrl: `http://${host}/projects/site_retry`,
    previewUrl: `http://${host}/preview/site_retry`,
    files: canonical,
  }
}

async function withFakeApi(handler, task) {
  const server = createServer(async (request, response) => {
    let body = null
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      await handler({ request, response, body })
    } catch (error) {
      if (!response.headersSent) json(response, 500, { message: error.message })
      else response.destroy(error)
    }
  })
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  try {
    return await task(origin)
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise))
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function runCli(args, apiOrigin, { cwd = packageDirectory, env = {} } = {}) {
  return run(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, GOALMATIC_TOKEN: 'gmc_simulated', GOALMATIC_API_URL: apiOrigin, NO_COLOR: '1', ...env },
  })
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('exit', code => resolvePromise({ code, stdout, stderr }))
  })
}

async function tempDirectory() {
  return realpath(await mkdtemp(join(tmpdir(), 'goalmatic-cli-test-')))
}

async function createGitFixture(root) {
  const work = join(root, 'remote-work')
  const bareRepository = join(root, 'selected.git')
  await mkdir(join(work, '.goalmatic'), { recursive: true })
  await mkdir(join(work, 'public'), { recursive: true })
  const remoteConfig = `${JSON.stringify({ schemaVersion: 1, name: 'fresh-project', type: 'site', framework: 'vue', accountId: 'acct_one', projectId: 'site_fresh' }, null, 2)}\n`
  await writeFile(join(work, 'goalmatic.json'), remoteConfig)
  await writeFile(join(work, 'README.md'), '# Remote project\n')
  await writeFile(join(work, 'CONTRIBUTING.md'), 'Contribute safely.\n')
  await writeFile(join(work, '.goalmatic/source.json'), '{"authority":"git"}\n')
  await writeFile(join(work, 'public/binary.bin'), Buffer.from([0, 255, 1, 128, 10]))
  await writeFile(join(work, 'existing.txt'), 'remote version\n')
  await run('git', ['init', '-b', 'preview'], { cwd: work })
  await run('git', ['config', 'user.email', 'cli-test@example.test'], { cwd: work })
  await run('git', ['config', 'user.name', 'CLI Test'], { cwd: work })
  await run('git', ['add', '.'], { cwd: work })
  await run('git', ['commit', '-m', 'verified tree'], { cwd: work })
  const commitSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: work })).stdout.trim()
  await run('git', ['clone', '--bare', work, bareRepository], { cwd: root })
  return { bareRepository, commitSha, localConfig: remoteConfig }
}

async function createAppCheckout(root, projectId) {
  const directory = join(root, projectId)
  await mkdir(join(directory, '.goalmatic'), { recursive: true })
  await writeFile(join(directory, 'goalmatic.json'), JSON.stringify({ schemaVersion: 1, name: projectId, type: 'app', framework: 'vue', accountId: 'acct_one', projectId }))
  await writeFile(join(directory, '.goalmatic/app.json'), JSON.stringify({ schemaVersion: 3, contractVersion: '2.0.0', siteId: projectId, packageId: 'package_1', name: projectId, slug: projectId, version: '1.2.3' }))
  await writeFile(join(directory, 'App.vue'), '<template><main>App</main></template>\n')
  await run('git', ['init', '-b', 'preview'], { cwd: directory })
  await run('git', ['config', 'user.email', 'cli-test@example.test'], { cwd: directory })
  await run('git', ['config', 'user.name', 'CLI Test'], { cwd: directory })
  await run('git', ['add', '.'], { cwd: directory })
  await run('git', ['commit', '-m', 'tested preview'], { cwd: directory })
  return directory
}

function pickEnvironment(keys) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]))
}

function restoreEnvironment(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
