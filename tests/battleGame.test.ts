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
  it('wounds the boss on a level-3 merge', () => {
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
    // The wound is reported from the merge cell to the boss, so the view can
    // send a volley between the two.
    expect(hurt).toMatchObject({ srcX: 2, srcY: FIELD_TOP, x: CONFIG.gapX, y: CONFIG.wallRow })
  })

  it('wounds the boss on a merge of level-1 blocks too', () => {
    // Every merge counts: there is no such thing as a harmless one.
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
    expect(types(events)).toContain('pacmanHurt')
    // Three level-1 blocks -> 3 x 1 = 3.
    expect(events.find((e) => e.type === 'pacmanHurt')).toMatchObject({ amount: 3, hp: 37 })
  })

  it('leaves the action bar alone on a merge, and fills it otherwise', () => {
    // This is the defence mechanic: merging buys a turn instead of pushing the
    // boss backwards.
    const game = battleGame()
    const step = 1 / CONFIG.turnsPerAction

    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 }
        ],
        buffer: [1, 0, 0],
        // A replacement must exist or the follow-up placement never happens and
        // the bar would stay at zero for the wrong reason.
        next: 1,
        boss: looseBoss({ hp: 99, maxHp: 99, bar: 0 })
      })
    )
    game.placeFromBuffer(0, 2, FIELD_TOP)
    // A merge: no progress at all.
    expect(game.view().pacman?.bar).toBe(0)

    // A plain placement elsewhere: exactly one turn's worth.
    game.pullNextToBuffer()
    const events = game.placeFromBuffer(0, 6, FIELD_TOP + 1)
    expect(types(events)).toContain('placed')
    expect(game.view().pacman?.bar).toBeCloseTo(step, 6)
  })

  it('makes the boss wait three unmerged turns between actions', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: [{ x: 6, y: FIELD_TOP + 2, level: 2 }],
        buffer: [1, 0, 0],
        // A replacement has to exist, or `pullNextToBuffer` refuses and none of
        // these placements would happen at all.
        next: 1,
        boss: looseBoss({ hp: 10, maxHp: 10, bar: 0 })
      })
    )

    // Deliberately two columns apart: adjacent 1s would merge into a triple and
    // the bar would never advance at all.
    const spots = [
      { x: 0, y: FIELD_TOP },
      { x: 2, y: FIELD_TOP },
      { x: 4, y: FIELD_TOP },
      { x: 6, y: FIELD_TOP }
    ]

    // One full cycle plus the first turn of the next: the boss acts on the
    // third turn only, then the cycle restarts.
    const bitesPerTurn: number[] = []
    for (let i = 0; i < spots.length; i++) {
      const pulled = game.pullNextToBuffer()
      expect(pulled.map((e) => e.type)).toContain('toBuffer')

      const events = game.placeFromBuffer(0, spots[i].x, spots[i].y)
      expect(types(events)).toContain('placed')
      bitesPerTurn.push(events.filter((e) => e.type === 'pacmanAte').length)
    }

    expect(bitesPerTurn).toEqual([0, 0, 1, 0])
  })

  it('lets the boss act once the bar fills, healing it from the board', () => {
    const game = battleGame({
      mutateTuning: (t) => {
        t.battle.mergesDelayAction = false
      }
    })
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 },
          // Spare food, so the boss has something to eat after acting.
          { x: 6, y: FIELD_TOP + 2, level: 2 }
        ],
        buffer: [1, 0, 0],
        // One turn short of full, so this placement tips it over.
        boss: looseBoss({ hp: 10, maxHp: 10, bar: 1 - 1 / CONFIG.turnsPerAction })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanAte')

    // The turn both hurt (the merge) and healed (the bite); assert against the
    // events rather than a hand-computed number, so the two stay in step.
    const hurt = events.find((e) => e.type === 'pacmanHurt')
    const ate = events.find((e) => e.type === 'pacmanAte')
    const damage = hurt !== undefined && hurt.type === 'pacmanHurt' ? hurt.amount : 0
    const heal = ate !== undefined && ate.type === 'pacmanAte' ? ate.heal : 0

    expect(damage).toBeGreaterThan(0)
    expect(heal).toBeGreaterThan(0)
    expect(game.view().pacman?.hp).toBe(10 - damage + heal)
    // The bar reset when it acted.
    expect(game.view().pacman?.bar).toBeLessThan(1)
  })

  it('prefers the killing blow over the boss taking its turn', () => {
    // The order inside a turn is damage-then-action, so a lethal merge must end
    // the run before the bar can fill and earn the boss a free bite.
    //
    // `mergesDelayAction` is switched off here on purpose: with it on, a merge
    // can never fill the bar, so there would be no race to test.
    const game = battleGame({
      mutateTuning: (t) => {
        t.battle.mergesDelayAction = false
      }
    })
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 3 },
          { x: 1, y: FIELD_TOP, level: 3 },
          { x: 6, y: FIELD_TOP + 2, level: 2 }
        ],
        buffer: [3, 0, 0],
        // Exactly lethal (a level-3 triple deals 9), and this placement would
        // fill the bar.
        boss: looseBoss({ hp: 9, maxHp: 9, bar: 1 - 1 / CONFIG.turnsPerAction })
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
    // Same reason as above: the bite has to be reachable within one turn, which
    // a merge alone can no longer do.
    const game = battleGame({
      mutateTuning: (t) => {
        t.battle.mergesDelayAction = false
      }
    })
    game.restore(
      battleSnapshot({
        // A level-1 triple whose merge is the player's whole board: the three
        // 1s become a single block, which the boss then eats, leaving nothing.
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 }
        ],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 99, maxHp: 99, bar: 1 - 1 / CONFIG.turnsPerAction })
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

