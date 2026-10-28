import { mkdir } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { ApiError } from './lib/errors.js'
import { SerialGate } from './lib/serial-gate.js'
import { SessionStore } from './lib/session.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerAuthRoutes, resolveAuth } from './routes/auth.js'
import { registerFileRoutes } from './routes/files.js'
import { registerHistoryRoutes } from './routes/history.js'
import { registerImageRoutes } from './routes/images.js'
import { registerMonitorRoutes } from './routes/monitor.js'
import { QuotaStore } from './services/quota-store.js'
import { RateLimiter } from './services/rate-limiter.js'
import { TrafficStore } from './services/traffic-store.js'
import { registerMetaRoutes } from './routes/meta.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerStyleRoutes } from './routes/styles.js'
import { ProjectStore } from './services/project-store.js'
import { LocalFileStorage } from './services/storage.js'
import { StyleLibraryStore } from './services/style-library.js'
import { UsageStore } from './services/usage-store.js'
import { UserStore } from './services/user-store.js'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')
const storageDirectory = config.storageDir
  ? resolve(config.storageDir)
  : join(projectRoot, 'generated')
const userDatabasePath = config.userDatabasePath
  ? resolve(config.userDatabasePath)
  : join(projectRoot, 'users.json')
const usageDatabasePath = config.usageDatabasePath
  ? resolve(config.usageDatabasePath)
  : join(projectRoot, 'usage.json')
const projectDatabasePath = config.projectDatabasePath
  ? resolve(config.projectDatabasePath)
  : join(projectRoot, 'projects.json')
// 每个账号一份风格库，落在 styles/<userId>.json
const styleLibraryRoot = config.styleLibraryPath
  ? resolve(config.styleLibraryPath)
  : join(projectRoot, 'styles')
const webDirectory = join(projectRoot, 'web', 'dist')

await mkdir(storageDirectory, { recursive: true })

// 日志按天写入本地 logs/ 目录（YYYY-MM-DD.log），同时输出到控制台
const logsDirectory = join(projectRoot, 'logs')
await mkdir(logsDirectory, { recursive: true })
const today = () => new Date().toISOString().slice(0, 10)
let logFilePath = join(logsDirectory, `${today()}.log`)
let logFileStream = createWriteStream(logFilePath, { flags: 'a' })

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: undefined,
    stream: {
      write(line: string) {
        process.stdout.write(line)
        // 跨天时切到新文件
        const nextPath = join(logsDirectory, `${today()}.log`)
        if (nextPath !== logFilePath) {
          logFilePath = nextPath
          logFileStream.end()
          logFileStream = createWriteStream(nextPath, { flags: 'a' })
        }
        logFileStream.write(line)
      },
    },
  },
  // 项目保存会带上整份资产表（几百项时可达数百 KB），
  // 128 KB 会被 Fastify 直接拒绝，导致项目存成空。
  bodyLimit: 8 * 1024 * 1024,
})

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }
    // 局域网工具：放行本机回环与私有网段来源，其余拒绝
    callback(null, isAllowedOrigin(origin))
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
})

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.local') ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
    )
  } catch {
    return false
  }
}

await app.register(cookie, { secret: config.sessionSecret || randomBytes(32).toString('hex') })

// 允许 DELETE 等请求带 application/json 但空 body
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_request, body, done) => {
    const text = (body as string).trim()
    if (!text) return done(null, {})
    try {
      done(null, JSON.parse(text))
    } catch (error) {
      done(error as Error, undefined)
    }
  },
)

const storage = new LocalFileStorage(storageDirectory)
await storage.init()
const styleLibrary = new StyleLibraryStore(styleLibraryRoot)
const projects = new ProjectStore(projectDatabasePath)
const users = new UserStore(userDatabasePath)
const usage = new UsageStore(usageDatabasePath)
const sessions = new SessionStore(config.sessionSecret || randomBytes(32).toString('hex'))
const gate = new SerialGate()

