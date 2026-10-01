import { describe, expect, it } from 'vitest'
import { loadTuning } from '../src/core/data'
import { CELL_EMPTY, CELL_WALL, type GameEvent, type PacManState } from '../src/core/types'
import { cellsOf, craft, makeGame, onlyLevelOne, type CraftSpec } from './helpers'

/**
 * Battle mode through the real `Game` facade.
 *
 * The unit tests in battle.test.ts cover the arena maths in isolation; these
 * cover the parts that only exist once the mode is wired into a turn: placement
 * legality, the order of damage and the boss's action, and both endings.
 */

const tuning = loadTuning()
const CONFIG = tuning.battle
const FIELD_TOP = CONFIG.wallRow + 1

const GAP = { x: CONFIG.gapX, y: CONFIG.wallRow }

function battleGame(options?: { seed?: number; mutateTuning?: (t: typeof tuning) => void }) {
  return makeGame({
    modeId: 'battle',
    seed: options?.seed ?? 4242,
    mutateTuning: (t) => {
      onlyLevelOne(t)
      options?.mutateTuning?.(t)
    }
  })
}

function types(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.type)
}

/** A boss placed outside the cage, ready to hunt the field. */
function looseBoss(overrides: Partial<PacManState> = {}): PacManState {
  return {
    x: CONFIG.gapX,
    y: CONFIG.wallRow,
    hp: 10,
    maxHp: 10,
    bar: 0,
    phase: 'board',
    ...overrides
  }
}

/**
 * A battle snapshot with an explicit arena and boss.
 * The spec field is named `boss` here for readability; `CraftSpec` knows it as
 * `pacman`, so it is mapped across.
 */
function battleSnapshot(spec: CraftSpec & { boss: PacManState | null }) {
  const walls = []
  for (let x = 0; x < tuning.board.width; x++) {
    if (x !== CONFIG.gapX) walls.push({ x, y: CONFIG.wallRow })
  }
  const { boss, ...rest } = spec
  return craft(tuning.board.width, tuning.board.height, { walls, ...rest, pacman: boss })
}

describe('Game: battle mode setup', () => {
  it('starts with a wall, a stocked cage, a playable field and a live boss', () => {
    const game = battleGame()
    const view = game.view()

    expect(view.pacman).not.toBeNull()
    expect(view.pacman?.phase).toBe('cage')
    expect(view.pacman?.hp).toBe(CONFIG.startHp)

    const cells = cellsOf(game)
    const at = (x: number, y: number): number => cells[y * tuning.board.width + x]

    expect(at(CONFIG.gapX, CONFIG.wallRow)).toBe(CELL_EMPTY)
    expect(at(CONFIG.gapX === 0 ? 1 : 0, CONFIG.wallRow)).toBe(CELL_WALL)

    let cageBlocks = 0
    for (let y = 0; y < CONFIG.wallRow; y++) {
      for (let x = 0; x < tuning.board.width; x++) {
        if (at(x, y) > CELL_EMPTY) cageBlocks++
      }
    }
    expect(cageBlocks).toBe(CONFIG.cageBlockCount)

    for (let y = FIELD_TOP; y < tuning.board.height; y++) {
      for (let x = 0; x < tuning.board.width; x++) {
        expect(at(x, y)).toBe(CELL_EMPTY)
      }
    }
  })

  it('is not immediately lost or full, even though the cage holds blocks', () => {
    // The regression this guards: a board-wide "no empty cell" or "no blocks"
    // check would end a battle run on its first frame.
    const view = battleGame().view()
    expect(view.gameOver).toBe(false)
    expect(view.boardFull).toBe(false)
  })

  it('restarts with a freshly stocked cage', () => {
    const game = battleGame()
    game.restart(99)
    expect(game.view().pacman?.hp).toBe(CONFIG.startHp)
    expect(game.view().pacman?.phase).toBe('cage')
  })
})

describe('Game: battle placement rules', () => {
  it('refuses the cage, the wall and the gap as sealed zones', () => {
    const game = battleGame()
    game.pullNextToBuffer()

    for (const target of [
      { x: 0, y: 0 },
      { x: 4, y: CONFIG.wallRow - 1 },
      { x: 0, y: CONFIG.wallRow },
      GAP
    ]) {
      const events = game.placeFromBuffer(0, target.x, target.y)
      expect(types(events)).toEqual(['invalid'])
      expect(events[0]).toMatchObject({ reason: 'sealed-zone' })
    }
  })

  it('reports `canPlaceAt` false across the whole sealed band', () => {
    const game = battleGame()
    for (let y = 0; y <= CONFIG.wallRow; y++) {
      for (let x = 0; x < tuning.board.width; x++) {
        expect(game.canPlaceAt(x, y)).toBe(false)
      }
    }
    expect(game.canPlaceAt(0, FIELD_TOP)).toBe(true)
  })

  it('accepts the playable field', () => {
    const game = battleGame()
    game.pullNextToBuffer()
    const events = game.placeFromBuffer(0, 0, FIELD_TOP)
    expect(types(events)).toContain('placed')
  })

  it('still refuses an occupied field cell', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({ blocks: [{ x: 0, y: FIELD_TOP, level: 1 }], next: 1, boss: looseBoss() })
    )
    game.pullNextToBuffer()
    const events = game.placeFromBuffer(0, 0, FIELD_TOP)
    expect(events[0]).toMatchObject({ type: 'invalid', reason: 'cell-occupied' })
  })
})

