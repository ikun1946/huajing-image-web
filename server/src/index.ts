import { mkdir } from 'node:fs/promises'
import { access } from 'node:fs/promises'
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
import { registerImageRoutes } from './routes/images.js'
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
const styleLibraryPath = config.styleLibraryPath
  ? resolve(config.styleLibraryPath)
  : join(projectRoot, 'styles.json')
const userDatabasePath = config.userDatabasePath
  ? resolve(config.userDatabasePath)
  : join(projectRoot, 'users.json')
const usageDatabasePath = config.usageDatabasePath
  ? resolve(config.usageDatabasePath)
  : join(projectRoot, 'usage.json')
const projectDatabasePath = config.projectDatabasePath
  ? resolve(config.projectDatabasePath)
  : join(projectRoot, 'projects.json')
const webDirectory = join(projectRoot, 'web', 'dist')

await mkdir(storageDirectory, { recursive: true })

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: undefined,
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
    const allowed = config.corsOrigins.includes(origin)
    callback(null, allowed)
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400,
})

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
const styleLibrary = new StyleLibraryStore(styleLibraryPath)
const projects = new ProjectStore(projectDatabasePath)
const users = new UserStore(userDatabasePath)
const usage = new UsageStore(usageDatabasePath)
const sessions = new SessionStore(config.sessionSecret || randomBytes(32).toString('hex'))
const gate = new SerialGate()

// 每个请求解析登录身份，未登录时 request.auth 为空
app.addHook('onRequest', async request => {
  request.auth = await resolveAuth(request, { users, sessions })
})

registerMetaRoutes(app)
registerAuthRoutes(app, { users, sessions })
registerAdminRoutes(app, { users, usage })
registerImageRoutes(app, { storage, gate, usage })
registerFileRoutes(app, { storage })
registerStyleRoutes(app, { library: styleLibrary })
registerProjectRoutes(app, { projects })

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
  await access(join(webDirectory, 'index.html'))
  await app.register(fastifyStatic, {
    root: webDirectory,
    prefix: '/',
    decorateReply: false,
    index: ['index.html'],
  })
  staticRegistered = true

  app.get('/batch', async (_request, reply) => reply.redirect('/batch.html'))
  app.get('/studio', async (_request, reply) => reply.redirect('/index.html'))
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
}

await app.listen({ host: config.host, port: config.port })

app.log.info(`Magpie 图片 API: ${config.magpieBaseUrl}/v1/images/generations`)
app.log.info(`模型: ${config.imageModel}`)
app.log.info(`存储目录: ${storageDirectory}`)
app.log.info(`风格库文件: ${styleLibraryPath}`)
app.log.info(`账号库文件: ${userDatabasePath}`)
app.log.info(`用量统计文件: ${usageDatabasePath}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0))
  })
}
