import { sfxConfig, type SoundId } from '../core/fxMap'
import {
  blockSlot,
  parseTheme,
  slotPath,
  soundSlot,
  type ThemeDefinition
} from '../core/theme'
import type { ThemeEntry } from '../core/types'
import { readZip, type ZipEntry } from '../core/zip'
import { deflateRaw, toArrayBuffer } from './inflate'

/**
 * Loads a theme's sprites and sound overrides, from a folder or a zip pack.
 *
 * Failure policy: a theme is never allowed to break the game. A missing
 * manifest, a 404 sprite or a corrupt image all degrade to the procedural
 * renderer, and a missing sound file falls back to the synthesised preset.
 * Each distinct failure is reported once so the console stays readable.
 *
 * Both sources normalise to a slot -> URL resolver, so the renderer never has
 * to know whether a theme came from a directory or from an archive.
 */

export interface ThemeAssets {
  theme: ThemeDefinition
  /** Where the theme came from; used in console warnings. */
  source: string
  /** Successfully decoded images, keyed by slot name. */
  images: Map<string, HTMLImageElement>
  /** Audio override URLs, keyed by sound id. */
  sounds: Map<SoundId, string>
  /** Slots that were declared but failed to load. */
  failed: Set<string>
  warnings: string[]
  /** Blob URLs created for a zip pack; revoked when the theme is replaced. */
  objectUrls: string[]
}

const warned = new Set<string>()

function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(`[theme] ${message}`)
}

function emptyAssets(theme: ThemeDefinition, source: string, warnings: string[] = []): ThemeAssets {
  return {
    theme,
    source,
    images: new Map(),
    sounds: new Map(),
    failed: new Set(),
    warnings,
    objectUrls: []
  }
}

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

/**
 * Loads every sprite a theme declares, plus the level sprites the modes can
 * actually reach, then the sound overrides. Shared by both sources so the
 * loading and fallback rules cannot drift apart.
 */
async function loadAll(
  assets: ThemeAssets,
  resolve: (slot: string) => string | null,
  levelCounts: readonly number[]
): Promise<void> {
  const slots = new Set<string>()
  const maxLevel = Math.max(0, ...levelCounts)
  for (let level = 1; level <= maxLevel; level++) slots.add(blockSlot(level))
  for (const slot of Object.keys(assets.theme.slots)) {
    if (!slot.startsWith('sfx.')) slots.add(slot)
  }

  const loads: Array<Promise<void>> = []
  for (const slot of slots) {
    const url = resolve(slot)
    if (url === null) continue

    loads.push(
      loadImage(url).then((image) => {
        if (image === null) {
          assets.failed.add(slot)
          warnOnce(`${assets.theme.id}: "${slot}" failed to load; using procedural fallback`)
          return
        }
        assets.images.set(slot, image)
      })
    )
  }

  for (const id of Object.keys(sfxConfig.sounds) as SoundId[]) {
    const url = resolve(soundSlot(id))
    if (url !== null) assets.sounds.set(id, url)
  }

  await Promise.all(loads)
}

// ---------------------------------------------------------------------------
// Folder theme (public/themes/<name>/)
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

export async function loadFolderTheme(
  entry: ThemeEntry,
  levelCounts: readonly number[]
): Promise<ThemeAssets> {
  const manifest = await fetchJson(`${entry.dir}/theme.json`)

  if (manifest === null) {
    warnOnce(`could not load ${entry.dir}/theme.json — using procedural graphics`)
    const fallback = parseTheme({ id: entry.id, name: entry.name }, entry.id)
    return emptyAssets(fallback.theme, entry.dir)
  }

  const parsed = parseTheme(manifest, entry.id)
  const assets = emptyAssets(parsed.theme, entry.dir, parsed.warnings)
  for (const warning of parsed.warnings) warnOnce(`${entry.id}: ${warning}`)

  await loadAll(assets, (slot) => slotPath(parsed.theme, entry.dir, slot), levelCounts)
  return assets
}

// ---------------------------------------------------------------------------
// Zip theme pack
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  json: 'application/json'
}

function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

function parseJsonBlob(data: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(data)) as unknown
  } catch {
    return null
  }
}

