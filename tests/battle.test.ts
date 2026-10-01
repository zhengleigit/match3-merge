import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board'
import {
  advanceBoss,
  applyDamage,
  boardIsCleared,
  drainActionBar,
  isSealedCell,
  mergeDamage,
  seedArena
} from '../src/core/battle'
import { Rng } from '../src/core/rng'
import { CELL_EMPTY, type BattleConfig, type PacManState } from '../src/core/types'
import { loadTuning } from '../src/core/data'

/**
 * Battle mode: the arena layout and the boss's behaviour.
 *
 * These are the rules the whole mode rests on, so they are pinned here rather
 * than only being exercised through the UI. The numbers come from the real
 * tuning file, so a change to `tuning.json` that breaks an assumption fails
 * here instead of silently changing how the mode plays.
 */

const tuning = loadTuning()
const CONFIG: BattleConfig = tuning.battle
const SCORES = [1, 2, 3, 5, 8]
const scoreOf = (level: number): number => SCORES[Math.min(level, SCORES.length) - 1] ?? 0

function arena(seed = 1234): { board: Board; boss: PacManState; rng: Rng } {
  const board = new Board(tuning.board.width, tuning.board.height)
  const rng = new Rng(seed)
  const boss = seedArena(board, CONFIG, (n) => rng.int(n))
  return { board, boss, rng }
}

/** Cage cells (above the wall) that currently hold a block. */
function cageFood(board: Board): number {
  let n = 0
  for (let y = 0; y < CONFIG.wallRow; y++) {
    for (let x = 0; x < board.width; x++) {
      if (board.get(x, y) > CELL_EMPTY) n++
    }
  }
  return n
}

describe('battle: arena seeding', () => {
  it('builds the wall on the configured row, with exactly one gap', () => {
    const { board } = arena()

    for (let x = 0; x < board.width; x++) {
      if (x === CONFIG.gapX) {
        expect(board.get(x, CONFIG.wallRow)).toBe(CELL_EMPTY)
      } else {
        expect(board.isWall(x, CONFIG.wallRow)).toBe(true)
      }
    }
  })

  it('never treats the wall as a damageable obstacle', () => {
    // A wall must survive the obstacle damage path untouched; this is why it is
    // a separate cell value rather than an obstacle with a large hit count.
    const { board } = arena()
    expect(board.countObstacles()).toBe(0)
    expect(board.isWall(CONFIG.gapX === 0 ? 1 : 0, CONFIG.wallRow)).toBe(true)
  })

  it('stocks the cage with the configured number of blocks', () => {
    const { board } = arena()
    expect(cageFood(board)).toBe(CONFIG.cageBlockCount)

    for (let y = 0; y < CONFIG.wallRow; y++) {
      for (let x = 0; x < board.width; x++) {
        const value = board.get(x, y)
        if (value > CELL_EMPTY) expect(value).toBe(CONFIG.cageBlockLevel)
      }
    }
  })

  it('leaves the playable field empty at the start', () => {
    // The opening board must be playable, not already lost. A "no blocks left"
    // check that also counted the cage would fail on the first frame.
    const { board } = arena()
    expect(board.countBlocksInRows(CONFIG.wallRow + 1, board.height - 1)).toBe(0)
    expect(board.hasFreeCellInRows(CONFIG.wallRow + 1, board.height - 1)).toBe(true)
  })

  it('keeps the boss start cell free of food, so it is not eaten at once', () => {
    const { board } = arena()
    expect(board.get(CONFIG.start.x, CONFIG.start.y)).toBe(CELL_EMPTY)
  })

  it('starts the boss at its configured cell with the starting hp and an empty bar', () => {
    const { boss } = arena()
    expect({ x: boss.x, y: boss.y }).toEqual(CONFIG.start)
    expect(boss.hp).toBe(CONFIG.startHp)
    expect(boss.bar).toBe(0)
    expect(boss.phase).toBe('cage')
  })

  it('is reproducible for the same seed and differs across seeds', () => {
    // The layout must come from the run's RNG, never Math.random: an undo has to
    // restore the same arena.
    const a = arena(777)
    const b = arena(777)
    expect(a.board.toArray()).toEqual(b.board.toArray())

    const layouts = new Set<string>()
    for (let seed = 1; seed <= 12; seed++) {
      layouts.add(arena(seed).board.toArray().join(','))
    }
    expect(layouts.size).toBeGreaterThan(1)
  })
})

