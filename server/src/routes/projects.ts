import type { FastifyInstance } from 'fastify'
import { ApiError } from '../lib/errors.js'
import type { ProjectStore } from '../services/project-store.js'

interface CreateBody {
  name?: unknown
  fileName?: unknown
}

interface UpdateBody {
  name?: unknown
  assets?: unknown
  styles?: unknown
  defaultStyle?: unknown
  bulkParams?: unknown
}

export function registerProjectRoutes(app: FastifyInstance, deps: { projects: ProjectStore }): void {
  app.get('/api/projects', async () => {
    const projects = await deps.projects.list()
    const database = await deps.projects.read()
    return { projects, activeProjectId: database.activeProjectId }
  })

  app.get('/api/projects/:id', async request => {
    const id = (request.params as { id?: string }).id ?? ''
    const project = await deps.projects.find(id)
    if (!project) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { project }
  })

  app.post('/api/projects', async request => {
    const body = (request.body ?? {}) as CreateBody
    const project = await deps.projects.create({
      name: typeof body.name === 'string' ? body.name : undefined,
      fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
    })
    return { project }
  })

  app.patch('/api/projects/:id', async request => {
    const id = (request.params as { id?: string }).id ?? ''
    const body = (request.body ?? {}) as UpdateBody

    const patch: Record<string, unknown> = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (body.assets !== undefined) patch.assets = body.assets
    if (body.styles !== undefined) patch.styles = body.styles
    if (body.defaultStyle !== undefined) patch.defaultStyle = body.defaultStyle
    if (body.bulkParams !== undefined) patch.bulkParams = body.bulkParams

    const project = await deps.projects.save(id, patch)
    if (!project) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { project }
  })

  app.delete('/api/projects/:id', async request => {
    const id = (request.params as { id?: string }).id ?? ''
    const removed = await deps.projects.remove(id)
    if (!removed) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { ok: true }
  })

  app.post('/api/projects/:id/activate', async request => {
    const id = (request.params as { id?: string }).id ?? ''
    const project = await deps.projects.setActive(id)
    if (!project) throw new ApiError('PROJECT_NOT_FOUND', '项目不存在', 404)
    return { project }
  })
}
