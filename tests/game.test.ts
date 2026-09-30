import { describe, expect, it } from 'vitest'
import type { Game } from '../src/core/game'
import type { GameEvent } from '../src/core/types'
import { cellsOf, craft, levelAt, makeGame, onlyLevelOne } from './helpers'

function eventTypes(events: readonly GameEvent[]): string[] {
  return events.map((e) => e.type)
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
    const game = makeGame({ modeId: 'obstacle', mutateTuning: onlyLevelOne })
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

  it('takes the interval from the tuning data, not from the code', () => {
    const game = makeGame({
      modeId: 'obstacle',
      mutateTuning: (t) => {
        onlyLevelOne(t)
        t.obstacles.spawnEverySteps = 2
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

  it('clears an obstacle hit by a merge and awards the bonus', () => {
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

    const events = game.placeFromBuffer(0, 2, 0)

    expect(eventTypes(events)).toContain('obstacleCleared')
    expect(cellsOf(game).filter((c) => c === -1)).toHaveLength(0)
    expect(game.view().score).toBe(3 + 1) // merge + clear bonus
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
