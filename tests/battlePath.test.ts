import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board'
import { chooseTarget, seedArena } from '../src/core/battle'
import { loadTuning } from '../src/core/data'
import { Rng } from '../src/core/rng'
import { CELL_EMPTY, CELL_OBSTACLE, CELL_WALL, type Pos } from '../src/core/types'

/**
 * The boss's targeting and movement route.
 *
 * Two properties matter and are easy to get wrong:
 *
 *  1. it goes for the NEAREST food, measured in real walking steps;
 *  2. the route never crosses the wall.
 *
 * The second one is why a straight-line tie-break is not good enough: from the
 * cage, an L-shaped path "vertical first" would walk straight through solid
 * wall, and in the other direction the same shape would clip it on the way out
 * of the gap.
 */

const tuning = loadTuning()
const CONFIG = tuning.battle
const W = tuning.board.width
const H = tuning.board.height

/** An empty board with only the wall in place. */
function walled(): Board {
  const board = new Board(W, H)
  for (let x = 0; x < W; x++) {
    if (x !== CONFIG.gapX) board.set(x, CONFIG.wallRow, CELL_WALL)
  }
  return board
}

/** True when the route steps only between orthogonally adjacent cells. */
function isContiguous(from: Pos, path: readonly Pos[]): boolean {
  let previous = from
  for (const step of path) {
    const dx = Math.abs(step.x - previous.x)
    const dy = Math.abs(step.y - previous.y)
    if (dx + dy !== 1) return false
    previous = step
  }
  return true
}

function crossesWall(board: Board, path: readonly Pos[]): boolean {
  for (const step of path) {
    if (board.isWall(step.x, step.y)) return true
  }
  return false
}

describe('battle targeting: nearest food', () => {
  it('walks past far food to reach the closest one', () => {
    const board = walled()
    const from = { x: 0, y: H - 1 }
    // Two candidates: one 1 step away, one across the board.
    const near = { x: 0, y: H - 2 }
    const far = { x: 6, y: 3 }
    board.set(near.x, near.y, 1)
    board.set(far.x, far.y, 1)

    const target = chooseTarget(board, from, [far, near])
    expect(target?.cell).toEqual(near)
    expect(target?.path).toHaveLength(1)
  })

  it('measures distance by walking, not by straight line', () => {
    // The wall makes a candidate in the cage much further away than its
    // coordinate distance suggests: the boss has to reach the gap.
    const board = walled()
    const from = { x: 0, y: CONFIG.wallRow + 1 }
    const cageBlock = { x: 0, y: 0 }
    const boardBlock = { x: 4, y: CONFIG.wallRow + 1 }
    board.set(cageBlock.x, cageBlock.y, 1)
    board.set(boardBlock.x, boardBlock.y, 1)

    const target = chooseTarget(board, from, [cageBlock, boardBlock])
    // The board block is 4 steps away; the cage one needs a trip to the gap.
    expect(target?.cell).toEqual(boardBlock)
  })

  it('breaks ties in reading order, without using any randomness', () => {
    const board = walled()
    const from = { x: 0, y: CONFIG.wallRow + 1 }
    // Two equidistant candidates in the same column.
    const a = { x: 0, y: CONFIG.wallRow + 2 }
    const b = { x: 0, y: CONFIG.wallRow + 4 }
    board.set(a.x, a.y, 1)
    board.set(b.x, b.y, 1)

    // Both are 2 steps away; the upper one (smaller y) wins.
    const first = chooseTarget(board, from, [a, b])
    const second = chooseTarget(board, from, [b, a])
    expect(first?.cell).toEqual(a)
    // Order of the input list must not change the answer.
    expect(second?.cell).toEqual(a)
  })

  it('returns null when there is nothing to eat', () => {
    const board = walled()
    expect(chooseTarget(board, { x: 0, y: 5 }, [])).toBeNull()
  })
})

