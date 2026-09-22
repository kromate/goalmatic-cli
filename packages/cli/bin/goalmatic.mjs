#!/usr/bin/env node

import { main } from '../src/cli.mjs'

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (process.argv.slice(2).includes('--json')) {
    process.stderr.write(`${JSON.stringify({ error: { message, exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1 } }, null, 2)}\n`)
  } else {
    process.stderr.write(`Error: ${message}\n`)
  }
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
})
