/**
 * 画境服务控制台
 *
 * 一个独立的小型 Node 服务（默认 127.0.0.1:8790），提供：
 *  - 启动 / 停止 / 重启 主服务（server，默认 0.0.0.0:8787）的按钮
 *  - 运行时间与进程状态
 *  - 流量监控与每客户端限流配置（转发主服务管理端接口，需登录主服务管理员）
 *  - 查看本地 logs/ 目录下的日志文件
 *  - 内嵌客户端页面（iframe，主服务运行时可直接使用）
 *
 * 只监听本机回环：控制台是管理入口，不对局域网开放。
 */
import { execSync, spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/* 打包进桌面端后目录结构与仓库不同，路径统一允许被环境变量覆盖 */
const projectRoot = process.env.PANEL_ROOT ? resolve(process.env.PANEL_ROOT) : resolve(here, '..')
const serverEntry = process.env.SERVER_ENTRY
  ? resolve(process.env.SERVER_ENTRY)
  : join(projectRoot, 'server', 'dist', 'index.js')
const logsDir = process.env.LOGS_DIR ? resolve(process.env.LOGS_DIR) : join(projectRoot, 'logs')

const PANEL_PORT = Number(process.env.PANEL_PORT || 8790)
const SERVER_PORT = Number(process.env.PORT || 8787)
/* 桌面端把控制台当成自己的子进程时置 1：
   - 主服务不再 detached（生命周期归桌面端）
   - 停服务时先请求主服务优雅退出，再等端口释放
   - 额外开放 POST /api/panel/shutdown 供桌面端退出前收尾 */
const EMBEDDED = process.env.PANEL_EMBEDDED === '1'
/* 控制台自己的设置（目前只有上游 Magpie 地址）：存在数据目录里，
   启动主服务时作为环境变量注入，优先级高于桌面端 config.env 里的默认值。 */
const settingsDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(projectRoot, 'data')
const settingsFile = join(settingsDir, 'settings.json')
const DEFAULT_UPSTREAM = process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425'
const upstreamModel = process.env.MAGPIE_IMAGE_MODEL || 'codex/gpt-image-2'
let upstreamSettings = { magpieBaseUrl: '' }

/**
 * 桌面端（父进程）可以直接控制服务：它本来就持有子进程的生命周期，
 * 不应该再要求用户在一个网页里登录一次管理员。只认嵌入模式 + 进程内随机令牌，
 * 令牌由桌面端每次启动生成并通过环境变量注入，浏览器页面拿不到。
 */
function desktopAuthorized(request) {
  if (!EMBEDDED) return false
  const expected = process.env.SHUTDOWN_TOKEN
  if (!expected) return false
  const token = request.headers['x-desktop-token']
  return typeof token === 'string' && token === expected
}

let serverProcess = null
let startedAt = 0
/** 启动失败时保留退出码与输出，供页面展示 */
let lastExit = null
/** 控制台自己的管理员会话：登录一次即持有主服务的会话令牌（Bearer），
    这样控制台无需依赖浏览器在客户端页面里的登录态。 */
let panelSession = { token: '', user: null }

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
  log: 'text/plain; charset=utf-8',
}

function serverRunning() {
  if (serverProcess && serverProcess.pid === null) return true // 接管态：端口探测确认过
  return Boolean(serverProcess && serverProcess.exitCode === null && !serverProcess.killed)
}

async function portAlive() {
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

/* 服务是否真的在跑：优先信子进程句柄；句柄为空时探一次端口（结果缓存 2 秒，
   避免状态轮询每次都付 1.5 秒超时代价）。探测到活着就顺手接管，供停止功能使用。 */
let probeCache = { at: 0, alive: false }

async function serviceRunningLive() {
  if (serverRunning()) return true
  if (Date.now() - probeCache.at < 2000) return probeCache.alive

  const alive = await portAlive()
  probeCache = { at: Date.now(), alive }

  if (alive) {
    if (!startedAt) startedAt = Date.now()
    serverProcess = { pid: null, exitCode: null, killed: false, on: () => {} }
  } else if (serverProcess && !serverProcess.pid) {
    // 接管态失效（服务被外部停掉）
    serverProcess = null
    startedAt = 0
  }
  return alive
}

async function startServer() {
  if (serverRunning()) return { ok: false, message: '服务已在运行' }

  // 面板自己重启过、或服务被别的途径启动时：探测到主服务活着就直接接管状态（不重复拉起）
  if (await portAlive()) {
    startedAt = Date.now()
    serverProcess = { pid: null, exitCode: null, killed: false, on: () => {} }
    return { ok: true, message: '服务已在运行，控制台已接管监控' }
  }

  if (!existsSync(serverEntry)) {
    return { ok: false, message: '后端未编译：请先运行 npm run build:server' }
  }

  lastExit = null
  startedAt = Date.now()
  // detached：服务是独立进程，不随控制台退出而消失；
  // 控制台重启后靠端口探测重新接管。
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: join(projectRoot, 'server'),
    stdio: 'ignore',
    env: { ...process.env, ...settingsEnv() },
    detached: !EMBEDDED,
  })
  if (!EMBEDDED) serverProcess.unref()
  serverProcess.on('exit', (code, signal) => {
    lastExit = { code, signal, at: new Date().toISOString() }
    if (serverProcess === trackedProcess) {
      serverProcess = null
      startedAt = 0
    }
  })
  const trackedProcess = serverProcess
  return { ok: true, message: '服务已启动' }
}

/** 请主服务优雅退出（Windows 上 child.kill() 是强杀，收不到 SIGTERM，只能走接口） */
async function requestGracefulStop() {
  const token = process.env.SHUTDOWN_TOKEN
  if (!token) return false
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shutdown-token': token },
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

/** 等端口真的释放，避免「刚停就起」时新进程抢不到端口 */
async function waitForPortFree(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portAlive())) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  return false
}

/** 按监听端口反查 PID 强杀：句柄失效或非嵌入模式下的兜底，仅 Windows */
function killByPort() {
  try {
    const netstat = execSync(
      `netstat -ano | findstr :${SERVER_PORT} | findstr LISTENING`, { encoding: 'utf8' })
    const pids = [...new Set(netstat
      .split('\n')
      .map(line => line.trim().split(/\s+/).pop())
      .filter(pid => /^\d+$/.test(pid)))]
    for (const pid of pids) {
      execSync(`taskkill /f /pid ${pid}`, { stdio: 'ignore' })
    }
  } catch {
    if (serverProcess && serverProcess.pid) {
      try { serverProcess.kill() } catch {}
    }
  }
}

async function stopServer() {
  if (!serverRunning()) return { ok: false, message: '服务未在运行' }

  if (EMBEDDED) {
    // 嵌入式：先优雅退出（补写流量、关日志流），失败再兜底强杀
    if (await requestGracefulStop()) {
      await waitForPortFree(8000)
    } else if (serverProcess && serverProcess.pid) {
      try { serverProcess.kill() } catch {}
      await waitForPortFree(4000)
    } else {
      killByPort()
      await waitForPortFree(4000)
    }
  } else {
    killByPort()
    await waitForPortFree(4000)
  }

  serverProcess = null
  startedAt = 0
  probeCache = { at: 0, alive: false }
  return { ok: true, message: '服务已停止' }
}

async function restartServer() {
  if (serverRunning()) {
    await stopServer()
  } else {
    await waitForPortFree(2000)
  }
  return startServer()
}

/* 用控制台持有的令牌调用主服务管理端接口 */
async function mainFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (panelSession.token) headers.authorization = 'Bearer ' + panelSession.token
  return fetch('http://127.0.0.1:' + SERVER_PORT + path, { ...options, headers })
}

async function proxyJson(reply, path, options) {
  if (!serverRunning()) return json(reply, 409, { error: '服务未运行，请先启动服务' })
  if (!panelSession.token) {
    return json(reply, 401, { error: '请先在控制台登录管理员账号', code: 'PANEL_AUTH_REQUIRED' })
  }
  try {
    const response = await mainFetch(path, options)
    const payload = await response.json().catch(() => ({}))
    // 主服务重启后令牌会失效：清掉控制台会话，让用户重新登录
    if (response.status === 401) {
      panelSession = { token: '', user: null }
      return json(reply, 401, { error: '登录已失效（服务可能重启过），请重新登录', code: 'PANEL_AUTH_REQUIRED' })
    }
    return json(reply, response.status, payload)
  } catch (error) {
    return json(reply, 502, { error: '主服务无响应：' + error.message })
  }
}

/** 读取控制台设置（文件不存在就用空设置） */
async function loadSettings() {
  try {
    const raw = await readFile(settingsFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.magpieBaseUrl === 'string') {
      upstreamSettings.magpieBaseUrl = parsed.magpieBaseUrl
    }
  } catch {}
}

async function saveSettings() {
  await mkdir(settingsDir, { recursive: true })
  await writeFile(settingsFile, JSON.stringify(upstreamSettings, null, 2), 'utf8')
}

/** 当前生效的上游地址：控制台设置优先，其次环境变量/默认值 */
function effectiveUpstream() {
  return (upstreamSettings.magpieBaseUrl || DEFAULT_UPSTREAM).replace(/\/+$/, '')
}

/** 主服务启动时注入的环境变量（只注入被显式设置过的项） */
function settingsEnv() {
  return upstreamSettings.magpieBaseUrl ? { MAGPIE_BASE_URL: upstreamSettings.magpieBaseUrl } : {}
}

/**
 * 校验用户填的上游地址：只允许 http/https、必须有主机名、不能带账号密码。
 * 允许回环与内网地址——这个项目的上游本来就是本机的 Magpie。
 */
