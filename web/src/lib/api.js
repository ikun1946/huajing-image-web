import { API_BASE } from './config.js'

export class ApiRequestError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

export async function request(path, options = {}) {
  const hasBody = options.body !== undefined && options.body !== null
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })

  const isJson = (response.headers.get('content-type') || '').includes('application/json')
  const payload = isJson ? await response.json().catch(() => null) : null

  if (!response.ok) {
    throw new ApiRequestError(
      payload?.error || `请求失败（HTTP ${response.status}）`,
      payload?.code,
      response.status,
    )
  }

  return payload
}

export function generateImage({ prompt, ratio, category, name, source }) {
  return request('/api/images', {
    method: 'POST',
    body: JSON.stringify({ prompt, ratio, category, name, source }),
  })
}

export function fetchServerConfig() {
  return request('/api/config', { method: 'GET' })
}

export function fetchHealth() {
  return request('/api/health', { method: 'GET' })
}

export function fetchStyleLibrary() {
  return request('/api/styles', { method: 'GET' })
}

export function saveStyleLibrary(library) {
  return request('/api/styles', {
    method: 'PUT',
    body: JSON.stringify(library),
  })
}

// ---------- 认证 ----------

export function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logout() {
  return request('/api/auth/logout', { method: 'POST' })
}

export function fetchCurrentUser() {
  return request('/api/auth/me', { method: 'GET' })
}

// ---------- 管理端 ----------

export function fetchAdminUsers() {
  return request('/api/admin/users', { method: 'GET' })
}

export function createAdminUser({ username, displayName, password, role }) {
  return request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, displayName, password, role }),
  })
}

export function updateAdminUser(id, patch) {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteAdminUser(id) {
  return request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function fetchAdminStats() {
  return request('/api/admin/stats', { method: 'GET' })
}
// ---------- 项目 ----------

export function fetchProjects() {
  return request('/api/projects', { method: 'GET' })
}

export function fetchProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'GET' })
}

export function createProject(payload) {
  return request('/api/projects', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  })
}

export function updateProject(id, patch) {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function activateProject(id) {
  return request(`/api/projects/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}