import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { checkHealth } from '../services/magpie.js'

export function registerMetaRoutes(app: FastifyInstance): void {
  app.get('/api/config', async () => ({
    ratios: config.ratios.map(({ id, label, shortLabel, width, height, nativeWidth, nativeHeight, promptHint }) => ({
      id,
      label,
      shortLabel,
      width,
      height,
      nativeWidth,
      nativeHeight,
      promptHint,
    })),
    maxPromptLength: config.maxPromptLength,
    defaults: {
      ratio: config.defaultRatio,
      byAssetType: {
        role: config.defaultRoleRatio,
        scene: config.defaultSceneRatio,
        prop: config.defaultPropRatio,
      },
    },
  }))

  app.get('/api/health', async () => {
    const magpie = await checkHealth({
      baseUrl: config.magpieBaseUrl,
      model: config.imageModel,
      timeoutMs: config.requestTimeoutMs,
    })
    return {
      status: magpie.reachable ? 'ok' : 'degraded',
      magpie,
    }
  })
}