function normalizeUpstreamUrl(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) throw new Error('请填写 Magpie 地址')
  if (raw.length > 300) throw new Error('地址过长')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('地址格式不正确，示例：http://127.0.0.1:3425')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http / https 地址')
  }
  if (!parsed.hostname) throw new Error('地址里缺少主机名')
  if (parsed.username || parsed.password) throw new Error('地址里不要带用户名和密码')
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${pathname}`
}

/** 探一下上游是否可达：任何 HTTP 响应都算可达（401 也说明服务在） */
async function probeUpstream(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2500) })
    return { reachable: true, status: response.status }
  } catch (error) {
    return { reachable: false, error: error.message }
  }
}

function notLoggedIn(reply) {
  return json(reply, 401, { error: '请先登录控制台', code: 'PANEL_AUTH_REQUIRED' })
}

function json(reply, status, payload) {
  reply.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  reply.end(JSON.stringify(payload))
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch { return {} }
}

/** 读取 logs/ 下某天的日志（默认今天），限制大小避免拖垮控制台。 */
async function readLog(date, metaOnly = false) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10)
  const file = join(logsDir, `${safeDate}.log`)
  if (!existsSync(file)) {
    return { date: safeDate, content: '', files: await listLogs(), bytes: 0, mtimeMs: 0 }
  }
  const stat = await (await import('node:fs/promises')).stat(file)
  // 轻量探测：只回报文件大小与修改时间，供前端判断是否需要重新拉内容
  if (metaOnly) {
    return {
      date: safeDate,
      meta: true,
      bytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      truncated: stat.size > 256 * 1024,
      files: await listLogs(),
    }
  }
  // 只读末尾 256KB
  const start = Math.max(0, stat.size - 256 * 1024)
  const buffer = Buffer.alloc(stat.size - start)
  if (start > 0 || stat.size > 0) {
    const fh = await (await import('node:fs/promises')).open(file, 'r')
    await fh.read(buffer, 0, buffer.length, start)
    await fh.close()
  }
  return {
    date: safeDate,
    truncated: start > 0,
    content: buffer.toString('utf8'),
    files: await listLogs(),
    bytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  }
}

async function listLogs() {
  try {
    return (await readdir(logsDir)).filter(name => name.endsWith('.log')).sort().reverse()
  } catch {
    return []
  }
}

await loadSettings()

const server = createServer(async (request, reply) => {
  const url = new URL(request.url, `http://127.0.0.1:${PANEL_PORT}`)
  const path = url.pathname

  try {
    // ---- 控制接口 ----
    if (path === '/api/status') {
      const running = await serviceRunningLive()
      const status = {
        running,
        pid: serverProcess?.pid ?? null,
        startedAt: startedAt ? new Date(startedAt).toISOString() : null,
        uptimeMs: startedAt ? Date.now() - startedAt : 0,
        uptimeText: startedAt ? formatUptime(Date.now() - startedAt) : '—',
        clientUrl: `http://${lanIp()}:${SERVER_PORT}/`,
        lastExit,
      }
      status.auth = panelSession.user
        ? { username: panelSession.user.username, displayName: panelSession.user.displayName, role: panelSession.user.role }
        : null
      // 服务在运行时用控制台自己的令牌取流量与限流数据
      if (running) {
        if (!panelSession.token) {
          status.monitor = { unauthorized: true }
        } else {
          try {
            const monitor = await mainFetch('/api/admin/monitor')
            if (monitor.status === 401) panelSession = { token: '', user: null }
            status.monitor = monitor.ok ? await monitor.json() : { unauthorized: true }
          } catch {
            status.monitor = { unreachable: true }
          }
        }
      }
      return json(reply, 200, status)
    }

    // ---- 控制台登录（管理员账号） ----
    if (path === '/api/panel/login' && request.method === 'POST') {
      if (!serverRunning()) return json(reply, 409, { error: '服务未运行，请先启动服务' })
      const body = await readBody(request)
      try {
        const response = await fetch('http://127.0.0.1:' + SERVER_PORT + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: body.username, password: body.password }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
          return json(reply, response.status, { error: payload.error || '登录失败' })
        }
        if (!payload.user || payload.user.role !== 'admin') {
          return json(reply, 403, { error: '该账号不是管理员，无法使用控制台' })
        }
        // 从 Set-Cookie 取出会话令牌，之后以 Bearer 方式调用管理端接口
        const cookie = response.headers.get('set-cookie') || ''
        const cookieMatch = cookie.match(/huajing_session=([^;]+)/)
        if (!cookieMatch) return json(reply, 500, { error: '登录成功但未取到会话令牌' })
        panelSession = { token: cookieMatch[1], user: payload.user }
        return json(reply, 200, { user: payload.user })
      } catch (error) {
        return json(reply, 502, { error: '主服务无响应：' + error.message })
      }
    }

    if (path === '/api/panel/logout' && request.method === 'POST') {
      panelSession = { token: '', user: null }
      return json(reply, 200, { ok: true })
    }

    if (path === '/api/panel/me') {
      return json(reply, 200, { user: panelSession.user })
    }

    // ---- 原后台管理页内容：账号管理 / 生图统计 / 生图趋势 ----
    if (path === '/api/admin/users') {
      if (request.method === 'GET') return proxyJson(reply, '/api/admin/users')
      if (request.method === 'POST') {
        return proxyJson(reply, '/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await readBody(request)),
        })
      }
    }

    const userPathMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (userPathMatch) {
      const id = decodeURIComponent(userPathMatch[1])
      if (request.method === 'PATCH') {
        return proxyJson(reply, '/api/admin/users/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await readBody(request)),
        })
      }
      if (request.method === 'DELETE') {
        return proxyJson(reply, '/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' })
      }
    }

    if (path === '/api/admin/quotas') return proxyJson(reply, '/api/admin/quotas')

    const quotaPathMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/quota$/)
    if (quotaPathMatch && request.method === 'PUT') {
      const id = decodeURIComponent(quotaPathMatch[1])
      return proxyJson(reply, '/api/admin/users/' + encodeURIComponent(id) + '/quota', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await readBody(request)),
      })
    }

    if (path === '/api/admin/stats') return proxyJson(reply, '/api/admin/stats')

    // 自助申请的审核：列表与通过/拒绝
    if (path === '/api/admin/registrations') return proxyJson(reply, '/api/admin/registrations')

    const registrationMatch = path.match(/^\/api\/admin\/registrations\/([^/]+)\/(approve|reject)$/)
    if (registrationMatch && request.method === 'POST') {
      const id = decodeURIComponent(registrationMatch[1])
      return proxyJson(
        reply,
        '/api/admin/registrations/' + encodeURIComponent(id) + '/' + registrationMatch[2],
        { method: 'POST' },
      )
    }

    if (path === '/api/admin/stats/trend') {
      const range = url.searchParams.get('range') || '7d'
      return proxyJson(reply, '/api/admin/stats/trend?range=' + encodeURIComponent(range))
    }

    // 桌面端退出前调用：停服务 + 关闭控制台自身（只在嵌入模式开放，且只接受本机）
    if (path === '/api/panel/shutdown' && request.method === 'POST') {
      if (!EMBEDDED) return json(reply, 404, { error: '未启用嵌入模式' })
      const remote = request.socket.remoteAddress || ''
      if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)) {
        return json(reply, 403, { error: '仅允许本机调用' })
      }
      json(reply, 200, { ok: true })
      setTimeout(async () => {
        try { await stopServer() } catch {}
        try { server.close(() => process.exit(0)) } catch { process.exit(0) }
      }, 80)
      return
    }

    // 上游（Magpie）地址设置：控制台自己的配置，改了要重启主服务才生效
    if (path === '/api/upstream') {
      if (!panelSession.token && !desktopAuthorized(request)) return notLoggedIn(reply)
      if (request.method === 'GET') {
        const baseUrl = effectiveUpstream()
        const probe = await probeUpstream(baseUrl)
        return json(reply, 200, {
          baseUrl,
          saved: upstreamSettings.magpieBaseUrl,
          envDefault: DEFAULT_UPSTREAM,
          model: upstreamModel,
          ...probe,
        })
      }
      if (request.method === 'PUT') {
        const body = await readBody(request)
        let baseUrl
        try {
          baseUrl = normalizeUpstreamUrl(body.baseUrl)
        } catch (error) {
          return json(reply, 400, { error: error.message })
        }
        upstreamSettings.magpieBaseUrl = baseUrl
        await saveSettings()
        // 主服务只在启动时读配置，改完必须重启才生效
        const result = await restartServer()
        return json(reply, 200, {
          ok: true,
          baseUrl,
          restarted: result.ok !== false,
          message: '已保存并重启服务，请重新登录控制台',
        })
      }
      return json(reply, 405, { error: '不支持的方法' })
    }

    if (path === '/api/upstream/test' && request.method === 'POST') {
      if (!panelSession.token && !desktopAuthorized(request)) return notLoggedIn(reply)
      const body = await readBody(request)
      let baseUrl
      try {
        baseUrl = normalizeUpstreamUrl(body.baseUrl)
      } catch (error) {
        return json(reply, 400, { error: error.message })
      }
      return json(reply, 200, { baseUrl, ...(await probeUpstream(baseUrl)) })
    }

    // 控制类操作需要登录；唯一例外是「服务未运行时允许启动」——
    // 登录凭证由主服务校验，不先启动就无从登录，必须留这个引导口子。
    if (path === '/api/start' && request.method === 'POST') {
      const allowed = panelSession.token || desktopAuthorized(request)
      if (serverRunning() && !allowed) return notLoggedIn(reply)
      return json(reply, 200, await startServer())
    }
    if (path === '/api/stop' && request.method === 'POST') {
      if (!panelSession.token && !desktopAuthorized(request)) return notLoggedIn(reply)
      return json(reply, 200, await stopServer())
    }
    if (path === '/api/restart' && request.method === 'POST') {
      if (!panelSession.token && !desktopAuthorized(request)) return notLoggedIn(reply)
      return json(reply, 200, await restartServer())
    }

    if (path === '/api/rate-limit') {
      if (request.method === 'GET') return proxyJson(reply, '/api/admin/rate-limit')
      if (request.method === 'PUT') {
        return proxyJson(reply, '/api/admin/rate-limit', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await readBody(request)),
        })
      }
    }

    // 生图并发上限：运行时调整，无需重启服务
    if (path === '/api/concurrency') {
      if (request.method === 'GET') return proxyJson(reply, '/api/admin/concurrency')
      if (request.method === 'PUT') {
        return proxyJson(reply, '/api/admin/concurrency', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(await readBody(request)),
        })
      }
    }

    if (path.startsWith('/api/logs')) {
      if (!panelSession.token) return notLoggedIn(reply)
      const date = url.searchParams.get('date') || ''
      const metaOnly = url.searchParams.get('meta') === '1'
      return json(reply, 200, await readLog(date, metaOnly))
    }

    // ---- 静态页面 ----
    if (path === '/' || path === '/index.html') {
      reply.writeHead(200, { 'Content-Type': MIME.html })
      return reply.end(panelHtml())
    }
    if (path === '/panel.js') {
      reply.writeHead(200, { 'Content-Type': MIME.js })
      return reply.end(panelJs())
    }

    // 主服务的客户端页面直接代理：控制台里可内嵌使用
    if (serverRunning() && (path.startsWith('/api/') || path.startsWith('/assets/'))) {
      const upstream = await fetch(`http://127.0.0.1:${SERVER_PORT}${request.url}`, {
        method: request.method,
        headers: { cookie: request.headers.cookie || '' },
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request,
        duplex: 'half',
      })
      reply.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
      return reply.end(Buffer.from(await upstream.arrayBuffer()))
    }

    reply.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    reply.end('Not Found')
  } catch (error) {
    json(reply, 500, { error: error.message })
  }
})

function lanIp() {
  const candidates = []
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) candidates.push(address.address)
    }
  }
  // 优先家用局域网段，避开虚拟网卡地址（如 WSL 的 172.21.x）
  const homeLan = candidates.find(ip => /^192\.168\./.test(ip))
    || candidates.find(ip => /^10\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('10.99.'))
  return homeLan || candidates[0] || '127.0.0.1'
}

function formatUptime(ms) {
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hh = String(Math.floor((totalSec % 86400) / 3600)).padStart(2, '0')
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')
  const ss = String(totalSec % 60).padStart(2, '0')
  return days > 0 ? `${days} 天 ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`
}

function panelHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>画境 · 服务控制台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23425a46'/%3E%3Ctext x='16' y='23' font-size='18' text-anchor='middle' fill='%23fffdf8' font-family='serif'%3E境%3C/text%3E%3C/svg%3E">
<style>
  :root {
    /* 表面层次：靠 1%~3% 明度差分层，不用纯黑、不用重阴影 */
    --bg: #f3ece0;
    --surface: #fffdf8;
    --surface-sunken: #f7f2e7;
    --ink: #23201c;
    --ink-soft: #5f6a61;
    --ink-faint: #63695f;
    --hair: rgba(35, 32, 28, .09);
    --hair-soft: rgba(35, 32, 28, .05);
    --green: #3d5544;
    --green-ink: #2f4436;
    --green-tint: rgba(61, 85, 68, .07);
    --red: #9c3d2b;
    --red-tint: rgba(156, 61, 43, .08);
    --amber: #a87c25;
    --amber-tint: rgba(168, 124, 37, .1);

    --radius-card: 14px;
    --radius-inner: 10px;
    --radius-field: 7px;

    /* 单一缓动曲线：指数型 ease-out，从已可见状态出发 */
    --ease: cubic-bezier(.22, .61, .16, 1);
    --dur: .24s;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    background: var(--bg);
    color: var(--ink);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  /* 浏览器自带表面也纳入设计：选区、光标、滚动条 */
  ::selection { background: rgba(61, 85, 68, .18); }
  input, textarea, select { caret-color: var(--green); }
  ::placeholder { color: var(--ink-faint); opacity: 1; }
  * { scrollbar-width: thin; scrollbar-color: rgba(35,32,28,.22) transparent; }
  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-thumb {
    background: rgba(35, 32, 28, .2);
    border: 3px solid transparent;
    background-clip: content-box;
    border-radius: 99px;
  }
  *::-webkit-scrollbar-thumb:hover { background: rgba(35, 32, 28, .32); background-clip: content-box; }

  /* 数字锁死，避免刷新跳动 */
  .stat b, .metrics dd, td, #st-uptime, #log-meta, .status-pill, .trend-axis-label {
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum";
  }
  p::after, .msg::after { content: ""; display: inline-block; width: 1.6em; }

  :focus-visible {
    outline: 2px solid var(--green);
    outline-offset: 2px;
  }

  /* ===== 顶栏 ===== */
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 16px;
    padding: 12px 32px;
    background: var(--green);
    color: #fdfbf6;
  }
  header h1 {
    display: flex; align-items: center; gap: 9px;
    margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .01em;
    min-width: 0; white-space: nowrap;
  }
  header h1 span { overflow: hidden; text-overflow: ellipsis; }
  header .brand { display: flex; align-items: center; min-width: 0; flex: 1 1 auto; }
  .status-pill {
    margin-left: auto;
    white-space: nowrap;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 13px 5px 10px;
    border-radius: 999px;
    background: rgba(255, 253, 248, .1);
    font-size: 12px; font-weight: 500;
  }
  .status-pill .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #d99c8c;
    transition: background var(--dur) var(--ease);
  }
  .status-pill.on { background: rgba(159, 214, 168, .16); }
  .status-pill.on .dot { background: #9fd6a8; }
  .header-user { display: flex; align-items: center; gap: 10px; font-size: 12px; white-space: nowrap; }
  .header-user .who {
    color: rgba(253, 251, 246, .82);
    max-width: 140px; overflow: hidden; text-overflow: ellipsis;
  }

  /* ===== 布局：单栏控制台 ===== */
  .console-main {
    max-width: 1440px; margin: 0 auto;
    padding: 22px 32px 48px;
    display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px;
    align-content: start;
  }
  body.logged-out .console-main { min-height: calc(100vh - 56px); align-content: center; }

  /* 卡片：只声明一层边界（边框），不再叠加投影 */
  section {
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--hair);
    border-radius: var(--radius-card);
    padding: 18px 20px 20px;
  }
  /* 宽表格自己横向滚动，不把整页撑破 */
  .table-scroll {
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }
  .table-scroll > table { min-width: 520px; }
  /* 表格已在自身容器内横向滚动，单元格不再折行（避免「管理/员」被拆开） */
  .table-scroll th, .table-scroll td { white-space: nowrap; }
  section.bootstrap-card { border-color: rgba(168, 124, 37, .32); background: #fffcf3; }

  .sec-head {
    display: flex; align-items: baseline; gap: 12px;
    margin-bottom: 14px;
  }
  .sec-head h2 {
    margin: 0; font-size: 13px; font-weight: 600;
    letter-spacing: .02em; color: var(--ink);
  }
  .sec-head .hint { margin-left: auto; font-size: 11.5px; color: var(--ink-faint); }
  .sec-head .hint.warn, .msg.err { color: var(--red); }

  /* ===== 按钮 ===== */
  button {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    white-space: nowrap;
    border: 0; border-radius: 999px;
    padding: 9px 18px;
    font: inherit; font-size: 12.5px; font-weight: 600;
    cursor: pointer;
    transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
                transform .12s var(--ease), box-shadow var(--dur) var(--ease);
  }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .btn-start { background: var(--green); color: #fdfbf6; }
  .btn-start:hover:not(:disabled) { background: var(--green-ink); }
  .btn-stop { background: var(--red-tint); color: var(--red); }
  .btn-stop:hover:not(:disabled) { background: rgba(156, 61, 43, .14); }
  .btn-restart { background: var(--amber-tint); color: var(--amber); }
  .btn-restart:hover:not(:disabled) { background: rgba(168, 124, 37, .17); }
  .btn-mini {
    padding: 6px 13px; font-size: 12px; font-weight: 500;
    background: rgba(35, 32, 28, .045); color: var(--ink-soft);
  }
  .btn-mini:hover { background: rgba(35, 32, 28, .08); color: var(--ink); }
  .btn-mini.ghost-light {
    background: rgba(255, 253, 248, .12); color: #fdfbf6;
  }
  .btn-mini.ghost-light:hover { background: rgba(255, 253, 248, .2); color: #fff; }
  /* ===== 上游地址设置 ===== */
  .upstream-block {
    margin-top: 16px; padding-top: 14px;
    border-top: 1px solid var(--hair-soft);
  }
  .upstream-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .upstream-title { font-size: 12px; font-weight: 600; color: var(--ink-soft); }
  .upstream-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .upstream-input {
    flex: 1 1 240px; min-width: 180px; height: 32px; padding: 0 10px;
    border: 1px solid var(--hair); border-radius: var(--radius-field);
    background: var(--surface); color: var(--ink); font-family: inherit; font-size: 12.5px;
  }
  .upstream-input:focus {
    outline: none; border-color: var(--green);
    box-shadow: 0 0 0 3px var(--green-tint);
  }
  .btn-mini.primary-mini { background: var(--green-tint); color: var(--green-ink); }
  .btn-mini.primary-mini:hover { background: rgba(61, 85, 68, .14); color: var(--green-ink); }
  .upstream-note {
    margin: 8px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--ink-faint);
    word-break: break-all;
  }

  /* ===== 指标条：一行标签+数值，用细线分隔，不再套卡片 ===== */
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 210px));
    margin: 0;
    border-top: 1px solid var(--hair-soft);
  }
  .metrics > div {
    padding: 12px 16px 4px 0;
    border-right: 1px solid var(--hair-soft);
  }
  .metrics > div:last-child { border-right: 0; }
  .metrics dt {
    font-size: 11.5px; color: var(--ink-faint);
    margin-bottom: 2px;
  }
  .metrics dd {
    margin: 0;
    font-size: 19px; font-weight: 600; letter-spacing: -.01em;
    color: var(--ink);
  }
  .metrics dd.small { font-size: 13px; font-weight: 500; }
  .metrics dd.good { color: var(--green-ink); }
  .metrics dd.warn { color: var(--red); }

  .msg { font-size: 11.5px; color: var(--ink-soft); min-height: 17px; }
  .msg.ok { color: var(--green-ink); }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

  /* ===== 表格：去掉外层盒子，靠行分隔线与表头底色 ===== */
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  thead th {
    text-align: left; padding: 8px 12px;
    font-size: 11px; font-weight: 600; letter-spacing: .03em;
    color: var(--ink-faint);
    background: var(--surface-sunken);
    border-bottom: 1px solid var(--hair-soft);
    white-space: nowrap;
  }
  thead th:first-child { border-radius: var(--radius-field) 0 0 0; }
  thead th:last-child { border-radius: 0 var(--radius-field) 0 0; }
  tbody td {
    padding: 9px 12px;
    border-bottom: 1px solid var(--hair-soft);
    vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: rgba(61, 85, 68, .035); }
  td.num { font-weight: 600; }
  td .rej { color: var(--red); font-weight: 600; }
  td .idle { color: var(--ink-faint); }
  td .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  td .row-btn {
    padding: 4px 10px; font-size: 11.5px; font-weight: 500;
    border-radius: var(--radius-field);
    background: rgba(35, 32, 28, .045); color: var(--ink-soft);
  }
  td .row-btn:hover { background: rgba(35, 32, 28, .09); color: var(--ink); }
  td .row-btn.danger { background: var(--red-tint); color: var(--red); }
  td .row-btn.danger:hover { background: rgba(156, 61, 43, .15); }
  .role-badge {
    display: inline-block; padding: 2px 8px;
    border-radius: 999px; font-size: 11px;
    background: rgba(35, 32, 28, .05); color: var(--ink-soft);
  }
  .status-badge { font-size: 11.5px; font-weight: 600; color: var(--green-ink); }
  .status-badge.off { color: var(--red); }
  .table-empty { text-align: center; color: var(--ink-faint); padding: 20px 12px; font-size: 12px; }
  .table-block { margin-top: 16px; }
  /* 待审核区与账号表之间留出距离，避免两段表格标题连成一片 */
  .pending-block { margin: 16px 0 18px; }
  .table-caption {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    font-size: 11.5px; font-weight: 500; color: var(--ink-soft);
    margin-bottom: 6px;
  }
  .caption-note { font-size: 11px; color: var(--ink-faint); }
  /* 排行序号：窄列 + 等宽数字，前三名给一层极浅的底色 */
  th.rank-col, td.rank-col { width: 38px; text-align: right; padding-right: 4px; }
  .rank {
    display: inline-block; min-width: 22px; padding: 1px 6px;
    border-radius: 6px; text-align: center;
    font-size: 11.5px; font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink-faint);
  }
  .rank.top { background: var(--green-tint); color: var(--green-ink); }
  /* 在线状态点（替代表情符号） */
  .live-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--green); margin-right: 6px; vertical-align: 1px;
  }

  /* ===== 表单 ===== */
  /* ===== 登录页：左说明 + 右表单 ===== */
  .login-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
    gap: 0;
    padding: 0;
    overflow: hidden;
    max-width: 860px;
    width: 100%;
    margin: 0 auto;
  }
  /* display 会压过 hidden 属性的默认隐藏，必须显式声明，否则登录后卡片还在 */
  .login-card[hidden] { display: none; }
  .login-brand {
    display: flex; flex-direction: column; gap: 14px;
    padding: 28px 30px;
    background: linear-gradient(160deg, rgba(61, 85, 68, .07), rgba(61, 85, 68, .02) 60%);
    border-right: 1px solid var(--hair);
  }
  .login-mark {
    display: inline-flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; border-radius: 12px;
    background: var(--green); color: #fdfbf6;
  }
  .login-title {
    margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .01em;
  }
  .login-sub {
    margin: 6px 0 0;
    font-size: 12px; line-height: 1.7; color: var(--ink-soft);
    max-width: 34ch;
  }
  .login-facts {
    margin: auto 0 0;
    display: grid; gap: 10px;
    padding-top: 16px;
    border-top: 1px solid var(--hair);
  }
  .login-facts > div { display: flex; align-items: baseline; gap: 10px; }
  .login-facts dt { font-size: 11.5px; color: var(--ink-faint); min-width: 66px; }
  .login-facts dd {
    margin: 0; font-size: 12.5px; font-weight: 500;
    overflow-wrap: anywhere;
  }
  .login-facts dd.ok { color: var(--green-ink); }
  .login-facts dd.off { color: var(--red); }
  .login-facts dd.mono { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11.5px; }

  .login-form {
    display: flex; flex-direction: column; gap: 14px;
    padding: 28px 30px 26px;
  }
  .login-form-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .login-form-head p { margin: 5px 0 0; font-size: 11.5px; line-height: 1.65; color: var(--ink-faint); }
  .login-field { display: flex; flex-direction: column; gap: 6px; }
  .login-field > span { font-size: 12px; color: var(--ink-soft); }
  /* 登录页输入框必须占满整列：特异性要压过下面通用的 width:170px 规则 */
  .login-card .login-field input { width: 100%; padding: 10px 12px; font-size: 13px; }
  .login-card .login-pass-wrap { position: relative; display: block; }
  .login-card .login-pass-wrap input { padding-right: 42px; }
  .login-eye {
    position: absolute; top: 50%; right: 6px; transform: translateY(-50%);
    width: 28px; height: 28px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; background: transparent; color: var(--ink-faint);
  }
  .login-eye svg { width: 15px; height: 15px; }
  .login-eye:hover { background: rgba(35, 32, 28, .06); color: var(--ink); }
  .login-eye[aria-pressed="true"] { color: var(--green-ink); }
  .login-submit { width: 100%; padding: 11px 18px; font-size: 13px; }
  .login-submit:disabled { opacity: .6; }
  .login-form .msg { min-height: 0; margin: 0; }
  .login-form .msg.err { animation: loginErr .22s var(--ease); }
  @keyframes loginErr {
    from { opacity: 0; transform: translateY(-2px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .rl-row label {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--ink-soft);
  }
  input[type=text], input[type=password], input[type=number], select {
    padding: 8px 11px;
    border: 1px solid var(--hair);
    border-radius: var(--radius-field);
    background: var(--surface);
    color: var(--ink);
    font: inherit; font-size: 12.5px;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }
  input[type=text], input[type=password] { width: 170px; }
  input[type=number] { width: 108px; }
  input:hover, select:hover { border-color: rgba(35, 32, 28, .18); }
  input:focus, select:focus {
    outline: none;
    border-color: var(--green);
    box-shadow: 0 0 0 3px rgba(61, 85, 68, .1);
  }
  .rl-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .switch-wrap { cursor: pointer; }
  .switch { position: relative; width: 40px; height: 22px; flex: none; }
  .switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; position: absolute; z-index: 2; }
  .switch .track {
    position: absolute; inset: 0; border-radius: 999px;
    background: rgba(35, 32, 28, .16);
    transition: background var(--dur) var(--ease);
  }
  .switch .knob {
    position: absolute; top: 3px; left: 3px;
    width: 16px; height: 16px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(35, 32, 28, .28);
    transition: left var(--dur) var(--ease);
  }
  .switch input:checked ~ .track { background: var(--green); }
  .switch input:checked ~ .track .knob { left: 21px; }

  /* ===== 趋势图 ===== */
  /* ===== 趋势图：白底 + 虚线网格 + 渐变面积 ===== */
  .trend-toolbar {
    display: flex; align-items: center; gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  /* 分段胶囊：底色浅灰，选中项白底带投影 */
  .trend-tabs {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 3px; border-radius: 999px;
    background: rgba(35, 32, 28, .05);
    max-width: 100%; overflow-x: auto;
    scrollbar-width: none;
  }
  .trend-tabs::-webkit-scrollbar { display: none; }
  .trend-tab {
    padding: 5px 13px; font-size: 12px; font-weight: 500;
    border-radius: 999px; background: transparent; color: var(--ink-soft);
    border: 0;
    transition: background .18s ease, color .18s ease, box-shadow .18s ease;
  }
  .trend-tab:hover:not(.active) { color: var(--ink); }
  .trend-tab.active {
    background: var(--surface); color: var(--ink);
    box-shadow: 0 1px 2px rgba(35, 32, 28, .1), 0 0 0 1px rgba(35, 32, 28, .04);
  }
  .trend-views {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 3px; border-radius: 999px;
    background: rgba(35, 32, 28, .05);
    margin-left: 2px;
  }
  .trend-view {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 24px; padding: 0;
    border-radius: 999px; background: transparent; color: var(--ink-faint);
    border: 0;
  }
  .trend-view svg { width: 13px; height: 13px; }
  .trend-view:hover { color: var(--ink); }
  .trend-view.active {
    background: var(--surface); color: var(--ink);
    box-shadow: 0 1px 2px rgba(35, 32, 28, .1), 0 0 0 1px rgba(35, 32, 28, .04);
  }

  .trend-wrap { position: relative; }
  .trend-chart { display: block; width: 100%; height: 240px; }
  /* 虚线网格 */
  .trend-grid {
    stroke: rgba(35, 32, 28, .12);
    stroke-width: 1;
    stroke-dasharray: 2 6;
  }
  .trend-axis-label { font-size: 10.5px; fill: var(--ink-faint); letter-spacing: .01em; }
  .trend-area { stroke: none; }
  .trend-line {
    fill: none; stroke: var(--green); stroke-width: 2.4;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .trend-bar {
    fill: var(--green); opacity: .75;
    transition: opacity .16s ease;
  }
  .trend-bar:hover { opacity: 1; }
  /* 数据点：默认隐藏，悬停时才浮出（贴近参考图的无点风格） */
  .trend-dot-visible { opacity: 0; transition: opacity .16s ease; }
  .trend-dot:hover .trend-dot-visible { opacity: 1; }
  .trend-dot-hit { fill: transparent; }

  /* 悬停浮层：显示该时间段的张数与各账号的 token 消耗 */
  .trend-tooltip {
    position: absolute;
    z-index: 5;
    min-width: 168px;
    max-width: 260px;
    padding: 9px 11px;
    border-radius: 10px;
    background: rgba(31, 36, 32, .92);
    border: 1px solid rgba(255, 255, 255, .16);
    box-shadow: 0 10px 28px rgba(0, 0, 0, .28);
    color: #eef3ec;
    font-size: 11.5px;
    line-height: 1.55;
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity .14s ease, transform .14s ease;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .trend-tooltip.visible { opacity: 1; transform: translateY(0); }
  .trend-tooltip[hidden] { display: none; }
  .trend-tooltip .tt-head {
    display: flex; align-items: baseline; gap: 8px;
    padding-bottom: 6px; margin-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, .12);
  }
  .trend-tooltip .tt-label { font-weight: 600; font-size: 12px; }
  .trend-tooltip .tt-total { margin-left: auto; color: rgba(238, 243, 236, .72); font-variant-numeric: tabular-nums; }
  .trend-tooltip .tt-row {
    display: flex; align-items: baseline; gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .trend-tooltip .tt-user {
    max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: rgba(238, 243, 236, .92);
  }
  .trend-tooltip .tt-num { margin-left: auto; color: rgba(238, 243, 236, .72); }
  .trend-tooltip .tt-empty { color: rgba(238, 243, 236, .5); }
  .trend-empty {
    position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 12px; color: var(--ink-faint);
  }
  .trend-empty[hidden] { display: none; }

  /* ===== 日志：等宽是内容需要，不是装饰 ===== */
  .log-bar {
    display: flex; gap: 8px 10px; align-items: center; flex-wrap: wrap;
    margin-bottom: 10px; position: relative;
  }
  .log-auto {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11.5px; color: var(--ink-soft); cursor: pointer;
    user-select: none;
  }
  .log-auto input { accent-color: var(--green); width: 13px; height: 13px; margin: 0; }
  .log-wrap {
    position: relative;
    background: #1f2422;
    border-radius: var(--radius-inner);
    overflow: hidden;
    /* 滚轮只在日志内部滚动，不把整页带走 */
    overscroll-behavior: contain;
  }
  pre {
    margin: 0;
    padding: 14px 16px;
    max-height: 360px;
    overflow: auto;
    color: #c8d8cb;
    font: 11px/1.75 Consolas, "Cascadia Mono", monospace;
    /* 侧栏宽度有限：软换行（优先在词边界断开），避免长 JSON 只能横向拖 */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 2;
    overscroll-behavior: contain;
  }
  pre::selection, pre *::selection { background: rgba(159, 214, 168, .25); }

  /* 日志滚动条：平时隐去，鼠标移进日志窗口才浮现（深色区用浅色滑块） */
  #log-content {
    scrollbar-width: thin;
    scrollbar-color: transparent transparent;
  }
  #log-content:hover { scrollbar-color: rgba(232, 244, 233, .38) transparent; }
  #log-content::-webkit-scrollbar { width: 10px; height: 10px; }
  #log-content::-webkit-scrollbar-track { background: transparent; }
  #log-content::-webkit-scrollbar-thumb {
    background: transparent;
    border: 3px solid transparent;
    background-clip: content-box;
    border-radius: 99px;
  }
  #log-content:hover::-webkit-scrollbar-thumb {
    background: rgba(232, 244, 233, .34);
    background-clip: content-box;
  }
  #log-content::-webkit-scrollbar-thumb:hover {
    background: rgba(232, 244, 233, .58);
    background-clip: content-box;
  }
  /* 跳至最新：日志窗口底部居中的细描边幽灵（唯一风格）
     只留一圈描边，按钮范围内是雾面玻璃——被盖住的日志文字会明显模糊，
     叠一层冷白薄雾与内外微光，形成「文字被雾气压住并透出弱光」的观感。 */
  .jump-latest {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translate(-50%, 0);
    z-index: 3;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px;
    font-size: 11.5px; font-weight: 500;
    color: #f4f7f3;
    background:
      radial-gradient(120% 130% at 50% 0%, rgba(236, 248, 239, .1), rgba(236, 248, 239, .05) 70%);
    border: 1px solid rgba(255, 255, 255, .46);
    box-shadow:
      0 0 18px rgba(228, 244, 233, .13),
      inset 0 0 16px rgba(228, 244, 233, .09);
    backdrop-filter: blur(14px) saturate(135%);
    -webkit-backdrop-filter: blur(14px) saturate(135%);
    text-shadow: 0 0 10px rgba(228, 244, 233, .5);
    animation: jumpIn .24s cubic-bezier(.22, .61, .16, 1);
  }
  .jump-latest:hover {
    background: rgba(255, 255, 255, .09);
    border-color: rgba(255, 255, 255, .72);
    box-shadow:
      0 0 22px rgba(228, 244, 233, .2),
      inset 0 0 14px rgba(228, 244, 233, .1);
  }
  /* 全局 button:active 的 translateY 会覆盖居中用的 translateX(-50%)，
     导致按下瞬间按钮右移半个宽度，这里显式保住水平居中 */
  .jump-latest:active:not(:disabled) { transform: translate(-50%, 1px); }
  .jump-latest[hidden] { display: none; }
  @keyframes jumpIn {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  /* ===== 水墨晕染：单字 90ms 模糊到清晰，相邻字错开 30ms ===== */
  .ink-reveal .ch {
    display: inline-block;
    animation: inkIn 90ms var(--ease) both;
    animation-delay: calc(var(--ch-index) * 30ms);
  }
  @keyframes inkIn {
    from { filter: blur(3px); opacity: 0; transform: translateY(2px); }
    to { filter: blur(0); opacity: 1; transform: translateY(0); }
  }
  .inline-icon { vertical-align: -0.125em; }
  .pop { animation: pop .38s var(--ease); }
  @keyframes pop {
    0% { transform: scale(1); }
    45% { transform: scale(1.08); }
    100% { transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .ink-reveal .ch, .pop { animation: none; }
    * { transition-duration: .01ms !important; }
  }

  /* ===== 暗色：黑底白字的光晕补偿——字重整体调细一档 ===== */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #171a17;
      --surface: #1f2320;
      --surface-sunken: #1a1e1b;
      --ink: #e6e2d8;
      --ink-soft: #a4ada2;
      --ink-faint: #8b948a;
      --hair: rgba(230, 226, 216, .1);
      --hair-soft: rgba(230, 226, 216, .06);
      --green: #5e7a64;
      --green-ink: #a8c2ac;
      --green-tint: rgba(148, 186, 155, .1);
      --red: #cf8574;
      --red-tint: rgba(207, 133, 116, .12);
      --amber: #c9a45e;
      --amber-tint: rgba(201, 164, 94, .12);
    }
    /* 趋势图在暗色下：网格与分段胶囊要用浅色，否则看不见 */
    .trend-grid { stroke: rgba(230, 226, 216, .14); }
    .trend-tabs, .trend-views { background: rgba(255, 255, 255, .06); }
    .trend-tab.active, .trend-view.active {
      background: rgba(255, 255, 255, .12);
      color: var(--ink);
      box-shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 0 0 1px rgba(255, 255, 255, .08);
    }
    .trend-bar { opacity: .8; }
    body { font-weight: 300; }
    header h1, .sec-head h2, .metrics dd, td.num, button { font-weight: 400; }
    .metrics dd { font-weight: 400; }
    .btn-start { background: #3f5a46; color: #f2f6f0; }
    .btn-start:hover:not(:disabled) { background: #47654e; }
    /* 表格行内小按钮：浅色主题的深色薄底在暗色下等于没有，换一层亮底 */
    .btn-mini.primary-mini { background: rgba(148, 186, 155, .16); }
    .btn-mini.primary-mini:hover { background: rgba(148, 186, 155, .24); }
    td .row-btn { background: rgba(255, 255, 255, .07); }
    td .row-btn:hover { background: rgba(255, 255, 255, .13); }
    .log-wrap { background: #141714; }
    pre { color: #b9c9bc; font-weight: 300; }
    section { background: var(--surface); }
  }

  /* ===== 宽屏：运行日志放到「服务控制」右侧，其余板块通栏 ===== */
  @media (min-width: 1200px) {
    .console-main {
      grid-template-columns: minmax(0, 1fr) minmax(400px, 500px);
      grid-template-areas:
        "service   logs"
        "accounts  accounts"
        "stats     stats"
        "trend     trend"
        "traffic   traffic"
        "ratelimit ratelimit"
        "concurrency concurrency";
      /* 第一行两块等高对齐，避免左侧卡片下方留空档 */
      align-items: stretch;
    }
    #login-card, .bootstrap-card { grid-column: 1 / -1; }
    #sec-service   { grid-area: service; }
    #sec-logs      { grid-area: logs; }
    #sec-accounts  { grid-area: accounts; }
    #sec-stats     { grid-area: stats; }
    #sec-trend     { grid-area: trend; }
    #sec-traffic   { grid-area: traffic; }
    #sec-ratelimit { grid-area: ratelimit; }
    #sec-concurrency { grid-area: concurrency; }
    /* 日志高度与左侧服务卡片相近，内部滚动，不撑高整行 */
    #sec-logs pre { height: 214px; max-height: 214px; }
    #sec-logs .log-wrap { flex: 0 0 auto; }
  }
  /* 中等宽度：日志回到正文流末尾，给足高度 */
  @media (max-width: 1199px) and (min-width: 901px) {
    #sec-logs pre { max-height: 420px; }
  }

  @media (max-width: 900px) {
    .login-card { grid-template-columns: 1fr; }
    .login-brand { border-right: 0; border-bottom: 1px solid var(--hair); padding: 22px; }
    .login-facts { margin-top: 4px; }
    .login-form { padding: 22px; }
    header h1 { min-width: 0; }
    header h1 span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .console-main { padding: 16px; }
    section { padding: 15px 14px 16px; }
    .sec-head { flex-wrap: wrap; gap: 4px 10px; }
    .sec-head .hint { margin-left: 0; }
    .metrics { grid-template-columns: repeat(2, 1fr); }
    .metrics > div { padding-right: 12px; }
    header { padding: 10px 16px; gap: 10px; }
    header h1 { font-size: 14px; }
    input[type=text], input[type=password] { width: 100%; }
    .login-form { flex-direction: column; align-items: stretch; }
    .jump-latest { margin-left: 0; }
  }
  @media (max-width: 560px) {
    /* 极窄屏：顶栏只保留必要信息，避免横向溢出 */
    .header-user .who { display: none; }
    .status-pill { padding: 4px 10px; font-size: 11px; }
    header h1 { font-size: 13.5px; }
    .metrics { grid-template-columns: 1fr; }
    .metrics > div { border-right: 0; border-bottom: 1px solid var(--hair-soft); }
    .metrics > div:last-child { border-bottom: 0; }
    table { font-size: 12px; }
    thead th, tbody td { padding: 7px 9px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand"><h1><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h8M8 13h5"/></svg><span>画境 · 服务控制台</span></h1></div>
  <div class="status-pill tnum" id="pill" role="status" aria-live="polite"><span class="dot"></span><span id="pill-text">检测中…</span></div>
  <div class="header-user" id="header-user">
    <span class="who" id="who" hidden></span>
    <button class="btn-mini ghost-light" id="btn-logout" type="button" hidden>退出</button>
  </div>
</header>
<main class="console-main">
  <section class="login-card" id="login-card" hidden>
    <div class="login-brand">
      <span class="login-mark" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7.5 9.5h9M7.5 13h5.5"/></svg>
      </span>
      <div>
        <h2 class="login-title">画境 · 服务控制台</h2>
        <p class="login-sub">局域网生图服务的管理入口。启动与停止服务、查看流量、管理账号与生图额度都在这里。</p>
      </div>
      <dl class="login-facts">
        <div>
          <dt>服务状态</dt>
          <dd id="login-status">检测中…</dd>
        </div>
        <div>
          <dt>客户端地址</dt>
          <dd class="mono" id="login-address">—</dd>
        </div>
      </dl>
    </div>

    <form class="login-form" id="login-form">
      <div class="login-form-head">
        <h3>登录控制台</h3>
        <p>使用管理员账号；账号由管理员在控制台内创建，本页不提供注册。</p>
      </div>

      <label class="login-field">
        <span>用户名</span>
        <input id="login-user" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required>
      </label>

      <label class="login-field">
        <span>密码</span>
        <span class="login-pass-wrap">
          <input id="login-pass" type="password" autocomplete="current-password" required>
          <button class="login-eye" id="login-eye" type="button" aria-label="显示密码" aria-pressed="false" title="显示密码">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>
          </button>
        </span>
      </label>

      <p class="msg" id="login-msg" role="alert"></p>
      <button class="btn-start login-submit" type="submit">登录</button>
    </form>
  </section>

  <section class="auth-only" id="sec-service" hidden>
    <div class="sec-head">
      <h2>服务控制</h2>
      <span class="hint" id="st-pid"></span>
    </div>
    <div class="controls">
      <button class="btn-start" id="btn-start" type="button">启动服务</button>
      <button class="btn-stop" id="btn-stop" type="button">停止服务</button>
      <button class="btn-restart" id="btn-restart" type="button">重启服务</button>
      <span class="msg" id="ctrl-msg"></span>
    </div>
    <dl class="metrics">
      <div><dt>服务状态</dt><dd class="good" id="st-running">—</dd></div>
      <div><dt>运行时间</dt><dd id="st-uptime">—</dd></div>
      <div><dt>客户端地址（局域网）</dt><dd class="small" id="st-url">—</dd></div>
    </dl>
    <div class="upstream-block">
      <div class="upstream-head">
        <span class="upstream-title">上游 Magpie</span>
        <span class="hint" id="upstream-hint">生图会转发到该地址的 /v1/images/generations</span>
      </div>
      <div class="upstream-row">
        <input class="upstream-input" id="upstream-url" type="text" spellcheck="false"
               autocomplete="off" aria-label="Magpie 地址" placeholder="http://127.0.0.1:3425">
        <button class="btn-mini" id="upstream-test" type="button">测试连通</button>
        <button class="btn-mini primary-mini" id="upstream-save" type="button">保存并重启</button>
      </div>
      <p class="upstream-note" id="upstream-note">正在读取当前地址…</p>
    </div>
  </section>

  <section class="bootstrap-card" id="bootstrap-card" hidden>
    <div class="sec-head">
      <h2>服务未运行</h2>
      <span class="hint">控制台登录由主服务校验，需要先启动服务</span>
    </div>
    <div class="controls">
      <button class="btn-start" id="btn-bootstrap-start" type="button">启动服务</button>
      <span class="msg" id="bootstrap-msg"></span>
    </div>
    <p class="msg" style="margin:10px 0 0">启动完成后，用管理员账号在本页登录即可使用全部功能。</p>
  </section>

  <section class="auth-only" id="sec-accounts" hidden>
    <div class="sec-head">
      <h2>账号管理</h2>
      <button class="btn-mini" id="btn-new-user" type="button">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        新建账号
      </button>
    </div>
    <div class="table-block pending-block" id="pending-block" hidden>
      <p class="table-caption">待审核申请<span class="caption-note" id="pending-note">客户端登录页提交的申请；通过后账号才能登录，拒绝会删掉这条记录</span></p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>用户名</th><th>显示名</th><th>申请时间</th><th>操作</th></tr></thead>
          <tbody id="pending-body"></tbody>
        </table>
      </div>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>生图数</th><th>token 消耗</th><th>今日额度</th><th>操作</th></tr></thead>
        <tbody id="users-body"><tr><td colspan="8" class="table-empty">未登录</td></tr></tbody>
      </table>
    </div>
  </section>

  <section class="auth-only" id="sec-stats" hidden>
    <div class="sec-head">
      <h2>生图统计</h2>
      <span class="hint" id="stats-hint"></span>
    </div>
    <dl class="metrics">
      <div><dt>累计生成</dt><dd id="st-total">—</dd></div>
      <div><dt>参与账号</dt><dd id="st-accounts">—</dd></div>
      <div><dt>占用空间</dt><dd id="st-bytes">—</dd></div>
      <div><dt>累计 token</dt><dd id="st-tokens">—</dd></div>
      <div><dt>平均每张 token</dt><dd id="st-avg">—</dd></div>
    </dl>
    <div class="table-block">
      <p class="table-caption">账号 token 排行<span class="caption-note">按累计消耗降序，均值只算有 token 数据的记录</span></p>
      <div class="table-scroll">
        <table>
          <thead><tr><th class="rank-col">#</th><th>账号</th><th>生成张数</th><th>累计 token</th><th>均值 / 张</th><th>占比</th><th>占用空间</th><th>最近生成</th></tr></thead>
          <tbody id="stats-body"><tr><td colspan="8" class="table-empty">—</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="table-block">
      <p class="table-caption">按画幅的 token 均值<span class="caption-note">画幅取自每次生成的比例</span></p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>画幅</th><th>生成张数</th><th>累计 token</th><th>均值 / 张</th><th>占比</th></tr></thead>
          <tbody id="ratio-body"><tr><td colspan="5" class="table-empty">—</td></tr></tbody>
        </table>
      </div>
    </div>
    <div class="table-block">
      <p class="table-caption">最近 50 条生成明细</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>时间</th><th>账号</th><th>类型</th><th>名称</th><th>画幅</th><th>尺寸</th><th>大小</th><th>token</th></tr></thead>
          <tbody id="recent-body"><tr><td colspan="8" class="table-empty">—</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="auth-only" id="sec-trend" hidden>
    <div class="sec-head">
      <h2>生图趋势</h2>
      <span class="hint" id="trend-total"></span>
    </div>
    <div class="trend-toolbar">
      <div class="trend-tabs" id="trend-tabs" role="tablist" aria-label="统计范围">
        <button class="trend-tab" data-range="today" type="button">今天</button>
        <button class="trend-tab active" data-range="7d" type="button">七天</button>
        <button class="trend-tab" data-range="30d" type="button">一个月</button>
        <button class="trend-tab" data-range="90d" type="button">三个月</button>
        <button class="trend-tab" data-range="180d" type="button">六个月</button>
      </div>
      <div class="trend-views" id="trend-views" role="group" aria-label="图表类型">
        <button class="trend-view" data-view="bar" type="button" title="柱状图" aria-label="柱状图">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 20V12M10 20V6M16 20v-5M22 20V9"/></svg>
        </button>
        <button class="trend-view active" data-view="line" type="button" title="折线图" aria-label="折线图">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/></svg>
        </button>
      </div>
    </div>
    <div class="trend-wrap">
      <svg id="trend-chart" class="trend-chart" aria-label="生图趋势折线图"></svg>
      <div class="trend-tooltip" id="trend-tooltip" role="tooltip" hidden></div>
      <div class="trend-empty" id="trend-empty" hidden>该时间范围内还没有生成记录</div>
    </div>
  </section>

  <section class="auth-only" id="sec-traffic" hidden>
    <div class="sec-head">
      <h2>流量监控</h2>
      <span class="hint" id="mon-since"></span>
    </div>
    <p class="msg" id="mon-hint" hidden style="margin:0">请先在上方用管理员账号登录控制台，即可查看流量数据</p>
    <dl class="metrics">
      <div><dt>总请求</dt><dd id="tr-req">—</dd></div>
      <div><dt>发出流量</dt><dd id="tr-out">—</dd></div>
      <div><dt>接收流量</dt><dd id="tr-in">—</dd></div>
      <div><dt>被限流次数</dt><dd id="tr-rej">—</dd></div>
    </dl>
    <div class="table-block">
      <p class="table-caption">按客户端 IP</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>客户端 IP</th><th>请求数</th><th>发出</th><th>接收</th><th>被限流</th><th>最近活跃</th></tr></thead>
          <tbody id="clients-body"><tr><td colspan="6" class="table-empty">—</td></tr></tbody>
        </table>
      </div>
    </div>
  </section>

  <section class="auth-only" id="sec-ratelimit" hidden>
    <div class="sec-head">
      <h2>客户端限流</h2>
      <span class="hint" id="rl-state-hint"></span>
    </div>
    <div class="rl-row">
      <label class="switch-wrap">
        <span class="switch"><input type="checkbox" id="rl-enabled"><span class="track"><span class="knob"></span></span></span>
        <span id="rl-switch-text">启用限流</span>
      </label>
      <label>窗口 <input type="number" id="rl-window" min="1000" step="1000" value="60000"> 毫秒</label>
      <label>窗口内最多 <input type="number" id="rl-max" min="1" value="60"> 个请求</label>
      <button class="btn-start" id="rl-save" type="button">保存配置</button>
      <span class="msg" id="rl-msg"></span>
    </div>
    <p class="msg" style="margin:10px 0 0">超出窗口限额的客户端会收到 429 响应。配置保存在 data/rate-limit.json，服务重启后仍然生效。</p>
  </section>

  <section class="auth-only" id="sec-concurrency" hidden>
    <div class="sec-head">
      <h2>生图并发</h2>
      <span class="hint" id="cc-state-hint"></span>
    </div>
    <div class="rl-row">
      <label>全局上限 <input type="number" id="cc-limit" min="1" max="8" step="1" value="5"> 张</label>
      <button class="btn-start" id="cc-save" type="button">保存并生效</button>
      <span class="msg" id="cc-msg"></span>
    </div>
    <p class="msg" style="margin:10px 0 0">所有标签页与账号合计最多同时生成这么多张，改完立即生效，并保存到 data/concurrency.json。
      批量页的并行数不会超过它；调整后刷新批量页即可看到新的可选值。</p>
  </section>

  <section class="auth-only" id="sec-logs" hidden>
    <div class="sec-head">
      <h2>运行日志</h2>
      <span class="hint">本地 logs/ 目录，按天分文件</span>
    </div>
    <div class="log-bar">
      <select id="log-date" aria-label="选择日志日期"><option value="">今天</option></select>
      <button class="btn-mini" id="log-refresh" type="button">刷新</button>
      <span class="msg filename" id="log-meta"></span>
      <label class="log-auto" title="每 3 秒检查一次，只刷新今天的日志">
        <input type="checkbox" id="log-auto" checked>
        <span>自动刷新</span>
      </label>
    </div>
    <div class="log-wrap">
      <pre id="log-content">载入中…</pre>
      <button class="jump-latest" id="log-jump" type="button" title="跳至最新" hidden>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v13M6 13l6 6 6-6"/></svg>
        <span class="jump-label">跳至最新</span>
      </button>
    </div>
  </section>
</main>
<script src="/panel.js"></script>
</body>
</html>`
}

function panelJs() {
  return `
const $ = id => document.getElementById(id)

function formatTokenCount(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 10_000) return (n / 1000).toFixed(1) + 'k'
  return n.toLocaleString('zh-CN')
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}
function esc(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
}
/* 水墨晕染：把文本拆成单字 span，90ms 模糊到清晰，相邻字错开 30ms */
function inkReveal(el, text) {
  el.classList.add('ink-reveal')
  el.innerHTML = Array.from(text)
    .map((ch, i) => '<span class="ch" style="--ch-index:' + i + '">' + esc(ch) + '</span>')
    .join('')
}

let monitorUnauth = false

/* ===== 运行时间：本地平滑走时 =====
   基准 = 服务端给出的已运行毫秒 + 本地经过时间。
   数据源优先级：主服务进程 uptime（最准，控制台重启也不会倒退）> 控制台记录的启动时刻。
   只有与基准偏差超过 1.5 秒才重新对齐，避免每次轮询让数字抖动。 */
let uptimeBase = null

function fmtUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86400)
  const hh = String(Math.floor((total % 86400) / 3600)).padStart(2, '0')
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return days > 0 ? days + ' 天 ' + hh + ':' + mm + ':' + ss : hh + ':' + mm + ':' + ss
}

function syncUptime(status) {
  let serverMs = null
  const mon = status.monitor
  if (status.running && mon && mon.uptime && typeof mon.uptime.uptimeMs === 'number') {
    serverMs = mon.uptime.uptimeMs
  } else if (status.running && status.startedAt) {
    serverMs = Date.now() - Date.parse(status.startedAt)
  }

  if (serverMs === null || !Number.isFinite(serverMs)) {
    uptimeBase = null
    $('st-uptime').textContent = '—'
    return
  }

  const now = Date.now()
  const drift = uptimeBase ? Math.abs(uptimeBase.ms + (now - uptimeBase.at) - serverMs) : Infinity
  if (drift > 1500) uptimeBase = { ms: serverMs, at: now }
  renderUptime()
}

function renderUptime() {
  if (!uptimeBase) return
  $('st-uptime').textContent = fmtUptime(uptimeBase.ms + (Date.now() - uptimeBase.at))
}

async function refresh() {
  let status
  try {
    status = await (await fetch('/api/status')).json()
  } catch {
    $('pill-text').textContent = '控制台离线'
    return
  }

  // 顶栏状态胶囊：状态切换时用水墨晕染动画逐字显现
  $('pill').classList.toggle('on', status.running)
  const pillText = status.running ? '服务运行中' : '服务已停止'
  if ($('pill-text').dataset.last !== pillText) {
    inkReveal($('pill-text'), pillText)
    $('pill-text').dataset.last = pillText
  }
  const stateText = status.running ? '运行中' : '已停止'
  if ($('st-running').dataset.last !== stateText) {
    inkReveal($('st-running'), stateText)
    $('st-running').dataset.last = stateText
  }
  // 运行时间不直接用服务端字符串（只在轮询时更新，会 3 秒一跳甚至卡顿），
  // 改为拿到基准后本地平滑走时，轮询只负责校准。
  syncUptime(status)
  $('st-pid').textContent = status.running && status.pid ? 'PID ' + status.pid : ''
  $('st-url').innerHTML = status.running
    ? '<a href="' + status.clientUrl + '" target="_blank" style="color:var(--green);text-decoration:none">' + status.clientUrl + '</a>'
    : '—'
  $('btn-start').disabled = status.running
  $('btn-stop').disabled = !status.running

  // 登录态：控制台自己的管理员会话（不依赖客户端页面里的登录状态）
  const loggedIn = Boolean(status.auth)
  panelLoggedIn = loggedIn
  serviceRunning = Boolean(status.running)
  $('who').hidden = !loggedIn
  $('btn-logout').hidden = !loggedIn
  if (loggedIn) $('who').textContent = (status.auth.displayName || status.auth.username) + '（管理员）'
  const loginButton = document.querySelector('#login-form button[type=submit]')
  if (loginButton) loginButton.disabled = !status.running

  // 登录页左侧的事实信息：服务状态与客户端地址
  const loginStatus = $('login-status')
  if (loginStatus) {
    loginStatus.textContent = status.running ? '运行中' : '已停止'
    loginStatus.className = status.running ? 'ok' : 'off'
  }
  const loginAddress = $('login-address')
  if (loginAddress) loginAddress.textContent = status.running ? status.clientUrl : '—'
  document.body.classList.toggle('logged-out', !loggedIn)
  $('login-card').hidden = loggedIn
  // 未登录时整个控制台不可用（服务控制、日志也只对已登录管理员开放）
  for (const id of [
    'sec-service', 'sec-accounts', 'sec-stats', 'sec-trend',
    'sec-traffic', 'sec-ratelimit', 'sec-concurrency', 'sec-logs',
  ]) {
    $(id).hidden = !loggedIn
  }
  // 服务未运行时给出唯一的启动入口（否则无法登录，会把自己锁死）
  $('bootstrap-card').hidden = !( !loggedIn && !status.running)
  // 未登录时登录表单给出可操作提示
  const loginHint = $('login-msg')
  if (!loggedIn && !status.running && !loginHint.textContent) {
    loginHint.textContent = '服务当前未运行，先点下方「启动服务」'
    loginHint.className = 'msg'
  }
  if (loggedIn && !wasLoggedIn) {
    wasLoggedIn = true
    // 统计先行：账号表里的「生图数 / token 消耗」取自统计数据，必须等它到齐
    loadStats()
    loadTrend()
    loadLogs('')
    loadUpstream()
  }
  if (!loggedIn) wasLoggedIn = false

  const mon = status.monitor
  const monData = status.running && mon && !mon.unauthorized && !mon.unreachable ? mon : null
  monitorUnauth = Boolean(status.running && mon && mon.unauthorized)
  $('mon-hint').hidden = !monitorUnauth
  $('mon-hint').classList.toggle('err', monitorUnauth)

  if (monData) {
    $('mon-since').textContent = '统计自 ' + ((monData.traffic.since || '').slice(0, 10) || '—')
    $('tr-req').textContent = monData.traffic.total.requests.toLocaleString()
    $('tr-out').textContent = fmtBytes(monData.traffic.total.bytesOut)
    $('tr-in').textContent = fmtBytes(monData.traffic.total.bytesIn)
    $('tr-rej').textContent = monData.traffic.total.rejected

    const clients = monData.traffic.clients
    $('clients-body').innerHTML = clients.length
      ? clients.map(c => {
          const seen = c.lastSeen ? c.lastSeen.replace('T', ' ').slice(5, 19) : ''
          const recent = c.lastSeen && (Date.now() - new Date(c.lastSeen).getTime() < 120000)
          return '<tr><td>' + esc(c.ip) + '</td>'
            + '<td class="num">' + c.requests.toLocaleString() + '</td>'
            + '<td>' + fmtBytes(c.bytesOut) + '</td>'
            + '<td>' + fmtBytes(c.bytesIn) + '</td>'
            + '<td>' + (c.rejected ? '<span class="rej">' + c.rejected + '</span>' : '0') + '</td>'
            + '<td>' + (seen
                ? (recent ? '<span class="live-dot" aria-hidden="true"></span>' : '') +
                  '<span class="' + (recent ? '' : 'idle') + '">' + seen + '</span>'
                : '<span class="idle">从未</span>') + '</td></tr>'
        }).join('')
      : '<tr><td colspan="6" class="table-empty">还没有客户端访问记录</td></tr>'

    // 限流表单：仅在用户没有未保存修改时跟随服务端状态刷新
    if (!rlDirty) {
      $('rl-enabled').checked = monData.rateLimit.config.enabled
      $('rl-window').value = monData.rateLimit.config.windowMs
      $('rl-max').value = monData.rateLimit.config.maxRequests
    }
    $('rl-state-hint').textContent = monData.rateLimit.config.enabled
      ? '已启用 · 活跃窗口 ' + monData.rateLimit.activeClients + ' 个'
      : '未启用'
    $('rl-switch-text').textContent = monData.rateLimit.config.enabled ? '限流已启用' : '限流未启用'

    // 生图并发：显示当前上限与在途情况；用户正在编辑输入框时不回填
    if (monData.queue) {
      if (!ccDirty) $('cc-limit').value = monData.queue.limit
      $('cc-state-hint').textContent = '当前上限 ' + monData.queue.limit +
        ' · 生成中 ' + monData.queue.active + ' / 等待 ' + monData.queue.waiting
    }
  }
}

let wasLoggedIn = false

/* ===== 控制台登录 ===== */
$('login-eye').addEventListener('click', () => {
  const input = $('login-pass')
  const eye = $('login-eye')
  const show = input.type === 'password'
  input.type = show ? 'text' : 'password'
  eye.setAttribute('aria-pressed', show ? 'true' : 'false')
  eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
  eye.title = show ? '隐藏密码' : '显示密码'
  input.focus()
})

$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  const msg = $('login-msg')
  const submit = document.querySelector('.login-submit')
  msg.textContent = '登录中…'
  msg.className = 'msg'
  if (submit) { submit.disabled = true; submit.textContent = '登录中…' }
  try {
    const response = await fetch('/api/panel/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value.trim(), password: $('login-pass').value }),
    })
    const data = await response.json()
    if (!response.ok) {
      msg.textContent = data.error || '登录失败'
      msg.className = 'msg err'
      if (submit) { submit.disabled = false; submit.textContent = '登录' }
      return
    }
    msg.textContent = '登录成功'
    msg.className = 'msg ok'
    $('login-pass').value = ''
    wasLoggedIn = false
    refresh()
  } catch (error) {
    msg.textContent = '控制台无响应'
    msg.className = 'msg err'
    if (submit) { submit.disabled = false; submit.textContent = '登录' }
  }
})