describe('battle: sealed zones', () => {
  it('seals the cage, the wall and the gap, and nothing below', () => {
    expect(isSealedCell(CONFIG, 0)).toBe(true)
    expect(isSealedCell(CONFIG, CONFIG.wallRow)).toBe(true)
    expect(isSealedCell(CONFIG, CONFIG.wallRow + 1)).toBe(false)
    expect(isSealedCell(CONFIG, tuning.board.height - 1)).toBe(false)
  })
})

describe('battle: the action bar', () => {
  it('fills by the configured amount per placement', () => {
    const { board, boss, rng } = arena()
    const score = scoreOf

    const first = advanceBoss(board, CONFIG, boss, score, (n) => rng.int(n))
    expect(boss.bar).toBeCloseTo(CONFIG.actionPerPlacement, 6)
    expect(first.events).toHaveLength(0)

    const second = advanceBoss(board, CONFIG, boss, score, (n) => rng.int(n))
    expect(second.events).toHaveLength(1)
    // Acting empties the bar, and a full bar never banks a second action.
    expect(boss.bar).toBe(0)
  })

  it('takes exactly two placements per action at the shipped rate', () => {
    expect(CONFIG.actionPerPlacement).toBe(0.5)
  })

  it('never overflows past one, so an action can never be stored up', () => {
    const { board, boss, rng } = arena()
    for (let i = 0; i < 3; i++) advanceBoss(board, CONFIG, boss, scoreOf, (n) => rng.int(n))
    expect(boss.bar).toBeGreaterThanOrEqual(0)
    expect(boss.bar).toBeLessThanOrEqual(1)
  })
})

describe('battle: eating in the cage', () => {
  it('eats a cage block, gains its score as hp, and moves onto it', () => {
    const { board, boss, rng } = arena()
    boss.bar = 1

    const before = cageFood(board)
    const result = advanceBoss(board, CONFIG, boss, scoreOf, (n) => rng.int(n))
    const ate = result.events[0]

    expect(ate.type).toBe('pacmanAte')
    if (ate.type !== 'pacmanAte') return

    expect(ate.fromCage).toBe(true)
    expect(ate.level).toBe(CONFIG.cageBlockLevel)
    // hp gained is the block's score value, not a flat number.
    expect(ate.heal).toBe(Math.round(scoreOf(CONFIG.cageBlockLevel) * CONFIG.healPerScore))
    expect(boss.hp).toBe(CONFIG.startHp + ate.heal)
    expect(boss.maxHp).toBe(boss.hp)
    expect(cageFood(board)).toBe(before - 1)
    // It stands where the food was.
    expect({ x: boss.x, y: boss.y }).toEqual({ x: ate.x, y: ate.y })
    expect(board.get(ate.x, ate.y)).toBe(CELL_EMPTY)
  })

  it('empties the cage and heads for the gap on the last bite', () => {
    const { board, boss, rng } = arena()
    for (let i = 0; i < CONFIG.cageBlockCount; i++) {
      boss.bar = 1
      advanceBoss(board, CONFIG, boss, scoreOf, (n) => rng.int(n))
    }

    expect(cageFood(board)).toBe(0)
    expect(boss.phase).toBe('exit')
    // 8 blocks, each healing its own score value (a level-5 block scores 8),
    // on top of the starting hp.
    const perBlock = Math.round(scoreOf(CONFIG.cageBlockLevel) * CONFIG.healPerScore)
    expect(boss.hp).toBe(CONFIG.startHp + CONFIG.cageBlockCount * perBlock)
  })

  it('walks to the gap and then out onto the board', () => {
    const { board, boss, rng } = arena()
    for (let i = 0; i < CONFIG.cageBlockCount; i++) {
      boss.bar = 1
      advanceBoss(board, CONFIG, boss, scoreOf, (n) => rng.int(n))
    }

    boss.bar = 1
    const exit = advanceBoss(board, CONFIG, boss, scoreOf, (n) => rng.int(n))
    expect(exit.events[0].type).toBe('pacmanExited')
    expect(boss.phase).toBe('board')
    expect(boss.x).toBe(CONFIG.gapX)
    expect(boss.y).toBe(CONFIG.wallRow)
  })
})

