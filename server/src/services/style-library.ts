import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

export class StyleLibraryStore {
  private readonly file: string
  private cache: StyleLibrary | null = null

  constructor(file: string) {
    this.file = file
  }

  async read(): Promise<StyleLibrary> {
    if (this.cache) return this.cache

    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StyleLibrary>
      this.cache = normalize(parsed)
    } catch {
      this.cache = emptyLibrary()
    }
    return this.cache
  }

  async write(library: StyleLibrary): Promise<StyleLibrary> {
    const normalized = normalize(library)
    await mkdir(dirname(this.file), { recursive: true })

    // 先写临时文件再改名，避免写入中断导致文件损坏
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(temp, this.file)

    this.cache = normalized
    return normalized
  }

  get path(): string {
    return this.file
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
