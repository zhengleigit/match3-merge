import { describe, expect, it } from 'vitest'
import { fillStartObstacles, obstacleBandAt, shouldSpawnObstacle } from '../src/core/obstacles'
import { Board } from '../src/core/board'
import { loadTuning } from '../src/core/data'
import { CELL_EMPTY, CELL_OBSTACLE } from '../src/core/types'
import type { ObstacleBand, StartClearArea } from '../src/core/types'

/**
 * The escalating obstacle schedule.
 *
 * The shipped table is:
 *   steps   1-100   one obstacle every 3 steps
 *   steps 101-200   one every 2
 *   steps 201+      one every step
 *
 * The boundaries are the whole point of the feature, so they are pinned here
 * explicitly rather than inferred from a few sample steps.
 */

const SHIPPED: readonly ObstacleBand[] = loadTuning().obstacles.spawnBands
const SINGLE: readonly ObstacleBand[] = [{ fromStep: 1, every: 3 }]

/** Steps in `[from, to]` where an obstacle spawns. */
function spawnsIn(bands: readonly ObstacleBand[], from: number, to: number): number[] {
  const out: number[] = []
  for (let step = from; step <= to; step++) {
    if (shouldSpawnObstacle(bands, step)) out.push(step)
  }
  return out
}

describe('obstacles: the shipped schedule', () => {
  it('is the three bands the mode advertises', () => {
    expect(SHIPPED).toEqual([
      { fromStep: 1, every: 3 },
      { fromStep: 101, every: 2 },
      { fromStep: 201, every: 1 }
    ])
  })

  it('picks the band whose fromStep is the highest at or below the step', () => {
    expect(obstacleBandAt(SHIPPED, 1)?.every).toBe(3)
    expect(obstacleBandAt(SHIPPED, 100)?.every).toBe(3)
    expect(obstacleBandAt(SHIPPED, 101)?.every).toBe(2)
    expect(obstacleBandAt(SHIPPED, 200)?.every).toBe(2)
    expect(obstacleBandAt(SHIPPED, 201)?.every).toBe(1)
    expect(obstacleBandAt(SHIPPED, 9999)?.every).toBe(1)
  })

  it('spawns nothing before the first band starts', () => {
    // A schedule that begins later than step 1 must not spawn from step 0.
    const late: readonly ObstacleBand[] = [{ fromStep: 5, every: 1 }]
    expect(obstacleBandAt(late, 0)).toBeNull()
    expect(obstacleBandAt(late, 4)).toBeNull()
    expect(shouldSpawnObstacle(late, 4)).toBe(false)
    expect(shouldSpawnObstacle(late, 5)).toBe(true)
  })
})

describe('obstacles: band 1 (steps 1-100, every 3)', () => {
  it('spawns on steps 3, 6, 9, ... and not before', () => {
    expect(spawnsIn(SHIPPED, 1, 12)).toEqual([3, 6, 9, 12])
  })

  it('spawns on step 99 but not 100', () => {
    // 99 = 3 x 33, 100 is not a multiple of 3.
    expect(shouldSpawnObstacle(SHIPPED, 99)).toBe(true)
    expect(shouldSpawnObstacle(SHIPPED, 100)).toBe(false)
  })

  it('produces 33 obstacles across its 100 steps', () => {
    expect(spawnsIn(SHIPPED, 1, 100)).toHaveLength(33)
  })
})

describe('obstacles: band 2 (steps 101-200, every 2)', () => {
  it('counts from its own first step rather than from the run', () => {
    // Band 2 starts at 101. Counting from the band means the first spawn is two
    // band-steps in, at 102 — not tied to the run's parity.
    expect(shouldSpawnObstacle(SHIPPED, 101)).toBe(false)
    expect(shouldSpawnObstacle(SHIPPED, 102)).toBe(true)
    expect(spawnsIn(SHIPPED, 101, 108)).toEqual([102, 104, 106, 108])
  })

  it('spawns on step 200, its last', () => {
    // 100 band-steps in, and 100 is even.
    expect(shouldSpawnObstacle(SHIPPED, 200)).toBe(true)
  })

  it('produces 50 obstacles across its 100 steps', () => {
    expect(spawnsIn(SHIPPED, 101, 200)).toHaveLength(50)
  })

  it('is twice as dense as band 1', () => {
    const first = spawnsIn(SHIPPED, 1, 100).length
    const second = spawnsIn(SHIPPED, 101, 200).length
    expect(second).toBe(first * 2 - 16)
    expect(second).toBeGreaterThan(first)
  })
})

describe('obstacles: band 3 (steps 201+, every step)', () => {
  it('spawns on every single step from 201 on', () => {
    // Starting the window at 198 shows the hand-over: band 2 still spaces its
    // spawns out (198, 200), and from 201 nothing is skipped.
    expect(spawnsIn(SHIPPED, 198, 210)).toEqual([
      198, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210
    ])
  })

  it('never skips a step, however far the run goes', () => {
    for (let step = 201; step <= 320; step++) {
      expect(shouldSpawnObstacle(SHIPPED, step), `step ${step}`).toBe(true)
    }
  })
})

describe('obstacles: monotonic escalation', () => {
  it('never gets slower', () => {
    // A band that is less frequent than the one before it would be dead config,
    // and the player would experience the difficulty going backwards.
    for (let i = 1; i < SHIPPED.length; i++) {
      expect(SHIPPED[i].every).toBeLessThanOrEqual(SHIPPED[i - 1].every)
    }
  })

  it('produces a strictly rising spawn count per 100 steps', () => {
    const counts = [spawnsIn(SHIPPED, 1, 100).length, spawnsIn(SHIPPED, 101, 200).length]
    // Band 3 is every step, so its first 100 steps are simply 100.
    expect(counts[0]).toBeLessThan(counts[1])
    expect(100).toBeGreaterThan(counts[1])
  })
})

