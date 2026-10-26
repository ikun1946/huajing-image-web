import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface UsageEntry {
  id: string
  /** 账号 id；匿名或未知来源记为 '' */
  userId: string
  username: string
  displayName: string
  /** 单张或批量 */
  source: 'studio' | 'batch' | 'free'
  category: string
  name: string
  ratio: string
  width: number
  height: number
  bytes: number
  createdAt: string
}

export interface UsageDatabase {
  entries: UsageEntry[]
}

export class UsageStore {
  private readonly file: string
  private cache: UsageDatabase | null = null
  private pending: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  async read(): Promise<UsageDatabase> {
    if (this.cache) return this.cache

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UsageDatabase>
      this.cache = {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      }
    } catch {
      this.cache = { entries: [] }
    }
    return this.cache
  }

  async write(database: UsageDatabase): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(database, null, 2), 'utf8')
    await rename(temp, this.file)
    this.cache = database
  }

  /** 记录一次生图。串行化写入，避免并发丢数据。 */
  async record(entry: Omit<UsageEntry, 'id' | 'createdAt'>): Promise<UsageEntry> {
    this.pending = this.pending.then(async () => {
      const database = await this.read()
      const full: UsageEntry = {
        ...entry,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      database.entries.push(full)
      await this.write(database)
    })
    await this.pending
    return { ...entry, id: '', createdAt: '' }
  }

  async entries(): Promise<UsageEntry[]> {
    return (await this.read()).entries
  }
}
