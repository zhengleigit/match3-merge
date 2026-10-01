import { describe, expect, it } from 'vitest'
import type { Game } from '../src/core/game'
import { History, cloneSnapshot } from '../src/core/history'
import type { GameSnapshot } from '../src/core/types'
import { craft, makeGame, onlyLevelOne, openBoard } from './helpers'

/** Deterministic move script: pull a block, then place it. */
const SCRIPT: Array<[number, number]> = [
  [0, 0],
  [2, 0],
  [4, 0],
  [1, 1],
  [3, 1],
  [0, 2],
  [2, 2],
  [5, 3],
  [1, 4],
  [6, 5],
  [3, 6],
  [2, 7]
]

function playScript(game: Game, count = SCRIPT.length): void {
  for (let i = 0; i < count; i++) {
    const [x, y] = SCRIPT[i]
    game.pullNextToBuffer()
    game.placeFromBuffer(0, x, y)
  }
}

function undoAll(game: Game): number {
  let count = 0
  while (game.canUndo()) {
    game.undo()
    count++
  }
  return count
}

describe('History stack', () => {
  const snap = (score: number): GameSnapshot => ({
    cells: [0, 0, 0, 0],
    buffer: [0, 0, 0],
    next: 1,
    score,
    steps: score,
    maxReachedLevel: 1,
    hasWon: false,
    gameOver: false,
    pendingWin: null,
    pacman: null,
    rngState: 1
  })

  it('reports empty, pops in LIFO order and clears', () => {
    const history = new History(10)
    expect(history.canUndo()).toBe(false)
    expect(history.pop()).toBeNull()

    history.push(snap(1))
    history.push(snap(2))
    history.push(snap(3))
    expect(history.size()).toBe(3)

    expect(history.pop()?.score).toBe(3)
    expect(history.pop()?.score).toBe(2)
    expect(history.peek()?.score).toBe(1)

    history.clear()
    expect(history.canUndo()).toBe(false)
  })

  it('trims the oldest entries once the limit is reached', () => {
    const history = new History(3)
    for (let i = 1; i <= 6; i++) history.push(snap(i))

    expect(history.size()).toBe(3)
    // Only the three most recent snapshots survive.
    expect(history.pop()?.score).toBe(6)
    expect(history.pop()?.score).toBe(5)
    expect(history.pop()?.score).toBe(4)
    expect(history.pop()).toBeNull()
  })

  it('clones without sharing array references', () => {
    const original = snap(5)
    const copy = cloneSnapshot(original)

    copy.cells[0] = 9
    copy.buffer[0] = 9

    expect(original.cells[0]).toBe(0)
    expect(original.buffer[0]).toBe(0)
    expect(copy).toEqual({ ...original, cells: [9, 0, 0, 0], buffer: [9, 0, 0] })
  })
})

describe('undo: round-trip fidelity', () => {
  it('has nothing to undo at the start', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    expect(game.canUndo()).toBe(false)
    expect(game.undo()).toEqual([{ type: 'invalid', reason: 'no-history' }])
  })

  it('restores the exact pre-action state for every move in a script', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    for (let i = 0; i < SCRIPT.length; i++) {
      const [x, y] = SCRIPT[i]
      const beforeMove = game.snapshot()

      game.pullNextToBuffer()
      const afterPull = game.snapshot()

      game.placeFromBuffer(0, x, y)

      // One snapshot per action: undo twice to get back to the start of the move.
      expect(game.undo()).toEqual([{ type: 'undo' }])
      expect(game.snapshot()).toEqual(afterPull)

      expect(game.undo()).toEqual([{ type: 'undo' }])
      expect(game.snapshot()).toEqual(beforeMove)

      // Re-apply so the next iteration starts from the same kind of state.
      game.pullNextToBuffer()
      game.placeFromBuffer(0, x, y)
    }
  })

  it('rewinds a placement in full: board, score, steps and buffer', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })

    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 1, 0)
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 2, 0) // completes the triple

    expect(game.view().score).toBe(3)
    expect(game.view().steps).toBe(3)

    game.undo()

    const view = game.view()
    expect(view.score).toBe(0)
    expect(view.steps).toBe(2)
    expect(view.cells[0]).toBe(1)
    expect(view.cells[1]).toBe(1)
    expect(view.cells[2]).toBe(0) // the placed block was rolled back
    expect(view.maxReachedLevel).toBe(1)
  })

  it('rewinds a whole chain, not individual merge steps', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    game.restore(
      craft(7, 10, {
        blocks: [
          { x: 0, y: 2, level: 1 },
          { x: 1, y: 2, level: 1 },
          { x: 2, y: 1, level: 2 },
          { x: 2, y: 3, level: 2 }
        ],
        buffer: [1, 0, 0]
      })
    )
    const before = game.snapshot()

    const events = game.placeFromBuffer(0, 2, 2)
    // level-1 triple then a level-2 triple: two merges in one turn.
    expect(events.filter((e) => e.type === 'merged')).toHaveLength(2)
    expect(game.view().score).toBe(9)

    game.undo()

    expect(game.snapshot()).toEqual(before)
    expect(game.view().score).toBe(0)
  })
})

