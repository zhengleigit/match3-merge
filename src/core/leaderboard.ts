import type { StorageAdapter } from './settings'
import { writeJson } from './settings'

/**
 * Run leaderboard: one entry per finished run, showing mode, score and time.
 *
 * Pure data plus a storage adapter — no DOM. The wall-clock timestamp and the
 * run duration are supplied by the caller (the view), so the rules layer never
 * reads a clock and tests stay deterministic.
 */

export const LEADERBOARD_VERSION = 1
export const LEADERBOARD_KEY = 'match3-merge.leaderboard.v1'
/** Entries kept in storage; the renderer shows only the top few. */
export const LEADERBOARD_MAX = 50
/** Entries drawn in the on-canvas panel. */
export const LEADERBOARD_VISIBLE = 3

export interface ScoreEntry {
  modeId: string
  modeName: string
  score: number
  /** Epoch milliseconds when the run finished. */
  at: number
  /** How long the run lasted, in milliseconds. */
  durationMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Parses stored entries. Anything malformed is dropped rather than repaired:
 * a half-written entry has no meaningful score to show.
 */
export function parseLeaderboard(raw: string | null): ScoreEntry[] {
  if (raw === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []

  const list = parsed.entries
  if (!Array.isArray(list)) return []

  const out: ScoreEntry[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const score = finiteOr(item.score, Number.NaN)
    if (!Number.isFinite(score) || score < 0) continue

    out.push({
      modeId: typeof item.modeId === 'string' ? item.modeId : 'unknown',
      modeName: typeof item.modeName === 'string' ? item.modeName : '未知模式',
      score: Math.floor(score),
      at: Math.max(0, Math.floor(finiteOr(item.at, 0))),
      durationMs: Math.max(0, Math.floor(finiteOr(item.durationMs, 0)))
    })
  }

  return rank(out)
}

/**
 * Sort order: highest score first; ties broken by the faster run, then by the
 * older record so a long-standing entry is not pushed down by a duplicate.
 */
export function rank(entries: readonly ScoreEntry[]): ScoreEntry[] {
  return entries.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs
    return a.at - b.at
  })
}

/** `m:ss` for durations under an hour, `h:mm:ss` beyond. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${minutes}:${pad(seconds)}`
}

/** `MM-DD HH:mm` in local time. */
export function formatStamp(at: number, pad = true): string {
  const date = new Date(at)
  const mm = date.getMonth() + 1
  const dd = date.getDate()
  const hh = date.getHours()
  const mi = date.getMinutes()
  const two = (value: number): string => (value < 10 ? `0${value}` : String(value))
  const month = pad ? two(mm) : String(mm)
  const day = pad ? two(dd) : String(dd)
  return `${month}-${day} ${two(hh)}:${two(mi)}`
}

export class LeaderboardStore {
  private entries: ScoreEntry[]

  constructor(private readonly adapter: StorageAdapter) {
    this.entries = this.read()
  }

  private read(): ScoreEntry[] {
    try {
      return parseLeaderboard(this.adapter.read(LEADERBOARD_KEY))
    } catch {
      return []
    }
  }

  /** Adds a finished run and persists, trimming to the storage cap. */
  add(entry: ScoreEntry): ScoreEntry[] {
    const normalized: ScoreEntry = {
      modeId: entry.modeId,
      modeName: entry.modeName,
      score: Math.max(0, Math.floor(entry.score)),
      at: Math.max(0, Math.floor(entry.at)),
      durationMs: Math.max(0, Math.floor(entry.durationMs))
    }

    this.entries = rank([...this.entries, normalized]).slice(0, LEADERBOARD_MAX)
    writeJson(this.adapter, LEADERBOARD_KEY, {
      version: LEADERBOARD_VERSION,
      entries: this.entries
    })
    return this.list()
  }

/**
 * Ranked entries, best first.
 *
 * Returns fresh objects: `rank` only shallow-copies the array, so handing out
 * the stored entries directly would let a caller mutate persisted state.
 */
list(limit?: number): ScoreEntry[] {
  const ranked = rank(this.entries)
  const capped = limit === undefined ? ranked : ranked.slice(0, limit)
  return capped.map((entry) => ({ ...entry }))
  }

  /** The best entry for a mode, or null when that mode has no finished run. */
  bestForMode(modeId: string): ScoreEntry | null {
    for (const entry of this.list()) {
      if (entry.modeId === modeId) return entry
    }
    return null
  }

  isEmpty(): boolean {
    return this.entries.length === 0
  }

  clear(): void {
    this.entries = []
    writeJson(this.adapter, LEADERBOARD_KEY, { version: LEADERBOARD_VERSION, entries: [] })
  }
}
