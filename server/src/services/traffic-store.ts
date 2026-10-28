/**
 * 按客户端 IP 的流量与请求统计。
 * 内存累计 + 定期落盘到 data/traffic.json，重启后延续总量。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ClientTraffic {
  /** 累计请求次数 */
  requests: number
  /** 累计响应字节数 */
  bytesOut: number
  /** 累计请求字节数 */
  bytesIn: number
  /** 被限流拒绝的次数 */
  rejected: number
  lastSeen: string
}

interface TrafficDatabase {
  clients: Record<string, ClientTraffic>
  /** 服务累计启动时间戳，用于运行时间统计 */
  totalStartedAt: string
}

function emptyClient(): ClientTraffic {
  return { requests: 0, bytesOut: 0, bytesIn: 0, rejected: 0, lastSeen: '' }
}

export class TrafficStore {
  private readonly file: string
  private db: TrafficDatabase = { clients: {}, totalStartedAt: new Date().toISOString() }
  private dirty = false

  constructor(dataDir: string) {
    this.file = join(dataDir, 'traffic.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<TrafficDatabase>
      if (parsed && typeof parsed === 'object') {
        this.db = {
          clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
          totalStartedAt: parsed.totalStartedAt || new Date().toISOString(),
        }
      }
    } catch {
      // 首次运行没有历史文件
    }
    if (!this.db.totalStartedAt) this.db.totalStartedAt = new Date().toISOString()
  }

  record(ip: string, bytesIn: number, bytesOut: number, rejected = false): void {
    const client = this.db.clients[ip] || emptyClient()
    client.requests += 1
    client.bytesIn += bytesIn
    client.bytesOut += bytesOut
    if (rejected) client.rejected += 1
    client.lastSeen = new Date().toISOString()
    this.db.clients[ip] = client
    this.dirty = true
  }

  snapshot(): { clients: Array<ClientTraffic & { ip: string }>; total: ClientTraffic; since: string } {
    const clients = Object.entries(this.db.clients)
      .map(([ip, stat]) => ({ ip, ...stat }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 100)

    const total = emptyClient()
    for (const client of Object.values(this.db.clients)) {
      total.requests += client.requests
      total.bytesIn += client.bytesIn
      total.bytesOut += client.bytesOut
      total.rejected += client.rejected
    }

    return { clients, total, since: this.db.totalStartedAt }
  }

  /** 定期调用：有变更才写盘。 */
  async flushIfDirty(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(this.db, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