describe('Game: the boss is invincible inside the cage', () => {
  /** A level-3 triple: 9 damage, enough to kill anything with hp <= 9. */
  const lethalBlocks = [
    { x: 0, y: FIELD_TOP, level: 3 },
    { x: 1, y: FIELD_TOP, level: 3 }
  ]

  it('reports immunity instead of damage while it is in the cage', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: lethalBlocks,
        buffer: [3, 0, 0],
        boss: looseBoss({ hp: 30, maxHp: 30, phase: 'cage' })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanImmune')
    expect(types(events)).not.toContain('pacmanHurt')
    // Untouched.
    expect(game.view().pacman?.hp).toBe(30)
    expect(game.view().hasWon).toBe(false)
  })

  it('cannot be killed from inside the cage, however big the merge', () => {
    // Three 5-level blocks would be a max-level clear worth 24 damage; against
    // 1 hp that would be a turn-three win if the cage did not protect it.
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 5 },
          { x: 1, y: FIELD_TOP, level: 5 }
        ],
        buffer: [5, 0, 0],
        boss: looseBoss({ hp: 1, maxHp: 1, phase: 'cage' })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('maxCleared')
    expect(types(events)).toContain('pacmanImmune')
    expect(game.view().pacman?.hp).toBe(1)
    expect(game.view().hasWon).toBe(false)
  })

  it('stays invincible while standing in the wall gap', () => {
    // The `exit` phase is still the cage side of the wall, not the field.
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: lethalBlocks,
        buffer: [3, 0, 0],
        boss: looseBoss({ hp: 30, maxHp: 30, phase: 'exit' })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanImmune')
    expect(game.view().pacman?.hp).toBe(30)
  })

  it('becomes vulnerable once it is loose on the board', () => {
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: lethalBlocks,
        buffer: [3, 0, 0],
        boss: looseBoss({ hp: 30, maxHp: 30, phase: 'board' })
      })
    )

    const events = game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(types(events)).toContain('pacmanHurt')
    expect(types(events)).not.toContain('pacmanImmune')
    expect(game.view().pacman?.hp).toBe(21)
  })

  it('still advances the action bar on a merge it shrugged off', () => {
    // The immunity is about damage only. A merge is still a merge, so it still
    // buys the player their turn.
    const game = battleGame()
    game.restore(
      battleSnapshot({
        blocks: lethalBlocks,
        buffer: [3, 0, 0],
        boss: looseBoss({ hp: 30, maxHp: 30, bar: 0.5, phase: 'cage' })
      })
    )

    game.placeFromBuffer(0, 2, FIELD_TOP)
    expect(game.view().pacman?.bar).toBe(0.5)
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
    const game = battleGame({
      seed: 31337,
      mutateTuning: (t) => {
        t.battle.mergesDelayAction = false
      }
    })
    game.restore(
      battleSnapshot({
        blocks: [
          { x: 0, y: FIELD_TOP, level: 1 },
          { x: 1, y: FIELD_TOP, level: 1 },
          { x: 6, y: FIELD_TOP + 2, level: 2 }
        ],
        buffer: [1, 0, 0],
        boss: looseBoss({ hp: 30, maxHp: 30, bar: 1 - 1 / CONFIG.turnsPerAction }),
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
