/**
 * 全局串行闸门：任何时刻只放行一个生图请求打向上游。
 * 避免多标签页或多个前端实例同时刷同一个账号，触发供应商风控。
 */
export class SerialGate {
  private busy = false
  private readonly waiters: Array<() => void> = []

  get isBusy(): boolean {
    return this.busy
  }

  get queueLength(): number {
    return this.waiters.length
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
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.busy = false
  }
}
