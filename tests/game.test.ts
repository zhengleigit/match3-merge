import { describe, expect, it } from 'vitest'
import type { Game } from '../src/core/game'
import { CELL_OBSTACLE, CELL_OBSTACLE_CRACKED } from '../src/core/types'
import type { GameEvent, Tuning } from '../src/core/types'
import { cellsOf, craft, levelAt, makeGame, onlyLevelOne, openBoard } from './helpers'

function eventTypes(events: readonly GameEvent[]): string[] {
  return events.map((e) => e.type)
}

/** Obstacle mode on an open board, with every spawn forced to level 1. */
function obstacleTuning(tuning: Tuning): void {
  onlyLevelOne(tuning)
  openBoard(tuning)
}

describe('Game: initial state', () => {
  it('starts with an empty board, empty buffer and one level-1 block queued', () => {
    const game = makeGame()
    const view = game.view()

    expect(view.cells.every((c) => c === 0)).toBe(true)
    expect(view.buffer).toEqual([0, 0, 0])
    expect(view.next).toBe(1)
    expect(view.score).toBe(0)
    expect(view.steps).toBe(0)
    expect(view.maxReachedLevel).toBe(1)
    expect(view.canUndo).toBe(false)
    expect(view.gameOver).toBe(false)
  })

  it('can only spawn level 1 until a higher level has been created', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    for (let i = 0; i < 20; i++) {
      game.pullNextToBuffer()
      expect(game.view().next).toBe(1)
    }
  })
})

describe('Game: next -> buffer flow', () => {
  it('moves the next block into the buffer and immediately spawns a replacement', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    const events = game.pullNextToBuffer()

    expect(eventTypes(events)).toEqual(['toBuffer', 'spawned'])
    const view = game.view()
    expect(view.buffer).toEqual([1, 0, 0])
    expect(view.next).toBe(1)
    // Moving to the buffer is not a placement, so the step counter stays put.
    expect(view.steps).toBe(0)
  })

  it('fills the first free slot, then a requested slot', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    game.pullNextToBuffer()
    game.pullNextToBuffer(2)

    expect(game.view().buffer).toEqual([1, 0, 1])
  })

  it('refuses to overfill the buffer', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    expect(eventTypes(game.pullNextToBuffer())).toEqual(['toBuffer', 'spawned'])
    expect(eventTypes(game.pullNextToBuffer())).toEqual(['toBuffer', 'spawned'])
    expect(eventTypes(game.pullNextToBuffer())).toEqual(['toBuffer', 'spawned'])

    const rejected = game.pullNextToBuffer()
    expect(rejected).toEqual([{ type: 'invalid', reason: 'buffer-full' }])
    expect(game.view().buffer).toEqual([1, 1, 1])
  })

  it('refuses a buffer slot that is already taken', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    game.pullNextToBuffer(1)

    expect(game.pullNextToBuffer(1)).toEqual([{ type: 'invalid', reason: 'buffer-full' }])
  })
})

