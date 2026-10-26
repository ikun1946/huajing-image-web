import type { FastifyInstance } from 'fastify'
import { config, findRatio } from '../config.js'
import { ApiError } from '../lib/errors.js'
import type { SerialGate } from '../lib/serial-gate.js'
import { requestImage } from '../services/magpie.js'
import { detectImageType, readImageSize } from '../services/imaging.js'
import type { ImageStorage } from '../services/storage.js'
import type { UsageStore } from '../services/usage-store.js'
import { requireAuth } from './auth.js'

interface GenerateBody {
  prompt?: unknown
  ratio?: unknown
  /** 资产类型，决定子文件夹 */
  category?: unknown
  /** 资产名称，用作文件名主体 */
  name?: unknown
  /** 来源标记，用于统计 */
  source?: unknown
}

export function registerImageRoutes(
  app: FastifyInstance,
  deps: { storage: ImageStorage; gate: SerialGate; usage: UsageStore },
): void {
  app.post('/api/images', async (request, reply) => {
    const auth = requireAuth(request)
    const body = (request.body ?? {}) as GenerateBody
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''

    if (!prompt) {
      throw new ApiError('INVALID_PROMPT', '请输入图片提示词')
    }

    if (prompt.length > config.maxPromptLength) {
      throw new ApiError(
        'PROMPT_TOO_LONG',
        `提示词不能超过 ${config.maxPromptLength} 个字符`,
      )
    }

    const ratio = findRatio(body.ratio)
    if (!ratio) {
      throw new ApiError('RATIO_INVALID', '请选择有效的图片比例')
    }

    // 串行闸门：同一时刻只允许一个生图请求打向 Magpie
    const generated = await deps.gate.run(async () => {
      const upstream = await requestImage(
        {
          baseUrl: config.magpieBaseUrl,
          model: config.imageModel,
          timeoutMs: config.requestTimeoutMs,
        },
        { prompt, ratioHint: ratio.promptHint },
      )

      let type
      try {
        type = detectImageType(upstream.buffer)
      } catch {
        throw new ApiError('IMAGE_UNSUPPORTED', 'Magpie 返回了不支持的图片格式', 502)
      }

      const size = readImageSize(upstream.buffer)
      // 上游按画幅输出的原生尺寸已足够准确，直接交付原图，不做缩放
      const stored = await deps.storage.save(upstream.buffer, type.extension, {
        category: typeof body.category === 'string' ? body.category : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        width: size?.width,
        height: size?.height,
      })

      return { stored, model: upstream.model, mimeType: type.mimeType, size }
    })

    const category = typeof body.category === 'string' ? body.category : '未分类'
    const assetName = typeof body.name === 'string' ? body.name : ''
    const source =
      body.source === 'batch' || body.source === 'free' ? body.source : 'studio'

    // 记录本次生图归属，供管理端统计
    await deps.usage.record({
      userId: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      source,
      category,
      name: assetName,
      ratio: ratio.id,
      width: generated.size?.width ?? ratio.nativeWidth,
      height: generated.size?.height ?? ratio.nativeHeight,
      bytes: generated.stored.bytes,
    })

    return reply.send({
      id: generated.stored.id,
      imageUrl: buildImageUrl(
        request,
        generated.stored.id,
        generated.stored.relativePath,
        typeExtension(generated.mimeType),
      ),
      model: generated.model,
      mimeType: generated.mimeType,
      bytes: generated.stored.bytes,
      width: generated.size?.width ?? ratio.nativeWidth,
      height: generated.size?.height ?? ratio.nativeHeight,
      ratio: ratio.id,
    })
  })
}

function buildImageUrl(
  request: { headers: Record<string, unknown>; protocol?: string },
  id: string,
  relativePath: string,
  extension: string,
): string {
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/')
  const configured = config.publicBaseUrl
  if (configured) return `${configured}/api/files/${encoded}`

  const host = (request.headers['x-forwarded-host'] as string) || (request.headers.host as string)
  const protocol =
    (request.headers['x-forwarded-proto'] as string) ||
    request.protocol ||
    'http'

  if (!host) return `/api/files/${encoded}`
  return `${protocol}://${host}/api/files/${encoded}`
}

function typeExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      return 'png'
  }
}
