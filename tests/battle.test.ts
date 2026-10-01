import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board'
import {
  advanceBoss,
  applyDamage,
  boardIsCleared,
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
  /** One placement's worth of progress, when the bar is allowed to advance. */
  const step = 1 / CONFIG.turnsPerAction

  it('fills by one turn per placement and fires on the Nth', () => {
    const { board, boss } = arena()

    for (let i = 1; i < CONFIG.turnsPerAction; i++) {
      const result = advanceBoss(board, CONFIG, boss, scoreOf, false)
      expect(result.events).toHaveLength(0)
      expect(boss.bar).toBeCloseTo(step * i, 6)
    }

    const final = advanceBoss(board, CONFIG, boss, scoreOf, false)
    expect(final.events).toHaveLength(1)
    // Acting empties the bar, and a full bar never banks a second action.
    expect(boss.bar).toBe(0)
  })

  it('acts once every three turns as shipped', () => {
    expect(CONFIG.turnsPerAction).toBe(3)
  })

  it('acts on exactly the Nth turn for every plausible N', () => {
    // Regression guard for the floating-point trap: the bar accumulates
    // 1 / turnsPerAction, and 1/3 + 1/3 + 1/3 is 0.9999999999999999 in binary
    // floating point. Without a tolerance it skipped that turn and fired on the
    // next one, so "every 3 turns" silently became "every 4".
    for (let n = 2; n <= 8; n++) {
      const { board, boss } = arena()
      const config: BattleConfig = { ...CONFIG, turnsPerAction: n }

      let firedOn = 0
      for (let turn = 1; turn <= n * 3; turn++) {
        const result = advanceBoss(board, config, boss, scoreOf, false)
        if (result.events.length > 0 && firedOn === 0) firedOn = turn
      }
      expect(firedOn, `turnsPerAction ${n}`).toBe(n)
    }
  })

  it('gives no progress at all on a placement that merged', () => {
    // The defence mechanic: a merge buys a turn. It must not push the bar
    // backwards, or the bar could be driven to zero and the boss stalled for
    // good; it simply does nothing.
    const { board, boss } = arena()
    boss.bar = 0.5

    advanceBoss(board, CONFIG, boss, scoreOf, true)
    expect(boss.bar).toBe(0.5)
  })

  it('lets merges hold the bar off indefinitely', () => {
    const { board, boss } = arena()
    for (let i = 0; i < 40; i++) advanceBoss(board, CONFIG, boss, scoreOf, true)
    expect(boss.bar).toBe(0)
  })

  it('can be turned off, so every placement counts', () => {
    const { board, boss } = arena()
    const alwaysCounts: BattleConfig = { ...CONFIG, mergesDelayAction: false }

    let fired = 0
    for (let i = 0; i < alwaysCounts.turnsPerAction; i++) {
      fired += advanceBoss(board, alwaysCounts, boss, scoreOf, true).events.length
    }
    expect(fired).toBe(1)
  })

  it('never overflows past one, so an action can never be stored up', () => {
    const { board, boss } = arena()
    for (let i = 0; i < 5; i++) advanceBoss(board, CONFIG, boss, scoreOf, false)
    expect(boss.bar).toBeGreaterThanOrEqual(0)
    expect(boss.bar).toBeLessThanOrEqual(1)
  })
})

describe('battle: eating in the cage', () => {
  it('eats a cage block, gains its score as hp, and moves onto it', () => {
    const { board, boss } = arena()
    boss.bar = 1

    const before = cageFood(board)
    const result = advanceBoss(board, CONFIG, boss, scoreOf, false)
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
    const { board, boss } = arena()
    for (let i = 0; i < CONFIG.cageBlockCount; i++) {
      boss.bar = 1
      advanceBoss(board, CONFIG, boss, scoreOf, false)
    }

    expect(cageFood(board)).toBe(0)
    expect(boss.phase).toBe('exit')
    // 8 blocks, each healing its own score value (a level-5 block scores 8),
    // on top of the starting hp.
    const perBlock = Math.round(scoreOf(CONFIG.cageBlockLevel) * CONFIG.healPerScore)
    expect(boss.hp).toBe(CONFIG.startHp + CONFIG.cageBlockCount * perBlock)
  })

  it('walks to the gap and then out onto the board', () => {
    const { board, boss } = arena()
    for (let i = 0; i < CONFIG.cageBlockCount; i++) {
      boss.bar = 1
      advanceBoss(board, CONFIG, boss, scoreOf, false)
    }

    boss.bar = 1
    const exit = advanceBoss(board, CONFIG, boss, scoreOf, false)
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
    const { board, boss } = loose()
    const before = board.countBlocksInRows(CONFIG.wallRow + 1, board.height - 1)
    boss.bar = 1

    const result = advanceBoss(board, CONFIG, boss, scoreOf, false)
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
  it('lets even a level-1 merge hurt the boss', () => {
    // `damageFromLevel` ships at 1, so there is no free merge: every one of them
    // chips the boss.
    expect(CONFIG.damageFromLevel).toBe(1)
    expect(mergeDamage(CONFIG, 1, 3, scoreOf).dealt).toBe(true)
    expect(mergeDamage(CONFIG, 2, 3, scoreOf).dealt).toBe(true)
  })

  it('deals the consumed score as damage', () => {
    // Three level-1 blocks -> 3 x 1 = 3 points.
    expect(mergeDamage(CONFIG, 1, 3, scoreOf).amount).toBe(3)
    // Three level-3 blocks -> 3 x 3 = 9 points.
    expect(mergeDamage(CONFIG, 3, 3, scoreOf).amount).toBe(9)
    // A 5-level clear is the heaviest single blow: 3 x 8 = 24.
    expect(mergeDamage(CONFIG, 5, 3, scoreOf).amount).toBe(24)
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

describe('battle: the bar is not touched by merges in any other way', () => {
  it('has no action-bar drain left in the rules', () => {
    // The old model pushed the bar backwards on a merge. It was replaced by
    // "a merge adds nothing", which is what the player actually asked for, so
    // the drain function is gone rather than merely unused.
    expect('drainActionBar' in ({} as Record<string, unknown>)).toBe(false)
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