describe('Game: placing', () => {
  it('rejects an empty buffer slot and an occupied cell', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    expect(game.placeFromBuffer(0, 0, 0)).toEqual([{ type: 'invalid', reason: 'empty-slot' }])

    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)

    game.pullNextToBuffer()
    expect(game.placeFromBuffer(0, 0, 0)).toEqual([{ type: 'invalid', reason: 'cell-occupied' }])
  })

  it('rejects out-of-bounds coordinates', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    game.pullNextToBuffer()

    expect(game.placeFromBuffer(0, -1, 0)).toEqual([{ type: 'invalid', reason: 'out-of-bounds' }])
    expect(game.placeFromBuffer(0, 7, 0)).toEqual([{ type: 'invalid', reason: 'out-of-bounds' }])
    expect(game.placeFromBuffer(0, 0, 10)).toEqual([{ type: 'invalid', reason: 'out-of-bounds' }])
  })

  it('consumes the buffer slot, counts a step and keeps a lone block unmerged', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    game.pullNextToBuffer()

    const events = game.placeFromBuffer(0, 3, 3)

    expect(eventTypes(events)).toEqual(['placed'])
    expect(levelAt(game, 3, 3)).toBe(1)
    const view = game.view()
    expect(view.buffer).toEqual([0, 0, 0])
    expect(view.steps).toBe(1)
    expect(view.score).toBe(0)
  })

  it('scores the consumed blocks and unlocks the next level', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    // Three level-1 blocks in a row; the third completes the triple.
    for (const x of [0, 1, 2]) {
      game.pullNextToBuffer()
      game.placeFromBuffer(0, x, 0)
    }

    const view = game.view()
    expect(levelAt(game, 2, 0)).toBe(2)
    expect(view.score).toBe(3)
    expect(view.maxReachedLevel).toBe(2)
    expect(view.steps).toBe(3)
  })

  it('allows higher levels to spawn only after they were created', () => {
    const game = makeGame()
    for (const x of [0, 1, 2]) {
      game.pullNextToBuffer()
      game.placeFromBuffer(0, x, 0)
    }
    expect(game.view().maxReachedLevel).toBe(2)

    let sawLevel2 = false
    for (let i = 0; i < 200 && !sawLevel2; i++) {
      game.pullNextToBuffer()
      if (game.view().next === 2) sawLevel2 = true

      // Drop the buffered block on any cell that is still free, so the board
      // never fills up and the loop can keep rolling.
      const view = game.view()
      const free = view.cells.indexOf(0)
      if (free >= 0) {
        game.placeFromBuffer(0, free % view.width, Math.floor(free / view.width))
      }
    }
    expect(sawLevel2).toBe(true)
  })

  it('clears a max-level cluster and pays the bonus (basic mode)', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 0, level: 5 },
          { x: 1, y: 0, level: 5 }
        ],
        buffer: [5, 0, 0]
      })
    )

    const events = game.placeFromBuffer(0, 2, 0)

    expect(eventTypes(events)).toContain('maxCleared')
    expect(events.some((e) => e.type === 'merged')).toBe(false)
    expect(game.view().score).toBe(3 * 8 + 50)
    // The whole cluster is gone and nothing was created in its place.
    expect(levelAt(game, 0, 0)).toBe(0)
    expect(levelAt(game, 1, 0)).toBe(0)
    expect(levelAt(game, 2, 0)).toBe(0)
  })
})

describe('Game: placing the next block directly (drag from the next slot)', () => {
  it('places the queued block on the board and rolls a replacement', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    expect(game.view().next).toBe(1)

    const events = game.placeFromNext(3, 4)

    expect(eventTypes(events)).toEqual(['placed'])
    expect(levelAt(game, 3, 4)).toBe(1)
    // A replacement was rolled immediately, mirroring the buffer flow.
    expect(game.view().next).toBe(1)
    expect(game.view().steps).toBe(1)
    // The tray is untouched by this path.
    expect(game.view().buffer).toEqual([0, 0, 0])
  })

  it('works when every buffer slot is already full', () => {
    // Regression: the old implementation staged the block through the buffer
    // first, so a full tray made dragging from "next" impossible.
    const game = makeGame({ mutateTuning: onlyLevelOne })

    expect(eventTypes(game.pullNextToBuffer(0))).toEqual(['toBuffer', 'spawned'])
    expect(eventTypes(game.pullNextToBuffer(1))).toEqual(['toBuffer', 'spawned'])
    expect(eventTypes(game.pullNextToBuffer(2))).toEqual(['toBuffer', 'spawned'])
    expect(game.view().buffer).toEqual([1, 1, 1])

    // Staging another block is refused...
    expect(game.pullNextToBuffer()).toEqual([{ type: 'invalid', reason: 'buffer-full' }])

    // ...but placing straight from "next" still works.
    const events = game.placeFromNext(0, 0)
    expect(eventTypes(events)).toEqual(['placed'])
    expect(levelAt(game, 0, 0)).toBe(1)
    expect(game.view().buffer).toEqual([1, 1, 1])
  })

  it('rejects an occupied cell and leaves the queued block alone', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)

    const events = game.placeFromNext(0, 0)
    expect(events).toEqual([{ type: 'invalid', reason: 'cell-occupied' }])
    // Still queued, and no step was consumed.
    expect(game.view().next).toBe(1)
    expect(game.view().steps).toBe(1)
  })

  it('rejects out-of-bounds coordinates', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    expect(game.placeFromNext(7, 0)).toEqual([{ type: 'invalid', reason: 'out-of-bounds' }])
    expect(game.placeFromNext(-1, 0)).toEqual([{ type: 'invalid', reason: 'out-of-bounds' }])
  })

  it('merges and scores exactly like a buffered placement', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    game.placeFromNext(0, 0)
    game.placeFromNext(1, 0)
    const events = game.placeFromNext(2, 0)

    expect(levelAt(game, 2, 0)).toBe(2)
    expect(game.view().score).toBe(3)
    expect(eventTypes(events)).toContain('merged')
  })

  it('is blocked while the win dialog is pending', () => {
    const game = makeGame({ modeId: 'endless', mutateTuning: onlyLevelOne })
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 0, level: 9 },
          { x: 1, y: 0, level: 9 }
        ],
        next: 9,
        maxReachedLevel: 9
      })
    )

    // Creating the 89-point block pauses the game on the win dialog.
    expect(eventTypes(game.placeFromNext(2, 0))).toContain('win')
    expect(game.view().pendingWin).not.toBeNull()

    expect(game.placeFromNext(4, 0)).toEqual([{ type: 'invalid', reason: 'win-pending' }])
  })

  it('can be undone in full, restoring the queued block', () => {
    const game = makeGame({ seed: 99 })
    const before = game.snapshot()

    game.placeFromNext(5, 5)
    expect(game.view().steps).toBe(1)

    game.undo()

    expect(game.snapshot()).toEqual(before)
    expect(game.view().steps).toBe(0)
  })
})

