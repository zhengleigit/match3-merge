import type { Board } from './board'
import type { Rng } from './rng'
import {
  CELL_EMPTY,
  CELL_OBSTACLE,
  CELL_OBSTACLE_CRACKED,
  type ObstacleBand,
  type Pos,
  type StartClearArea
} from './types'

/**
 * Obstacles (obstacle mode).
 *
 * They occupy a cell, cannot be placed on, never merge, and take damage from a
 * merge happening next to them.
 *
 * Damage model: a fresh obstacle cracks on the first hit and shatters on the
 * second, so clearing one costs two merges next to it. The exception is a
 * MAX-level merge (the 5-level clear in basic/obstacle mode): it is strong
 * enough to destroy whatever it touches outright, which keeps a big play from
 * feeling blocked by a two-hit chore.
 *
 * One merge deals exactly one point of damage per obstacle, no matter how many
 * cells of the group touch it — otherwise a long cluster would shred a whole
 * wall in a single move.
 */

/**
 * Fills the board with fresh obstacles except for a centred open pocket.
 *
 * This is obstacle mode's opening position rather than a turn outcome, so it is
 * built once when the game is constructed and then carried by every snapshot
 * like any other board state.
 *
 * The pocket is centred by floor division, which leaves an odd leftover row or
 * column *below / right of* the pocket — the only split that still reads as
 * "the middle" on both axes. No RNG is involved, so a given config always opens
 * the same way and a rewind restores it from the snapshot for free.
 */
export function fillStartObstacles(board: Board, clear: StartClearArea): Pos & StartClearArea {
  // A pocket larger than the board simply means "no obstacles at all", which is
  // what clamping produces; the config is validated to be at least 1x1.
  const width = Math.max(1, Math.min(board.width, Math.floor(clear.width)))
  const height = Math.max(1, Math.min(board.height, Math.floor(clear.height)))
  const x0 = Math.floor((board.width - width) / 2)
  const y0 = Math.floor((board.height - height) / 2)

  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const inside = x >= x0 && x < x0 + width && y >= y0 && y < y0 + height
      if (!inside) board.set(x, y, CELL_OBSTACLE)
    }
  }

  return { x: x0, y: y0, width, height }
}

/** Drops one fresh obstacle on a uniformly random empty cell. */
export function spawnObstacle(board: Board, rng: Rng): Pos | null {
  const empties = board.emptyPositions()
  if (empties.length === 0) return null
  const spot = empties[rng.int(empties.length)]
  board.set(spot.x, spot.y, CELL_OBSTACLE)
  return spot
}

/**
 * The band of the spawn schedule in force at `steps`, or null before the first
 * band begins.
 *
 * Bands are ordered by `fromStep`; the last one at or below `steps` wins. The
 * result is a pure function of the step count, so undo needs no extra state to
 * restore the correct rate — rewinding the step counter rewinds the schedule.
 */
export function obstacleBandAt(
  bands: readonly ObstacleBand[],
  steps: number
): ObstacleBand | null {
  let active: ObstacleBand | null = null
  for (let i = 0; i < bands.length; i++) {
    if (steps >= bands[i].fromStep) active = bands[i]
    else break
  }
  return active
}

/**
 * Whether a placement ending on `steps` should drop an obstacle.
 *
 * Counting restarts at the active band's own first step. Anchoring to the run
 * instead would make "every 2 steps from step 101" fire on step 102, 104, … —
 * i.e. tied to the parity of the run rather than to the band, so the first
 * spawn of a band could arrive one step late without any way to see why.
 */
export function shouldSpawnObstacle(bands: readonly ObstacleBand[], steps: number): boolean {
  const band = obstacleBandAt(bands, steps)
  if (band === null) return false
  if (band.every <= 0) return false

  const withinBand = steps - band.fromStep + 1
  return withinBand % band.every === 0
}

export interface ObstacleDamageOptions {
  /** Hits needed to destroy a fresh obstacle. 1 disables the cracked stage. */
  hits: number
  /** True for a max-level merge, which destroys outright. */
  breakOutright: boolean
}

export interface ObstacleDamageResult {
  /** Obstacles that took damage and survived (they are now cracked). */
  cracked: Pos[]
  /** Obstacles destroyed by this hit. */
  cleared: Pos[]
}

/**
 * Damages every obstacle orthogonally adjacent to any cell of `group`.
 * Diagonal obstacles are untouched (4-neighbour adjacency only).
 */
export function damageAdjacentObstacles(
  board: Board,
  group: readonly Pos[],
  options: ObstacleDamageOptions
): ObstacleDamageResult {
  const cracked: Pos[] = []
  const cleared: Pos[] = []
  const seen = new Set<number>()

  // A hit count below 1 would mean an obstacle that can never be removed.
  const hits = Math.max(1, options.hits)

  for (let i = 0; i < group.length; i++) {
    const cell = group[i]
    const neighbors = board.neighbors(cell.x, cell.y)
    for (let n = 0; n < neighbors.length; n++) {
      const p = neighbors[n]
      const key = board.index(p.x, p.y)
      if (seen.has(key)) continue
      if (!board.isObstacle(p.x, p.y)) continue
      seen.add(key)

      const breaks = options.breakOutright || hits <= 1 || board.isCrackedObstacle(p.x, p.y)
      board.set(p.x, p.y, breaks ? CELL_EMPTY : CELL_OBSTACLE_CRACKED)
      ;(breaks ? cleared : cracked).push({ x: p.x, y: p.y })
    }
  }

  return { cracked, cleared }
}
