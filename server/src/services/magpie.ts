import { ApiError } from '../lib/errors.js'

export interface MagpieOptions {
  baseUrl: string
  model: string
  timeoutMs: number
}

export interface MagpieImageResult {
  buffer: Buffer
  model: string
}

export async function requestImage(
  options: MagpieOptions,
  params: { prompt: string; ratioHint: string },
): Promise<MagpieImageResult> {
  let upstream: Response

  try {
    upstream = await fetch(`${options.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        // 不传 size：实测传 size 会让构图走样，文字描述比例反而更准
        prompt: `${params.prompt}\n\n${params.ratioHint}`,
        n: 1,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (error) {
    const isTimeout = (error as Error).name === 'TimeoutError'
    throw new ApiError(
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      isTimeout ? '生成超时，请稍后重试' : '无法连接 Magpie，请确认 Magpie 正在运行',
      502,
    )
  }

  const raw = await upstream.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'Magpie 返回了无法解析的响应', 502)
  }

  if (!upstream.ok) {
    const message = extractErrorMessage(payload) || '图片生成失败'
    throw new ApiError('UPSTREAM_ERROR', translateUpstreamError(message), upstream.status)
  }

  const base64 = extractBase64(payload)
  if (!base64) {
    throw new ApiError('UPSTREAM_BAD_RESPONSE', 'Magpie 没有返回图片数据', 502)
  }

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.byteLength === 0) {
    throw new ApiError('IMAGE_INVALID', '返回的图片数据无效', 502)
  }

  return {
    buffer,
    model: extractModel(payload) || options.model,
  }
}

export async function checkHealth(options: MagpieOptions): Promise<{
  reachable: boolean
  model: string
  baseUrl: string
  error?: string
}> {
  try {
    const response = await fetch(`${options.baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    return {
      reachable: response.ok,
      model: options.model,
      baseUrl: options.baseUrl,
      ...(response.ok ? {} : { error: `Magpie 返回 ${response.status}` }),
    }
  } catch (error) {
    return {
      reachable: false,
      model: options.model,
      baseUrl: options.baseUrl,
      error: (error as Error).message,
    }
  }
}

function extractBase64(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) return undefined
  const first = data[0] as { b64_json?: unknown }
  return typeof first?.b64_json === 'string' ? first.b64_json : undefined
}

function extractModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const model = (payload as { model?: unknown }).model
  return typeof model === 'string' ? model : undefined
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
}

/**
 * 上游（chatgpt.com）的安全策略拒绝时，返回的是一大段英文技术信息。
 * 这里翻译成用户能看懂的中文，同时保留原始 request id 方便排查。
 */
function translateUpstreamError(message: string): string {
  if (!/rejected by the safety system/i.test(message)) return message

  const categories = [...message.matchAll(/safety_violations=\[([^\]]*)\]/g)]
    .map(match => (match[1] || '').trim())
    .filter(Boolean)

  const labels: Record<string, string> = {
    violence: '血腥暴力',
    sexual: '色情内容',
    'sexual-minors': '未成年人色情',
    hate: '仇恨言论',
    'hate-symbols': '仇恨符号',
    'self-harm': '自残伤害',
    illicit: '违法行为',
    'illicit-drugs': '违禁药物',
    'graphic-violence': '血腥暴力',
    'sexual-content': '色情内容',
    'non-consensual': '非自愿行为',
    'personal-data': '个人隐私',
    'protected-class': '歧视性内容',
  }

  const names = categories.length
    ? categories.map(item => labels[item.toLowerCase()] || item).join('、')
    : '违规内容'

  const requestId = message.match(/request ID ([0-9a-f-]{36})/i)?.[1]

  return `提示词被上游安全策略拦截（涉及${names}）。请调整画面描述后重试。${requestId ? ` 排查编号：${requestId}` : ''}`
}