describe('Game: obstacles (obstacle mode)', () => {
  /**
   * Checkerboard cells (x+y even) are never orthogonally adjacent to each
   * other, so nothing can merge and every placement is a clean step.
   */
  const CANDIDATES: Array<[number, number]> = []
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 7; x++) {
      if ((x + y) % 2 === 0) CANDIDATES.push([x, y])
    }
  }

  /**
   * Places `count` blocks on the first still-free candidates.
   *
   * Obstacles drop into random empty cells, so a fixed script would eventually
   * be blocked by one; picking the first free candidate keeps the sequence
   * deterministic without pinning the RNG.
   */
  function placeTimes(game: Game, count: number): GameEvent[][] {
    const log: GameEvent[][] = []
    for (const [x, y] of CANDIDATES) {
      if (log.length >= count) break
      if (!game.canPlaceAt(x, y)) continue
      game.pullNextToBuffer()
      log.push(game.placeFromBuffer(0, x, y))
    }
    expect(log).toHaveLength(count)
    return log
  }

  it('spawns an obstacle every 3 steps', () => {
    const game = makeGame({ modeId: 'obstacle', mutateTuning: obstacleTuning })
    const log = placeTimes(game, 9)

    // Steps 1-2: none. Step 3: one. Then the pattern repeats.
    expect(eventTypes(log[0])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[1])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[2])).toContain('obstacleSpawned')
    expect(eventTypes(log[3])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[4])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[5])).toContain('obstacleSpawned')
    expect(eventTypes(log[6])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[7])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[8])).toContain('obstacleSpawned')

    expect(cellsOf(game).filter((c) => c === -1)).toHaveLength(3)
  })

  it('takes the schedule from the tuning data, not from the code', () => {
    const game = makeGame({
      modeId: 'obstacle',
      mutateTuning: (t) => {
        obstacleTuning(t)
        t.obstacles.spawnBands = [{ fromStep: 1, every: 2 }]
      }
    })
    const log = placeTimes(game, 4)

    expect(eventTypes(log[0])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[1])).toContain('obstacleSpawned')
    expect(eventTypes(log[2])).not.toContain('obstacleSpawned')
    expect(eventTypes(log[3])).toContain('obstacleSpawned')
    expect(cellsOf(game).filter((c) => c === -1)).toHaveLength(2)
  })

  it('never spawns obstacles in basic mode', () => {
    const game = makeGame({ modeId: 'basic', mutateTuning: onlyLevelOne })
    placeTimes(game, 9)

    expect(cellsOf(game).filter((c) => c === -1)).toHaveLength(0)
  })

  it('cracks an obstacle on the first hit and destroys it on the second', () => {
    const game = makeGame({
      modeId: 'obstacle',
      mutateTuning: onlyLevelOne,
      seed: 999
    })
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 0, level: 1 },
          { x: 1, y: 0, level: 1 }
        ],
        obstacles: [{ x: 2, y: 1 }],
        buffer: [1, 0, 0]
      })
    )

    // Hit 1: three level-1s become a level-2 at (2,0), which touches (2,1).
    const first = game.placeFromBuffer(0, 2, 0)
    expect(eventTypes(first)).toContain('obstacleHit')
    expect(eventTypes(first)).not.toContain('obstacleCleared')
    // Damage is visible in the board, not just in the event.
    expect(cellsOf(game).filter((c) => c === CELL_OBSTACLE_CRACKED)).toHaveLength(1)
    expect(game.view().score).toBe(3) // no bonus for chipping

    // Hit 2: another triple whose placement cell touches the same obstacle.
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 5, level: 1 },
          { x: 1, y: 5, level: 1 }
        ],
        crackedObstacles: [{ x: 2, y: 4 }],
        buffer: [1, 0, 0],
        score: game.view().score
      })
    )

    const second = game.placeFromBuffer(0, 2, 5)
    expect(eventTypes(second)).toContain('obstacleCleared')
    expect(cellsOf(game).filter((c) => c < 0)).toHaveLength(0)
    expect(game.view().score).toBe(3 + 3 + 1) // both merges + clear bonus
  })

  it('throws away a max-level clear to break obstacles in one hit', () => {
    const game = makeGame({ modeId: 'obstacle', mutateTuning: onlyLevelOne, seed: 7 })
    // Level-5 mode: three 5s are the max-level clear, which breaks outright.
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 0, level: 5 },
          { x: 1, y: 0, level: 5 }
        ],
        obstacles: [{ x: 2, y: 1 }],
        buffer: [5, 0, 0]
      })
    )

    const events = game.placeFromBuffer(0, 2, 0)

    expect(eventTypes(events)).toContain('maxCleared')
    expect(eventTypes(events)).toContain('obstacleCleared')
    expect(eventTypes(events)).not.toContain('obstacleHit')
    expect(cellsOf(game).filter((c) => c < 0)).toHaveLength(0)
  })

  it('never spawns a cracked obstacle', () => {
    // spawnObstacle always writes a pristine obstacle, so a board of only
    // cracked ones could never occur through play.
    const game = makeGame({ modeId: 'obstacle', mutateTuning: obstacleTuning, seed: 31 })
    placeTimes(game, 9)

    const cells = cellsOf(game)
    expect(cells.filter((c) => c === CELL_OBSTACLE).length).toBeGreaterThan(0)
    expect(cells.filter((c) => c === CELL_OBSTACLE_CRACKED)).toHaveLength(0)
  })
})

