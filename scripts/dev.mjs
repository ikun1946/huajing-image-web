import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const processes = [
  { name: 'server', cwd: join(root, 'server'), args: ['run', 'dev'] },
  { name: 'web', cwd: join(root, 'web'), args: ['run', 'dev'] },
]

const children = processes.map(({ name, cwd, args }) => {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  const prefix = `[${name}]`
  child.stdout.on('data', chunk => process.stdout.write(`${prefix} ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`${prefix} ${chunk}`))
  child.on('exit', code => {
    console.log(`${prefix} 退出，代码 ${code}`)
    shutdown(code ?? 0)
  })

  return child
})

let closing = false

function shutdown(code) {
  if (closing) return
  closing = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
