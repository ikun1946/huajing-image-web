import { app, BrowserWindow, Menu, Tray, clipboard, dialog, nativeImage, shell } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { appRoot, dataRoot } from './paths.mjs'
import { loadConfig } from './config.mjs'

/* ===== 基础路径：数据一律写在数据根，绝不碰安装目录 ===== */
const ROOT = appRoot()
const DATA = dataRoot()
const LOG_DIR = join(DATA, 'logs')
const MAIN_LOG = join(LOG_DIR, 'desktop.log')

// userData 指到固定的 huajing 目录，不随 productName 变化
app.setPath('userData', DATA)

for (const dir of [DATA, LOG_DIR, join(DATA, 'generated'), join(DATA, 'styles'), join(DATA, 'data')]) {
  try { mkdirSync(dir, { recursive: true }) } catch {}
}

const config = loadConfig(DATA)
const PANEL_PORT = Number(config.PANEL_PORT) || 8790
const SERVER_PORT = Number(config.PORT) || 8787
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}/`
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}/`
const CLIENT_URL = `${SERVER_URL}batch.html`
const CLIENT_LOGIN_URL = `${SERVER_URL}login.html`
/** 每次启动换一个：只有本进程知道，服务端的 /api/shutdown 靠它验身 */
const SHUTDOWN_TOKEN = randomBytes(24).toString('hex')

let panelChild = null
let mainWindow = null
let tray = null
let quitting = false
let serviceRunning = false

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try { appendFileSync(MAIN_LOG, line) } catch {}
  if (!app.isPackaged) process.stdout.write(line)
}

function iconPath() {
  const file = join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(file) ? file : undefined
}

/* ===== 控制台子进程（用 Electron 自带的 Node 跑，不依赖用户装 Node） ===== */
function panelEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PANEL_EMBEDDED: '1',
    PANEL_ROOT: ROOT,
    SERVER_ENTRY: join(ROOT, 'server', 'dist', 'index.js'),
    LOGS_DIR: LOG_DIR,
    // 数据目录全部指向数据根
    STORAGE_DIR: join(DATA, 'generated'),
    STYLE_LIBRARY_PATH: join(DATA, 'styles'),
    USER_DATABASE_PATH: join(DATA, 'users.json'),
    USAGE_DATABASE_PATH: join(DATA, 'usage.json'),
    PROJECT_DATABASE_PATH: join(DATA, 'projects.json'),
    DATA_DIR: join(DATA, 'data'),
    LOG_DIR,
    WEB_DIST_DIR: join(ROOT, 'web', 'dist'),
    SHUTDOWN_TOKEN,
    ...config,
    PORT: String(SERVER_PORT),
    PANEL_PORT: String(PANEL_PORT),
  }
}

function startPanel() {
  const entry = join(ROOT, 'scripts', 'control-panel.mjs')
  if (!existsSync(entry)) throw new Error(`控制台脚本缺失：${entry}`)

  panelChild = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: panelEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  panelChild.stdout.on('data', chunk => log(`[panel] ${String(chunk).trimEnd()}`))
  panelChild.stderr.on('data', chunk => log(`[panel:err] ${String(chunk).trimEnd()}`))
  panelChild.on('exit', (code, signal) => {
    log(`控制台进程退出 code=${code} signal=${signal}`)
    if (panelChild) panelChild = null
  })
  log(`控制台已启动 pid=${panelChild.pid} root=${ROOT}`)
}

async function waitForOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) })
      if (response.ok) return true
    } catch {}
    await delay(300)
  }
  return false
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) })
    return response.status < 500
  } catch {
    return false
  }
}

async function startBackend() {
  if (!(await waitForOk(`${PANEL_URL}api/status`, 15000))) {
    throw new Error(`控制台没有在 15 秒内就绪，端口 ${PANEL_PORT} 可能被占用或被防火墙拦截`)
  }
  // 控制台设计上不会自动拉起主服务，这里点一次启动
  try {
    const response = await fetch(`${PANEL_URL}api/start`, { method: 'POST' })
    log(`请求启动主服务：${response.status} ${await response.text().catch(() => '')}`)
  } catch (error) {
    log(`请求启动主服务失败：${error.message}`)
  }
  if (!(await waitForOk(`${SERVER_URL}api/health`, 20000))) {
    throw new Error(`主服务没有在 20 秒内就绪，端口 ${SERVER_PORT} 可能被占用`)
  }
  log('主服务就绪')
}

