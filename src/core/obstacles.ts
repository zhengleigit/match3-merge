import type { Board } from './board'
import type { Rng } from './rng'
import { CELL_EMPTY, CELL_OBSTACLE, CELL_OBSTACLE_CRACKED, type Pos } from './types'

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

/** Drops one fresh obstacle on a uniformly random empty cell. */
export function spawnObstacle(board: Board, rng: Rng): Pos | null {
  const empties = board.emptyPositions()
  if (empties.length === 0) return null
  const spot = empties[rng.int(empties.length)]
  board.set(spot.x, spot.y, CELL_OBSTACLE)
  return spot
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
