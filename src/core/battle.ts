import type { Board } from './board'
import { CELL_EMPTY, CELL_WALL, type BattleConfig, type GameEvent, type PacManState, type Pos } from './types'

/**
 * Battle mode: the arena, and the boss that hunts the board.
 *
 * The arena is three bands. Rows above the wall are the cage, where eight
 * blocks of `cageBlockLevel` are sealed in with the boss; the wall row itself is
 * solid except for one gap; everything below is the field the player defends.
 *
 * The boss runs on an action bar:
 *   - every placement fills it by `actionPerPlacement`;
 *   - when it fills, the boss acts once and the bar resets.
 *
 * While it is in the cage, acting means eating one of its own blocks and gaining
 * that block's score as hit points — so the opening of a run is the boss getting
 * *stronger*, and clearing the cage is the player's progress, not a threat.
 * Once the cage is empty it walks to the wall's gap, and from then on it eats
 * the player's board instead, which is what runs the player out of blocks.
 *
 * All of this is pure: it mutates the board and returns events, and nothing here
 * touches a browser API.
 */

/** True for a cell the player may never place into, whatever it contains. */
export function isSealedCell(config: BattleConfig, y: number): boolean {
  return y <= config.wallRow
}

/**
 * Lays out the cage blocks and the wall, and puts the boss at its start.
 *
 * The cage blocks are scattered with the run's RNG, so a replay (and an undo)
 * reproduces the same arena — the position must never come from `Math.random`.
 */
export function seedArena(
  board: Board,
  config: BattleConfig,
  /** Returns a uniform integer below `n`, from the run's seeded RNG. */
  int: (n: number) => number
): PacManState {
  // The wall, minus its gap. The gap stays empty so the boss can pass through it.
  for (let x = 0; x < board.width; x++) {
    if (x === config.gapX) continue
    board.set(x, config.wallRow, CELL_WALL)
  }

  // Cage blocks, scattered over the empty cage cells.
  const cageCells: Pos[] = []
  for (let y = 0; y < config.wallRow; y++) {
    for (let x = 0; x < board.width; x++) {
      if (config.start.x === x && config.start.y === y) continue
      cageCells.push({ x, y })
    }
  }

  const wanted = Math.min(config.cageBlockCount, cageCells.length)
  for (let placed = 0; placed < wanted; placed++) {
    // Pick uniformly from what is left, then remove it (swap-with-last), so the
    // same RNG stream always yields the same layout.
    const pick = int(cageCells.length)
    const spot = cageCells[pick]
    cageCells[pick] = cageCells[cageCells.length - 1]
    cageCells.pop()

    board.set(spot.x, spot.y, config.cageBlockLevel)
  }

  return {
    x: config.start.x,
    y: config.start.y,
    hp: config.startHp,
    maxHp: config.startHp,
    bar: 0,
    phase: 'cage'
  }
}

/** Cage cells that still hold food. */
function cageFoodPositions(board: Board, config: BattleConfig): Pos[] {
  const out: Pos[] = []
  for (let y = 0; y < config.wallRow; y++) {
    for (let x = 0; x < board.width; x++) {
      if (board.get(x, y) > CELL_EMPTY) out.push({ x, y })
    }
  }
  return out
}

/**
 * Board cells the boss can eat once it is loose.
 *
 * Only the playable field counts: the cage is already empty by then, and the
 * wall can never hold a block.
 */
function boardFoodPositions(board: Board, config: BattleConfig): Pos[] {
  const out: Pos[] = []
  for (let y = config.wallRow + 1; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      if (board.get(x, y) > CELL_EMPTY) out.push({ x, y })
    }
  }
  return out
}

/** True when no block is left in the playable field (the losing condition). */
export function boardIsCleared(board: Board, config: BattleConfig): boolean {
  return boardFoodPositions(board, config).length === 0
}

export interface BossTurnResult {
  /** Events to append to the turn, in order. */
  events: GameEvent[]
  /** True when this turn killed the boss. */
  defeated: boolean
}

/**
 * Fills the action bar by `actionPerPlacement` and, if that fills it, lets the
 * boss act once.
 *
 * Acting is deliberately a single step per turn: a full bar does not carry over
 * into a second action, so the bar can never bank more than one move.
 */
