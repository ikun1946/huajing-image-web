import type { FastifyInstance } from 'fastify'
import os from 'node:os'
import { requireAdmin } from './auth.js'
import type { RateLimiter } from '../services/rate-limiter.js'
import type { TrafficStore } from '../services/traffic-store.js'
import type { SerialGate } from '../lib/serial-gate.js'

export function registerMonitorRoutes(
  app: FastifyInstance,
  deps: {
    traffic: TrafficStore
    rateLimiter: RateLimiter
    processStartedAt: number
    gate: SerialGate
  },
): void {
  // 管理端监控总览：流量、运行时间、限流状态
  app.get('/api/admin/monitor', async request => {
    requireAdmin(request)

    const snapshot = deps.traffic.snapshot()
    const uptimeMs = Date.now() - deps.processStartedAt

    return {
      uptime: {
        startedAt: new Date(deps.processStartedAt).toISOString(),
        uptimeMs,
        uptimeText: formatUptime(uptimeMs),
      },
      host: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()}`,
        totalMemoryGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        loadAvg: os.loadavg()[0] || 0,
      },
      traffic: {
        total: snapshot.total,
        since: snapshot.since,
        clients: snapshot.clients,
      },
      rateLimit: deps.rateLimiter.status(),
      queue: {
        busy: deps.gate.isBusy,
        waiting: deps.gate.queueLength,
      },
    }
  })

  // 管理端限流配置：读取 + 修改
  app.get('/api/admin/rate-limit', async request => {
    requireAdmin(request)
    return deps.rateLimiter.status()
  })

  app.put('/api/admin/rate-limit', async (request, reply) => {
    requireAdmin(request)
    const body = (request.body ?? {}) as {
      enabled?: unknown
      windowMs?: unknown
      maxRequests?: unknown
    }

    const config = await deps.rateLimiter.updateConfig({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      windowMs: Number(body.windowMs) > 0 ? Number(body.windowMs) : undefined,
      maxRequests: Number(body.maxRequests) > 0 ? Number(body.maxRequests) : undefined,
    })

    return reply.send({ config })
  })
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86_400)
  const hours = String(Math.floor((totalSec % 86_400) / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')
  const seconds = String(totalSec % 60).padStart(2, '0')
  if (days > 0) return `${days} 天 ${hours}:${minutes}:${seconds}`
  return `${hours}:${minutes}:${seconds}`
}