describe('undo: RNG rollback (no rerolling the next block)', () => {
  it('yields the same next block when the same move is replayed', () => {
    const game = makeGame({ seed: 20260930 })
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)

    const nextAfterFirst = game.view().next

    game.undo()
    game.pullNextToBuffer()
    game.placeFromBuffer(0, 0, 0)

    expect(game.view().next).toBe(nextAfterFirst)
  })

  it('restores the queued block when a buffer move is undone', () => {
    const game = makeGame({ seed: 4242 })
    const originalNext = game.view().next

    game.pullNextToBuffer()
    game.undo()

    expect(game.view().next).toBe(originalNext)
    expect(game.view().buffer).toEqual([0, 0, 0])
  })

  it('keeps undo from being used to fish for a better board', () => {
    const game = makeGame({ seed: 777 })

    // Roll twenty future blocks through the buffer, remembering the sequence.
    const sequence: number[] = []
    for (let i = 0; i < 20; i++) {
      sequence.push(game.view().next)
      game.pullNextToBuffer()
      game.placeFromBuffer(0, i % 7, Math.floor(i / 7))
    }

    undoAll(game)

    const replayed: number[] = []
    for (let i = 0; i < 20; i++) {
      replayed.push(game.view().next)
      game.pullNextToBuffer()
      game.placeFromBuffer(0, i % 7, Math.floor(i / 7))
    }

    expect(replayed).toEqual(sequence)
  })
})

describe('undo: interactions with the rest of the game', () => {
  it('removes an obstacle that the undone placement had spawned', () => {
    const game = makeGame({
      modeId: 'obstacle',
      seed: 5,
      mutateTuning: (t) => {
        onlyLevelOne(t)
        openBoard(t)
      }
    })

    // Checkerboard cells (x+y even) are never orthogonally adjacent to each
    // other, so nothing can merge and every placement is a clean step.
    const candidates: Array<[number, number]> = []
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 7; x++) {
        if ((x + y) % 2 === 0) candidates.push([x, y])
      }
    }

    // Obstacles spawn into random empty cells, so pick the first still-free
    // candidate each time instead of a fixed script that could get blocked.
    const place = (): void => {
      for (const [x, y] of candidates) {
        if (!game.canPlaceAt(x, y)) continue
        game.pullNextToBuffer()
        game.placeFromBuffer(0, x, y)
        return
      }
      throw new Error('no free candidate cell left')
    }

    // The obstacle interval is 3 steps, so the third placement spawns one.
    place()
    place()
    expect(game.view().cells.filter((c) => c === -1)).toHaveLength(0)
    place()

    expect(game.view().steps).toBe(3)
    expect(game.view().cells.filter((c) => c === -1)).toHaveLength(1)

    game.undo()

    expect(game.view().steps).toBe(2)
    expect(game.view().cells.filter((c) => c === -1)).toHaveLength(0)
  })

  it('revives the run when the losing placement is undone', () => {
    const game = makeGame({
      modeId: 'endless',
      mutateTuning: (t) => {
        t.board.width = 3
        t.board.height = 3
        t.buffer.slots = 1
      }
    })
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

    game.placeFromBuffer(0, 2, 2)
    expect(game.view().gameOver).toBe(true)

    game.undo()

    const view = game.view()
    expect(view.gameOver).toBe(false)
    expect(view.boardFull).toBe(false)
    expect(view.cells[2 * 3 + 2]).toBe(0)
  })

  it('drops the whole history on restart', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne })
    playScript(game)
    expect(game.canUndo()).toBe(true)

    game.restart(1)

    expect(game.canUndo()).toBe(false)
    expect(game.undo()).toEqual([{ type: 'invalid', reason: 'no-history' }])
  })

  it('caps how far back the player can rewind', () => {
    const game = makeGame({
      mutateTuning: (t) => {
        onlyLevelOne(t)
        t.history.limit = 3
      }
    })

    playScript(game)
    expect(game.canUndo()).toBe(true)

    const undone = undoAll(game)
    expect(undone).toBe(3)
    // The last three snapshots were [place10, pull11, place11], so rewinding
    // them lands just after pull10: ten placements are still on the board.
    expect(game.view().steps).toBe(10)
  })

  it('replays an identical run after undoing everything', () => {
    const game = makeGame({ mutateTuning: onlyLevelOne, seed: 31 })

    playScript(game)
    const firstRun = game.snapshot()

    const undone = undoAll(game)
    expect(undone).toBe(SCRIPT.length * 2) // one snapshot per pull and per place

    playScript(game)
    const secondRun = game.snapshot()

    expect(secondRun).toEqual(firstRun)
  })
})
