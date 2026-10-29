/**
 * 生图闸门：限制同时打向 Magpie 的生图请求数。
 *
 * 上限可在运行时调整（服务端控制台 → 生图并发），调整后立即生效，
 * 并拆成两档：前端默认并行 5，批量页的并行数不会超过这里；调到 1 即逐张生成。
 * 无论多少标签页/账号，合计都不会超过这个上限，避免把上游刷爆触发风控。
 */
const MIN_LIMIT = 1
const MAX_LIMIT = 8

function clampLimit(value: number): number {
  const limit = Math.floor(Number(value))
  if (!Number.isFinite(limit)) return MIN_LIMIT
  return Math.min(Math.max(limit, MIN_LIMIT), MAX_LIMIT)
}

export class SerialGate {
  private active = 0
  private readonly waiters: Array<() => void> = []
  private limit: number

  constructor(limit = 1) {
    this.limit = clampLimit(limit)
  }

  get isBusy(): boolean {
    return this.active > 0
  }

  /** 当前在途的生图请求数 */
  get activeCount(): number {
    return this.active
  }

  /** 允许的最大并行数 */
  get limitCount(): number {
    return this.limit
  }

  get queueLength(): number {
    return this.waiters.length
  }

  /**
   * 调整并行上限：调高会立刻放行排队的请求；调低不会打断在途请求，
   * 但新请求要等在途数降下来才会进入。返回实际生效的值（夹在 1–8）。
   */
  setLimit(limit: number): number {
    this.limit = clampLimit(limit)
    this.wake()
    return this.limit
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    this.wake()
  }

  /** 有空位就唤醒排队者；每次唤醒都会把 active 加回来，所以要在循环里重新判断 */
  private wake(): void {
    while (this.active < this.limit && this.waiters.length) {
      const next = this.waiters.shift()
      if (!next) break
      next()
    }
  }
}