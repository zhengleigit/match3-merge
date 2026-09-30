import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board'
import { resolveCascade, scoreOfLevel, type CascadeOptions } from '../src/core/merge'
import { CELL_EMPTY, CELL_OBSTACLE, CELL_OBSTACLE_CRACKED } from '../src/core/types'

const BASIC_SCORES = [1, 2, 3, 5, 8]
const ENDLESS_SCORES = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]

function options(overrides?: Partial<CascadeOptions>): CascadeOptions {
  return {
    scoreByLevel: BASIC_SCORES,
    maxLevelBonus: 50,
    obstacleClearBonus: 1,
    obstacleHits: 2,
    obstacleBreakOutrightAtMaxLevel: true,
    winAtLevel: null,
    winAlreadyClaimed: false,
    cascadeEnabled: true,
    ...overrides
  }
}

describe('scoreOfLevel', () => {
  it('maps levels to their configured scores', () => {
    expect(scoreOfLevel(BASIC_SCORES, 1)).toBe(1)
    expect(scoreOfLevel(BASIC_SCORES, 5)).toBe(8)
    expect(scoreOfLevel(ENDLESS_SCORES, 10)).toBe(89)
  })

  it('clamps above the table and returns 0 for empty cells', () => {
    expect(scoreOfLevel(BASIC_SCORES, 99)).toBe(8)
    expect(scoreOfLevel(BASIC_SCORES, 0)).toBe(0)
  })
})

describe('merge: basic 3-in-a-row', () => {
  it('creates one bigger block at the placement cell and scores the consumed blocks', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 1)
    board.set(1, 1, 1)
    board.set(2, 1, 1)

    // The caller has already placed the third block at (2, 1).
    const result = resolveCascade(board, 2, 1, 1, options())

    expect(result.score).toBe(3) // 3 x level-1
    expect(result.finalLevel).toBe(2)
    expect(board.get(2, 1)).toBe(2)
    expect(board.get(0, 1)).toBe(CELL_EMPTY)
    expect(board.get(1, 1)).toBe(CELL_EMPTY)

    const merged = result.events.filter((e) => e.type === 'merged')
    expect(merged).toHaveLength(1)
  })

  it('does nothing when only two blocks touch', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 1)
    board.set(1, 1, 1)

    const result = resolveCascade(board, 1, 1, 1, options())

    expect(result.score).toBe(0)
    expect(result.events).toHaveLength(0)
    expect(board.get(1, 1)).toBe(1)
  })

  it('consumes a cluster of 4 in full and still creates only one block', () => {
    const board = new Board(5, 3)
    for (let x = 0; x < 4; x++) board.set(x, 1, 1)

    const result = resolveCascade(board, 3, 1, 1, options())

    expect(result.score).toBe(4) // all four consumed
    expect(result.finalLevel).toBe(2)
    expect(board.countBlocks()).toBe(1)
    const merged = result.events.find((e) => e.type === 'merged')
    expect(merged?.type === 'merged' && merged.consumed).toBe(4)
  })

  it('consumes a cross-shaped cluster of 5 in full', () => {
    const board = new Board(5, 5)
    board.set(2, 2, 1)
    board.set(1, 2, 1)
    board.set(3, 2, 1)
    board.set(2, 1, 1)
    board.set(2, 3, 1)

    const result = resolveCascade(board, 2, 2, 1, options())

    expect(result.score).toBe(5)
    expect(board.countBlocks()).toBe(1)
    expect(board.get(2, 2)).toBe(2)
  })
})

describe('merge: chaining', () => {
  it('chains upward while the new block completes another triple', () => {
    const board = new Board(5, 5)
    // Row of three level-1 blocks ending at the placement cell (2, 2).
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    // Two level-2 blocks directly above and below the placement cell.
    board.set(2, 1, 2)
    board.set(2, 3, 2)

    const result = resolveCascade(board, 2, 2, 1, options())

    // 3 x level-1 (=3) then 3 x level-2 (=6).
    expect(result.score).toBe(9)
    expect(result.finalLevel).toBe(3)
    expect(result.maxCreatedLevel).toBe(3)

    const merged = result.events.filter((e) => e.type === 'merged')
    expect(merged).toHaveLength(2)
    expect(merged[0].type === 'merged' && merged[0].chain).toBe(1)
    expect(merged[1].type === 'merged' && merged[1].chain).toBe(2)
  })

  it('stops chaining when cascade is disabled', () => {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(2, 1, 2)
    board.set(2, 3, 2)

    const result = resolveCascade(board, 2, 2, 1, options({ cascadeEnabled: false }))

    expect(result.score).toBe(3)
    expect(result.finalLevel).toBe(2)
    expect(result.events.filter((e) => e.type === 'merged')).toHaveLength(1)
  })
})

