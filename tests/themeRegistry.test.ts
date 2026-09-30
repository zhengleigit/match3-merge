import { describe, expect, it } from 'vitest'
import {
  findSource,
  packThemeIds,
  themeSources,
  type ThemeSource
} from '../src/view/themeRegistry'
import type { ThemeEntry } from '../src/core/types'

/**
 * Theme discovery.
 *
 * The important property is that dropping a zip into `src/themes/packs` is
 * enough — no manifest edit. That is what these tests pin down, plus the id
 * namespacing that stops a pack from shadowing a registered folder theme.
 */

const FOLDER_THEMES: readonly ThemeEntry[] = [
  { id: 'default', name: '默认（程序化绘制）', dir: 'themes/default', description: '' },
  { id: 'example', name: '示例素材（SVG）', dir: 'themes/example', description: '' }
]

function names(sources: readonly ThemeSource[]): string[] {
  return sources.map((source) => source.name)
}

describe('themeRegistry: folder themes', () => {
  it('keeps the registered order and marks them as folders', () => {
    const sources = themeSources(FOLDER_THEMES)

    expect(sources[0].id).toBe('default')
    expect(sources[1].id).toBe('example')
    expect(sources[0].kind).toBe('folder')
    expect(sources[0].entry).not.toBeNull()
    expect(sources[0].pack).toBeNull()
  })
})

describe('themeRegistry: zip packs', () => {
  it('discovers the bundled packs without any manifest entry', () => {
    // If this fails, the import.meta.glob pattern or the folder path changed.
    const ids = packThemeIds(themeSources(FOLDER_THEMES))

    expect(ids).toContain('pack:neon')
    expect(ids).toContain('pack:paper')
  })

  it('names a pack after its file, which is what the settings list shows', () => {
    const names = themeSources(FOLDER_THEMES).filter((s) => s.kind === 'pack').map((s) => s.name)

    expect(names).toContain('neon')
    expect(names).toContain('paper')
  })

  it('namespaces pack ids so a pack cannot shadow a folder theme', () => {
    // A pack called "default.zip" must not take over the built-in theme.
    const sources = themeSources(FOLDER_THEMES)
    const ids = sources.map((source) => source.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(findSource(sources, 'default')?.kind).toBe('folder')
  })

  it('gives every pack a fetchable URL', () => {
    for (const source of themeSources(FOLDER_THEMES).filter((s) => s.kind === 'pack')) {
      expect(source.pack).not.toBeNull()
      expect(source.pack?.url).toBeTruthy()
      expect(source.pack?.fallbackName).toBe(source.name)
    }
  })

  it('returns folder themes first so the fallback is always a built-in', () => {
    const sources = themeSources(FOLDER_THEMES)
    expect(names(sources).slice(0, 2)).toEqual(['默认（程序化绘制）', '示例素材（SVG）'])
  })

  it('sorts packs so the list does not depend on a directory listing', () => {
    const packs = themeSources(FOLDER_THEMES).filter((s) => s.kind === 'pack').map((s) => s.name)
    expect(packs).toEqual([...packs].sort((a, b) => a.localeCompare(b)))
  })
})

describe('themeRegistry: lookup', () => {
  it('finds a source by id and returns null for an unknown one', () => {
    const sources = themeSources(FOLDER_THEMES)

    expect(findSource(sources, 'example')?.name).toBe('示例素材（SVG）')
    expect(findSource(sources, 'pack:neon')?.kind).toBe('pack')
    expect(findSource(sources, 'gone')).toBeNull()
  })
})
