import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { SESSION_COOKIE, type SessionStore } from '../lib/session.js'
import { toPublicUser, type UserStore } from '../services/user-store.js'
import { config } from '../config.js'

interface LoginBody {
  username?: unknown
  password?: unknown
}

export interface AuthContext {
  userId: string
  username: string
  displayName: string
  role: 'admin' | 'user'
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext
  }
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { users: UserStore; sessions: SessionStore },
): void {
  app.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!username || !password) {
      throw new ApiError('AUTH_INVALID', '请输入用户名和密码')
    }

    const user = await deps.users.authenticate(username, password)
    if (!user) {
      throw new ApiError('AUTH_INVALID', '用户名或密码不正确，或账号已被停用')
    }

    const session = deps.sessions.create(user.id)
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
    })

    return { user: toPublicUser(user) }
  })

  // 首次部署：若一个账号都没有，允许用管理密钥引导创建第一个管理员。
  // 密钥来自 ADMIN_SETUP_KEY，未设置时该接口不可用。
  // 账号库是否为空，用于登录页显示引导创建
  app.get('/api/auth/status', async () => {
    const users = await deps.users.list()
    return {
      needsSetup: users.length === 0,
      setupEnabled: Boolean(config.adminSetupKey),
    }
  })
  app.post('/api/auth/setup', async (request) => {
    if (!config.adminSetupKey) {
      throw new ApiError('AUTH_FORBIDDEN', '未配置管理密钥，无法引导创建账号', 403)
    }

    const body = (request.body ?? {}) as { setupKey?: unknown; username?: unknown; password?: unknown; displayName?: unknown }
    const setupKey = typeof body.setupKey === 'string' ? body.setupKey : ''
    if (setupKey !== config.adminSetupKey) {
      throw new ApiError('AUTH_FORBIDDEN', '管理密钥不正确', 403)
    }

    const existing = await deps.users.list()
    if (existing.length > 0) {
      throw new ApiError('AUTH_INVALID', '账号库已初始化，请直接登录', 409)
    }

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username) throw new ApiError('AUTH_INVALID', '用户名不能为空')
    if (password.length < 6) throw new ApiError('AUTH_INVALID', '密码至少 6 位')

    const user = await deps.users.create({
      username,
      displayName: typeof body.displayName === 'string' ? body.displayName : username,
      password,
      role: 'admin',
    })
    return { user: toPublicUser(user) }
  })
  app.post('/api/auth/logout', async (request, reply) => {
    const token = readSessionToken(request)
    deps.sessions.destroy(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async request => {
    const auth = await resolveAuth(request, deps)
    if (!auth) {
      throw new ApiError('AUTH_REQUIRED', '请先登录')
    }
    return { user: auth }
  })
}

function readSessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim()
  }
  const cookie = request.cookies?.[SESSION_COOKIE]
  return typeof cookie === 'string' ? cookie : undefined
}

/** 解析当前请求的登录身份，未登录返回 undefined。 */
export async function resolveAuth(
  request: FastifyRequest,
  deps: { users: UserStore; sessions: SessionStore },
): Promise<AuthContext | undefined> {
  const token = readSessionToken(request)
  const session = deps.sessions.get(token)
  if (!session) return undefined

  const user = await deps.users.findById(session.userId)
  if (!user || user.disabled) return undefined

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  }
}

/** 需要登录才能访问的守卫。 */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw new ApiError('AUTH_REQUIRED', '请先登录')
  }
  return request.auth
}

/** 需要管理员权限的守卫。 */
export function requireAdmin(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request)
  if (auth.role !== 'admin') {
    throw new ApiError('AUTH_FORBIDDEN', '需要管理员权限', 403)
  }
  return auth
}

export function setAuthCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
  })
}
