export class CliError extends Error {
  constructor(message, exitCode = 1, details) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.details = details
  }
}

export function assert(condition, message, exitCode = 1) {
  if (!condition) throw new CliError(message, exitCode)
}
