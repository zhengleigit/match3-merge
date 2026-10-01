import type { GameSnapshot } from './types'
import type { PacManPhase } from './types'
import { writeJson, type StorageAdapter } from './settings'

/**
 * In-progress run persistence, one slot per mode.
 *
 * A `GameSnapshot` is already a complete description of a run — cells, tray,
 * queued block, score, steps, unlocked level, win flag and RNG state — so
 * resuming is just `Game.restore(snapshot)`. Nothing about the rules has to be
 * replayed or re-derived, and the RNG state means the resumed run continues the
 * same random sequence rather than restarting it.
 */

export const RUNS_VERSION = 1
export const RUNS_KEY = 'match3-merge.runs.v1'

export interface SavedRun {
  modeId: string
  /** Epoch milliseconds when the run was parked. */
  at: number
  snapshot: GameSnapshot
}

export type RunMap = Record<string, SavedRun>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

/**
 * Coerces a snapshot into a shape that is safe to resume.
 *
 * Two normalisations, both about not persisting a half-open decision:
 *  - a pending win dialog cannot be resumed (its paused-cascade position is not
 *    part of the snapshot), so the win is banked and the dialog dropped;
 *  - a finished run is not a run at all, so callers get null and store nothing.
 */
export function normalizeForSave(snapshot: GameSnapshot): GameSnapshot | null {
  if (snapshot.gameOver) return null

  if (snapshot.pendingWin !== null) {
    return { ...snapshot, pendingWin: null, hasWon: true }
  }
  return { ...snapshot }
}

function parseSnapshot(raw: unknown): GameSnapshot | null {
  if (!isRecord(raw)) return null

  const cells = raw.cells
  if (!Array.isArray(cells) || cells.length === 0) return null
  if (!cells.every((value) => typeof value === 'number' && Number.isFinite(value))) return null

  const buffer = Array.isArray(raw.buffer)
    ? raw.buffer.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : []
  if (buffer.length === 0) return null

  const pendingWin = isRecord(raw.pendingWin)
    ? {
        level: finiteIntOr(raw.pendingWin.level, 1),
        score: finiteIntOr(raw.pendingWin.score, 0)
      }
    : null

  // Older saves predate battle mode, so a missing field means "no boss".
  const pacman = isRecord(raw.pacman)
    ? {
        x: finiteIntOr(raw.pacman.x, 0),
        y: finiteIntOr(raw.pacman.y, 0),
        hp: Math.max(0, finiteIntOr(raw.pacman.hp, 0)),
        maxHp: Math.max(1, finiteIntOr(raw.pacman.maxHp, 1)),
        bar: clamp01(raw.pacman.bar),
        phase: parsePhase(raw.pacman.phase)
      }
    : null

  return {
    cells: cells as number[],
    buffer,
    next: finiteIntOr(raw.next, 0),
    score: Math.max(0, finiteIntOr(raw.score, 0)),
    steps: Math.max(0, finiteIntOr(raw.steps, 0)),
    maxReachedLevel: Math.max(1, finiteIntOr(raw.maxReachedLevel, 1)),
    hasWon: raw.hasWon === true,
    gameOver: raw.gameOver === true,
    pendingWin,
    pacman,
    rngState: finiteIntOr(raw.rngState, 1)
  }
}

/** Unknown phases fall back to the cage, which is the safe starting state. */
function parsePhase(value: unknown): PacManPhase {
  return value === 'exit' || value === 'board' ? value : 'cage'
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Parses the stored slots. Anything malformed is dropped rather than repaired:
 * a half-written board would resume into a state the player never had.
 */
export function parseRuns(raw: string | null): RunMap {
  if (raw === null) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}

  const slots = parsed.runs
  if (!isRecord(slots)) return {}

  const out: RunMap = {}
  for (const [modeId, value] of Object.entries(slots)) {
    if (!isRecord(value)) continue
    const snapshot = parseSnapshot(value.snapshot)
    if (snapshot === null || snapshot.gameOver) continue
    out[modeId] = {
      modeId,
      at: Math.max(0, finiteIntOr(value.at, 0)),
      snapshot
    }
  }

  return out
}

export class RunStore {
  private runs: RunMap

  constructor(private readonly adapter: StorageAdapter) {
    this.runs = this.read()
  }

  private read(): RunMap {
    try {
      return parseRuns(this.adapter.read(RUNS_KEY))
    } catch {
      return {}
    }
  }

  private persist(): void {
    writeJson(this.adapter, RUNS_KEY, { version: RUNS_VERSION, runs: this.runs })
  }

  /** Parks a run. Returns false when there was nothing worth saving. */
  save(modeId: string, snapshot: GameSnapshot, at: number): boolean {
    const normalized = normalizeForSave(snapshot)
    if (normalized === null) {
      this.clear(modeId)
      return false
    }

    this.runs = {
      ...this.runs,
      [modeId]: { modeId, at: Math.max(0, Math.floor(at)), snapshot: normalized }
    }
    this.persist()
    return true
  }

  load(modeId: string): SavedRun | null {
    const found = this.runs[modeId]
    return found === undefined ? null : found
  }

  has(modeId: string): boolean {
    return this.runs[modeId] !== undefined
  }

  clear(modeId: string): void {
    if (this.runs[modeId] === undefined) return
    const next = { ...this.runs }
    delete next[modeId]
    this.runs = next
    this.persist()
  }

  /** Drops slots whose mode no longer exists (e.g. after a data edit). */
  prune(knownModeIds: readonly string[]): void {
    const known = new Set(knownModeIds)
    let changed = false
    const next: RunMap = {}

    for (const [modeId, run] of Object.entries(this.runs)) {
      if (known.has(modeId)) next[modeId] = run
      else changed = true
    }

    if (changed) {
      this.runs = next
      this.persist()
    }
  }

  /** Modes that currently have a parked run. */
  parkedModeIds(): string[] {
    return Object.keys(this.runs)
  }
}