$('btn-bootstrap-start').addEventListener('click', async () => {
  const msg = $('bootstrap-msg')
  msg.textContent = '正在启动…'
  msg.className = 'msg'
  try {
    const result = await (await fetch('/api/start', { method: 'POST' })).json()
    msg.textContent = result.message || (result.ok ? '已启动' : '启动失败')
    msg.className = 'msg ' + (result.ok ? 'ok' : 'err')
  } catch {
    msg.textContent = '控制台无响应'
    msg.className = 'msg err'
  }
  setTimeout(refresh, 1600)
})

$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/panel/logout', { method: 'POST' }).catch(() => {})
  wasLoggedIn = false
  refresh()
})

/* ===== 账号管理 ===== */
async function api(path, options) {
  const response = await fetch(path, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}

/* ===== 上游（Magpie）地址设置 ===== */
let upstreamLoaded = false

function describeUpstream(data) {
  const source = data.saved ? '控制台设置' : '默认/环境变量'
  const reach = data.reachable ? '可达（HTTP ' + data.status + '）' : '当前不可达'
  return '生效地址：' + data.baseUrl + '（' + source + '）· 模型 ' + data.model + ' · ' + reach
}

async function loadUpstream(force = false) {
  if (upstreamLoaded && !force) return
  try {
    const data = await api('/api/upstream')
    upstreamLoaded = true
    const input = $('upstream-url')
    if (input && !input.value) input.value = data.saved || data.baseUrl || ''
    $('upstream-note').textContent = describeUpstream(data)
  } catch (error) {
    $('upstream-note').textContent = '读取上游设置失败：' + error.message
  }
}

$('upstream-test').addEventListener('click', async () => {
  const button = $('upstream-test')
  const note = $('upstream-note')
  button.disabled = true
  button.textContent = '测试中…'
  try {
    const data = await api('/api/upstream/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: $('upstream-url').value }),
    })
    note.textContent = data.reachable
      ? data.baseUrl + ' 可达（HTTP ' + data.status + '）'
      : data.baseUrl + ' 连不上：' + (data.error || '请确认 Magpie 正在运行')
  } catch (error) {
    note.textContent = error.message
  } finally {
    button.disabled = false
    button.textContent = '测试连通'
  }
})

