import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { realpath } from 'node:fs/promises'
import { inspectLocalGit } from '../src/git.mjs'

test('Git inspection waits for stdout to drain after process exit before declaring a checkout clean', async t => {
  const directory = await realpath(process.cwd())
  t.mock.method(childProcess, 'spawn', (_command, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdout = args.includes('--is-inside-work-tree') ? 'true\n'
      : args.includes('--show-toplevel') ? `${directory}\n`
      : args.includes('--show-current') ? 'preview\n'
      : args[0] === 'status' ? ' M App.vue\n' : `${'a'.repeat(40)}\n`
    setImmediate(() => {
      if (args[0] === 'status') {
        child.emit('exit', 0)
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(stdout))
          child.emit('close', 0)
        })
      } else {
        child.stdout.emit('data', Buffer.from(stdout))
        child.emit('exit', 0)
        child.emit('close', 0)
      }
    })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const state = await inspectLocalGit(directory)
  assert.equal(state.branch, 'preview')
  assert.equal(state.commitSha, 'a'.repeat(40))
  assert.equal(state.clean, false)
})