/* ===== 窗口 ===== */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: '画境 · 服务控制台',
    backgroundColor: '#f4f0e6',
    icon: iconPath(),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  mainWindow.loadURL(PANEL_URL)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // 页面里的外链（比如「新窗口 ↗」）交给系统浏览器，不在应用内开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 客户端（8787 的工作台）留在浏览器里，桌面端只负责服务端/控制台。
 * 这里用系统默认浏览器打开，局域网其他设备依旧访问控制台里显示的那个局域网地址。
 */
async function openClientInBrowser() {
  try {
    // 账号库为空时先给初始化页，否则直接进工作台
    const status = await fetch(`${SERVER_URL}api/auth/status`, { signal: AbortSignal.timeout(2000) })
    const needsSetup = Boolean((await status.json())?.needsSetup)
    await shell.openExternal(needsSetup ? CLIENT_LOGIN_URL : CLIENT_URL)
  } catch {
    await shell.openExternal(CLIENT_URL)
  }
}

/* ===== 菜单 / 托盘 ===== */
/**
 * 服务控制：带 x-desktop-token 直接调用控制台。
 * 桌面端就是主服务的父进程，控制自己的子进程不需要再在网页里登录一次。
 */
async function panelAction(label, path) {
  try {
    const response = await fetch(`${PANEL_URL}${path}`, {
      method: 'POST',
      headers: { 'x-desktop-token': SHUTDOWN_TOKEN },
      signal: AbortSignal.timeout(30000),
    })
    const payload = await response.json().catch(() => ({}))

    if (!response.ok) {
      dialog.showMessageBox({
        type: 'warning',
        title: label,
        message: payload.error || `操作失败（${response.status}）`,
        detail: `控制台日志：${MAIN_LOG}`,
      })
      return
    }
    // 已在运行 / 本来就没运行：这是状态提示，不是错误
    if (payload.ok === false) {
      dialog.showMessageBox({ type: 'info', title: label, message: payload.message || '无需操作' })
      await refreshServiceState()
      return
    }
    await refreshServiceState()
    showMainWindow()
  } catch (error) {
    dialog.showMessageBox({ type: 'error', title: label, message: '控制台没有响应', detail: error.message })
  }
}

/** 读一次服务状态，顺便更新托盘提示与菜单项（启用/禁用） */
async function refreshServiceState() {
  try {
    const response = await fetch(`${PANEL_URL}api/status`, { signal: AbortSignal.timeout(2000) })
    const status = await response.json()
    serviceRunning = Boolean(status.running)
  } catch {
    serviceRunning = false
  }
  if (tray) tray.setToolTip(`画境 · 服务${serviceRunning ? '运行中' : '已停止'}`)
  if (app.isReady()) {
    Menu.setApplicationMenu(buildMenu())
    if (tray) tray.setContextMenu(buildTrayMenu())
  }
}

function showAdminKey() {
  const key = config.ADMIN_SETUP_KEY || ''
  clipboard.writeText(key)
  dialog.showMessageBox({
    type: 'info',
    title: '管理密钥',
    message: '首次使用时用它创建管理员账号',
    detail: `密钥已复制到剪贴板：${key}\n\n在控制台登录页的「初始化画境」里粘贴即可。\n配置文件：${join(DATA, 'config.env')}`,
  })
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '画境',
      submenu: [
        { label: '在浏览器打开客户端', accelerator: 'CmdOrCtrl+1', click: openClientInBrowser },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(DATA) },
        { label: '打开日志目录', click: () => shell.openPath(LOG_DIR) },
        { label: '复制管理密钥', click: showAdminKey },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit() } },
      ],
    },
    {
      label: '服务',
      submenu: [
        { label: `状态：${serviceRunning ? '运行中' : '已停止'}`, enabled: false },
        { type: 'separator' },
        { label: '启动服务', enabled: !serviceRunning, click: () => panelAction('启动服务', 'api/start') },
        { label: '停止服务', enabled: serviceRunning, click: () => panelAction('停止服务', 'api/stop') },
        { label: '重启服务', click: () => panelAction('重启服务', 'api/restart') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ])
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '显示控制台', click: showMainWindow },
    { label: '在浏览器打开客户端', click: openClientInBrowser },
    { type: 'separator' },
    { label: `状态：${serviceRunning ? '运行中' : '已停止'}`, enabled: false },
    { label: '启动服务', enabled: !serviceRunning, click: () => panelAction('启动服务', 'api/start') },
    { label: '停止服务', enabled: serviceRunning, click: () => panelAction('停止服务', 'api/stop') },
    { label: '重启服务', click: () => panelAction('重启服务', 'api/restart') },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(DATA) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ])
}

