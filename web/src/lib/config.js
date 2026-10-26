// 运行时配置：API 地址在开发期默认指向本地后端，
// 生产构建时可通过 window.__MOYING_CONFIG__ 覆盖。
const injected = window.__MOYING_CONFIG__ || {}

export const API_BASE = (
  injected.apiBase ||
  import.meta.env?.VITE_API_BASE ||
  'http://127.0.0.1:8787'
).replace(/\/+$/, '')

export const DEFAULT_MAX_PROMPT_LENGTH = 12000