describe('Game: the obstacle opening pocket', () => {
  /** The 3x3 pocket the shipped config leaves open on a 7x10 board. */
  const POCKET = { x0: 2, y0: 3, x1: 4, y1: 5 }
  const inPocket = (x: number, y: number): boolean =>
    x >= POCKET.x0 && x <= POCKET.x1 && y >= POCKET.y0 && y <= POCKET.y1

  it('opens walled in, with only the middle 3x3 playable', () => {
    const view = makeGame({ modeId: 'obstacle' }).view()

    const obstacles: Array<[number, number]> = []
    const free: Array<[number, number]> = []
    for (let y = 0; y < view.height; y++) {
      for (let x = 0; x < view.width; x++) {
        const value = view.cells[y * view.width + x]
        if (value === CELL_OBSTACLE) obstacles.push([x, y])
        if (value === 0) free.push([x, y])
      }
    }

    expect(obstacles).toHaveLength(61)
    expect(free).toHaveLength(9)
    expect(free.every(([x, y]) => inPocket(x, y))).toBe(true)
    expect(view.steps).toBe(0)
    expect(view.gameOver).toBe(false)
    // There is room to play, so the run is not over on the first frame.
    expect(view.boardFull).toBe(false)
  })

  it('refuses placements outside the pocket and accepts them inside', () => {
    const game = makeGame({ modeId: 'obstacle', mutateTuning: onlyLevelOne })

    expect(game.canPlaceAt(0, 0)).toBe(false)
    expect(game.canPlaceAt(3, 2)).toBe(false)
    expect(game.canPlaceAt(5, 5)).toBe(false)
    expect(game.canPlaceAt(3, 3)).toBe(true)

    expect(game.placeFromNext(0, 0)).toEqual([{ type: 'invalid', reason: 'cell-occupied' }])
    expect(eventTypes(game.placeFromNext(3, 3))).toEqual(['placed'])
  })

  it('leaves the other modes alone', () => {
    expect(makeGame({ modeId: 'endless' }).view().cells.every((c) => c === 0)).toBe(true)
    expect(makeGame({ modeId: 'basic' }).view().cells.every((c) => c === 0)).toBe(true)
  })

  it('takes the pocket size from the tuning data', () => {
    const game = makeGame({
      modeId: 'obstacle',
      mutateTuning: (t) => {
        t.obstacles.startClear = { width: 1, height: 1 }
      }
    })
    const view = game.view()

    expect(view.cells.filter((c) => c === 0)).toHaveLength(1)
    // A single centred cell: floor((7-1)/2) = 3, floor((10-1)/2) = 4.
    expect(game.canPlaceAt(3, 4)).toBe(true)
    expect(game.canPlaceAt(3, 3)).toBe(false)
  })

  it('rebuilds the pocket on restart', () => {
    // Regression guard: restart builds a brand new Board, so an opening that
    // lived only in the constructor would silently hand the player an empty
    // board — a far easier game than the one they just lost.
    const game = makeGame({ modeId: 'obstacle' })
    game.restart(1234)

    const view = game.view()
    expect(view.cells.filter((c) => c === CELL_OBSTACLE)).toHaveLength(61)
    expect(view.cells.filter((c) => c === 0)).toHaveLength(9)
    expect(view.gameOver).toBe(false)
  })

  it('is restored by undo, pocket and all', () => {
    const game = makeGame({ modeId: 'obstacle', mutateTuning: onlyLevelOne })
    const before = game.snapshot()

    game.placeFromNext(3, 3)
    expect(game.view().steps).toBe(1)

    game.undo()

    expect(game.snapshot()).toEqual(before)
    expect(game.view().cells.filter((c) => c === CELL_OBSTACLE)).toHaveLength(61)
  })

  it('opens a way out: breaking the wall makes the freed cell playable', () => {
    // Without this the pocket would be a dead end — the whole point of the
    // opening is that merges along its edge drill outwards.
    const game = makeGame({ modeId: 'obstacle', mutateTuning: obstacleTuning })

    const obstacles: Array<{ x: number; y: number }> = []
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 7; x++) {
        if (!inPocket(x, y) && !(x === 3 && y === 2)) obstacles.push({ x, y })
      }
    }

    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 2, y: 3, level: 1 },
          { x: 3, y: 3, level: 1 }
        ],
        obstacles,
        // The wall cell above the pocket's middle column, one hit from gone.
        crackedObstacles: [{ x: 3, y: 2 }],
        buffer: [1, 0, 0]
      })
    )

    expect(game.canPlaceAt(3, 2)).toBe(false)

    // Completing a level-1 row along the pocket's top edge blasts the wall.
    const events = game.placeFromBuffer(0, 4, 3)

    expect(eventTypes(events)).toContain('merged')
    expect(eventTypes(events)).toContain('obstacleCleared')
    expect(levelAt(game, 4, 3)).toBe(2)
    // The freed cell is now part of the playable area.
    expect(game.canPlaceAt(3, 2)).toBe(true)
    // ...and the rest of the wall only cracked, so it still blocks.
    expect(game.canPlaceAt(2, 2)).toBe(false)
  })

  it('ends the run when the pocket itself fills up', () => {
    // This is the hazard the pocket creates: obstacles and blocks share the
    // same nine cells, so a player who never merges is squeezed out rather than
    // ground down over the rest of the board.
    const game = makeGame({ modeId: 'obstacle' })

    const obstacles: Array<{ x: number; y: number }> = []
    const blocks: Array<{ x: number; y: number; level: number }> = []
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 7; x++) {
        if (!inPocket(x, y)) {
          obstacles.push({ x, y })
          continue
        }
        // Checkerboarded levels inside the pocket: no two orthogonally adjacent
        // cells share a level, so no group of three can form.
        if (x === 4 && y === 5) continue // the one cell left for the player
        blocks.push({ x, y, level: (x + y) % 2 === 0 ? 1 : 2 })
      }
    }

    game.restore(craft(7, 10, { blocks, obstacles, next: 2 }))
    // Level 2, matching neither of its two neighbours, so the placement itself
    // is a clean step and the only thing left to resolve is the full board.
    const events = game.placeFromNext(4, 5)

    expect(eventTypes(events)).toEqual(['placed', 'gameOver'])
    expect(game.view().boardFull).toBe(true)
    expect(game.pullNextToBuffer()).toEqual([{ type: 'invalid', reason: 'game-over' }])
  })
})

