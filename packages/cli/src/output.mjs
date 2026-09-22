export function createOutput({ json = false } = {}) {
  return {
    json,
    info(message) {
      if (!json) process.stdout.write(`${message}\n`)
    },
    warn(message) {
      if (!json) process.stderr.write(`${message}\n`)
    },
    result(value) {
      if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
      else if (typeof value === 'string') process.stdout.write(`${value}\n`)
    },
  }
}
