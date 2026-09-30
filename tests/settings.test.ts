import { describe, expect, it } from 'vitest'
import {
  PROGRESS_KEY,
  ProgressStore,
  SETTINGS_KEY,
  SettingsStore,
  defaultProgress,
  defaultSettings,
  parseProgress,
  parseSettings,
  writeJson,
  type StorageAdapter
} from '../src/core/settings'

class MemoryAdapter implements StorageAdapter {
  readonly map = new Map<string, string>()
  writes = 0

  read(key: string): string | null {
    return this.map.get(key) ?? null
  }

  write(key: string, value: string): void {
    this.writes++
    this.map.set(key, value)
  }
}

class BrokenAdapter implements StorageAdapter {
  read(): string | null {
    throw new Error('storage disabled')
  }

  write(): void {
    throw new Error('quota exceeded')
  }
}

const base = defaultSettings('default', 'medium')

describe('settings: defaults', () => {
  it('starts with sound on, a sane volume and the configured theme', () => {
    expect(base).toEqual({
      version: 1,
      themeId: 'default',
      soundEnabled: true,
      volume: 0.7,
      particleDensity: 'medium',
      layoutMode: 'auto'
    })
  })
})

describe('settings: parsing (a corrupt blob must never block booting)', () => {
  it('returns the fallback for missing, corrupt or non-object content', () => {
    expect(parseSettings(null, base)).toEqual(base)
    expect(parseSettings('{not json', base)).toEqual(base)
    expect(parseSettings('[1,2,3]', base)).toEqual(base)
    expect(parseSettings('"text"', base)).toEqual(base)
  })

  it('keeps valid fields and repairs invalid ones individually', () => {
    const parsed = parseSettings(
      JSON.stringify({
        themeId: 'example',
        soundEnabled: 'yes',
        volume: 5,
        particleDensity: 'ultra'
      }),
      base
    )

    expect(parsed.themeId).toBe('example')
    // Non-boolean falls back rather than being coerced.
    expect(parsed.soundEnabled).toBe(base.soundEnabled)
    // Out-of-range volume is clamped, not rejected.
    expect(parsed.volume).toBe(1)
    expect(parsed.particleDensity).toBe(base.particleDensity)
  })

  it('clamps a negative volume to 0', () => {
    expect(parseSettings(JSON.stringify({ volume: -3 }), base).volume).toBe(0)
  })

  it('accepts every documented density', () => {
    for (const density of ['low', 'medium', 'high'] as const) {
      expect(parseSettings(JSON.stringify({ particleDensity: density }), base).particleDensity).toBe(
        density
      )
    }
  })

  it('keeps an unknown theme id so the app can resolve the fallback itself', () => {
    expect(parseSettings(JSON.stringify({ themeId: 'gone' }), base).themeId).toBe('gone')
  })

  it('accepts every layout mode and rejects anything else', () => {
    for (const mode of ['auto', 'desktop', 'mobile'] as const) {
      expect(parseSettings(JSON.stringify({ layoutMode: mode }), base).layoutMode).toBe(mode)
    }
    for (const bad of ['tablet', '', 3, null, { mode: 'desktop' }]) {
      expect(parseSettings(JSON.stringify({ layoutMode: bad }), base).layoutMode).toBe('auto')
    }
  })

  it('treats a settings blob written before layoutMode existed as auto', () => {
    // This is the real upgrade path: an existing player's stored settings have
    // no layoutMode field at all.
    const legacy = JSON.stringify({
      version: 1,
      themeId: 'example',
      soundEnabled: false,
      volume: 0.4,
      particleDensity: 'high'
    })
    const parsed = parseSettings(legacy, base)

    expect(parsed.layoutMode).toBe('auto')
    expect(parsed.themeId).toBe('example')
    expect(parsed.volume).toBe(0.4)
  })
})