describe('merge: max level behaviour', () => {
  it('basic mode: clears 3 max-level blocks, pays the bonus and creates nothing', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 5)
    board.set(1, 1, 5)
    board.set(2, 1, 5)

    const result = resolveCascade(board, 2, 1, 5, options())

    expect(result.score).toBe(74) // 3 x 8 + 50
    expect(result.finalLevel).toBe(CELL_EMPTY)
    expect(board.countBlocks()).toBe(0)

    const cleared = result.events.find((e) => e.type === 'maxCleared')
    expect(cleared).toBeDefined()
    expect(cleared?.type === 'maxCleared' && cleared.bonus).toBe(50)
    expect(result.events.some((e) => e.type === 'merged')).toBe(false)
  })

  it('obstacle mode uses the same +50 bonus', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 5)
    board.set(1, 1, 5)
    board.set(2, 1, 5)

    const result = resolveCascade(board, 2, 1, 5, options({ maxLevelBonus: 50 }))
    expect(result.score).toBe(74)
  })

  it('endless mode: level 5 is NOT max, so it merges normally with no bonus', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 5)
    board.set(1, 1, 5)
    board.set(2, 1, 5)

    const result = resolveCascade(
      board,
      2,
      1,
      5,
      options({ scoreByLevel: ENDLESS_SCORES, maxLevelBonus: 0 })
    )

    expect(result.score).toBe(24) // 3 x 8, no bonus
    expect(result.finalLevel).toBe(6)
    expect(result.events.some((e) => e.type === 'merged')).toBe(true)
    expect(result.events.some((e) => e.type === 'maxCleared')).toBe(false)
  })

  it('endless mode: clearing 3 max-level blocks pays no bonus and clears the board', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 10)
    board.set(1, 1, 10)
    board.set(2, 1, 10)

    const result = resolveCascade(
      board,
      2,
      1,
      10,
      options({ scoreByLevel: ENDLESS_SCORES, maxLevelBonus: 0 })
    )

    expect(result.score).toBe(3 * 89)
    expect(board.countBlocks()).toBe(0)
    const cleared = result.events.find((e) => e.type === 'maxCleared')
    expect(cleared?.type === 'maxCleared' && cleared.bonus).toBe(0)
  })
})