$('upstream-save').addEventListener('click', async () => {
  const button = $('upstream-save')
  const note = $('upstream-note')
  button.disabled = true
  button.textContent = '保存中…'
  try {
    const data = await api('/api/upstream', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: $('upstream-url').value }),
    })
    upstreamLoaded = false
    // 重启后旧的登录会话失效，顺手退出控制台，避免看着「已登录」却点什么都 401
    await fetch('/api/panel/logout', { method: 'POST' }).catch(() => {})
    note.textContent = data.message || ('已保存 ' + data.baseUrl)
    $('login-msg').textContent = data.message || '已保存并重启，请重新登录'
    $('login-msg').className = 'msg ok'
    wasLoggedIn = false
    refresh()
  } catch (error) {
    note.textContent = '保存失败：' + error.message
    button.disabled = false
    button.textContent = '保存并重启'
  }
})

async function loadUsers() {
  try {
    const data = await api('/api/admin/users')
    const users = data.users || []
    const counts = {}
    const tokenByUser = {}
    for (const client of (cachedStats?.accounts || [])) {
      counts[client.username] = client.count
      tokenByUser[client.username] = client.tokens || 0
    }

    // 额度：{ userId -> { dailyLimit, usedToday } }
    const quotaMap = {}
    try {
      const quotaData = await api('/api/admin/quotas')
      for (const row of (quotaData.quotas || [])) quotaMap[row.userId] = row
    } catch {}

    const signature = JSON.stringify([
      users.map(user => [user.id, user.username, user.displayName, user.role, user.disabled]),
      users.map(user => [counts[user.username] || 0, tokenByUser[user.username] || 0]),
      users.map(user => {
        const quota = quotaMap[user.id] || {}
        return [quota.dailyLimit || 0, quota.usedToday || 0]
      }),
    ])
    if (signature === usersSignature) {
      loadRegistrations()
      return
    }
    usersSignature = signature

    $('users-body').innerHTML = users.length
      ? users.map(user => {
          const id = esc(user.id)
          const quota = quotaMap[user.id] || { dailyLimit: 0, usedToday: 0 }
          const quotaCell = quota.dailyLimit > 0
            ? '<b class="num">' + quota.usedToday + '</b> / ' + quota.dailyLimit + ' 张'
            : '<span class="idle">不限</span>（今日 ' + quota.usedToday + ' 张）'
          const isSelf = user.username === ($('who').textContent || '').replace('（管理员）', '')
          return '<tr>'
            + '<td>' + esc(user.username) + '</td>'
            + '<td>' + esc(user.displayName || '—') + '</td>'
            + '<td><span class="role-badge">' + (user.role === 'admin' ? '管理员' : '普通用户') + '</span></td>'
            + '<td><span class="status-badge' + (user.disabled ? ' off' : '') + '">' + (user.disabled ? '已停用' : '正常') + '</span></td>'
            + '<td class="num">' + (counts[user.username] || 0) + '</td>'
            + '<td class="num">' + formatTokenCount(tokenByUser[user.username] || 0) + '</td>'
            + '<td>' + quotaCell + '</td>'
            + '<td><div class="row-actions">'
            + '<button class="row-btn" data-user-action="quota" data-id="' + id + '" data-limit="' + quota.dailyLimit + '">设额度</button>'
            + '<button class="row-btn" data-user-action="rename" data-id="' + id + '">改名</button>'
            + '<button class="row-btn" data-user-action="password" data-id="' + id + '">改密码</button>'
            + '<button class="row-btn" data-user-action="toggle" data-id="' + id + '" data-disabled="' + (user.disabled ? '1' : '0') + '">' + (user.disabled ? '启用' : '停用') + '</button>'
            + '<button class="row-btn danger" data-user-action="delete" data-id="' + id + '">删除</button>'
            + '</div></td></tr>'
        }).join('')
      : '<tr><td colspan="8" class="table-empty">还没有账号</td></tr>'
    loadRegistrations()
  } catch (error) {
    $('users-body').innerHTML = '<tr><td colspan="8" class="table-empty">' + esc(error.message) + '</td></tr>'
  }
}

