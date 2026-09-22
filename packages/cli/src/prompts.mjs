import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { CliError } from './errors.mjs'

export function promptSession() {
  if (!stdin.isTTY || !stdout.isTTY) return null
  return createInterface({ input: stdin, output: stdout })
}

export async function promptText(rl, label, defaultValue = '') {
  if (!rl) throw new CliError(`${label} requires an interactive terminal or an explicit option`, 2)
  const suffix = defaultValue ? ` (${defaultValue})` : ''
  const result = (await rl.question(`${label}${suffix}: `)).trim()
  return result || defaultValue
}

export async function choose(rl, label, items, { format = String } = {}) {
  if (!items.length) throw new CliError(`No ${label.toLowerCase()} options are available`)
  if (items.length === 1) return items[0]
  if (!rl) throw new CliError(`${label} requires an explicit option in a non-interactive terminal`, 2)
  stdout.write(`${label}:\n`)
  items.forEach((item, index) => stdout.write(`  ${index + 1}. ${format(item)}\n`))
  while (true) {
    const value = Number((await rl.question('Choose a number: ')).trim())
    if (Number.isInteger(value) && value >= 1 && value <= items.length) return items[value - 1]
    stdout.write(`Enter a number from 1 to ${items.length}.\n`)
  }
}

export async function confirm(rl, question) {
  if (!rl) return false
  const value = (await rl.question(`${question} [y/N]: `)).trim().toLowerCase()
  return value === 'y' || value === 'yes'
}

export async function confirmDefaultYes(rl, question) {
  if (!rl) return false
  const value = (await rl.question(`${question} [Y/n]: `)).trim().toLowerCase()
  return value === '' || value === 'y' || value === 'yes'
}
