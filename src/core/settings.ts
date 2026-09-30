import type { ParticleDensity } from './types'

/**
 * Settings persistence.
 *
 * Kept separate from progress (best scores) on purpose: wiping settings must
 * not touch scores and vice versa. Storage access goes through an injected
 * adapter because the rules layer must stay DOM-free (and because tests need
 * to simulate a full or unavailable localStorage).
 */

export const SETTINGS_VERSION = 1
export const PROGRESS_VERSION = 1

/**
 * Which layout to use.
 *
 * `auto` follows the viewport width; the other two let the player force a
 * layout, e.g. a tablet user who prefers the wide arrangement (or the compact
 * one) regardless of how the window happens to be sized.
 */
export type LayoutMode = 'auto' | 'desktop' | 'mobile'

export const LAYOUT_MODES: readonly LayoutMode[] = ['auto', 'desktop', 'mobile']

export interface Settings {
  version: number
  themeId: string
  soundEnabled: boolean
  /** 0..1 */
  volume: number
  particleDensity: ParticleDensity
  layoutMode: LayoutMode
}

export interface Progress {
  version: number
  /** Best score per mode id. */
  bestScores: Record<string, number>
}

export interface StorageAdapter {
  read(key: string): string | null
  write(key: string, value: string): void
}

export const SETTINGS_KEY = 'match3-merge.settings.v1'
export const PROGRESS_KEY = 'match3-merge.progress.v1'

const DENSITIES: readonly ParticleDensity[] = ['low', 'medium', 'high']

export function defaultSettings(defaultThemeId: string, density: ParticleDensity): Settings {
  return {
    version: SETTINGS_VERSION,
    themeId: defaultThemeId,
    soundEnabled: true,
    volume: 0.7,
    particleDensity: density,
    layoutMode: 'auto'
  }
}

export function defaultProgress(): Progress {
  return { version: PROGRESS_VERSION, bestScores: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/**
 * Parses stored settings, repairing anything invalid with the default.
 * A corrupt or partially written blob must never stop the game from booting.
 */
export function parseSettings(raw: string | null, fallback: Settings): Settings {
  if (raw === null) return { ...fallback }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...fallback }
  }
  if (!isRecord(parsed)) return { ...fallback }

  const themeId =
    typeof parsed.themeId === 'string' && parsed.themeId.length > 0
      ? parsed.themeId
      : fallback.themeId
  const density =
    typeof parsed.particleDensity === 'string' &&
    (DENSITIES as readonly string[]).includes(parsed.particleDensity)
      ? (parsed.particleDensity as ParticleDensity)
      : fallback.particleDensity

  const layoutMode =
    typeof parsed.layoutMode === 'string' &&
    (LAYOUT_MODES as readonly string[]).includes(parsed.layoutMode)
      ? (parsed.layoutMode as LayoutMode)
      : fallback.layoutMode

  return {
    version: SETTINGS_VERSION,
    themeId,
    soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : fallback.soundEnabled,
    volume: clamp01(parsed.volume, fallback.volume),
    particleDensity: density,
    layoutMode
  }
}

export function parseProgress(raw: string | null, fallback: Progress): Progress {
  if (raw === null) return { ...fallback }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...fallback }
  }
  if (!isRecord(parsed)) return { ...fallback }

  const bestScores: Record<string, number> = {}
  const rawScores = parsed.bestScores
  if (isRecord(rawScores)) {
    for (const [modeId, score] of Object.entries(rawScores)) {
      if (typeof score === 'number' && Number.isFinite(score) && score >= 0) {
        bestScores[modeId] = Math.floor(score)
      }
    }
  }

  return { version: PROGRESS_VERSION, bestScores }
}

/**
 * Serialises and writes. Storage can throw (private browsing, quota exceeded),
 * so every write is best-effort and reported rather than propagated.
 */
export function writeJson(adapter: StorageAdapter, key: string, value: unknown): boolean {
  try {
    adapter.write(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export class SettingsStore {
  private current: Settings

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly fallback: Settings
  ) {
    this.current = parseSettings(this.readRaw(), fallback)
  }

  get(): Settings {
    return { ...this.current }
  }

  set(patch: Partial<Omit<Settings, 'version'>>): Settings {
    this.current = parseSettings(JSON.stringify({ ...this.current, ...patch }), this.fallback)
    writeJson(this.adapter, SETTINGS_KEY, this.current)
    return this.get()
  }

  private readRaw(): string | null {
    try {
      return this.adapter.read(SETTINGS_KEY)
    } catch {
      return null
    }
  }
}

export class ProgressStore {
  private current: Progress

  constructor(private readonly adapter: StorageAdapter) {
    this.current = parseProgress(this.readRaw(), defaultProgress())
  }

  get(): Progress {
    return { version: this.current.version, bestScores: { ...this.current.bestScores } }
  }

  bestFor(modeId: string): number {
    return this.current.bestScores[modeId] ?? 0
  }

  /** Records a score; only overwrites when it is actually better. */
  record(modeId: string, score: number): boolean {
    const rounded = Math.max(0, Math.floor(score))
    if (rounded <= this.bestFor(modeId)) return false

    this.current = {
      version: PROGRESS_VERSION,
      bestScores: { ...this.current.bestScores, [modeId]: rounded }
    }
    writeJson(this.adapter, PROGRESS_KEY, this.current)
    return true
  }

  private readRaw(): string | null {
    try {
      return this.adapter.read(PROGRESS_KEY)
    } catch {
      return null
    }
  }
}
