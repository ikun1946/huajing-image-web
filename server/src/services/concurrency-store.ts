/**
 * 生图并发上限的持久化（<dataDir>/concurrency.json）。
 * 控制台修改后立即生效并落盘，服务重启后沿用；文件不存在时才用
 * IMAGE_CONCURRENCY 环境变量 / 默认值。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MIN_LIMIT = 1
const MAX_LIMIT = 8

export function clampConcurrency(value: number): number {
  const limit = Math.floor(Number(value))
  if (!Number.isFinite(limit)) return MIN_LIMIT
  return Math.min(Math.max(limit, MIN_LIMIT), MAX_LIMIT)
}

export class ConcurrencyStore {
  private readonly file: string
  private limit: number

  constructor(dataDir: string, fallback: number) {
    this.file = join(dataDir, 'concurrency.json')
    this.limit = clampConcurrency(fallback)
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { limit?: unknown }
      this.limit = clampConcurrency(Number(parsed?.limit))
    } catch {
      // 没有文件或文件损坏：沿用环境变量 / 默认值
    }
  }

  get(): number {
    return this.limit
  }

  async set(limit: number): Promise<number> {
    this.limit = clampConcurrency(limit)
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(
      temp,
      JSON.stringify({ limit: this.limit, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
    await rename(temp, this.file)
    return this.limit
  }
}