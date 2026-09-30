import type { ThemeEntry } from '../core/types'
import {
  loadFolderTheme,
  loadPackTheme,
  type ThemeAssets,
  type ThemePackInfo
} from './assets'

/**
 * The list of themes the settings panel offers.
 *
 * Two sources are merged:
 *
 *  1. **Folder themes** — `public/themes/<name>/theme.json`, registered in
 *     `src/data/themes.json`. Good for themes you are editing.
 *  2. **Zip packs** — any `.zip` dropped into `src/themes/packs/`. These are
 *     discovered automatically, with no manifest to update: Vite's
 *     `import.meta.glob` is evaluated when the bundle is built, so a new pack
 *     shows up after a rebuild (`npm run dev` picks it up on its own).
 *
 * The glob is the reason this has to be a build-time list. A browser cannot
 * enumerate a directory, and a static host cannot either, so "drop a file in and
 * have it appear at runtime" is only possible with a server or a manual index.
 * Discovery at build time keeps the drop-in workflow while staying static.
 */

/** Every `.zip` in src/themes/packs, as a file name -> asset URL map. */
const PACK_URLS: Record<string, string> = import.meta.glob('../themes/packs/*.zip', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

export type ThemeKind = 'folder' | 'pack'

export interface ThemeSource {
  id: string
  name: string
  kind: ThemeKind
  /** Set for folder themes. */
  entry: ThemeEntry | null
  /** Set for zip packs. */
  pack: ThemePackInfo | null
}

/** `neon-arcade.zip` -> `neon arcade`; used until the manifest provides a name. */
function nameFromFile(fileName: string): string {
  return fileName
    .replace(/\.zip$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

function packSources(): ThemeSource[] {
  const sources: ThemeSource[] = []

  for (const [path, url] of Object.entries(PACK_URLS)) {
    const fileName = path.split('/').pop() ?? path
    const fallbackName = nameFromFile(fileName)
    // Prefix the id so a pack can never shadow a folder theme with the same name.
    sources.push({
      id: `pack:${fallbackName}`,
      name: fallbackName,
      kind: 'pack',
      entry: null,
      pack: { url, fallbackName }
    })
  }

  // Stable order: a directory listing is not guaranteed to be sorted.
  return sources.sort((a, b) => a.name.localeCompare(b.name))
}

export function themeSources(folderThemes: readonly ThemeEntry[]): ThemeSource[] {
  const folders: ThemeSource[] = folderThemes.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: 'folder',
    entry,
    pack: null
  }))
  return [...folders, ...packSources()]
}

export interface LoadedTheme {
  assets: ThemeAssets
  /** Display name, resolved from the pack manifest when available. */
  name: string
}

/**
 * Loads a theme by source id.
 *
 * Returns null when the id is unknown or a pack could not be read, so the caller
 * can fall back to the first theme rather than showing a blank game.
 */
export async function loadThemeSource(
  source: ThemeSource,
  levelCounts: readonly number[]
): Promise<ThemeAssets | null> {
  if (source.kind === 'folder') {
    if (source.entry === null) return null
    return loadFolderTheme(source.entry, levelCounts)
  }

  if (source.pack === null) return null
  return loadPackTheme(source.pack, levelCounts)
}

/** The first source, used as the guaranteed-good fallback. */
export function firstSource(sources: readonly ThemeSource[]): ThemeSource | null {
  return sources.length > 0 ? sources[0] : null
}

export function findSource(
  sources: readonly ThemeSource[],
  id: string
): ThemeSource | null {
  return sources.find((source) => source.id === id) ?? null
}

/** Ids of the pack themes, for diagnostics. */
export function packThemeIds(sources: readonly ThemeSource[]): string[] {
  return sources.filter((source) => source.kind === 'pack').map((source) => source.id)
}
