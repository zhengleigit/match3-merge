import { describe, expect, it } from 'vitest'
import {
  RUNS_KEY,
  RunStore,
  normalizeForSave,
  parseRuns,
  type SavedRun
} from '../src/core/runs'
import type { StorageAdapter } from '../src/core/settings'
import type { GameSnapshot } from '../src/core/types'
import { craft, makeGame, onlyLevelOne } from './helpers'

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

function snapshot(overrides: Partial<GameSnapshot> = {}): GameSnapshot {
  return {
    cells: new Array<number>(70).fill(0),
    buffer: [1, 0, 0],
    next: 2,
    score: 42,
    steps: 7,
    maxReachedLevel: 3,
    hasWon: false,
    gameOver: false,
    pendingWin: null,
    pacman: null,
    rngState: 12345,
    ...overrides
  }
}

describe('runs: normalizeForSave', () => {
  it('passes an in-progress run through unchanged', () => {
    const snap = snapshot()
    expect(normalizeForSave(snap)).toEqual(snap)
  })

  it('returns a copy, not the same object', () => {
    const snap = snapshot()
    const out = normalizeForSave(snap)
    expect(out).not.toBe(snap)
  })

  it('refuses to save a finished run', () => {
    expect(normalizeForSave(snapshot({ gameOver: true }))).toBeNull()
  })

  it('banks a pending win, because the paused cascade cannot be resumed', () => {
    const snap = snapshot({ score: 900, pendingWin: { level: 10, score: 900 } })
    const out = normalizeForSave(snap)

    expect(out).not.toBeNull()
    expect(out!.pendingWin).toBeNull()
    expect(out!.hasWon).toBe(true)
    // Board and score are preserved: the player keeps the win, only the
    // end-run / keep-playing choice is dropped.
    expect(out!.score).toBe(900)
  })
})

describe('runs: parsing (a corrupt blob must never block booting)', () => {
  it('returns empty for missing, corrupt or wrongly-shaped content', () => {
    expect(parseRuns(null)).toEqual({})
    expect(parseRuns('{not json')).toEqual({})
    expect(parseRuns('[1,2,3]')).toEqual({})
    expect(parseRuns(JSON.stringify({ runs: 'nope' }))).toEqual({})
  })

  it('drops entries with an unusable snapshot but keeps the good ones', () => {
    const parsed = parseRuns(
      JSON.stringify({
        version: 1,
        runs: {
          basic: { modeId: 'basic', at: 1, snapshot: snapshot() },
          broken: { modeId: 'broken', at: 1, snapshot: { cells: 'nope' } },
          broken2: { modeId: 'broken2', at: 1, snapshot: { cells: [] } },
          broken3: { modeId: 'broken3', at: 1, snapshot: { cells: [0, 0], buffer: [] } }
        }
      })
    )

    expect(Object.keys(parsed)).toEqual(['basic'])
  })

  it('drops entries whose snapshot claims the run is already over', () => {
    const parsed = parseRuns(
      JSON.stringify({
        runs: {
          basic: { modeId: 'basic', at: 1, snapshot: snapshot({ gameOver: true }) }
        }
      })
    )
    expect(parsed).toEqual({})
  })

  it('repairs loose numbers instead of dropping the entry', () => {
    const parsed = parseRuns(
      JSON.stringify({
        runs: {
          basic: {
            modeId: 'basic',
            at: 'later',
            snapshot: { cells: [1, 0], buffer: [1], score: -5, steps: 3.7, maxReachedLevel: 0, rngState: 9 }
          }
        }
      })
    )

    const run = parsed.basic
    expect(run).toBeDefined()
    expect(run.at).toBe(0)
    expect(run.snapshot.score).toBe(0)
    expect(run.snapshot.steps).toBe(3)
    expect(run.snapshot.maxReachedLevel).toBe(1)
  })
})

