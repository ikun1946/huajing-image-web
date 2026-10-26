#!/usr/bin/env node
/**
 * 画境后端一键启动器
 *
 * 依次完成：环境体检 → 依赖补齐 → 前端构建 → 拉起 Magpie → 启动后端 → 打开浏览器。
 * 任何一步失败都会给出中文原因与修复建议，而不是抛出一堆堆栈。
 *
 * 用法：
 *   node scripts/launch-server.mjs            启动（缺失产物时自动构建）
 *   node scripts/launch-server.mjs --rebuild  强制重新构建前后端
 *   node scripts/launch-server.mjs --dev      开发模式（热重载，不构建前端）
 *   node scripts/launch-server.mjs --no-open  不自动打开浏览器
 *   node scripts/launch-server.mjs --no-magpie  不自动拉起 Magpie
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, 'server')
const webDir = join(root, 'web')

const args = new Set(process.argv.slice(2))
const forceRebuild = args.has('--rebuild')
const devMode = args.has('--dev')
const autoOpen = !args.has('--no-open')
const autoMagpie = !args.has('--no-magpie')

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const MAGPIE_BASE_URL = (process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425').replace(/\/+$/, '')
const MAGPIE_URL = `${MAGPIE_BASE_URL}/v1/models`

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

const paint = (color, text) => `${colors[color] ?? ''}${text}${colors.reset}`
const line = (text = '') => console.log(text)
const step = text => console.log(`${paint('cyan', '▸')} ${text}`)
const ok = text => console.log(`  ${paint('green', '✔')} ${text}`)
const warn = text => console.log(`  ${paint('yellow', '!')} ${text}`)
const fail = text => console.log(`  ${paint('red', '✘')} ${text}`)

function loadEnvFile() {
  const envPath = join(serverDir, '.env')
  if (!existsSync(envPath)) return

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const lineText = rawLine.trim()
    if (!lineText || lineText.startsWith('#')) continue

    const separator = lineText.indexOf('=')
    if (separator <= 0) continue

    const key = lineText.slice(0, separator).trim()
    let value = lineText.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function run(command, commandArgs, options = {}) {
  const isWindows = process.platform === 'win32'
  const finalCommand = isWindows ? 'cmd.exe' : command
  const finalArgs = isWindows ? ['/d', '/s', '/c', command, ...commandArgs] : commandArgs

  return spawnSync(finalCommand, finalArgs, {
    cwd: options.cwd ?? root,
    stdio: options.quiet ? 'ignore' : 'inherit',
    shell: false,
    env: { ...process.env, ...options.env },
  })
}

function which(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    shell: false,
  })
  if (result.status === 0) {
    const first = String(result.stdout || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .find(Boolean)
    if (first) return first.trim()
  }
  return null
}

async function waitForHttp(url, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (response.ok) return true
    } catch {
      // 继续等待服务就绪
    }
    await sleep(intervalMs)
  }
  return false
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function checkNode() {
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 20) {
    fail(`Node.js 版本过低（当前 ${process.versions.node}，需要 20 或更高）`)
    fail('请从 https://nodejs.org 下载 LTS 版本后重试')
    return false
  }
  ok(`Node.js ${process.versions.node}`)
  return true
}

function checkPort() {
  // 实际尝试绑定端口，比探测连接更可靠
  const probe = net.createServer()
  probe.unref()
  probe.once('error', () => {})
  return new Promise(resolve => {
    probe.once('error', () => resolve(true))
    probe.listen({ host: HOST, port: PORT, exclusive: true }, () => {
      probe.close(() => resolve(false))
    })
  })
}

async function ensureMagpie() {
  if (await waitForHttp(MAGPIE_URL, { timeoutMs: 2500 })) {
    ok(`Magpie 网关已就绪（${MAGPIE_BASE_URL}）`)
    return true
  }

  if (!autoMagpie) {
    warn(`Magpie 未运行（${MAGPIE_BASE_URL}）`)
    warn('生图会失败，请先手动启动 Magpie')
    return false
  }

  const candidates = [
    process.env.MAGPIE_EXE,
    join(homedir(), 'Downloads', 'magpie-windows-amd64.exe'),
    join(homedir(), 'Downloads', 'magpie.exe'),
    which('magpie'),
  ].filter(Boolean)

  const executable = candidates.find(path => existsSync(path))
  if (!executable) {
    warn(`Magpie 未运行，且未找到可执行文件（${MAGPIE_BASE_URL}）`)
    warn('请手动启动 Magpie，或在 server/.env 中设置 MAGPIE_EXE 指向它的路径')
    return false
  }

  step(`正在拉起 Magpie：${executable}`)
  const child = spawn(executable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()

  const ready = await waitForHttp(MAGPIE_URL, { timeoutMs: 45000 })
  if (ready) {
    ok('Magpie 已启动并就绪')
    return true
  }

  warn('Magpie 启动超时，后端仍会启动，但生图可能失败')
  return false
}

function ensureServerDeps() {
  if (existsSync(join(serverDir, 'node_modules', 'fastify'))) {
    ok('后端依赖已安装')
    return true
  }

  step('正在安装后端依赖（首次较慢，请耐心等待）…')
  const result = run('npm', ['install'], { cwd: serverDir })
  if (result.status !== 0) {
    fail('后端依赖安装失败')
    return false
  }
  ok('后端依赖安装完成')
  return true
}

function ensureWebDeps() {
  if (devMode) return true
  if (existsSync(join(webDir, 'node_modules', 'vite'))) {
    ok('前端依赖已安装')
    return true
  }

  step('正在安装前端依赖…')
  const result = run('npm', ['install'], { cwd: webDir })
  if (result.status !== 0) {
    fail('前端依赖安装失败')
    return false
  }
  ok('前端依赖安装完成')
  return true
}

function buildFrontend() {
  if (devMode) {
    step('开发模式：跳过前端构建，由 Vite 提供页面')
    return true
  }

  const entry = join(webDir, 'dist', 'index.html')
  if (!forceRebuild && existsSync(entry)) {
    ok('前端产物已存在，跳过构建')
    return true
  }

  step('正在构建前端…')
  const result = run('npm', ['run', 'build'], { cwd: webDir })
  if (result.status !== 0) {
    fail('前端构建失败')
    return false
  }
  ok('前端构建完成')
  return true
}

function buildServer() {
  if (devMode) {
    step('开发模式：后端由 tsx 直接运行，跳过编译')
    return true
  }

  const entry = join(serverDir, 'dist', 'index.js')
  if (!forceRebuild && existsSync(entry)) {
    ok('后端产物已存在，跳过编译')
    return true
  }

  step('正在编译后端…')
  const result = run('npm', ['run', 'build'], { cwd: serverDir })
  if (result.status !== 0) {
    fail('后端编译失败')
    return false
  }
  ok('后端编译完成')
  return true
}

function openBrowser(url) {
  if (!autoOpen) return
  try {
    if (process.platform === 'win32') {
      run('cmd', ['/c', 'start', '', url])
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // 打不开浏览器不影响服务本身
  }
}

async function main() {
  loadEnvFile()

  line()
  line(paint('bold', '  画境 · 后端启动器'))
  line(paint('dim', `  ${new Date().toLocaleString('zh-CN')}`))
  line()

  line(paint('bold', '  环境体检'))
  const checks = [await checkNode()]
  if (checks.some(value => !value)) {
    line()
    fail('环境不满足要求，已中止启动')
    process.exit(1)
  }

  line()
  line(paint('bold', '  依赖与构建'))
  if (!ensureServerDeps() || !ensureWebDeps() || !buildFrontend() || !buildServer()) {
    line()
    fail('准备阶段失败，已中止启动')
    process.exit(1)
  }

  line()
  line(paint('bold', '  上游服务'))
  await ensureMagpie()

  line()
  line(paint('bold', '  端口检查'))
  if (await checkPort()) {
    fail(`端口 ${PORT} 已被占用`)
    fail('请先关闭占用该端口的程序，或在 server/.env 中改 PORT')
    process.exit(1)
  }
  ok(`端口 ${PORT} 可用`)

  line()
  line(paint('bold', '  启动服务'))
  const isWindows = process.platform === 'win32'

  // 直接跑 node 入口，不经过 npm 包装层：
  // npm 在没有 TTY 的环境里行为不可靠，双击 .bat 启动时容易静默退出。
  const serverEntry = devMode ? join(serverDir, 'src', 'index.ts') : join(serverDir, 'dist', 'index.js')
  const nodeArgs = devMode
    ? [join(root, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'), serverEntry]
    : [serverEntry]

  // 日志写文件，方便事后排查
  let logPath = ''
  let logStream = null
  if (isWindows) {
    logPath = join(root, 'server.log')
    try {
      logStream = createWriteStream(logPath, { flags: 'a' })
      logStream.write(`\n===== 启动于 ${new Date().toLocaleString('zh-CN')} =====\n`)
    } catch {
      logStream = null
    }
  }

  const child = spawn(process.execPath, nodeArgs, {
    cwd: serverDir,
    // 独立成组并脱离父进程：启动器窗口关掉后服务仍继续运行，
    // 双击 .bat 时也不会因为父 cmd 结束而把后端一起带走。
    stdio: isWindows ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    env: process.env,
    detached: isWindows,
    windowsHide: false,
  })

  if (isWindows) {
    if (logStream) {
      child.stdout?.pipe(logStream)
      child.stderr?.pipe(logStream)
    } else {
      child.stdout?.resume()
      child.stderr?.resume()
    }
    child.unref()
  }

  const siteUrl = `http://${HOST}:${PORT}`
  const ready = await waitForHttp(`${siteUrl}/api/health`, { timeoutMs: 20000 })

  line()
  if (ready) {
    ok('后端已就绪')
    line()
    line(`    ${paint('bold', '单张工作台')}   ${siteUrl}/`)
    line(`    ${paint('bold', '批量工作台')}   ${siteUrl}/batch`)
    line(`    ${paint('bold', '健康检查')}   ${siteUrl}/api/health`)
    if (logPath) {
      line(`    ${paint('bold', '运行日志')}   ${logPath}`)
    }
    line()
    line(paint('dim', '  这个窗口可以关掉，服务会继续运行'))
    line(paint('dim', '  要停止服务，在任务管理器结束 node.exe，或运行 停止服务.bat'))
    line()
    openBrowser(siteUrl)
  } else {
    warn('服务启动较慢，请查看上方日志确认状态')
    if (logPath) {
      warn(`日志文件：${logPath}`)
    }
  }

  const shutdown = () => {
    if (!child.killed) child.kill()
    logStream?.end()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  child.on('exit', code => {
    line()
    line(paint('dim', `  服务已退出（代码 ${code ?? 0}）`))
    logStream?.end()
    process.exit(code ?? 0)
  })
}

main().catch(error => {
  console.error()
  fail(`启动器异常：${error?.message || error}`)
  process.exit(1)
})
