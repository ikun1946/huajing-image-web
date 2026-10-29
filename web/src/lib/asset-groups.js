/* 资产分组：把同一角色/场景的不同状态（区域）归到一组，供批量页按层级展示。 */

/* 角色资产里常见的“状态”字段名 */
export const ROLE_STATE_LABELS = ['状态', '角色状态', '形态', '阶段', '时期', '造型', '版本', '变体', '身份']
/* 场景资产里常见的“子场景 / 区域”字段名 */
export const SCENE_AREA_LABELS = ['子场景', '区域', '分区', '场景类型']

/**
 * 把「沈砚-战损」「沈砚（少年）」「皇宫·主殿」拆成主体名与状态。
 * 角色与场景共用这套规则：分隔符、括号里的内容都视为二级标签。
 */
export function splitGroupedName(name) {
  const text = String(name || '').trim()
  const bracket = /^(.+?)\s*[（(【\[]\s*([^）)】\]]+?)\s*[）)】\]]$/.exec(text)
  if (bracket) return { group: bracket[1].trim(), state: bracket[2].trim() }

  const parts = text.split(/\s*[-－—–_·・/|｜]\s*/).filter(Boolean)
  if (parts.length > 1) {
    return { group: parts[0], state: parts.slice(1).join(' · ') }
  }
  return { group: text, state: '' }
}

/** 兼容旧调用名 */
export function splitRoleName(name) {
  const parsed = splitGroupedName(name)
  return { character: parsed.group, state: parsed.state }
}

/**
 * 主体名 + 状态：优先用字段里明确写的标签（角色看状态类，场景看区域类），
 * 其次用名称后缀。
 */
export function groupedAssetInfo(asset) {
  const parsed = splitGroupedName(asset.name)
  const labels = asset.type === 'scene' ? SCENE_AREA_LABELS : ROLE_STATE_LABELS
  const field = (asset.fields || []).find(item => labels.includes(item.label))
  const value = String(field?.value || '').replace(/\s+/g, ' ').trim()
  return {
    group: parsed.group || String(asset.name || '').trim(),
    state: value || parsed.state,
  }
}

/** 兼容旧调用名（角色语义） */
export function roleStateInfo(asset) {
  const info = groupedAssetInfo(asset)
  return { character: info.group, state: info.state }
}

/**
 * 按主体名分组，items 里带每条资产的二级标签。
 * 组内只有一条时 grouped 为 false，展示上仍按普通行处理。
 */
export function groupAssets(assets) {
  const map = new Map()
  ;(assets || []).forEach(asset => {
    const info = groupedAssetInfo(asset)
    const key = info.group || asset.name
    let group = map.get(key)
    if (!group) {
      group = { key, character: key, assets: [], items: [] }
      map.set(key, group)
    }
    group.assets.push(asset)
    group.items.push({ asset, state: info.state })
  })

  return [...map.values()].map(group => ({ ...group, grouped: group.assets.length > 1 }))
}

/** 兼容旧调用名（角色语义） */
export function groupRoleAssets(assets) {
  return groupAssets(assets)
}