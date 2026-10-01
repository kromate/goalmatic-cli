import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync(process.execPath, ['--test', 'plugins/test/package.test.mjs'], { cwd: repository, stdio: 'inherit' })
const plugin = resolve(repository, 'plugins/goalmatic')
const manifest = JSON.parse(readFileSync(resolve(plugin, 'plugin.json'), 'utf8'))
const output = resolve(repository, 'dist', `${manifest.name}-${manifest.version}.zip`)
mkdirSync(dirname(output), { recursive: true })
execFileSync('python3', ['-c', `
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import sys
root = Path(sys.argv[1])
with ZipFile(sys.argv[2], 'w', compression=ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file():
            info = ZipInfo(path.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
`, plugin, output], { stdio: 'inherit' })
console.log(output)
