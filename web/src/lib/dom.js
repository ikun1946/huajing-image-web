export function qs(selector, root = document) {
  return root.querySelector(selector)
}

export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)]
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#096;')
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function formatDateTime(value) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function timestamp() {
  const now = new Date()
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
}

export function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function shorten(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function getImageExtension(url) {
  try {
    const extension = new URL(url, location.href).pathname.split('.').pop().toLowerCase()
    return ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? extension : 'png'
  } catch {
    return 'png'
  }
}
