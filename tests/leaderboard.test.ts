import { describe, expect, it } from 'vitest'
import {
  LEADERBOARD_KEY,
  LEADERBOARD_MAX,
  LeaderboardStore,
  formatDuration,
  formatStamp,
  parseLeaderboard,
  rank,
  type ScoreEntry
} from '../src/core/leaderboard'
import type { StorageAdapter } from '../src/core/settings'

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

function entry(overrides: Partial<ScoreEntry> = {}): ScoreEntry {
  return {
    modeId: 'basic',
    modeName: '基础模式',
    score: 100,
    at: 1_700_000_000_000,
    durationMs: 90_000,
    ...overrides
  }
}

describe('leaderboard: formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5_000)).toBe('0:05')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(605_000)).toBe('10:05')
    expect(formatDuration(3_599_000)).toBe('59:59')
  })

  it('adds an hours field beyond an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })

  it('clamps negatives to zero instead of printing garbage', () => {
    expect(formatDuration(-5_000)).toBe('0:00')
  })
})

describe('leaderboard: formatStamp', () => {
  it('renders a zero-padded month-day and time', () => {
    const stamp = formatStamp(new Date(2026, 0, 5, 9, 7).getTime())
    expect(stamp).toBe('01-05 09:07')
  })
})

describe('leaderboard: rank', () => {
  it('sorts by score descending', () => {
    const ranked = rank([
      entry({ score: 10 }),
      entry({ score: 300 }),
      entry({ score: 120 })
    ])
    expect(ranked.map((item) => item.score)).toEqual([300, 120, 10])
  })

  it('breaks equal scores by the faster run', () => {
    const ranked = rank([
      entry({ score: 50, durationMs: 9_000 }),
      entry({ score: 50, durationMs: 3_000 })
    ])
    expect(ranked.map((item) => item.durationMs)).toEqual([3_000, 9_000])
  })

  it('breaks equal score and duration by the older record', () => {
    const ranked = rank([
      entry({ score: 50, durationMs: 3_000, at: 200 }),
      entry({ score: 50, durationMs: 3_000, at: 100 })
    ])
    expect(ranked.map((item) => item.at)).toEqual([100, 200])
  })

  it('does not mutate the input array', () => {
    const input = [entry({ score: 1 }), entry({ score: 2 })]
    rank(input)
    expect(input[0].score).toBe(1)
  })
})

describe('leaderboard: parsing (a corrupt blob must never block booting)', () => {
  it('returns empty for missing, corrupt or wrongly-shaped content', () => {
    expect(parseLeaderboard(null)).toEqual([])
    expect(parseLeaderboard('{not json')).toEqual([])
    expect(parseLeaderboard('[1,2,3]')).toEqual([])
    expect(parseLeaderboard(JSON.stringify({ entries: 'nope' }))).toEqual([])
  })

  it('drops malformed entries but keeps the good ones', () => {
    const parsed = parseLeaderboard(
      JSON.stringify({
        version: 1,
        entries: [
          entry({ score: 42 }),
          { modeId: 'basic', score: 'high' },
          null,
          { modeId: 'basic', score: -5 },
          entry({ score: 7 })
        ]
      })
    )

    expect(parsed.map((item) => item.score)).toEqual([42, 7])
  })

  it('repairs missing optional fields instead of dropping the entry', () => {
    const parsed = parseLeaderboard(
      JSON.stringify({ entries: [{ score: 5 }] })
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0].modeId).toBe('unknown')
    expect(parsed[0].durationMs).toBe(0)
  })

  it('returns entries in ranked order', () => {
    const parsed = parseLeaderboard(
      JSON.stringify({ entries: [entry({ score: 1 }), entry({ score: 99 })] })
    )
    expect(parsed[0].score).toBe(99)
  })
})

describe('leaderboard: store', () => {
  it('starts empty and reports a sensible best', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    expect(store.isEmpty()).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.bestForMode('basic')).toBeNull()
  })

  it('records a run and persists it across reloads', () => {
    const adapter = new MemoryAdapter()
    new LeaderboardStore(adapter).add(entry({ score: 128, modeName: '基础模式' }))

    const reloaded = new LeaderboardStore(adapter)
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0].score).toBe(128)
    expect(reloaded.list()[0].modeName).toBe('基础模式')
  })

  it('keeps the highest score first regardless of insertion order', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    store.add(entry({ score: 10 }))
    store.add(entry({ score: 900 }))
    store.add(entry({ score: 400 }))

    expect(store.list().map((item) => item.score)).toEqual([900, 400, 10])
  })

  it('finds the best run per mode', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    store.add(entry({ modeId: 'basic', modeName: '基础模式', score: 50 }))
    store.add(entry({ modeId: 'endless', modeName: '无尽模式', score: 800 }))
    store.add(entry({ modeId: 'basic', modeName: '基础模式', score: 200 }))

    expect(store.bestForMode('basic')?.score).toBe(200)
    expect(store.bestForMode('endless')?.score).toBe(800)
    expect(store.bestForMode('obstacle')).toBeNull()
  })

  it('floors fractional and negative scores', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    store.add(entry({ score: 12.9, durationMs: -5 }))
    expect(store.list()[0].score).toBe(12)
    expect(store.list()[0].durationMs).toBe(0)
  })

  it('trims storage to the cap while keeping the best entries', () => {
    const adapter = new MemoryAdapter()
    const store = new LeaderboardStore(adapter)

    for (let i = 0; i < LEADERBOARD_MAX + 20; i++) {
      store.add(entry({ score: i }))
    }

    const listed = store.list()
    expect(listed).toHaveLength(LEADERBOARD_MAX)
    expect(listed[0].score).toBe(LEADERBOARD_MAX + 19)

    // And the trimmed set is what actually got persisted.
    const reloaded = new LeaderboardStore(adapter)
    expect(reloaded.list()).toHaveLength(LEADERBOARD_MAX)
  })

  it('honours the list limit', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    for (let i = 0; i < 10; i++) store.add(entry({ score: i }))
    expect(store.list(3)).toHaveLength(3)
    expect(store.list(3)[0].score).toBe(9)
  })

  it('clears every entry', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    store.add(entry())
    store.clear()
    expect(store.isEmpty()).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('survives a storage adapter that always throws', () => {
    const store = new LeaderboardStore(new BrokenAdapter())
    expect(store.list()).toEqual([])
    expect(() => store.add(entry({ score: 5 }))).not.toThrow()
    // Still usable in-memory for this session.
    expect(store.list()[0].score).toBe(5)
  })

  it('writes to its own key, separate from settings and best scores', () => {
    const adapter = new MemoryAdapter()
    new LeaderboardStore(adapter).add(entry({ score: 3 }))
    expect(adapter.map.has(LEADERBOARD_KEY)).toBe(true)
    expect(adapter.map.size).toBe(1)
  })

  it('returns copies so callers cannot mutate stored state', () => {
    const store = new LeaderboardStore(new MemoryAdapter())
    store.add(entry({ score: 10 }))
    store.list()[0].score = 999
    expect(store.list()[0].score).toBe(10)
  })
})