describe('Game: battle turn resolution', () => {
  it('wounds the boss on a level-3 merge and drains its bar', () => {
    const game = battleGame()
    // Three 3s merge into a 4: score 9, so 9 damage.
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 3 },
          { x: 1, y: FIELD_TOP, level: 3 }
        ],
        buffer: [3, 0, 0],
        boss: looseBoss({ hp: 40, maxHp: 40, bar: 0.9 })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanHurt')

    const hurt = events.find((e) => e.type === 'pacmanHurt')
    expect(hurt).toMatchObject({ amount: 9, hp: 31 })

    // Order matters: the merge drains the bar *before* this placement's own
    // contribution is added, so the wound pushes the boss's next bite further
    // away rather than tipping it over. 0.9 - 0.5 + 0.5 = 0.9.
    expect(game.view().pacman?.bar).toBeCloseTo(
      0.9 - CONFIG.mergeBarDrain + CONFIG.actionPerPlacement,
      6
    )
  })

  it('does not wound the boss for a merge of blocks at or below the threshold', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 }
        ],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 40, maxHp: 40 })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).not.toContain('pacmanHurt')
    expect(game.view().pacman?.hp).toBe(40)
  })

  it('lets the boss act once the bar fills, healing it from the board', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 },
          // Spare food, so the boss has something to eat after acting.
          { x: 6, y: FIELD_TOP + 2, level: 2 }
        ],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 10, maxHp: 10, bar: CONFIG.actionPerPlacement })
      })
    )

    const before = game.view()
    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    // Two level-1 triples merge; the bar fills and the boss takes its bite.
    expect(types(events)).toContain('pacmanAte')

    const after = game.view()
    expect(after.pacman?.hp).toBeGreaterThan(10)
    expect(after.pacman?.hp).toBe(before.pacman === null ? 0 : 10 + 2)
    // The bar reset when it acted.
    expect(after.pacman?.bar).toBeLessThan(1)
  })

  it('prefers the killing blow over the boss taking its turn', () => {
    // The order inside a turn is damage-then-action, so a lethal merge must end
    // the run before the bar can fill and earn the boss a free bite.
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 3 },
          { x: 1, y: FIELD_TOP, level: 3 },
          { x: 6, y: FIELD_TOP + 2, level: 2 }
        ],
        buffer: [3, 0, 0],
        // Exactly lethal: a level-3 triple deals 9.
        boss: looseBoss({ hp: 9, maxHp: 9, bar: CONFIG.actionPerPlacement })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanHurt')
    expect(types(events)).toContain('pacmanDefeated')
    expect(types(events)).not.toContain('pacmanAte')
    expect(game.view().hasWon).toBe(true)
    expect(game.view().pacman?.hp).toBeLessThanOrEqual(0)
  })

  it('loses when the boss eats the last block of the field', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        // A level-1 triple whose merge is the player's whole board: the three
        // 1s become a single block, which the boss then eats, leaving nothing.
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 }
        ],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 99, maxHp: 99, bar: CONFIG.actionPerPlacement })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanAte')
    expect(types(events)).toContain('gameOver')
    expect(game.view().gameOver).toBe(true)
    // Losing is about the field specifically; the cage being empty is not the
    // trigger, and the wall can never hold a block.
    expect(game.view().pacman?.phase).toBe('board')
  })

  it('ends the run through the rules layer only, never through the level win', () => {
    const game = battleGame()
    // Battle modes have no level-based win, so nothing should ever pause the
    // cascade waiting for a "keep playing" choice.
    game.restore(
      battleSnapshot({
        blocks: [{ x: 0, y: FIELD_TOP, level: 1 }],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 999, maxHp: 999 })
      })
    )
    const events = game.placeFromBuffer(0, 1, FIELD_TOP)
    expect(types(events)).not.toContain('win')
    expect(game.view().pendingWin).toBeNull()
  })
})

describe('Game: battle undo', () => {
  it('restores the boss along with the board', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 3 },
          { x: 1, y: FIELD_TOP, level: 3 }
        ],
        buffer: [3, 0, 0],
        boss: looseBoss({ hp: 40, maxHp: 40, bar: 0.25 })
      })
    )

    const before = game.snapshot()
    game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(game.view().pacman?.hp).toBe(31)

    game.undo()
    const after = game.snapshot()

    // Everything about the boss comes back, not just the board: otherwise an
    // undo would leave the wound in place and be exploitable.
    expect(after.pacman).toEqual(before.pacman)
    expect(after.cells).toEqual(before.cells)
    expect(after.rngState).toBe(before.rngState)
  })

  it('replays an undone turn identically, including where the boss eats', () => {
    const game = battleGame({ seed: 31337 })
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 },
          { x: 6, y: FIELD_TOP + 2, level: 2 }
        ],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 10, maxHp: 10, bar: CONFIG.actionPerPlacement }),
        rngState: 777
      })
    )

    const first = game.placeFromBuffer(0, 2, FIELD_TOP)
    const firstState = game.snapshot()

    game.undo()
    const second = game.placeFromBuffer(0, 2, FIELD_TOP)

    // Same RNG state in, same boss move out: undoing cannot reroll the arena.
    expect(types(second)).toEqual(types(first))
    expect(second.find((e) => e.type === 'pacmanAte')).toEqual(
      first.find((e) => e.type === 'pacmanAte')
    )
    expect(game.snapshot().pacman).toEqual(firstState.pacman)
  })
})

describe('Game: battle snapshots', () => {
  it('round-trips the boss through a snapshot', () => {
    const game = battleGame()
    const boss = looseBoss({ hp: 17, maxHp: 42, bar: 0.3, phase: 'exit' })
    game.restore(battleSnapshot({ boss }))

    const restored = game.snapshot()
    expect(restored.pacman).toEqual(boss)
    expect(game.view().pacman).toEqual(boss)
  })

  it('reports no boss in modes that do not use one', () => {
    const game = makeGame({ modeId: 'basic' })
    expect(game.view().pacman).toBeNull()
    expect(game.snapshot().pacman).toBeNull()
  })
})
