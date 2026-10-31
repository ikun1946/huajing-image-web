import { getImageExtension, timestamp } from './dom.js'

/**
 * 批量工作台的资产结果纯函数：历史生成图、主图与下载文件名。
 * 只依赖传入的 asset，不读页面全局状态，便于在各工作台之间复用。
 */

/* 每条资产保留的历史生成图数量（含主图）；历史回填的账号记录也截到这个数 */
export const HISTORY_LIMIT = 20

/** 这条资产的历史生成图：新→旧；老数据只有 resultUrl 时也视作一条 */
export function assetHistory(asset) {
  const list = Array.isArray(asset.history)
    ? asset.history.filter(item => item && typeof item.url === 'string' && item.url)
    : []
  if (asset.resultUrl && !list.some(item => item.url === asset.resultUrl)) {
    list.unshift({
      url: asset.resultUrl,
      w: asset.width || 0,
      h: asset.height || 0,
      at: asset.updatedAt || '',
    })
  }
  return list.slice(0, HISTORY_LIMIT)
}

/** 主图：用户选过的优先，否则用最新结果 */
export function primaryImageOf(asset) {
  return asset.primaryUrl || asset.resultUrl || ''
}

/** 主图对应的尺寸/时间（历史里找不到就退回资产自身记录的宽高） */
export function primaryEntry(asset) {
  const url = primaryImageOf(asset)
  return assetHistory(asset).find(item => item.url === url) || {
    url,
    w: asset.width || 0,
    h: asset.height || 0,
    at: asset.updatedAt || '',
  }
}

export function assetFilename(asset) {
  const entry = primaryEntry(asset)
  const size = entry.w && entry.h ? `${entry.w}x${entry.h}` : ''
  return `${[asset.name, size, timestamp()].filter(Boolean).join('-')}.${getImageExtension(primaryImageOf(asset))}`
    .replace(/-+/g, '-')
}

/** 批量下载用的文件名：显式标注“主图” */
export function primaryFilename(asset) {
  const entry = primaryEntry(asset)
  const size = entry.w && entry.h ? `${entry.w}x${entry.h}` : ''
  const stem = [asset.name, '主图', size, timestamp()].filter(Boolean).join('-')
  return `${stem}.${getImageExtension(primaryImageOf(asset))}`.replace(/-+/g, '-')
}