// 流量统计、每客户端限流与进程启动时刻（控制台监控用）
const dataDir = join(projectRoot, 'data')
const traffic = new TrafficStore(dataDir)
const rateLimiter = new RateLimiter(dataDir)
const quotas = new QuotaStore(dataDir)
await traffic.init()
await rateLimiter.init()
await quotas.init()
const processStartedAt = Date.now()

// 每个请求：限流 → 解析登录身份 → 流量统计
app.addHook('onRequest', async request => {
  const ip = request.ip
  const retryAfterSec = rateLimiter.tryAccept(ip)
  if (retryAfterSec !== null) {
    traffic.record(ip, 0, 0, true)
    throw new ApiError('RATE_LIMITED', `请求过于频繁，请 ${retryAfterSec} 秒后重试`, 429)
  }
  request.auth = await resolveAuth(request, { users, sessions })
})

app.addHook('onResponse', async (request, reply) => {
  const bytesIn = Number(request.headers['content-length'] || 0)
  traffic.record(request.ip, bytesIn, Number(reply.getHeader('content-length') || 0))
})

// 流量数据定期落盘，进程退出时也会补写
setInterval(() => { traffic.flushIfDirty().catch(() => {}) }, 10_000)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    traffic.flushIfDirty().catch(() => {}).finally(() => process.exit(0))
  })
}

registerMetaRoutes(app)
registerAuthRoutes(app, { users, sessions })
registerAdminRoutes(app, { users, usage, quotas })
registerImageRoutes(app, { storage, gate, usage, quotas })
registerFileRoutes(app, { storage })
registerStyleRoutes(app, { library: styleLibrary })
registerProjectRoutes(app, { projects })
registerHistoryRoutes(app, { usage, quotas })
registerMonitorRoutes(app, { traffic, rateLimiter, processStartedAt, gate })

app.get('/api/queue', async () => ({
  busy: gate.isBusy,
  waiting: gate.queueLength,
}))

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiError) {
    return reply
      .status(error.statusCode)
      .send({ error: error.message, code: error.code })
  }

  if ((error as { statusCode?: number }).statusCode === 429) {
    return reply.status(429).send({ error: '请求过于频繁，请稍后重试', code: 'RATE_LIMITED' })
  }

  // Fastify 自身的客户端错误（400/404 等）保留原状态码
  const statusCode = (error as { statusCode?: number }).statusCode
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return reply
      .status(statusCode)
      .send({ error: (error as Error).message || '请求有误', code: 'BAD_REQUEST' })
  }

  request.log.error(error)
  return reply
    .status(500)
    .send({ error: '服务内部错误，请查看后端日志', code: 'INTERNAL_ERROR' })
})

let staticRegistered = false
try {
  // 单张工作台已合并进批量页，不再有 index.html，检查入口改为 batch.html
  await access(join(webDirectory, 'batch.html'))
  await app.register(fastifyStatic, {
    root: webDirectory,
    prefix: '/',
    decorateReply: false,
    index: ['index.html'],
  })
  staticRegistered = true

  // 单张工作台已合并进批量工作台的「自由创作」，老地址一律跳批量页
  app.get('/batch', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/studio', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/index.html', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/login', async (_request, reply) => reply.redirect('/login.html'))
  app.get('/admin', async (_request, reply) => reply.redirect('/admin.html'))
} catch (error) {
  app.log.warn(`未找到前端构建产物 ${webDirectory}，仅提供 API：${(error as Error).message}`)
}

if (!staticRegistered) {
  app.get('/', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return reply.send('<h1>画境后端</h1><p>前端请访问 Vite 开发服务，或先执行 npm run build。</p>')
  })
} else {
  // 根路径即批量工作台（唯一客户端）
  app.get('/', async (_request, reply) => reply.redirect('/batch.html'))
}

await app.listen({ host: config.host, port: config.port })

app.log.info(`Magpie 图片 API: ${config.magpieBaseUrl}/v1/images/generations`)
app.log.info(`模型: ${config.imageModel}`)
app.log.info(`存储目录: ${storageDirectory}`)
app.log.info(`风格库目录: ${styleLibraryRoot}`)
app.log.info(`账号库文件: ${userDatabasePath}`)
app.log.info(`用量统计文件: ${usageDatabasePath}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0))
  })
}