describe('battle: eating on the board', () => {
  /** Puts the boss outside the cage with a stocked playable field. */
  function loose(): { board: Board; boss: PacManState; rng: Rng } {
    const { board, boss, rng } = arena()
    boss.phase = 'board'
    boss.x = CONFIG.gapX
    boss.y = CONFIG.wallRow
    const row = CONFIG.wallRow + 1
    board.set(0, row, 1)
    board.set(1, row, 3)
    return { board, boss, rng }
  }

  it('eats a board block and heals by its value', () => {
    const { board, boss, rng } = loose()
    const before = board.countBlocksInRows(CONFIG.wallRow + 1, board.height - 1)
    boss.bar = 1

    const result = advanceBoss(board, CONFIG, boss, scoreOf, (n) => rng.int(n))
    const ate = result.events[0]
    expect(ate.type).toBe('pacmanAte')
    if (ate.type !== 'pacmanAte') return

    expect(ate.fromCage).toBe(false)
    expect(board.countBlocksInRows(CONFIG.wallRow + 1, board.height - 1)).toBe(before - 1)
    // The eaten block's own value decides the heal (level 1 -> +1, level 3 -> +3).
    expect([1, 3]).toContain(ate.level)
    expect(ate.heal).toBe(scoreOf(ate.level))
  })

  it('reports the board as cleared once the playable field is empty', () => {
    const { board, boss } = loose()
    expect(boardIsCleared(board, CONFIG)).toBe(false)
    board.set(0, CONFIG.wallRow + 1, CELL_EMPTY)
    board.set(1, CONFIG.wallRow + 1, CELL_EMPTY)
    expect(boardIsCleared(board, CONFIG)).toBe(true)
    // Losing happens while the field still has somewhere to build, so "cleared"
    // and "full" are genuinely different conditions.
    expect(board.hasFreeCellInRows(CONFIG.wallRow + 1, board.height - 1)).toBe(true)
    expect(boss.phase).toBe('board')
  })

  it('does not count cage blocks as board food', () => {
    // A fresh arena is full of cage blocks but the playable field is empty, so
    // it must already read as "cleared" once the boss is loose.
    const { board, boss } = arena()
    expect(cageFood(board)).toBeGreaterThan(0)
    boss.phase = 'board'
    expect(boardIsCleared(board, CONFIG)).toBe(true)
  })
})

describe('battle: merge damage', () => {
  it('ignores merges that consume nothing above the threshold level', () => {
    // 1s and 2s are below damageFromLevel: they must not chip the boss, or the
    // player would whittle it down with trivial merges.
    expect(mergeDamage(CONFIG, 1, 3, scoreOf).dealt).toBe(false)
    expect(mergeDamage(CONFIG, 2, 3, scoreOf).dealt).toBe(false)
    expect(CONFIG.damageFromLevel).toBe(3)
  })

  it('deals the consumed score as damage', () => {
    // Three level-3 blocks consumed -> 3 x 3 = 9 points of damage.
    const three = mergeDamage(CONFIG, 3, 3, scoreOf)
    expect(three.dealt).toBe(true)
    expect(three.amount).toBe(9)

    // A 5-level clear is the heaviest single blow: 3 x 8 = 24.
    const clear = mergeDamage(CONFIG, 5, 3, scoreOf)
    expect(clear.amount).toBe(24)
  })

  it('scales with how many blocks were consumed', () => {
    const three = mergeDamage(CONFIG, 4, 3, scoreOf).amount
    const five = mergeDamage(CONFIG, 4, 5, scoreOf).amount
    expect(five).toBeGreaterThan(three)
  })

  it('never turns the flat max-level bonus into damage', () => {
    // The +50 bonus is paid in score but is deliberately excluded here; folding
    // it in would let a single 5-level clear delete a full-health boss.
    const amount = mergeDamage(CONFIG, 5, 3, scoreOf).amount
    expect(amount).toBe(24)
    expect(amount).toBeLessThan(1 + CONFIG.cageBlockCount * CONFIG.cageBlockLevel)
  })
})

describe('battle: action bar drain', () => {
  it('does nothing while the boss is still in the cage', () => {
    // Draining during the cage phase would let the player stall the opening.
    const { boss } = arena()
    boss.bar = 0.8
    drainActionBar(CONFIG, boss)
    expect(boss.bar).toBe(0.8)
  })

  it('removes the configured fraction once the boss is out', () => {
    const { boss } = arena()
    boss.phase = 'board'
    boss.bar = 0.9
    drainActionBar(CONFIG, boss)
    expect(boss.bar).toBeCloseTo(0.4, 6)
  })

  it('never goes below zero', () => {
    const { boss } = arena()
    boss.phase = 'board'
    boss.bar = 0.1
    drainActionBar(CONFIG, boss)
    drainActionBar(CONFIG, boss)
    expect(boss.bar).toBe(0)
  })
})

describe('battle: defeat', () => {
  it('reports lethal damage at and below zero hp', () => {
    const { boss } = arena()
    expect(applyDamage(boss, boss.hp - 1)).toBe(false)
    expect(boss.hp).toBe(1)
    expect(applyDamage(boss, 1)).toBe(true)
    expect(boss.hp).toBe(0)
    expect(applyDamage(boss, 5)).toBe(true)
    expect(boss.hp).toBeLessThan(0)
  })
})