describe('Game: game over', () => {
  it('ends the run once no empty cell is left, and blocks further input', () => {
    const game = makeGame({
      modeId: 'endless',
      mutateTuning: (t) => {
        t.board.width = 3
        t.board.height = 3
        t.buffer.slots = 1
      }
    })

    // Eight cells filled with distinct levels so nothing can merge.
    game.restore(
      craft(3, 3, {
        blocks: [
          { x: 0, y: 0, level: 1 },
          { x: 1, y: 0, level: 2 },
          { x: 2, y: 0, level: 1 },
          { x: 0, y: 1, level: 2 },
          { x: 1, y: 1, level: 1 },
          { x: 2, y: 1, level: 2 },
          { x: 0, y: 2, level: 1 },
          { x: 1, y: 2, level: 2 }
        ],
        buffer: [3],
        next: 4
      })
    )

    const events = game.placeFromBuffer(0, 2, 2)

    expect(eventTypes(events)).toContain('gameOver')
    const view = game.view()
    expect(view.gameOver).toBe(true)
    expect(view.boardFull).toBe(true)

    expect(game.pullNextToBuffer()).toEqual([{ type: 'invalid', reason: 'game-over' }])
    expect(game.placeFromBuffer(0, 0, 0)).toEqual([{ type: 'invalid', reason: 'game-over' }])
  })
})