$('users-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-user-action]')
  if (!button) return
  const id = button.dataset.id
  const action = button.dataset.userAction
  try {
    if (action === 'quota') {
      const current = button.dataset.limit || '0'
      const input = window.prompt('设置该账号每天最多生成多少张图片（0 = 不限额）', current)
      if (input === null) return
      const dailyLimit = Math.max(0, Math.floor(Number(input) || 0))
      await api('/api/admin/users/' + encodeURIComponent(id) + '/quota', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyLimit }),
      })
    } else if (action === 'toggle') {
      await api('/api/admin/users/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: button.dataset.disabled !== '1' }),
      })
    } else if (action === 'rename') {
      const displayName = window.prompt('新的显示名')
      if (!displayName) return
      await api('/api/admin/users/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      })
    } else if (action === 'password') {
      const password = window.prompt('新密码（至少 6 位）')
      if (!password) return
      await api('/api/admin/users/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
    } else if (action === 'delete') {
      if (!window.confirm('确定删除这个账号？')) return
      await api('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' })
    }
    loadStats()
  } catch (error) {
    $('ctrl-msg').textContent = error.message
    $('ctrl-msg').className = 'msg err'
  }
})

$('btn-new-user').addEventListener('click', async () => {
  const username = window.prompt('新账号的用户名')
  if (!username) return
  const displayName = window.prompt('显示名（可留空）') || username
  const password = window.prompt('密码（至少 6 位）')
  if (!password) return
  const role = window.confirm('设为管理员账号？确定=管理员，取消=普通用户') ? 'admin' : 'user'
  try {
    await api('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName, password, role }),
    })
    loadStats()
  } catch (error) {
    $('ctrl-msg').textContent = error.message
    $('ctrl-msg').className = 'msg err'
  }
})

/* ===== 客户端提交的账号申请：审核队列 ===== */
// 轮询时用它比对新申请，避免每秒重渲染表格（会把正要点的按钮换掉）
let pendingSignature = ''

async function loadRegistrations() {
  const block = $('pending-block')
  if (!block) return
  try {
    const data = await api('/api/admin/registrations')
    const rows = data.registrations || []
    const signature = JSON.stringify(rows.map(item => [item.id, item.username, item.createdAt]))
    block.hidden = rows.length === 0
    if (!rows.length) {
      pendingSignature = ''
      $('pending-body').innerHTML = ''
      return
    }
    if (signature === pendingSignature) return
    pendingSignature = signature
    $('pending-note').textContent = '客户端登录页提交的申请；通过后账号才能登录，拒绝会删掉这条记录（共 ' + rows.length + ' 条）'
    $('pending-body').innerHTML = rows.map(item =>
      '<tr>'
      + '<td>' + esc(item.username) + '</td>'
      + '<td>' + esc(item.displayName || '—') + '</td>'
      + '<td>' + (item.createdAt ? item.createdAt.replace('T', ' ').slice(0, 16) : '—') + '</td>'
      + '<td><div class="row-actions">'
      + '<button class="row-btn" data-registration-action="approve" data-id="' + esc(item.id) + '" data-name="' + esc(item.username) + '">通过</button>'
      + '<button class="row-btn danger" data-registration-action="reject" data-id="' + esc(item.id) + '" data-name="' + esc(item.username) + '">拒绝</button>'
      + '</div></td></tr>').join('')
  } catch (error) {
    block.hidden = false
    pendingSignature = ''
    $('pending-body').innerHTML = '<tr><td colspan="4" class="table-empty">' + esc(error.message) + '</td></tr>'
  }
}

