import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 运行期资源根。
 * - 开发：仓库根（desktop/ 的上一级）
 * - 打包：resources/app-server（electron-builder 的 extraResources）
 */
export function appRoot() {
  if (app.isPackaged) return join(process.resourcesPath, 'app-server')
  return resolve(here, '..')
}

/** 便携版：electron-builder 的 portable 目标会注入 PORTABLE_EXECUTABLE_DIR */
export function portableDir() {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  return dir && existsSync(dir) ? dir : ''
}

/**
 * 数据根：账号库、图片、日志、config.env 都放这里，绝不写安装目录。
 * - 便携版：exe 同目录的 huajing-data/（可随 U 盘搬走）
 * - 安装版：%APPDATA%\huajing
 */
export function dataRoot() {
  // 开发/自动化测试可以指定独立数据目录，避免动到真实的账号、图片与日志
  if (process.env.HUAJING_DATA_DIR) return resolve(process.env.HUAJING_DATA_DIR)
  const portable = portableDir()
  if (portable) return join(portable, 'huajing-data')
  return join(app.getPath('appData'), 'huajing')
}
