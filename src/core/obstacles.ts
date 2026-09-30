import type { Board } from './board'
import type { Rng } from './rng'
import { CELL_OBSTACLE, type Pos } from './types'

/**
 * Obstacles (obstacle mode).
 *
 * They occupy a cell, cannot be placed on, never merge, and are destroyed when
 * a merge happens next to them.
 */

/** Drops one obstacle on a uniformly random empty cell. */
export function spawnObstacle(board: Board, rng: Rng): Pos | null {
  const empties = board.emptyPositions()
  if (empties.length === 0) return null
  const spot = empties[rng.int(empties.length)]
  board.set(spot.x, spot.y, CELL_OBSTACLE)
  return spot
}

/**
 * Clears every obstacle orthogonally adjacent to any cell of `group`.
 * Returns the cleared positions so the caller can award the bonus and emit
 * events. Diagonal obstacles are untouched (4-neighbour adjacency only).
 */
export function clearAdjacentObstacles(board: Board, group: readonly Pos[]): Pos[] {
  const cleared: Pos[] = []
  const seen = new Set<number>()

  for (let i = 0; i < group.length; i++) {
    const cell = group[i]
    const neighbors = board.neighbors(cell.x, cell.y)
    for (let n = 0; n < neighbors.length; n++) {
      const p = neighbors[n]
      const key = board.index(p.x, p.y)
      if (seen.has(key)) continue
      if (!board.isObstacle(p.x, p.y)) continue
      seen.add(key)
      board.set(p.x, p.y, 0)
      cleared.push({ x: p.x, y: p.y })
    }
  }

  return cleared
}
