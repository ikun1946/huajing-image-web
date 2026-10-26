import type { FastifyInstance } from 'fastify'
import { ApiError } from '../lib/errors.js'
import type { StyleLibrary, StyleLibraryStore } from '../services/style-library.js'

interface StyleBody {
  styles?: unknown
  defaultStyle?: unknown
}

export function registerStyleRoutes(app: FastifyInstance, deps: { library: StyleLibraryStore }): void {
  app.get('/api/styles', async () => deps.library.read())

  app.put('/api/styles', async (request) => {
    const body = (request.body ?? {}) as StyleBody
    if (!body || typeof body !== 'object') {
      throw new ApiError('INVALID_STYLES', '风格数据格式无效')
    }

    const incoming = body as Partial<StyleLibrary>
    if (!incoming.styles || typeof incoming.styles !== 'object') {
      throw new ApiError('INVALID_STYLES', '风格数据格式无效')
    }

    const saved = await deps.library.write(incoming as StyleLibrary)
    return saved
  })
}