describe('Game: endless win', () => {
  function nearlyWon(): ReturnType<typeof makeGame> {
    const game = makeGame({ modeId: 'endless', mutateTuning: onlyLevelOne })
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 0, level: 9 },
          { x: 1, y: 0, level: 9 }
        ],
        buffer: [9, 0, 0],
        next: 1,
        maxReachedLevel: 9
      })
    )
    return game
  }

  it('reports a win when the 89-point block is created', () => {
    const game = nearlyWon()

    const events = game.placeFromBuffer(0, 2, 0)

    expect(eventTypes(events)).toContain('win')
    const view = game.view()
    expect(view.hasWon).toBe(true)
    expect(view.pendingWin).not.toBeNull()
    expect(view.pendingWin?.level).toBe(10)
    expect(levelAt(game, 2, 0)).toBe(10)
  })

  it('blocks input until the player answers the win dialog', () => {
    const game = nearlyWon()
    game.placeFromBuffer(0, 2, 0)

    expect(game.pullNextToBuffer()).toEqual([{ type: 'invalid', reason: 'win-pending' }])
    expect(game.placeFromBuffer(0, 0, 5)).toEqual([{ type: 'invalid', reason: 'win-pending' }])
  })

  it('resumes play without re-triggering the win on a later 89 merge', () => {
    const game = nearlyWon()
    game.placeFromBuffer(0, 2, 0)

    game.continueAfterWin()
    expect(game.view().pendingWin).toBeNull()
    expect(game.view().hasWon).toBe(true)

    // A second max-level cluster must clear, not win again.
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 1, level: 10 },
          { x: 1, y: 1, level: 10 }
        ],
        buffer: [10, 0, 0],
        next: 1,
        hasWon: true,
        maxReachedLevel: 10
      })
    )

    const events = game.placeFromBuffer(0, 2, 1)
    expect(eventTypes(events)).not.toContain('win')
    expect(eventTypes(events)).toContain('maxCleared')
    expect(game.view().score).toBe(3 * 89)
  })

  it('can end the run from the win dialog', () => {
    const game = nearlyWon()
    game.placeFromBuffer(0, 2, 0)

    const events = game.endAfterWin()
    expect(eventTypes(events)).toEqual(['gameOver'])
    expect(game.view().gameOver).toBe(true)
  })
})

describe('Game: restart', () => {
  it('clears the board, the score and the undo history', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    for (const x of [0, 1, 2]) {
      game.pullNextToBuffer()
      game.placeFromBuffer(0, x, 0)
    }
    expect(game.view().score).toBe(3)
    expect(game.canUndo()).toBe(true)

    const events = game.restart(777)

    expect(eventTypes(events)).toEqual(['restarted'])
    const view = game.view()
    expect(view.score).toBe(0)
    expect(view.steps).toBe(0)
    expect(view.cells.every((c) => c === 0)).toBe(true)
    expect(view.buffer).toEqual([0, 0, 0])
    expect(view.next).toBe(1)
    expect(view.maxReachedLevel).toBe(1)
    expect(view.hasWon).toBe(false)
    expect(view.gameOver).toBe(false)
    expect(view.canUndo).toBe(false)
  })
})