describe('obstacles: custom schedules', () => {
  it('handles a single band as the degenerate case of the same table', () => {
    expect(obstacleBandAt(SINGLE, 1)?.every).toBe(3)
    expect(obstacleBandAt(SINGLE, 10_000)?.every).toBe(3)
    expect(spawnsIn(SINGLE, 1, 6)).toEqual([3, 6])
  })

  it('treats a non-positive interval as "never spawn"', () => {
    // Rather than dividing by zero or spawning on every step.
    expect(shouldSpawnObstacle([{ fromStep: 1, every: 0 }], 5)).toBe(false)
    expect(shouldSpawnObstacle([{ fromStep: 1, every: -2 }], 5)).toBe(false)
  })

  it('is a pure function of the step count', () => {
    // Undo rewinds the step counter and nothing else, so the schedule has to be
    // derivable from the number alone — no hidden "steps since last spawn".
    const a = spawnsIn(SHIPPED, 95, 110)
    const b = spawnsIn(SHIPPED, 95, 110)
    expect(a).toEqual(b)
    expect(shouldSpawnObstacle(SHIPPED, 103)).toBe(shouldSpawnObstacle(SHIPPED, 103))
  })
})

describe('obstacles: the opening pocket', () => {
  const TUNING = loadTuning()
  const W = TUNING.board.width
  const H = TUNING.board.height

  function filled(clear: StartClearArea, width = W, height = H): Board {
    const board = new Board(width, height)
    fillStartObstacles(board, clear)
    return board
  }

  it('walls off everything but a centred pocket on the shipped board', () => {
    expect(TUNING.obstacles.startClear).toEqual({ width: 3, height: 3 })

    // 7x10 with a 3x3 pocket: the leftover 4 columns/7 rows split 2|2 and 3|4,
    // so the pocket sits at x 2..4, y 3..5.
    expect(fillStartObstacles(new Board(W, H), TUNING.obstacles.startClear)).toEqual({
      x: 2,
      y: 3,
      width: 3,
      height: 3
    })

    const board = filled(TUNING.obstacles.startClear)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = x >= 2 && x <= 4 && y >= 3 && y <= 5
        expect(board.get(x, y), `cell ${x},${y}`).toBe(inside ? CELL_EMPTY : CELL_OBSTACLE)
      }
    }
  })

  it('opens with exactly the pocket left free', () => {
    const board = filled(TUNING.obstacles.startClear)
    const pocket = TUNING.obstacles.startClear.width * TUNING.obstacles.startClear.height

    expect(board.countObstacles()).toBe(W * H - pocket)
    expect(board.emptyPositions()).toHaveLength(pocket)
    expect(board.hasEmptyCell()).toBe(true)
  })

  it('puts the odd leftover below and to the right, never above and left', () => {
    // 8 - 3 = 5, which does not split evenly. Flooring the offset leaves two
    // columns on the left and three on the right.
    const board = filled({ width: 3, height: 3 }, 8, 8)

    expect(board.isEmpty(2, 2)).toBe(true)
    expect(board.isEmpty(4, 4)).toBe(true)
    expect(board.isObstacle(1, 2)).toBe(true)
    expect(board.isObstacle(5, 2)).toBe(true)
    expect(board.isObstacle(2, 5)).toBe(true)
  })

  it('lets an oversized pocket cover the whole board', () => {
    // Clamping means "no opening obstacles" needs no second switch: it is just
    // the degenerate case of a pocket as large as the board.
    const board = filled({ width: 99, height: 99 })

    expect(board.countObstacles()).toBe(0)
    expect(board.emptyPositions()).toHaveLength(W * H)
  })

  it('clamps a thin pocket the other way too', () => {
    const column = filled({ width: 1, height: 10 })
    expect(column.countObstacles()).toBe(60)
    for (let y = 0; y < H; y++) expect(column.isEmpty(3, y), `row ${y}`).toBe(true)

    const row = filled({ width: 7, height: 1 })
    expect(row.countObstacles()).toBe(63)
    for (let x = 0; x < W; x++) expect(row.isEmpty(x, 4), `col ${x}`).toBe(true)
  })

  it('leaves something playable for every pocket the config allows', () => {
    // A pocket of zero cells is rejected by loadTuning, so the smallest legal
    // pocket still opens the run with one cell rather than an instant loss.
    for (const size of [
      { width: 1, height: 1 },
      { width: 1, height: 10 },
      { width: 7, height: 1 }
    ]) {
      const board = filled(size)
      expect(board.hasEmptyCell(), `${size.width}x${size.height}`).toBe(true)
    }
  })

  it('is deterministic, so a rewind restores it from the snapshot', () => {
    expect(Array.from(filled({ width: 3, height: 3 }).cells)).toEqual(
      Array.from(filled({ width: 3, height: 3 }).cells)
    )
  })

  it('writes fresh obstacles, never cracked ones', () => {
    // A crack means "this took a hit from a merge"; an opening board that
    // looked pre-damaged would promise the player free progress.
    const board = filled({ width: 3, height: 3 })
    const counts = new Map<number, number>()
    for (const value of Array.from(board.cells)) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }

    expect(counts.get(CELL_OBSTACLE)).toBe(61)
    expect(counts.get(CELL_EMPTY)).toBe(9)
    expect(Array.from(counts.keys()).sort()).toEqual([CELL_OBSTACLE, CELL_EMPTY].sort())
  })
})