describe('merge: obstacle blast', () => {
  /** A level-1 triple with an obstacle directly above the placement cell. */
  function boardWithObstacleAbove(value = CELL_OBSTACLE): Board {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(2, 1, value)
    return board
  }

  it('cracks a fresh obstacle instead of destroying it, and pays nothing', () => {
    const board = boardWithObstacleAbove()
    const result = resolveCascade(board, 2, 2, 1, options())

    expect(board.get(2, 1)).toBe(CELL_OBSTACLE_CRACKED)
    expect(board.isObstacle(2, 1)).toBe(true)
    expect(board.isCrackedObstacle(2, 1)).toBe(true)

    // Only the merge scored: the bonus is for removing an obstacle, not for
    // chipping it.
    expect(result.score).toBe(3)
    expect(result.events.filter((e) => e.type === 'obstacleHit')).toHaveLength(1)
    expect(result.events.filter((e) => e.type === 'obstacleCleared')).toHaveLength(0)
  })

  it('destroys a cracked obstacle on the next hit and awards the bonus', () => {
    const board = boardWithObstacleAbove(CELL_OBSTACLE_CRACKED)
    const result = resolveCascade(board, 2, 2, 1, options())

    expect(board.isObstacle(2, 1)).toBe(false)
    expect(result.score).toBe(3 + 1)
    const cleared = result.events.filter((e) => e.type === 'obstacleCleared')
    expect(cleared).toHaveLength(1)
    expect(result.events.filter((e) => e.type === 'obstacleHit')).toHaveLength(0)
  })

  it('takes two separate merges to clear one obstacle', () => {
    const board = new Board(5, 5)
    board.set(2, 1, CELL_OBSTACLE)

    // Merge 1: a level-1 triple whose placement cell is directly below it.
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    resolveCascade(board, 2, 2, 1, options())
    expect(board.get(2, 1)).toBe(CELL_OBSTACLE_CRACKED)

    // Merge 2: a different triple that touches it from the left.
    board.set(0, 0, 1)
    board.set(1, 0, 1)
    board.set(1, 1, 1)
    const second = resolveCascade(board, 1, 1, 1, options())

    expect(board.isObstacle(2, 1)).toBe(false)
    expect(second.events.filter((e) => e.type === 'obstacleCleared')).toHaveLength(1)
  })

  it('deals one point of damage per merge, however many cells touch it', () => {
    // A long cluster touching the same obstacle from three sides must still
    // only crack it: otherwise a big group would shred a wall in one move.
    const board = new Board(5, 5)
    board.set(1, 3, 1)
    board.set(1, 2, CELL_OBSTACLE)
    board.set(0, 3, 1)
    board.set(2, 3, 1)
    board.set(1, 4, 1)

    const result = resolveCascade(board, 1, 4, 1, options())

    expect(result.events.filter((e) => e.type === 'obstacleHit')).toHaveLength(1)
    expect(board.get(1, 2)).toBe(CELL_OBSTACLE_CRACKED)
  })

  it('breaks obstacles outright on a max-level clear', () => {
    // The confirmed rule: two hits normally, but a 5-level clear is strong
    // enough to destroy what it touches immediately.
    const board = new Board(5, 5)
    board.set(0, 3, 5)
    board.set(1, 3, 5)
    board.set(2, 3, 5)
    board.set(1, 2, CELL_OBSTACLE)

    const result = resolveCascade(board, 1, 3, 5, options())

    expect(board.isObstacle(1, 2)).toBe(false)
    expect(result.events.filter((e) => e.type === 'obstacleCleared')).toHaveLength(1)
    expect(result.events.filter((e) => e.type === 'obstacleHit')).toHaveLength(0)
  })

  it('ignores breakOutrightAtMaxLevel when it is turned off', () => {
    const board = new Board(5, 5)
    board.set(0, 3, 5)
    board.set(1, 3, 5)
    board.set(2, 3, 5)
    board.set(1, 2, CELL_OBSTACLE)

    const result = resolveCascade(
      board,
      1,
      3,
      5,
      options({ obstacleBreakOutrightAtMaxLevel: false })
    )

    expect(board.get(1, 2)).toBe(CELL_OBSTACLE_CRACKED)
    expect(result.events.filter((e) => e.type === 'obstacleHit')).toHaveLength(1)
  })

  it('breaks in one hit when hits is set to 1', () => {
    const board = boardWithObstacleAbove()
    resolveCascade(board, 2, 2, 1, options({ obstacleHits: 1 }))

    expect(board.isObstacle(2, 1)).toBe(false)
  })

  it('does NOT damage diagonally adjacent obstacles', () => {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(3, 1, CELL_OBSTACLE) // diagonal from (2, 2)

    const result = resolveCascade(board, 2, 2, 1, options())

    expect(board.isObstacle(3, 1)).toBe(true)
    expect(board.isCrackedObstacle(3, 1)).toBe(false)
    expect(result.events.filter((e) => e.type === 'obstacleHit')).toHaveLength(0)
    expect(result.events.filter((e) => e.type === 'obstacleCleared')).toHaveLength(0)
  })
})