function createTray() {
  const image = iconPath() ? nativeImage.createFromPath(iconPath()) : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip('画境 · 服务控制台')
  tray.setContextMenu(buildTrayMenu())
  tray.on('double-click', showMainWindow)
}

/* ===== 退出：先让控制台停服务，再兜底强杀 ===== */
async function waitPanelExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!panelChild) return true
    await delay(200)
  }
  return !panelChild
}

async function shutdownAndQuit() {
  quitting = true
  try {
    await fetch(`${PANEL_URL}api/panel/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) })
    log('已请求控制台停止服务')
  } catch (error) {
    log(`请求控制台退出失败：${error.message}`)
  }

  const exited = await waitPanelExit(8000)
  if (!exited && panelChild?.pid) {
    log(`控制台未按时退出，强制结束 pid=${panelChild.pid}`)
    try { spawnSync('taskkill', ['/pid', String(panelChild.pid), '/T', '/F'], { windowsHide: true }) } catch {}
  }
  log('桌面端退出')
  app.exit(0)
}

/* ===== 启动 ===== */
async function bootstrap() {
  log(`启动：packaged=${app.isPackaged} root=${ROOT} data=${DATA}`)

  if (await probe(PANEL_URL)) {
    dialog.showErrorBox(
      '控制台端口被占用',
      `端口 ${PANEL_PORT} 已经有程序在监听。\n\n可能你已经用 npm run panel 起了一个控制台，请先关掉再打开桌面端。`,
    )
    app.exit(1)
    return
  }

  startPanel()

  try {
    await startBackend()
  } catch (error) {
    log(`启动失败：${error.message}`)
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '启动失败',
      message: error.message,
      detail: `日志：${MAIN_LOG}\n配置：${join(DATA, 'config.env')}`,
      buttons: ['打开日志目录', '退出'],
      defaultId: 0,
    })
    if (choice === 0) shell.openPath(LOG_DIR)
    quitting = true
    app.exit(1)
    return
  }

  await refreshServiceState()
  createTray()

  // 首次使用：账号库还是空的，控制台登录不了。直接把「初始化画境」页打开并亮出管理密钥。
  let needsSetup = false
  try {
    const status = await fetch(`${SERVER_URL}api/auth/status`, { signal: AbortSignal.timeout(2000) })
    needsSetup = Boolean((await status.json())?.needsSetup)
  } catch {}

  if (needsSetup) {
    log('账号库为空：用浏览器打开初始化向导')
    await openClientInBrowser()
    showAdminKey()
  } else {
    createMainWindow()
  }

  // 冒烟自检：HUAJING_DESKTOP_SMOKE_ACTION=start|stop|restart 时走一遍菜单动作并记日志
  const smokeAction = process.env.HUAJING_DESKTOP_SMOKE_ACTION
  if (smokeAction) {
    const path = { start: 'api/start', stop: 'api/stop', restart: 'api/restart' }[smokeAction]
    if (path) {
      try {
        const response = await fetch(`${PANEL_URL}${path}`, {
          method: 'POST',
          headers: { 'x-desktop-token': SHUTDOWN_TOKEN },
          signal: AbortSignal.timeout(30000),
        })
        log(`冒烟动作 ${smokeAction}: ${response.status} ${await response.text().catch(() => '')}`)
      } catch (error) {
        log(`冒烟动作 ${smokeAction} 失败: ${error.message}`)
      }
    }
  }

  // 菜单/托盘里的服务状态每 5 秒跟一次，避免点了才发现状态不对
  setInterval(() => { void refreshServiceState() }, 5000)

  // 冒烟自检用：设置 HUAJING_DESKTOP_SMOKE=<毫秒> 时，启动完成后自动走一遍退出流程
  const smokeMs = Number(process.env.HUAJING_DESKTOP_SMOKE || 0)
  if (smokeMs > 0) {
    log(`冒烟模式：${smokeMs}ms 后自动退出`)
    setTimeout(() => { void shutdownAndQuit() }, smokeMs)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    bootstrap().catch(error => {
      log(`未捕获的启动异常：${error?.stack || error}`)
      dialog.showErrorBox('画境启动失败', String(error?.message || error))
      app.exit(1)
    })
  })

  // 关掉所有窗口不收摊：托盘常驻、服务继续跑
  app.on('window-all-closed', () => {})

  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    void shutdownAndQuit()
  })

  process.on('uncaughtException', error => {
    log(`uncaughtException：${error?.stack || error}`)
  })
  process.on('unhandledRejection', reason => {
    log(`unhandledRejection：${reason?.stack || reason}`)
  })
}
