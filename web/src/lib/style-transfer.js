/* 风格库的导出 / 导入（纯函数，页面只负责文件读写与确认框）。 */
import { randomId } from './dom.js'

export const STYLE_TYPES = ['role', 'scene', 'prop']
const NAME_MAX = 40
const DESCRIPTION_MAX = 3000

function normalizeName(name) {
  return String(name || '').trim().toLowerCase()
}

function cleanStyle(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const name = String(item.name ?? '').trim().slice(0, NAME_MAX)
  if (!name) return null
  return {
    id: typeof item.id === 'string' ? item.id : '',
    name,
    description: String(item.description ?? '').trim().slice(0, DESCRIPTION_MAX),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }
}

/** 导出结构：三套风格 + 各自默认项，带格式标记与时间，方便以后兼容升级。 */
export function buildStyleExport(styles, defaultStyle, exportedAt = new Date().toISOString()) {
  const payload = { role: [], scene: [], prop: [] }
  for (const type of STYLE_TYPES) {
    payload[type] = (styles?.[type] || [])
      .map(style => cleanStyle(style))
      .filter(Boolean)
      .map(style => ({
        id: style.id,
        name: style.name,
        description: style.description,
        updatedAt: style.updatedAt,
      }))
  }

  return {
    format: 'huajing-styles',
    version: 1,
    exportedAt,
    styles: payload,
    defaultStyle: {
      role: defaultStyle?.role || '',
      scene: defaultStyle?.scene || '',
      prop: defaultStyle?.prop || '',
    },
  }
}

/**
 * 解析导入文件。
 * 兼容 { styles: { role, scene, prop } }（本项目导出格式）与裸的 { role, scene, prop }。
 */
export function parseStyleFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是有效的 JSON 文件')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('文件内容不是风格数据')
  }

  const source = parsed.styles && typeof parsed.styles === 'object' && !Array.isArray(parsed.styles)
    ? parsed.styles
    : parsed

  const styles = { role: [], scene: [], prop: [] }
  for (const type of STYLE_TYPES) {
    styles[type] = Array.isArray(source?.[type])
      ? source[type].map(style => cleanStyle(style)).filter(Boolean)
      : []
  }

  if (!STYLE_TYPES.some(type => styles[type].length)) {
    throw new Error('文件里没有可导入的风格')
  }

  return {
    format: typeof parsed.format === 'string' ? parsed.format : '',
    styles,
    defaultStyle: parsed.defaultStyle && typeof parsed.defaultStyle === 'object'
      ? parsed.defaultStyle
      : {},
  }
}

/**
 * 合并导入内容，返回新的 styles / defaultStyle 与新增、覆盖计数。
 * 规则：同名（去空格、忽略大小写）更新描述并保留本地 id，新名称追加；
 * 不删除任何现有风格。入参不会被修改。
 */
export function planStyleImport(currentStyles, currentDefaults, incoming, options = {}) {
  const now = options.now || new Date().toISOString()
  const makeId = options.makeId || (type => `style-${type}-${randomId()}`)

  const styles = {}
  for (const type of STYLE_TYPES) {
    styles[type] = (currentStyles?.[type] || []).map(style => ({ ...style }))
  }
  const defaultStyle = {
    role: currentDefaults?.role || '',
    scene: currentDefaults?.scene || '',
    prop: currentDefaults?.prop || '',
  }

  let added = 0
  let updated = 0

  for (const type of STYLE_TYPES) {
    const list = styles[type]
    const byName = new Map(list.map(style => [normalizeName(style.name), style]))
    const usedIds = new Set(list.map(style => style.id))
    const incomingList = incoming?.styles?.[type] || []

    for (const item of incomingList) {
      const key = normalizeName(item.name)
      const existing = byName.get(key)

      if (existing) {
        existing.description = item.description
        existing.updatedAt = item.updatedAt || now
        updated += 1
        continue
      }

      let id = item.id && !usedIds.has(item.id) ? item.id : makeId(type)
      while (usedIds.has(id)) id = makeId(type)
      usedIds.add(id)

      const style = {
        id,
        name: item.name,
        description: item.description,
        updatedAt: item.updatedAt || now,
      }
      list.push(style)
      byName.set(key, style)
      added += 1
    }

    // 默认项按名称映射：导入文件里的默认 id → 导入项名称 → 合并后的本地 id
    const incomingDefaultId = incoming?.defaultStyle?.[type]
    if (incomingDefaultId) {
      const imported = incomingList.find(style => style.id === incomingDefaultId)
      const target = imported ? byName.get(normalizeName(imported.name)) : null
      if (target) defaultStyle[type] = target.id
    }
  }

  return { styles, defaultStyle, added, updated }
}