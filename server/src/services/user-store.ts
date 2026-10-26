import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hashPassword, verifyPassword } from '../lib/password.js'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  passwordSalt: string
  passwordHash: string
  role: 'admin' | 'user'
  disabled: boolean
  createdAt: string
  lastLoginAt: string
}

export interface PublicUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
  disabled: boolean
  createdAt: string
  lastLoginAt: string
}

export interface UserDatabase {
  users: UserRecord[]
}

export function toPublicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
    disabled: record.disabled,
    createdAt: record.createdAt,
    lastLoginAt: record.lastLoginAt,
  }
}

export class UserStore {
  private readonly file: string
  private cache: UserDatabase | null = null

  constructor(file: string) {
    this.file = file
  }

  async read(): Promise<UserDatabase> {
    if (this.cache) return this.cache

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<UserDatabase>
      this.cache = {
        users: Array.isArray(parsed.users)
          ? parsed.users.filter(user => user && typeof user.id === 'string')
          : [],
      }
    } catch {
      this.cache = { users: [] }
    }
    return this.cache
  }

  async write(database: UserDatabase): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(database, null, 2), 'utf8')
    await rename(temp, this.file)
    this.cache = database
  }

  async list(): Promise<UserRecord[]> {
    return (await this.read()).users
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    const normalized = username.trim().toLowerCase()
    return (await this.read()).users.find(user => user.username.toLowerCase() === normalized)
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return (await this.read()).users.find(user => user.id === id)
  }

  /** 管理员创建账号。用户名唯一。 */
  async create(input: {
    username: string
    displayName: string
    password: string
    role: 'admin' | 'user'
  }): Promise<UserRecord> {
    const database = await this.read()
    const username = input.username.trim()

    if (!username) throw new Error('用户名不能为空')
    if (database.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('用户名已存在')
    }

    const { salt, hash } = await hashPassword(input.password)
    const record: UserRecord = {
      id: randomUUID(),
      username,
      displayName: input.displayName.trim() || username,
      passwordSalt: salt,
      passwordHash: hash,
      role: input.role,
      disabled: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: '',
    }

    database.users.push(record)
    await this.write(database)
    return record
  }

  async setDisabled(id: string, disabled: boolean): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record) return undefined
    record.disabled = disabled
    await this.write(database)
    return record
  }

  async setPassword(id: string, password: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record) return undefined
    const { salt, hash } = await hashPassword(password)
    record.passwordSalt = salt
    record.passwordHash = hash
    await this.write(database)
    return record
  }

  async setDisplayName(id: string, displayName: string): Promise<UserRecord | undefined> {
    const database = await this.read()
    const record = database.users.find(user => user.id === id)
    if (!record) return undefined
    record.displayName = displayName.trim() || record.username
    await this.write(database)
    return record
  }

  async remove(id: string): Promise<boolean> {
    const database = await this.read()
    const index = database.users.findIndex(user => user.id === id)
    if (index < 0) return false
    database.users.splice(index, 1)
    await this.write(database)
    return true
  }

  async authenticate(username: string, password: string): Promise<UserRecord | undefined> {
    const record = await this.findByUsername(username)
    if (!record) {
      // 即便用户不存在也做一次哈希运算，避免用耗时差异探测用户名是否存在
      await verifyPassword(password, { salt: 'x', hash: 'x' })
      return undefined
    }
    if (record.disabled) return undefined

    const ok = await verifyPassword(password, {
      salt: record.passwordSalt,
      hash: record.passwordHash,
    })
    if (!ok) return undefined

    record.lastLoginAt = new Date().toISOString()
    await this.write(await this.read())
    return record
  }
}
