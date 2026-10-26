import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'

export interface Session {
  token: string
  userId: string
  expiresAt: number
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 内存会话表。
 * 签名用 HMAC，令牌不可伪造；重启后需重新登录。
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly secret: string

  constructor(secret: string) {
    this.secret = secret
  }

  create(userId: string): Session {
    const token = randomBytes(32).toString('hex')
    const session: Session = {
      token,
      userId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    this.sessions.set(token, session)
    this.prune()
    return session
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined
    const session = this.sessions.get(token)
    if (!session) return undefined
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token)
      return undefined
    }
    return session
  }

  destroy(token: string | undefined): void {
    if (!token) return
    this.sessions.delete(token)
  }

  destroyByUser(userId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(token)
    }
  }

  /** 校验 cookie 签名，防止伪造。 */
  verifySignature(raw: string, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(raw).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  sign(raw: string): string {
    return createHmac('sha256', this.secret).update(raw).digest('hex')
  }

  private prune(): void {
    const now = Date.now()
    for (const [token, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(token)
    }
  }
}

export const SESSION_COOKIE = 'huajing_session'