export function advanceBoss(
  board: Board,
  config: BattleConfig,
  boss: PacManState,
  scoreOfLevel: (level: number) => number,
  int: (n: number) => number
): BossTurnResult {
  boss.bar = Math.min(1, boss.bar + config.actionPerPlacement)
  if (boss.bar < 1) return { events: [], defeated: false }

  boss.bar = 0
  return { events: [act(board, config, boss, scoreOfLevel, int)], defeated: false }
}

/** One boss action, chosen entirely by its current phase. */
function act(
  board: Board,
  config: BattleConfig,
  boss: PacManState,
  scoreOfLevel: (level: number) => number,
  int: (n: number) => number
): GameEvent {
  if (boss.phase === 'cage') {
    const food = cageFoodPositions(board, config)

    if (food.length > 0) {
      const spot = food[int(food.length)]
      const level = board.get(spot.x, spot.y)
      board.set(spot.x, spot.y, CELL_EMPTY)
      boss.x = spot.x
      boss.y = spot.y

      const heal = Math.round(scoreOfLevel(level) * config.healPerScore)
      boss.hp += heal
      if (boss.hp > boss.maxHp) boss.maxHp = boss.hp

      // Last block eaten -> the boss now heads for the gap.
      if (food.length === 1) boss.phase = 'exit'

      return { type: 'pacmanAte', x: spot.x, y: spot.y, level, heal, hp: boss.hp, fromCage: true }
    }

    // Cage already empty but still marked as inside it (e.g. a restored save).
    boss.phase = 'exit'
    return { type: 'pacmanExited', x: boss.x, y: boss.y }
  }

  if (boss.phase === 'exit') {
    boss.x = config.gapX
    boss.y = config.wallRow
    boss.phase = 'board'
    return { type: 'pacmanExited', x: boss.x, y: boss.y }
  }

  // Loose on the board: eat a block from the playable field.
  const food = boardFoodPositions(board, config)
  if (food.length === 0) {
    // Nothing to eat. The run is already lost by the board-cleared check, so
    // this is just a safe no-op rather than a second losing condition.
    return { type: 'pacmanExited', x: boss.x, y: boss.y }
  }

  const spot = food[int(food.length)]
  const level = board.get(spot.x, spot.y)
  board.set(spot.x, spot.y, CELL_EMPTY)
  boss.x = spot.x
  boss.y = spot.y

  const heal = Math.round(scoreOfLevel(level) * config.healPerScore)
  boss.hp += heal
  if (boss.hp > boss.maxHp) boss.maxHp = boss.hp

  return { type: 'pacmanAte', x: spot.x, y: spot.y, level, heal, hp: boss.hp, fromCage: false }
}

export interface MergeDamage {
  amount: number
  /** True when the merge was strong enough to hurt the boss at all. */
  dealt: boolean
}

/**
 * Damage from one merge step.
 *
 * The score is the merge's own consumption (`count * scoreOfLevel(level)`), not
 * the turn's total: a 5-level clear's flat bonus is deliberately excluded, so a
 * single clear is the heaviest possible blow rather than an instant kill.
 */
export function mergeDamage(
  config: BattleConfig,
  level: number,
  consumed: number,
  scoreOfLevel: (level: number) => number
): MergeDamage {
  if (level < config.damageFromLevel) return { amount: 0, dealt: false }

  const score = consumed * scoreOfLevel(level)
  const amount = Math.round(score * config.damagePerScore)
  return { amount, dealt: amount > 0 }
}

/**
 * Drains the action bar after a merge, once the boss is out of the cage.
 *
 * This is what gives the player a way to fight back: without it, every
 * placement would bring the boss's next bite closer with no counterplay.
 */
export function drainActionBar(config: BattleConfig, boss: PacManState): void {
  if (boss.phase === 'cage') return
  boss.bar = Math.max(0, boss.bar - config.mergeBarDrain)
}

/** Applies damage and reports whether it was lethal. */
export function applyDamage(boss: PacManState, amount: number): boolean {
  boss.hp -= amount
  return boss.hp <= 0
}
