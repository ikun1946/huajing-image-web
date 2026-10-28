// 运行时配置：API 地址走同源相对路径。
// 开发期由 Vite 代理把 /api 转发给本机后端；
// 生产构建时后端直接托管前端产物，天然同源。
// 这样无论从本机还是局域网（http://<主机IP>:5173）访问都正确，
// 也可通过 window.__MOYING_CONFIG__ 或 VITE_API_BASE 覆盖。
const injected = window.__MOYING_CONFIG__ || {}

export const API_BASE = (
  injected.apiBase ||
  import.meta.env?.VITE_API_BASE ||
  ''
).replace(/\/+$/, '')

export const DEFAULT_MAX_PROMPT_LENGTH = 12000