$('pending-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-registration-action]')
  if (!button) return
  const action = button.dataset.registrationAction
  const id = button.dataset.id
  const name = button.dataset.name || '该账号'
  if (action === 'reject' && !window.confirm('拒绝并删除「' + name + '」的申请？')) return

  button.disabled = true
  button.textContent = action === 'approve' ? '通过中…' : '拒绝中…'
  try {
    await api('/api/admin/registrations/' + encodeURIComponent(id) + '/' + action, { method: 'POST' })
    $('ctrl-msg').textContent = action === 'approve'
      ? '已通过「' + name + '」的申请，现在可以登录了'
      : '已拒绝并删除「' + name + '」的申请'
    $('ctrl-msg').className = 'msg ok'
    await loadRegistrations()
    loadStats()
  } catch (error) {
    $('ctrl-msg').textContent = error.message
    $('ctrl-msg').className = 'msg err'
    button.disabled = false
    button.textContent = action === 'approve' ? '通过' : '拒绝'
  }
})

/* ===== 生图统计 ===== */
let cachedStats = null
/* 数据区轮询用：内容签名不变就不重绘，避免闪一下、也别把正在点的按钮换掉 */
let statsSignature = ''
let usersSignature = ''
let trendSignature = ''
let serviceRunning = false

async function loadStats() {
  try {
    const stats = await api('/api/admin/stats')
    cachedStats = stats

    const signature = JSON.stringify([
      stats.totalImages, stats.totalTokens, stats.totalBytes, stats.accountCount, stats.avgTokens,
      (stats.accounts || []).map(item => [item.username, item.count, item.tokens, item.avgTokens]),
      (stats.ratioStats || []).map(item => [item.ratio, item.count, item.tokens]),
      (stats.recent || []).slice(0, 5).map(item => item.id),
    ])
    if (signature === statsSignature) {
      loadUsers()
      return
    }
    statsSignature = signature

    $('st-total').textContent = String(stats.totalImages || 0)
    $('st-accounts').textContent = String(stats.accountCount || 0)
    $('st-bytes').textContent = fmtBytes(stats.totalBytes || 0)
    $('st-tokens').textContent = formatTokenCount(stats.totalTokens || 0)
    $('st-avg').textContent = stats.avgTokens ? formatTokenCount(stats.avgTokens) : '—'
    $('stats-hint').textContent = stats.recent?.length
      ? '最近一次生成 ' + (stats.recent[0].createdAt || '').replace('T', ' ').slice(0, 16)
      : '还没有生成记录'

    // accounts 已由服务端按累计 token 降序排好，序号即排行
    const accounts = stats.accounts || []
    $('stats-body').innerHTML = accounts.length
      ? accounts.map((item, index) => {
          const percent = ((item.count / (stats.totalImages || 1)) * 100).toFixed(1)
          return '<tr>'
            + '<td class="rank-col"><span class="rank' + (index < 3 ? ' top' : '') + '">' + (index + 1) + '</span></td>'
            + '<td>' + esc(item.username) + '</td>'
            + '<td class="num">' + item.count + '</td>'
            + '<td class="num">' + formatTokenCount(item.tokens || 0) + '</td>'
            + '<td class="num">' + (item.avgTokens ? formatTokenCount(item.avgTokens) : '—') + '</td>'
            + '<td class="num">' + percent + '%</td>'
            + '<td>' + fmtBytes(item.bytes) + '</td>'
            + '<td>' + (item.lastGeneratedAt ? item.lastGeneratedAt.replace('T', ' ').slice(0, 16) : '—') + '</td>'
            + '</tr>'
        }).join('')
      : '<tr><td colspan="8" class="table-empty">还没有生图记录</td></tr>'

    const ratios = stats.ratioStats || []
    $('ratio-body').innerHTML = ratios.length
      ? ratios.map(item => {
          const percent = ((item.count / (stats.totalImages || 1)) * 100).toFixed(1)
          return '<tr>'
            + '<td>' + esc(item.ratio) + '</td>'
            + '<td class="num">' + item.count + '</td>'
            + '<td class="num">' + formatTokenCount(item.tokens || 0) + '</td>'
            + '<td class="num">' + (item.avgTokens ? formatTokenCount(item.avgTokens) : '—') + '</td>'
            + '<td class="num">' + percent + '%</td>'
            + '</tr>'
        }).join('')
      : '<tr><td colspan="5" class="table-empty">还没有生图记录</td></tr>'

    const recent = stats.recent || []
    $('recent-body').innerHTML = recent.length
      ? recent.map(item =>
          '<tr><td>' + (item.createdAt || '').replace('T', ' ').slice(0, 16) + '</td>'
          + '<td>' + esc(item.username) + '</td>'
          + '<td>' + esc(item.category) + '</td>'
          + '<td>' + esc(item.name || '—') + '</td>'
          + '<td>' + esc(item.ratio) + '</td>'
          + '<td>' + item.width + ' × ' + item.height + '</td>'
          + '<td>' + fmtBytes(item.bytes) + '</td>'
          + '<td class="num">' + (item.tokens ? formatTokenCount(item.tokens) : '—') + '</td></tr>').join('')
      : '<tr><td colspan="8" class="table-empty">还没有生图记录</td></tr>'

    // 统计就绪后再刷账号表，保证「生图数 / token 消耗」有值
    loadUsers()
  } catch (error) {
    $('stats-body').innerHTML = '<tr><td colspan="8" class="table-empty">' + esc(error.message) + '</td></tr>'
    $('ratio-body').innerHTML = '<tr><td colspan="5" class="table-empty">—</td></tr>'
    loadUsers()
  }
}

/* ===== 生图趋势折线图 ===== */
let trendRange = '7d'
const TREND_LABEL_EVERY = { today: 3, '7d': 1, '30d': 3, '90d': 15, '180d': 30 }

$('trend-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-range]')
  if (!tab) return
  trendRange = tab.dataset.range
  for (const item of $('trend-tabs').querySelectorAll('.trend-tab')) {
    item.classList.toggle('active', item === tab)
  }
  loadTrend()
})

/* ===== 悬停浮层：该时间段的张数、token，以及各账号明细 ===== */
function formatTokensShort(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function showTrendTooltip(bucket, event) {
  const tip = $('trend-tooltip')
  const wrap = document.querySelector('.trend-wrap')
  if (!tip || !wrap || !bucket) return

  const rows = (bucket.users || []).map(user =>
    '<div class="tt-row">'
    + '<span class="tt-user" title="' + esc(user.displayName || user.username) + '">' + esc(user.username) + '</span>'
    + '<span class="tt-num">' + user.count + ' 张 · ' + formatTokensShort(user.tokens) + ' token</span>'
    + '</div>').join('')

  tip.innerHTML = '<div class="tt-head">'
    + '<span class="tt-label">' + esc(bucket.label) + '</span>'
    + '<span class="tt-total">' + bucket.count + ' 张 · ' + formatTokensShort(bucket.tokens) + ' token</span>'
    + '</div>'
    + (rows || '<div class="tt-empty">这段时间没有生成</div>')

  tip.hidden = false
  const wrapRect = wrap.getBoundingClientRect()
  const tipRect = tip.getBoundingClientRect()
  // 默认跟随鼠标右下方，靠近右/下边界时翻到另一侧
  let left = event.clientX - wrapRect.left + 14
  let top = event.clientY - wrapRect.top + 14
  if (left + tipRect.width > wrapRect.width) left = event.clientX - wrapRect.left - tipRect.width - 14
  if (top + tipRect.height > wrapRect.height + 40) top = event.clientY - wrapRect.top - tipRect.height - 10
  tip.style.left = Math.max(0, left) + 'px'
  tip.style.top = Math.max(0, top) + 'px'
  tip.classList.add('visible')
}

function hideTrendTooltip() {
  const tip = $('trend-tooltip')
  if (!tip) return
  tip.classList.remove('visible')
  tip.hidden = true
}

$('trend-chart').addEventListener('mousemove', event => {
  const target = event.target.closest('[data-index]')
  if (!target) {
    hideTrendTooltip()
    return
  }
  const index = Number(target.dataset.index)
  const bucket = lastTrendBuckets[index]
  if (!bucket) return
  showTrendTooltip(bucket, event)
})

$('trend-chart').addEventListener('mouseleave', hideTrendTooltip)

// 折线 / 柱状切换
$('trend-views').addEventListener('click', event => {
  const button = event.target.closest('[data-view]')
  if (!button) return
  trendView = button.dataset.view
  for (const item of $('trend-views').querySelectorAll('.trend-view')) {
    item.classList.toggle('active', item === button)
  }
  hideTrendTooltip()
  if (lastTrendBuckets.length) drawTrend($('trend-chart'), lastTrendBuckets)
})

let lastTrendBuckets = []

async function loadTrend() {
  const svg = $('trend-chart')
  try {
    const data = await api('/api/admin/stats/trend?range=' + encodeURIComponent(trendRange))
    const buckets = data.buckets || []
    lastTrendBuckets = buckets

    const signature = trendRange + '|' + JSON.stringify(buckets.map(bucket => [bucket.label, bucket.count, bucket.tokens]))
    if (signature === trendSignature) return
    trendSignature = signature
    hideTrendTooltip()
    $('trend-total').textContent = '本范围共 ' + (data.total || 0) + ' 张'
    if (!buckets.some(bucket => bucket.count > 0)) {
      $('trend-empty').hidden = false
      svg.innerHTML = ''
      return
    }
    lastTrendBuckets = buckets
    $('trend-empty').hidden = true
    drawTrend(svg, buckets)
  } catch (error) {
    $('trend-total').textContent = error.message
  }
}

let trendView = 'line'

/**
 * 趋势图绘制：平滑曲线 + 渐变面积 + 虚线网格，风格对齐参考图。
 * 曲线用单调三次插值（Fritsch–Carlson 限幅），保证不会越过 0 出现虚假回落。
 */
function smoothPath(points) {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return 'M' + points[0].x + ',' + points[0].y

  const dx = []
  const slopes = []
  for (let i = 0; i < n - 1; i += 1) {
    const deltaX = points[i + 1].x - points[i].x
    dx.push(deltaX)
    slopes.push(deltaX === 0 ? 0 : (points[i + 1].y - points[i].y) / deltaX)
  }

  const tangent = new Array(n)
  tangent[0] = slopes[0]
  for (let i = 1; i < n - 1; i += 1) {
    tangent[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2
  }
  tangent[n - 1] = slopes[n - 2]

  // 限幅：避免曲线过冲（相邻段的切线不超过弦斜率 3 倍）
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i] / slopes[i]
    const b = tangent[i + 1] / slopes[i]
    const h = Math.hypot(a, b)
    if (h > 3) {
      const scale = 3 / h
      tangent[i] = scale * a * slopes[i]
      tangent[i + 1] = scale * b * slopes[i]
    }
  }

  let d = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1)
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3
    const c1x = points[i].x + third
    const c1y = points[i].y + tangent[i] * third
    const c2x = points[i + 1].x - third
    const c2y = points[i + 1].y - tangent[i + 1] * third
    d += ' C' + c1x.toFixed(1) + ',' + c1y.toFixed(1)
      + ' ' + c2x.toFixed(1) + ',' + c2y.toFixed(1)
      + ' ' + points[i + 1].x.toFixed(1) + ',' + points[i + 1].y.toFixed(1)
  }
  return d
}

/** 把最大值抬到整齐刻度（步长取 1/2/5×10ⁿ），避免出现 0/2/3/5/6 这种刻度 */
function niceScale(maxValue, ticks = 4) {
  if (!Number.isFinite(maxValue) || maxValue <= ticks) return { max: ticks, step: 1 }
  const rough = maxValue / ticks
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const residual = rough / magnitude
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10
  const step = niceResidual * magnitude
  return { max: step * ticks, step }
}

function formatAxisValue(value) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1) + 'k'
  return String(value)
}

