import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isValidFilename } from '../lib/filename.js'

export interface StyleItem {
  id: string
  name: string
  description: string
  updatedAt?: string
}

export interface StyleLibrary {
  styles: {
    role: StyleItem[]
    scene: StyleItem[]
    prop: StyleItem[]
  }
  defaultStyle: {
    role: string
    scene: string
    prop: string
  }
}

const TYPES = ['role', 'scene', 'prop'] as const

/**
 * 按账号隔离的风格库：每个账号一份 <root>/<userId>.json，
 * 互不可见、互不干扰。
 */
export class StyleLibraryStore {
  private readonly root: string
  private readonly cache = new Map<string, StyleLibrary>()

  constructor(root: string) {
    this.root = root
  }

  private fileFor(ownerId: string): string {
    if (!isValidFilename(ownerId)) {
      throw new Error('非法的账号标识')
    }
    return join(this.root, `${ownerId}.json`)
  }

  async read(ownerId: string): Promise<StyleLibrary> {
    const cached = this.cache.get(ownerId)
    if (cached) return cached

    let library = emptyLibrary()
    try {
      const raw = await readFile(this.fileFor(ownerId), 'utf8')
      library = normalize(JSON.parse(raw) as Partial<StyleLibrary>)
    } catch {
      // 文件不存在或损坏时按空库处理，首次保存时会落盘
    }

    this.cache.set(ownerId, library)
    return library
  }

  async write(ownerId: string, library: StyleLibrary): Promise<StyleLibrary> {
    const normalized = normalize(library)
    const file = this.fileFor(ownerId)
    await mkdir(dirname(file), { recursive: true })

    // 先写临时文件再改名，避免写入中断导致文件损坏
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(temp, file)

    this.cache.set(ownerId, normalized)
    return normalized
  }
}

function emptyLibrary(): StyleLibrary {
  return { styles: { role: [], scene: [], prop: [] }, defaultStyle: { role: '', scene: '', prop: '' } }
}

function normalize(input: Partial<StyleLibrary> | null | undefined): StyleLibrary {
  const result = emptyLibrary()

  for (const type of TYPES) {
    const list = Array.isArray(input?.styles?.[type]) ? input.styles[type] : []
    const seen = new Set<string>()

    result.styles[type] = list
      .filter((item): item is StyleItem => Boolean(item) && typeof item.id === 'string' && item.id.length > 0)
      .map(item => ({
        id: item.id,
        name: String(item.name || '未命名风格'),
        description: String(item.description || ''),
        updatedAt: item.updatedAt || '',
      }))
      .filter(item => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })

    const fallback: string = result.styles[type][0]?.id || ''
    const preferred: string = input?.defaultStyle?.[type] ?? ''
    result.defaultStyle[type] = result.styles[type].some(item => item.id === preferred) ? preferred : fallback
  }

  return result
}
