import type { FastifyInstance } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { requireAdmin } from './auth.js'
import { toPublicUser, type UserStore } from '../services/user-store.js'
import type { UsageEntry, UsageStore } from '../services/usage-store.js'

interface CreateUserBody {
  username?: unknown
  displayName?: unknown
  password?: unknown
  role?: unknown
}

interface UpdateUserBody {
  displayName?: unknown
  password?: unknown
  disabled?: unknown
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: { users: UserStore; usage: UsageStore },
): void {
  // 以下所有接口都要求管理员身份
  app.get('/api/admin/users', async request => {
    requireAdmin(request)
    const users = await deps.users.list()
    return { users: users.map(toPublicUser) }
  })

  app.post('/api/admin/users', async request => {
    requireAdmin(request)
    const body = (request.body ?? {}) as CreateUserBody

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName : ''
    const role = body.role === 'admin' ? 'admin' : 'user'

    if (!username) throw new ApiError('INVALID_STYLES', '用户名不能为空')
    if (password.length < 6) {
      throw new ApiError('INVALID_STYLES', '密码至少 6 位')
    }

    try {
      const user = await deps.users.create({ username, displayName, password, role })
      return { user: toPublicUser(user) }
    } catch (error) {
      throw new ApiError('INVALID_STYLES', (error as Error).message)
    }
  })

  app.patch('/api/admin/users/:id', async request => {
    requireAdmin(request)
    const id = (request.params as { id?: string }).id ?? ''
    const body = (request.body ?? {}) as UpdateUserBody

    if (typeof body.displayName === 'string') {
      await deps.users.setDisplayName(id, body.displayName)
    }
    if (typeof body.password === 'string' && body.password) {
      if (body.password.length < 6) {
        throw new ApiError('INVALID_STYLES', '密码至少 6 位')
      }
      await deps.users.setPassword(id, body.password)
    }
    if (typeof body.disabled === 'boolean') {
      await deps.users.setDisabled(id, body.disabled)
    }

    const user = await deps.users.findById(id)
    if (!user) throw new ApiError('AUTH_INVALID', '账号不存在', 404)
    return { user: toPublicUser(user) }
  })

  app.delete('/api/admin/users/:id', async request => {
    const admin = requireAdmin(request)
    const id = (request.params as { id?: string }).id ?? ''

    if (id === admin.userId) {
      throw new ApiError('INVALID_STYLES', '不能删除当前登录的管理员账号')
    }
    const removed = await deps.users.remove(id)
    if (!removed) throw new ApiError('AUTH_INVALID', '账号不存在', 404)
    return { ok: true }
  })

  // 统计：总量 + 按账号细分
  app.get('/api/admin/stats', async request => {
    requireAdmin(request)
    const entries = await deps.usage.entries()
    return buildStats(entries)
  })
}

export interface AccountStat {
  userId: string
  username: string
  displayName: string
  count: number
  bytes: number
  lastGeneratedAt: string
}

export interface StatsPayload {
  totalImages: number
  totalBytes: number
  accountCount: number
  accounts: AccountStat[]
  recent: Array<{
    id: string
    username: string
    displayName: string
    category: string
    name: string
    ratio: string
    width: number
    height: number
    bytes: number
    createdAt: string
  }>
}

export function buildStats(entries: UsageEntry[]): StatsPayload {
  const byAccount = new Map<string, AccountStat>()

  for (const entry of entries) {
    const key = entry.userId || '__anonymous__'
    const existing = byAccount.get(key)
    if (existing) {
      existing.count += 1
      existing.bytes += entry.bytes
      if (entry.createdAt > existing.lastGeneratedAt) {
        existing.lastGeneratedAt = entry.createdAt
      }
    } else {
      byAccount.set(key, {
        userId: entry.userId,
        username: entry.username || '（未登录）',
        displayName: entry.displayName || '（未登录）',
        count: 1,
        bytes: entry.bytes,
        lastGeneratedAt: entry.createdAt,
      })
    }
  }

  const accounts = [...byAccount.values()].sort((a, b) => b.count - a.count)

  return {
    totalImages: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    accountCount: accounts.length,
    accounts,
    recent: entries
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 50)
      .map(entry => ({
        id: entry.id,
        username: entry.username || '（未登录）',
        displayName: entry.displayName || '（未登录）',
        category: entry.category,
        name: entry.name,
        ratio: entry.ratio,
        width: entry.width,
        height: entry.height,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
      })),
  }
}
