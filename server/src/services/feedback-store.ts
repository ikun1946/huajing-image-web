/**
 * 意见反馈库：客户端提交 → 落 data/feedback.json → 管理员在后台标记处理。
 * 沿用 ProjectStore 的做法：写入先落 .tmp 再 rename 原子替换，写操作排成一条链，
 * 避免并发提交时互相覆盖。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type FeedbackCategory = 'bug' | 'suggestion' | 'other'
export type FeedbackStatus = 'new' | 'resolved'

export interface FeedbackEntry {
  id: string
  /** 提交者账号，管理员后台据此追溯到人 */
  userId: string
  username: string
  displayName: string
  category: FeedbackCategory
  content: string
  /** 反馈所在页面标识，客户端可不传 */
  page: string
  /** 客户端版本号，可不传 */
  appVersion: string
  createdAt: string
  status: FeedbackStatus
  /** 标记处理的时间；status 回到 new 时清空 */
  handledAt: string
  /** 最后标记处理的账号 id；status 回到 new 时清空 */
  handledBy: string
}

export interface FeedbackDatabase {
  feedback: FeedbackEntry[]
}

export interface FeedbackInput {
  userId: string
  username: string
  displayName: string
  category: FeedbackCategory
  content: string
  page?: string
  appVersion?: string
}

export type FeedbackStatusFilter = 'all' | FeedbackStatus

/** 保留上限：超出后从最旧的开始丢，防止单文件无限增长（写入追加在尾部） */
const MAX_ENTRIES = 2000

const CATEGORIES: FeedbackCategory[] = ['bug', 'suggestion', 'other']

export class FeedbackStore {
  private readonly file: string
  private cache: FeedbackDatabase = { feedback: [] }
  private pending: Promise<FeedbackDatabase> = Promise.resolve({ feedback: [] })

  constructor(dataDir: string) {
    this.file = join(dataDir, 'feedback.json')
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      this.cache = normalizeDatabase(JSON.parse(raw) as Partial<FeedbackDatabase>)
    } catch {
      // 首次运行没有文件，或文件损坏：回落到空库，不阻断服务启动
      this.cache = { feedback: [] }
    }
  }

  private enqueueWrite(mutator: (current: FeedbackDatabase) => FeedbackDatabase): Promise<FeedbackDatabase> {
    const run = async () => {
      const next = normalizeDatabase(mutator(this.cache))
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
      await rename(temp, this.file)
      this.cache = next
      return next
    }
    this.pending = this.pending.then(run, run)
    return this.pending
  }

  /** 新增一条反馈，状态固定为 new。 */
  async add(input: FeedbackInput): Promise<FeedbackEntry> {
    const entry: FeedbackEntry = {
      id: randomUUID(),
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      category: input.category,
      content: input.content,
      page: input.page ?? '',
      appVersion: input.appVersion ?? '',
      createdAt: new Date().toISOString(),
      status: 'new',
      handledAt: '',
      handledBy: '',
    }

    const database = await this.enqueueWrite(current => ({
      feedback: [...current.feedback, entry],
    }))
    return database.feedback.find(item => item.id === entry.id) ?? entry
  }

  /** 按时间倒序返回；status 传 all 表示不筛选。limit 取库容量即「全部」。 */
  async list(options: { status?: FeedbackStatusFilter; limit?: number } = {}): Promise<FeedbackEntry[]> {
    const status = options.status ?? 'all'
    const limit = clampLimit(options.limit)
    // 写入追加在尾部，倒序即「最新在前」；同毫秒写入也保持后写在前
    const ordered = [...this.cache.feedback].reverse()
    const filtered = status === 'all' ? ordered : ordered.filter(entry => entry.status === status)
    return filtered.slice(0, limit)
  }

  /**
   * 更新处理状态。找不到返回 undefined（路由据此回 404）。
   * 退回 new 时一并清空处理痕迹，避免后台把未处理条目显示成已处理。
   */
  async setStatus(id: string, status: FeedbackStatus, adminId: string): Promise<FeedbackEntry | undefined> {
    let updated: FeedbackEntry | undefined
    await this.enqueueWrite(current => ({
      feedback: current.feedback.map(entry => {
        if (entry.id !== id) return entry
        updated = status === 'resolved'
          ? { ...entry, status, handledAt: new Date().toISOString(), handledBy: adminId }
          : { ...entry, status, handledAt: '', handledBy: '' }
        return updated
      }),
    }))
    return updated
  }

  /** 全库计数（不受筛选条件影响），后台据此显示三个筛选页签的数量。 */
  counts(): { all: number; new: number; resolved: number } {
    let pending = 0
    for (const entry of this.cache.feedback) {
      if (entry.status === 'new') pending += 1
    }
    return {
      all: this.cache.feedback.length,
      new: pending,
      resolved: this.cache.feedback.length - pending,
    }
  }
}

function clampLimit(value: number | undefined): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_ENTRIES
  return Math.min(parsed, MAX_ENTRIES)
}

/** 读盘数据不可信：逐条校验字段、白名单化枚举，并裁到保留上限。 */
function normalizeDatabase(input: Partial<FeedbackDatabase> | null | undefined): FeedbackDatabase {
  const raw = Array.isArray(input?.feedback) ? input.feedback : []
  const feedback = raw
    .filter((entry): entry is FeedbackEntry => Boolean(entry) && typeof entry.id === 'string' && entry.id.length > 0)
    .map(entry => normalizeEntry(entry))

  return {
    feedback: feedback.length > MAX_ENTRIES ? feedback.slice(feedback.length - MAX_ENTRIES) : feedback,
  }
}

function normalizeEntry(entry: FeedbackEntry): FeedbackEntry {
  return {
    id: entry.id,
    userId: String(entry.userId || ''),
    username: String(entry.username || ''),
    displayName: String(entry.displayName || ''),
    category: CATEGORIES.includes(entry.category) ? entry.category : 'other',
    content: String(entry.content || ''),
    page: String(entry.page || ''),
    appVersion: String(entry.appVersion || ''),
    createdAt: String(entry.createdAt || ''),
    status: entry.status === 'resolved' ? 'resolved' : 'new',
    handledAt: String(entry.handledAt || ''),
    handledBy: String(entry.handledBy || ''),
  }
}