describe('battle targeting: the route never crosses the wall', () => {
  it('goes through the gap when leaving the cage', () => {
    const board = walled()
    const from = { x: 0, y: 0 }
    const food = { x: 6, y: CONFIG.wallRow + 1 }
    board.set(food.x, food.y, 1)

    const target = chooseTarget(board, from, [food])
    expect(target).not.toBeNull()
    if (target === null) return

    expect(isContiguous(from, target.path)).toBe(true)
    expect(crossesWall(board, target.path)).toBe(false)
    // It has to pass through the one opening on its way down.
    expect(target.path.some((step) => step.y === CONFIG.wallRow && step.x === CONFIG.gapX)).toBe(true)
  })

  it('goes through the gap when returning to it from the cage', () => {
    const board = walled()
    const from = { x: 0, y: CONFIG.wallRow - 1 }
    const gap = { x: CONFIG.gapX, y: CONFIG.wallRow }

    const target = chooseTarget(board, from, [gap])
    expect(target).not.toBeNull()
    if (target === null) return

    expect(isContiguous(from, target.path)).toBe(true)
    expect(crossesWall(board, target.path)).toBe(false)
    expect(target.path[target.path.length - 1]).toEqual(gap)
  })

  it('never routes through the wall from any reachable cage cell', () => {
    // Exhaustive over the cage: every start, aimed at a single board target.
    const food = { x: 6, y: H - 1 }
    for (let y = 0; y < CONFIG.wallRow; y++) {
      for (let x = 0; x < W; x++) {
        const board = walled()
        board.set(food.x, food.y, 1)
        const from = { x, y }
        const target = chooseTarget(board, from, [food])
        expect(target, `from ${x},${y}`).not.toBeNull()
        if (target === null) continue
        expect(crossesWall(board, target.path), `from ${x},${y}`).toBe(false)
        expect(isContiguous(from, target.path), `from ${x},${y}`).toBe(true)
      }
    }
  })

  it('steps around obstacles rather than through them', () => {
    const board = walled()
    const from = { x: 0, y: CONFIG.wallRow + 1 }
    // A vertical line of obstacles between the boss and its food.
    for (let y = CONFIG.wallRow + 1; y <= CONFIG.wallRow + 5; y++) {
      board.set(1, y, CELL_OBSTACLE)
    }
    const food = { x: 3, y: CONFIG.wallRow + 3 }
    board.set(food.x, food.y, 1)

    const target = chooseTarget(board, from, [food])
    expect(target).not.toBeNull()
    if (target === null) return

    // The direct route is blocked, so it must go around the column.
    expect(target.path.length).toBeGreaterThan(3)
    for (const step of target.path.slice(0, -1)) {
      expect(board.get(step.x, step.y)).toBe(CELL_EMPTY)
    }
  })

  it('still reaches food that is walled in by other blocks', () => {
    // The fallback: if every route is blocked by the blocks themselves, the boss
    // pushes through rather than standing still forever, which would stall the
    // run with no way to lose or win.
    const board = walled()
    const from = { x: 0, y: CONFIG.wallRow + 1 }
    const food = { x: 2, y: CONFIG.wallRow + 1 }
    // Ring the food with blocks so no empty cell touches it.
    board.set(1, CONFIG.wallRow + 1, 1)
    board.set(3, CONFIG.wallRow + 1, 1)
    board.set(2, CONFIG.wallRow, CELL_EMPTY) // pretend a block sits above
    board.set(2, CONFIG.wallRow, 1)
    board.set(2, CONFIG.wallRow + 2, 1)
    board.set(food.x, food.y, 1)

    const target = chooseTarget(board, from, [food])
    expect(target).not.toBeNull()
    // It gets there in the end, even if the route is not a pretty one.
    expect(target?.cell).toEqual(food)
    expect(target?.path[target.path.length - 1]).toEqual(food)
  })
})

describe('battle targeting: seeded arenas are walkable', () => {
  it('can reach every cage block from its start cell', () => {
    // A cage layout that was unreachable would make a run unwinnable in a way
    // the player could not see or fix.
    for (let seed = 1; seed <= 25; seed++) {
      const board = new Board(W, H)
      const rng = new Rng(seed)
      const boss = seedArena(board, CONFIG, (n) => rng.int(n))

      const food: Pos[] = []
      for (let y = 0; y < CONFIG.wallRow; y++) {
        for (let x = 0; x < W; x++) {
          if (board.get(x, y) > CELL_EMPTY) food.push({ x, y })
        }
      }
      expect(food.length).toBe(CONFIG.cageBlockCount)

      for (const cell of food) {
        const target = chooseTarget(board, { x: boss.x, y: boss.y }, [cell])
        expect(target, `seed ${seed} -> ${cell.x},${cell.y}`).not.toBeNull()
      }
    }
  })

  it('keeps the boss start clear so its first step is never blocked', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const board = new Board(W, H)
      const rng = new Rng(seed)
      const boss = seedArena(board, CONFIG, (n) => rng.int(n))
      expect(board.get(boss.x, boss.y)).toBe(CELL_EMPTY)
    }
  })
})