describe('runs: store', () => {
  it('starts empty', () => {
    const store = new RunStore(new MemoryAdapter())
    expect(store.has('basic')).toBe(false)
    expect(store.load('basic')).toBeNull()
    expect(store.parkedModeIds()).toEqual([])
  })

  it('round-trips a run through storage', () => {
    const adapter = new MemoryAdapter()
    new RunStore(adapter).save('basic', snapshot({ score: 128 }), 1000)

    const reloaded = new RunStore(adapter)
    const run = reloaded.load('basic')
    expect(run).not.toBeNull()
    expect(run!.snapshot.score).toBe(128)
    expect(run!.at).toBe(1000)
    expect(run!.modeId).toBe('basic')
  })

  it('keeps one slot per mode, independent of each other', () => {
    const store = new RunStore(new MemoryAdapter())
    store.save('basic', snapshot({ score: 10 }), 1)
    store.save('endless', snapshot({ score: 900 }), 2)

    expect(store.load('basic')!.snapshot.score).toBe(10)
    expect(store.load('endless')!.snapshot.score).toBe(900)
    expect(store.parkedModeIds().sort()).toEqual(['basic', 'endless'])
  })

  it('overwrites the slot when the same mode is parked again', () => {
    const store = new RunStore(new MemoryAdapter())
    store.save('basic', snapshot({ score: 10, steps: 1 }), 1)
    store.save('basic', snapshot({ score: 99, steps: 30 }), 2)

    expect(store.load('basic')!.snapshot.score).toBe(99)
    expect(store.parkedModeIds()).toEqual(['basic'])
  })

  it('clears a single slot without touching the others', () => {
    const store = new RunStore(new MemoryAdapter())
    store.save('basic', snapshot(), 1)
    store.save('endless', snapshot(), 2)

    store.clear('basic')

    expect(store.has('basic')).toBe(false)
    expect(store.has('endless')).toBe(true)
  })

  it('refuses to park a finished run and clears any stale slot', () => {
    const store = new RunStore(new MemoryAdapter())
    store.save('basic', snapshot(), 1)

    const saved = store.save('basic', snapshot({ gameOver: true }), 2)

    expect(saved).toBe(false)
    expect(store.has('basic')).toBe(false)
  })

  it('prunes slots for modes that no longer exist', () => {
    const adapter = new MemoryAdapter()
    const store = new RunStore(adapter)
    store.save('basic', snapshot(), 1)
    store.save('removed-mode', snapshot(), 2)

    store.prune(['basic'])

    expect(store.parkedModeIds()).toEqual(['basic'])
    // And the prune is persisted, not just held in memory.
    expect(new RunStore(adapter).parkedModeIds()).toEqual(['basic'])
  })

  it('survives a storage adapter that always throws', () => {
    const store = new RunStore(new BrokenAdapter())
    expect(store.parkedModeIds()).toEqual([])
    expect(() => store.save('basic', snapshot(), 1)).not.toThrow()
    // Still usable in memory for this session.
    expect(store.load('basic')).not.toBeNull()
  })

  it('writes to its own key', () => {
    const adapter = new MemoryAdapter()
    new RunStore(adapter).save('basic', snapshot(), 1)
    expect(adapter.map.has(RUNS_KEY)).toBe(true)
    expect(adapter.map.size).toBe(1)
  })
})

describe('runs: a real game resumes exactly where it left off', () => {
  /**
   * The point of the whole feature. A snapshot carries the RNG state too, so a
   * resumed run must continue the same random sequence, not restart it.
   */
  it('restores board, score, steps, tray, queued block and RNG', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne, seed: 4242 })
    for (const x of [0, 1, 2]) {
      game.pullNextToBuffer()
      game.placeFromBuffer(0, x, 0)
    }
    game.pullNextToBuffer()

    const parked = game.snapshot()
    const store = new RunStore(new MemoryAdapter())
    store.save('basic', parked, 1000)

    const resumed = makeGame({ mutateTuning: onlyLevelOne, seed: 1 })
    resumed.restore(store.load('basic')!.snapshot)

    expect(resumed.snapshot()).toEqual(parked)
    expect(resumed.view().score).toBe(3)
    expect(resumed.view().steps).toBe(3)
    expect(resumed.view().maxReachedLevel).toBe(2)
  })

  it('continues the same random sequence after resuming', () => {
    const game = makeGame({ seed: 777 })
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)
    const parked = game.snapshot()

    // What the original run produces next.
    const originalNext: number[] = []
    for (let i = 0; i < 5; i++) {
      game.pullNextToBuffer()
      originalNext.push(game.view().next)
    }

    // What a resumed run produces from the same snapshot.
    const resumed = makeGame({ seed: 1 })
    resumed.restore(parked)
    const resumedNext: number[] = []
    for (let i = 0; i < 5; i++) {
      resumed.pullNextToBuffer()
      resumedNext.push(resumed.view().next)
    }

    expect(resumedNext).toEqual(originalNext)
  })

  it('round-trips through JSON, which is how it is actually stored', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne, seed: 31337 })
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)
    const parked = game.snapshot()

    const adapter = new MemoryAdapter()
    new RunStore(adapter).save('basic', parked, 5)

    // Force a real serialise/deserialise cycle.
    const raw = adapter.map.get(RUNS_KEY)!
    const reparsed = parseRuns(raw).basic as SavedRun
    const resumed = makeGame({ mutateTuning: onlyLevelOne, seed: 1 })
    resumed.restore(reparsed.snapshot)

    expect(resumed.snapshot()).toEqual(parked)
  })

  it('resumes a hand-built mid-game board too', () => {
    const crafted = craft(7, 10, {
      blocks: [
        { x: 0, y: 0, level: 3 },
        { x: 1, y: 0, level: 3 }
      ],
      buffer: [3, 1, 0],
      next: 4,
      score: 260,
      steps: 88,
      maxReachedLevel: 4
    })

    const resumed = makeGame({ mutateTuning: onlyLevelOne })
    resumed.restore(crafted)

    const view = resumed.view()
    expect(view.score).toBe(260)
    expect(view.steps).toBe(88)
    expect(view.maxReachedLevel).toBe(4)
    expect(view.buffer).toEqual([3, 1, 0])
    expect(view.next).toBe(4)
  })
})