/**
 * Builds a path -> bytes map, dropping a single shared top-level folder.
 *
 * Zips made by "compress this folder" put everything under one directory, which
 * would make `blocks/level1.png` resolve as `mytheme/blocks/level1.png`.
 * Detecting the common prefix means both layouts work without the pack author
 * having to care.
 */
export function stripCommonPrefix(entries: readonly ZipEntry[]): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  // Backslashes are normalised here too: `readZip` already does it, but this
  // function is also reachable from tests and future sources.
  for (const entry of entries) {
    files.set(entry.name.replace(/\\/g, '/').replace(/^\/+/, ''), entry.data)
  }

  const topLevel = new Set<string>()
  for (const name of files.keys()) {
    const slash = name.indexOf('/')
    if (slash <= 0) return files // a top-level file exists -> no shared folder
    topLevel.add(name.slice(0, slash))
  }
  if (topLevel.size !== 1) return files

  const prefix = `${[...topLevel][0]}/`
  const stripped = new Map<string, Uint8Array>()
  for (const [name, data] of files) {
    if (!name.startsWith(prefix)) return files
    stripped.set(name.slice(prefix.length), data)
  }
  return stripped
}

export interface ThemePackInfo {
  /** Archive URL (a bundled asset URL, or any URL the page can fetch). */
  url: string
  /** Name shown when the pack has no usable manifest, without the extension. */
  fallbackName: string
}

/**
 * Loads a theme from a zip.
 *
 * Everything referenced is turned into a blob URL that lives as long as the
 * theme is active; `releaseTheme` revokes them.
 */
export async function loadPackTheme(
  info: ThemePackInfo,
  levelCounts: readonly number[]
): Promise<ThemeAssets | null> {
  let bytes: Uint8Array
  try {
    const response = await fetch(info.url)
    if (!response.ok) {
      warnOnce(`theme pack "${info.fallbackName}" could not be fetched (${response.status})`)
      return null
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch {
    warnOnce(`theme pack "${info.fallbackName}" could not be fetched`)
    return null
  }

  let files: Map<string, Uint8Array>
  let zipWarnings: string[]
  try {
    const result = await readZip(bytes, deflateRaw)
    files = stripCommonPrefix(result.entries)
    zipWarnings = result.warnings
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    warnOnce(`theme pack "${info.fallbackName}" is not a readable zip: ${detail}`)
    return null
  }

  for (const warning of zipWarnings) warnOnce(`${info.fallbackName}: ${warning}`)

  const manifest = files.get('theme.json')
  if (manifest === undefined) {
    warnOnce(`theme pack "${info.fallbackName}" has no theme.json; skipped`)
    return null
  }

  const parsed = parseTheme(parseJsonBlob(manifest), info.fallbackName)
  const assets = emptyAssets(parsed.theme, `zip:${info.fallbackName}`, parsed.warnings)
  for (const warning of parsed.warnings) warnOnce(`${info.fallbackName}: ${warning}`)

  // Materialise only the files the manifest references, so an unused 4 MB
  // sprite in the archive never becomes a blob URL.
  const urls = new Map<string, string>()
  const urlFor = (path: string): string | null => {
    const cached = urls.get(path)
    if (cached !== undefined) return cached

    const data = files.get(path.replace(/^\/+/, ''))
    if (data === undefined) return null

    const url = URL.createObjectURL(new Blob([toArrayBuffer(data)], { type: mimeFor(path) }))
    urls.set(path, url)
    assets.objectUrls.push(url)
    return url
  }

  const resolve = (slot: string): string | null => {
    const path = parsed.theme.slots[slot]
    return path === undefined ? null : urlFor(path)
  }

  await loadAll(assets, resolve, levelCounts)
  return assets
}

/** Revokes a theme's blob URLs. Call when swapping away from a zip theme. */
export function releaseTheme(assets: ThemeAssets | null): void {
  if (assets === null) return
  for (const url of assets.objectUrls) URL.revokeObjectURL(url)
  assets.objectUrls.length = 0
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Image for a slot, or null when it is absent or failed to load. */
export function imageFor(assets: ThemeAssets, slot: string): HTMLImageElement | null {
  return assets.images.get(slot) ?? null
}

export function blockImageFor(assets: ThemeAssets, level: number): HTMLImageElement | null {
  return imageFor(assets, blockSlot(level))
}

export function hasSoundPreset(id: SoundId): boolean {
  return sfxConfig.sounds[id] !== undefined
}