describe('settings: store', () => {
  it('round-trips through storage', () => {
    const adapter = new MemoryAdapter()
    const store = new SettingsStore(adapter, base)

    store.set({ themeId: 'example', volume: 0.25 })

    const reloaded = new SettingsStore(adapter, base).get()
    expect(reloaded.themeId).toBe('example')
    expect(reloaded.volume).toBe(0.25)
  })

  it('returns a copy so callers cannot mutate stored state', () => {
    const store = new SettingsStore(new MemoryAdapter(), base)
    store.get().volume = 0
    expect(store.get().volume).toBe(0.7)
  })

  it('persists a layout mode change', () => {
    const adapter = new MemoryAdapter()
    new SettingsStore(adapter, base).set({ layoutMode: 'mobile' })

    expect(new SettingsStore(adapter, base).get().layoutMode).toBe('mobile')
  })

  it('survives a storage adapter that always throws', () => {
    const store = new SettingsStore(new BrokenAdapter(), base)

    expect(store.get()).toEqual(base)
    expect(() => store.set({ volume: 0.2 })).not.toThrow()
    // The change still applies for this session even though it cannot persist.
    expect(store.get().volume).toBe(0.2)
  })

  it('reports a failed write instead of throwing', () => {
    expect(writeJson(new BrokenAdapter(), SETTINGS_KEY, { a: 1 })).toBe(false)
    const adapter = new MemoryAdapter()
    expect(writeJson(adapter, SETTINGS_KEY, { a: 1 })).toBe(true)
    expect(adapter.map.get(SETTINGS_KEY)).toBe('{"a":1}')
  })
})

describe('progress: best scores', () => {
  it('starts empty', () => {
    expect(defaultProgress()).toEqual({ version: 1, bestScores: {} })
  })

  it('ignores corrupt payloads and non-numeric scores', () => {
    expect(parseProgress('nope', defaultProgress()).bestScores).toEqual({})
    expect(
      parseProgress(JSON.stringify({ bestScores: { basic: 'high', endless: -5, ok: 12 } }), defaultProgress())
        .bestScores
    ).toEqual({ ok: 12 })
  })

  it('records a score only when it actually beats the previous best', () => {
    const adapter = new MemoryAdapter()
    const store = new ProgressStore(adapter)

    expect(store.bestFor('basic')).toBe(0)
    expect(store.record('basic', 40)).toBe(true)
    expect(store.record('basic', 40)).toBe(false)
    expect(store.record('basic', 39)).toBe(false)
    expect(store.record('basic', 41)).toBe(true)
    expect(store.bestFor('basic')).toBe(41)
  })

  it('keeps scores per mode and persists them', () => {
    const adapter = new MemoryAdapter()
    const store = new ProgressStore(adapter)

    store.record('basic', 10)
    store.record('endless', 250)

    const reloaded = new ProgressStore(adapter)
    expect(reloaded.bestFor('basic')).toBe(10)
    expect(reloaded.bestFor('endless')).toBe(250)
    expect(reloaded.bestFor('obstacle')).toBe(0)
  })

  it('floors fractional and negative scores', () => {
    const store = new ProgressStore(new MemoryAdapter())
    expect(store.record('basic', 12.9)).toBe(true)
    expect(store.bestFor('basic')).toBe(12)
    expect(store.record('endless', -50)).toBe(false)
  })

  it('writes to its own key, separate from settings', () => {
    const adapter = new MemoryAdapter()
    new SettingsStore(adapter, base).set({ volume: 0.1 })
    new ProgressStore(adapter).record('basic', 7)

    const settingsBlob = adapter.map.get(SETTINGS_KEY) ?? ''
    const progressBlob = adapter.map.get(PROGRESS_KEY) ?? ''
    expect(settingsBlob).toContain('volume')
    expect(settingsBlob).not.toContain('bestScores')
    expect(progressBlob).toContain('bestScores')
    expect(progressBlob).not.toContain('volume')
  })
})