describe('merge: cascade steps (per-link board states)', () => {
  /**
   * These snapshots are what let the view play a chain one link at a time.
   * If they are wrong the animation shows the wrong blocks, so they are pinned
   * down here rather than only being exercised through the UI.
   */
  it('records one step for a single merge, with both board states', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 1)
    board.set(1, 1, 1)
    board.set(2, 1, 1)

    const result = resolveCascade(board, 2, 1, 1, options())

    expect(result.steps).toHaveLength(1)
    const step = result.steps[0]

    // Before: all three level-1 blocks still present (that is what gets drawn
    // while the animation plays).
    expect(step.cellsBefore[board.index(0, 1)]).toBe(1)
    expect(step.cellsBefore[board.index(1, 1)]).toBe(1)
    expect(step.cellsBefore[board.index(2, 1)]).toBe(1)

    // After: the cluster is replaced by the single level-2 block.
    expect(step.cellsAfter[board.index(0, 1)]).toBe(CELL_EMPTY)
    expect(step.cellsAfter[board.index(1, 1)]).toBe(CELL_EMPTY)
    expect(step.cellsAfter[board.index(2, 1)]).toBe(2)

    expect(step.events).toHaveLength(1)
    expect(step.events[0].type).toBe('merged')
  })

  it('records one step per chained merge, each starting where the last ended', () => {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(2, 1, 2)
    board.set(2, 3, 2)

    const result = resolveCascade(board, 2, 2, 1, options())

    expect(result.steps).toHaveLength(2)

    // Link 1: the level-1 row becomes a level-2 at (2,2).
    expect(result.steps[0].cellsAfter[board.index(2, 2)]).toBe(2)
    // Link 2 starts exactly where link 1 left off.
    expect(result.steps[1].cellsBefore).toEqual(result.steps[0].cellsAfter)
    // Link 2 consumes the vertical level-2 triple.
    expect(result.steps[1].cellsAfter[board.index(2, 2)]).toBe(3)
    expect(result.steps[1].events[0].type).toBe('merged')
    expect(
      result.steps[1].events[0].type === 'merged' && result.steps[1].events[0].chain
    ).toBe(2)
  })

  it('leaves the final step equal to the live board', () => {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(2, 1, 2)
    board.set(2, 3, 2)

    const result = resolveCascade(board, 2, 2, 1, options())
    const last = result.steps[result.steps.length - 1]

    expect(last.cellsAfter).toEqual(board.toArray())
  })

  it('includes obstacle damage in the step that caused it', () => {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(2, 1, CELL_OBSTACLE)

    const result = resolveCascade(board, 2, 2, 1, options())

    expect(result.steps).toHaveLength(1)
    const types = result.steps[0].events.map((e) => e.type)
    expect(types).toContain('obstacleHit')
    expect(types).toContain('merged')
    // The step's "before" board shows the pristine obstacle and its "after"
    // board the cracked one, so the crack is what the animation reveals.
    expect(result.steps[0].cellsBefore[board.index(2, 1)]).toBe(CELL_OBSTACLE)
    expect(result.steps[0].cellsAfter[board.index(2, 1)]).toBe(CELL_OBSTACLE_CRACKED)
  })

  it('includes a destroyed obstacle in the step that caused it', () => {
    const board = new Board(5, 5)
    board.set(0, 2, 1)
    board.set(1, 2, 1)
    board.set(2, 2, 1)
    board.set(2, 1, CELL_OBSTACLE_CRACKED)

    const result = resolveCascade(board, 2, 2, 1, options())

    const types = result.steps[0].events.map((e) => e.type)
    expect(types).toContain('obstacleCleared')
    expect(result.steps[0].cellsAfter[board.index(2, 1)]).toBe(CELL_EMPTY)
  })

  it('records a step for a max-level clear, with nothing created', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 5)
    board.set(1, 1, 5)
    board.set(2, 1, 5)

    const result = resolveCascade(board, 2, 1, 5, options())

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].events[0].type).toBe('maxCleared')
    expect(result.steps[0].cellsAfter.every((v) => v === CELL_EMPTY)).toBe(true)
  })

  it('records no steps when nothing merged', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 1)
    board.set(1, 1, 1)

    const result = resolveCascade(board, 1, 1, 1, options())
    expect(result.steps).toHaveLength(0)
  })
})

describe('merge: win level pauses the cascade', () => {
  it('reports resume position when the win level is created', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 9)
    board.set(1, 1, 9)
    board.set(2, 1, 9)

    const result = resolveCascade(
      board,
      2,
      1,
      9,
      options({ scoreByLevel: ENDLESS_SCORES, maxLevelBonus: 0, winAtLevel: 10 })
    )

    expect(result.stoppedForWin).toBe(true)
    expect(result.resume).toEqual({ x: 2, y: 1, level: 10 })
    expect(board.get(2, 1)).toBe(10)
  })

  it('does not stop again once the win has been claimed', () => {
    const board = new Board(5, 3)
    board.set(0, 1, 9)
    board.set(1, 1, 9)
    board.set(2, 1, 9)

    const result = resolveCascade(
      board,
      2,
      1,
      9,
      options({
        scoreByLevel: ENDLESS_SCORES,
        maxLevelBonus: 0,
        winAtLevel: 10,
        winAlreadyClaimed: true
      })
    )

    expect(result.stoppedForWin).toBe(false)
    expect(result.resume).toBeNull()
  })
})