function drawTrend(svg, buckets) {
  const width = Math.max(svg.clientWidth || 640, 320)
  const height = 240
  const pad = { top: 14, right: 14, bottom: 26, left: 40 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const rawMax = Math.max(...buckets.map(bucket => bucket.count), 1)
  const scale = niceScale(rawMax, 4)
  const maxCount = scale.max
  const baseline = pad.top + innerH
  const isBar = trendView === 'bar'

  // 柱状图：按柱子宽度留出两侧余量，避免首尾柱贴边被裁
  const stepXRaw = buckets.length > 1 ? innerW / (buckets.length - 1) : 0
  const barWidth = Math.max(4, Math.min(26, stepXRaw * 0.55))
  const usableW = isBar ? innerW - barWidth : innerW
  const stepX = buckets.length > 1 ? usableW / (buckets.length - 1) : 0
  const startX = isBar ? pad.left + barWidth / 2 : pad.left
  const points = buckets.map((bucket, index) => ({
    ...bucket,
    x: startX + index * stepX,
    y: baseline - (bucket.count / maxCount) * innerH,
  }))

  // 网格：4 条虚线 + 左侧刻度（含 0）
  let grid = ''
  for (let i = 0; i <= 4; i += 1) {
    const value = scale.step * i
    const y = baseline - (value / maxCount) * innerH
    grid += '<line x1="' + pad.left + '" y1="' + y.toFixed(1) + '" x2="' + (width - pad.right).toFixed(1)
      + '" y2="' + y.toFixed(1) + '" class="trend-grid"></line>'
      + '<text x="' + (pad.left - 8) + '" y="' + (y + 3.5).toFixed(1)
      + '" class="trend-axis-label" text-anchor="end">' + esc(formatAxisValue(value)) + '</text>'
  }

  const every = TREND_LABEL_EVERY[trendRange] || 1
  const axis = points
    .filter((point, index) => index % every === 0 || index === points.length - 1)
    .map(point => '<text x="' + point.x.toFixed(1) + '" y="' + (height - 7)
      + '" class="trend-axis-label" text-anchor="middle">' + esc(point.label) + '</text>')
    .join('')

  let series = ''
  if (isBar) {
    series = points.map((point, index) => {
      const barHeight = baseline - point.y
      return '<g class="trend-dot" data-index="' + index + '">'
        + '<rect class="trend-bar" x="' + (point.x - barWidth / 2).toFixed(1) + '" y="' + point.y.toFixed(1)
        + '" width="' + barWidth.toFixed(1) + '" height="' + Math.max(0, barHeight).toFixed(1)
        + '" rx="' + Math.min(3, barWidth / 2).toFixed(1) + '"></rect>'
        + '<rect class="trend-dot-hit" x="' + (point.x - Math.max(barWidth, stepX) / 2).toFixed(1) + '" y="' + pad.top
        + '" width="' + Math.max(barWidth, stepX).toFixed(1) + '" height="' + innerH + '"></rect>'
        + '</g>'
    }).join('')
  } else {
    const linePath = smoothPath(points)
    const areaPath = linePath
      + ' L' + points[points.length - 1].x.toFixed(1) + ',' + baseline.toFixed(1)
      + ' L' + points[0].x.toFixed(1) + ',' + baseline.toFixed(1) + ' Z'
    const bandWidth = points.length > 1 ? Math.max(12, stepX) : innerW
    const dots = points.map((point, index) =>
      '<g class="trend-dot" data-index="' + index + '">'
      + '<rect class="trend-dot-hit" x="' + (point.x - bandWidth / 2).toFixed(1) + '" y="' + pad.top
      + '" width="' + bandWidth.toFixed(1) + '" height="' + innerH + '"></rect>'
      + '<circle cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="3.2" class="trend-dot-visible" fill="var(--green)"></circle>'
      + '</g>').join('')

    series = '<defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="var(--green)" stop-opacity=".26"></stop>'
      + '<stop offset="70%" stop-color="var(--green)" stop-opacity=".06"></stop>'
      + '<stop offset="100%" stop-color="var(--green)" stop-opacity="0"></stop>'
      + '</linearGradient></defs>'
      + '<path d="' + areaPath + '" class="trend-area" fill="url(#trendFill)"></path>'
      + '<path d="' + linePath + '" class="trend-line"></path>'
      + dots
  }

  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height)
  svg.innerHTML = grid + series + axis
}

async function control(action, doing) {
  const msg = $('ctrl-msg')
  msg.textContent = doing + '…'
  msg.className = 'msg'
  try {
    const result = await (await fetch('/api/' + action, { method: 'POST' })).json()
    msg.textContent = result.message || (result.ok ? '完成' : '操作失败')
    msg.className = 'msg ' + (result.ok ? 'ok' : 'err')
    msg.classList.remove('pop'); void msg.offsetWidth; msg.classList.add('pop')
  } catch {
    msg.textContent = '控制台服务无响应'
    msg.className = 'msg err'
  }
  setTimeout(refresh, 1400)
}

$('btn-start').onclick = () => control('start', '正在启动')
$('btn-stop').onclick = () => control('stop', '正在停止')
$('btn-restart').onclick = () => control('restart', '正在重启')

// 用户动过表单就暂停自动回填，保存成功后恢复
let rlDirty = false
for (const id of ['rl-enabled', 'rl-window', 'rl-max']) {
  $(id).addEventListener('input', () => { rlDirty = true })
  $(id).addEventListener('change', () => { rlDirty = true })
}

$('rl-save').onclick = async () => {
  const msg = $('rl-msg')
  msg.textContent = '保存中…'
  msg.className = 'msg'
  try {
    const result = await fetch('/api/rate-limit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: $('rl-enabled').checked,
        windowMs: Number($('rl-window').value),
        maxRequests: Number($('rl-max').value),
      }),
    })
    const data = await result.json()
    if (result.ok) {
      msg.textContent = '已保存并生效'
      msg.className = 'msg ok'
      msg.classList.remove('pop'); void msg.offsetWidth; msg.classList.add('pop')
      rlDirty = false
    } else {
      msg.textContent = data.error || '保存失败'
      msg.className = 'msg err'
    }
  } catch { msg.textContent = '服务未运行或无响应'; msg.className = 'msg err' }
  setTimeout(refresh, 600)
}

// 生图并发：保存后立即生效，无需重启服务
let ccDirty = false
$('cc-limit').addEventListener('input', () => { ccDirty = true })
$('cc-limit').addEventListener('change', () => { ccDirty = true })

$('cc-save').onclick = async () => {
  const msg = $('cc-msg')
  const limit = Number($('cc-limit').value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
    msg.textContent = '并发上限必须是 1–8 之间的整数'
    msg.className = 'msg err'
    return
  }

  msg.textContent = '保存中…'
  msg.className = 'msg'
  try {
    const result = await fetch('/api/concurrency', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit }),
    })
    const data = await result.json()
    if (result.ok) {
      msg.textContent = '已保存并生效：上限 ' + data.limit
      msg.className = 'msg ok'
      msg.classList.remove('pop'); void msg.offsetWidth; msg.classList.add('pop')
      ccDirty = false
    } else {
      msg.textContent = data.error || '保存失败'
      msg.className = 'msg err'
    }
  } catch { msg.textContent = '服务未运行或无响应'; msg.className = 'msg err' }
  setTimeout(refresh, 600)
}

let lastLogStamp = ''      // 日期 + 文件大小 + 修改时间，用于判断是否有新日志
let panelLoggedIn = false

async function loadLogs(date, options) {
  const silent = Boolean(options && options.silent)
  let data
  try {
    const response = await fetch('/api/logs' + (date ? '?date=' + date : ''))
    data = await response.json()
    if (!response.ok) {
      if (!silent) {
        $('log-content').textContent = data.error || '日志需要登录后查看'
        $('log-meta').textContent = ''
      }
      return
    }
  } catch {
    if (!silent) $('log-content').textContent = '控制台无响应'
    return
  }

  const files = Array.isArray(data.files) ? data.files : []
  const content = data.content || ''
  const stamp = (data.date || '') + ':' + (data.bytes || 0) + ':' + (data.mtimeMs || 0)

  // 静默轮询时：文件没变化就不动 DOM，避免每 3 秒闪一下、丢掉文本选区
  if (silent && stamp === lastLogStamp) return
  lastLogStamp = stamp

  const lines = content ? content.split(String.fromCharCode(10)) : []
  const prevScroll = logPre.scrollTop
  const wasFollowing = logFollow

  logPre.textContent = content || '（该日期没有日志）'
  // 贴底时跟随最新，否则保持原阅读位置
  logPre.scrollTop = wasFollowing ? logPre.scrollHeight : prevScroll
  const fileName = data.date ? data.date + '.log' : '今天'
  $('log-meta').innerHTML =
    '<span>' + esc(fileName) + '</span> · ' + lines.length + ' 行' + (data.truncated ? '（已截断）' : '')
  requestAnimationFrame(syncLogJump)

  // 静默轮询不重建下拉，避免抢焦点
  if (!silent) {
    const select = $('log-date')
    select.innerHTML = '<option value="">今天</option>' + files
      .filter(f => f !== data.date + '.log')
      .map(f => '<option value="' + f.replace('.log', '') + '">' + f + '</option>').join('')
    if (date) select.value = date
  }
}

$('log-date').onchange = () => loadLogs($('log-date').value)
$('log-refresh').onclick = () => loadLogs($('log-date').value)

/* ===== 日志自动刷新 =====
   每 3 秒检查一次，但有三条约束，避免浪费资源或打扰阅读：
   ① 页面切到后台（document.hidden）立即暂停；
   ② 只自动刷新「今天」，查看历史日期时不动；
   ③ 内容无变化则不重绘；已上滚时保持阅读位置，只在贴底时跟随最新。 */
const LOG_AUTO_KEY = 'moying.logAuto.v1'
const logAutoToggle = $('log-auto')

function readAutoPref() {
  try { return localStorage.getItem(LOG_AUTO_KEY) !== '0' } catch { return true }
}

if (logAutoToggle) {
  logAutoToggle.checked = readAutoPref()
  logAutoToggle.addEventListener('change', () => {
    try { localStorage.setItem(LOG_AUTO_KEY, logAutoToggle.checked ? '1' : '0') } catch {}
  })
}

async function autoRefreshLogs() {
  if (!panelLoggedIn) return                       // 未登录不轮询
  if (document.hidden) return                      // 后台标签页暂停
  if (logAutoToggle && !logAutoToggle.checked) return
  if ($('log-date') && $('log-date').value !== '') return  // 只看历史日期时不动

  // 先做一次轻量探测（只取大小与修改时间），文件没变就不拉 256KB 正文
  try {
    const response = await fetch('/api/logs?meta=1', { credentials: 'include' })
    if (!response.ok) return
    const meta = await response.json()
    const stamp = (meta.date || '') + ':' + (meta.bytes || 0) + ':' + (meta.mtimeMs || 0)
    if (stamp === lastLogStamp) return
  } catch {
    return
  }
  loadLogs('', { silent: true })
}

// 回到前台立刻补一次，不用等下一个 3 秒
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) autoRefreshLogs()
})

setInterval(autoRefreshLogs, 3000)

/* ===== 滚动不跳转 =====
   用户贴近底部（不足一行）时自动跟随新日志；
   用户向上滚动超过三行则暂停跟随并显示「跳至最新」按钮。 */
const logPre = $('log-content')
const logJump = $('log-jump')
const logWrap = document.querySelector('.log-wrap')
const LINE_H = 19  // 11px 字号 * 1.75 行高
let logFollow = true  // 是否跟随最新（贴底时跟随）

function syncLogJump() {
  const distance = logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight
  // 已经贴底（不足一行）＝在最新的日志上，按钮不出现
  const atLatest = distance <= LINE_H
  logFollow = atLatest
  logJump.hidden = atLatest
}

logPre.addEventListener('scroll', syncLogJump)

function scrollLogToLatest() {
  logFollow = true
  // 先滚到底再隐藏按钮；下一帧复核一次，防止同一帧内的重排把滚动位置吃掉
  logPre.scrollTop = logPre.scrollHeight
  requestAnimationFrame(() => {
    logPre.scrollTop = logPre.scrollHeight
    requestAnimationFrame(() => {
      const distance = logPre.scrollHeight - logPre.scrollTop - logPre.clientHeight
      if (distance <= LINE_H) logJump.hidden = true
    })
  })
}

logJump.addEventListener('click', scrollLogToLatest)

/* 滚轮落在日志窗口上时：只滚日志内容（到顶/到底也不把整页带走） */
logWrap.addEventListener('wheel', event => {
  if (event.ctrlKey) return
  if (logPre.scrollHeight <= logPre.clientHeight) return
  event.preventDefault()
  logPre.scrollTop += event.deltaY
}, { passive: false })

/* ===== 输入防误发 =====
   拼音选字阶段（compositionstart~end）拦截回车；
   选字结束后的 500ms 内回车也拦截（防止「确认选字」被当作提交）。 */
let composing = false
let composingJustEnded = 0
document.addEventListener('compositionstart', () => { composing = true })
document.addEventListener('compositionend', () => {
  composing = false
  composingJustEnded = Date.now()
})
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !event.target.matches('input, textarea, select')) return
  if (composing || Date.now() - composingJustEnded < 500) {
    event.stopPropagation()
    event.preventDefault()
  }
}, true)
refresh()
setInterval(refresh, 3000)
// 新的账号申请尽快出现在审核队列里；切到后台标签就暂停轮询
setInterval(() => {
  if (!panelLoggedIn || document.hidden) return
  loadRegistrations()
}, 10000)

// 数据区（生图统计 / 账号表 / 趋势）也跟着自动刷新：
// 已登录 + 页面可见 + 服务在运行才拉；各区块内部比内容签名，没变化不重绘
setInterval(() => {
  if (!panelLoggedIn || document.hidden || !serviceRunning) return
  loadStats()
  loadTrend()
}, 5000)
// 运行时间独立走时：250ms 一次，肉眼连续无跳秒
setInterval(renderUptime, 250)
`
}

// 每次启动控制台时，先检测主服务是否已经在运行（可能被其他途径启动过），
// 在运行就直接接管监控，并在启动横幅里说明，避免重复拉起。
server.listen(PANEL_PORT, '127.0.0.1', async () => {
  console.log(`画境服务控制台已启动: http://127.0.0.1:${PANEL_PORT}/`)
  console.log(`主服务端口: ${SERVER_PORT}（在控制台里点「启动服务」拉起）`)

  const already = await portAlive()
  if (already) {
    startedAt = Date.now()
    serverProcess = { pid: null, exitCode: null, killed: false, on: () => {} }
    console.log(`检测到主服务已在运行（端口 ${SERVER_PORT}），控制台已接管监控，无需重复启动`)
  } else {
    console.log(`当前没有运行中的主服务，可在控制台页面点「启动服务」`)
  }
})
