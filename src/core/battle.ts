import type { Board } from './board'
import {
  CELL_EMPTY,
  CELL_WALL,
  type BattleConfig,
  type GameEvent,
  type PacManState,
  type Pos
} from './types'

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

const STEP_OFFSETS: readonly Pos[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
]

interface SearchResult {
  /** Distance in steps from the origin, -1 when unreachable. */
  dist: Int32Array
  /** Index of the cell we arrived from, -1 for the origin and unreachable cells. */
  prev: Int32Array
}

/**
 * Breadth-first search outwards from `from`.
 *
 * The wall is never passable — the boss has to use the gap, which is the whole
 * point of the arena. Blocks are passable only in the fallback pass: normally
 * the boss walks up to its food through empty cells rather than over the rest
 * of the board, which both looks right and keeps the distance honest.
 */
function search(
  board: Board,
  from: Pos,
  blocksPassable: boolean,
  onCell?: (pos: Pos, distance: number) => void
): SearchResult {
  const size = board.width * board.height
  const dist = new Int32Array(size).fill(-1)
  const prev = new Int32Array(size).fill(-1)

  const start = board.index(from.x, from.y)
  dist[start] = 0

  const queue: number[] = [start]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]
    const cx = current % board.width
    const cy = (current - cx) / board.width
    const d = dist[current]
    if (onCell !== undefined) onCell({ x: cx, y: cy }, d)

    for (let i = 0; i < STEP_OFFSETS.length; i++) {
      const nx = cx + STEP_OFFSETS[i].x
      const ny = cy + STEP_OFFSETS[i].y
      if (!board.inBounds(nx, ny)) continue

      const value = board.get(nx, ny)
      const passable = value === CELL_EMPTY || (blocksPassable && value > CELL_EMPTY)
      if (!passable) continue

      const next = board.index(nx, ny)
      if (dist[next] >= 0) continue
      dist[next] = d + 1
      prev[next] = current
      queue.push(next)
    }
  }

  return { dist, prev }
}

/** Walks `prev` backwards to rebuild the route, excluding the origin cell. */
function tracePath(board: Board, result: SearchResult, target: Pos): Pos[] {
  const path: Pos[] = []
  let current = board.index(target.x, target.y)

  while (current >= 0 && result.prev[current] >= 0) {
    const x = current % board.width
    path.push({ x, y: (current - x) / board.width })
    current = result.prev[current]
  }

  return path.reverse()
}

interface Target {
  cell: Pos
  path: Pos[]
}

/**
 * Picks the food the boss goes for, and the route it takes to get there.
 *
 * The rule is "the nearest reachable food", measured in real walking steps
 * rather than straight-line distance, so a block behind the wall is correctly
 * treated as further away than one it can reach by stepping through the gap.
 *
 * Ties break on reading order, and nothing here consumes randomness: the
 * journey is a pure function of the board, so undo cannot reroll it.
 */
export function chooseTarget(board: Board, from: Pos, food: readonly Pos[]): Target | null {
  if (food.length === 0) return null

  // Pass 1: walk through empties only — the boss stops in front of its food and
  // then steps onto it. This is the route that reads as "hunting".
  const strict = search(board, from, false)
  let best: Target | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (let i = 0; i < food.length; i++) {
    const cell = food[i]
    // A food's distance is one step past its closest reachable side.
    let closest = -1
    let closestDist = Number.POSITIVE_INFINITY
    for (let n = 0; n < STEP_OFFSETS.length; n++) {
      const nx = cell.x + STEP_OFFSETS[n].x
      const ny = cell.y + STEP_OFFSETS[n].y
      if (!board.inBounds(nx, ny)) continue
      const d = strict.dist[board.index(nx, ny)]
      if (d >= 0 && d < closestDist) {
        closestDist = d
        closest = board.index(nx, ny)
      }
    }
    if (closest < 0) continue

    // Reading-order tie-break keeps the choice deterministic without an RNG.
    const score = (closestDist + 1) * 1000 + cell.y * 10 + cell.x
    if (score < bestScore) {
      bestScore = score
      const approach = { x: closest % board.width, y: 0 }
      approach.y = (closest - approach.x) / board.width
      best = { cell, path: [...tracePath(board, strict, approach), cell] }
    }
  }

  if (best !== null) return best

  // Pass 2: every food is walled off by other blocks. Rather than leave the
  // boss stuck (which would stall the run forever), let it shove through the
  // board to the nearest one by straight-line distance.
  const loose = search(board, from, true)
  for (let i = 0; i < food.length; i++) {
    const cell = food[i]
    const d = loose.dist[board.index(cell.x, cell.y)]
    if (d < 0) continue
    const score = d * 1000 + cell.y * 10 + cell.x
    if (score < bestScore) {
      bestScore = score
      best = { cell, path: tracePath(board, loose, cell) }
    }
  }

  return best
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
  scoreOfLevel: (level: number) => number
): BossTurnResult {
  boss.bar = Math.min(1, boss.bar + config.actionPerPlacement)
  if (boss.bar < 1) return { events: [], defeated: false }

  boss.bar = 0
  return { events: [act(board, config, boss, scoreOfLevel)], defeated: false }
}

/** One boss action, chosen entirely by its current phase. */
function act(
  board: Board,
  config: BattleConfig,
  boss: PacManState,
  scoreOfLevel: (level: number) => number
): GameEvent {
  if (boss.phase === 'cage') {
    const food = cageFoodPositions(board, config)
    const target = chooseTarget(board, { x: boss.x, y: boss.y }, food)

    if (target !== null) {
      const { cell, path } = target
      const from = { x: boss.x, y: boss.y }
      const level = board.get(cell.x, cell.y)
      board.set(cell.x, cell.y, CELL_EMPTY)
      boss.x = cell.x
      boss.y = cell.y

      const heal = Math.round(scoreOfLevel(level) * config.healPerScore)
      boss.hp += heal
      if (boss.hp > boss.maxHp) boss.maxHp = boss.hp

      // Last block eaten -> the boss now heads for the gap.
      if (food.length === 1) boss.phase = 'exit'

      return {
        type: 'pacmanAte',
        x: cell.x,
        y: cell.y,
        from,
        path,
        level,
        heal,
        hp: boss.hp,
        fromCage: true
      }
    }

    // Cage already empty but still marked as inside it (e.g. a restored save).
    boss.phase = 'exit'
    return { type: 'pacmanExited', x: boss.x, y: boss.y, from: { x: boss.x, y: boss.y }, path: [] }
  }

  if (boss.phase === 'exit') {
    const from = { x: boss.x, y: boss.y }
    const destination = { x: config.gapX, y: config.wallRow }
    // The route has to go round the wall and in through the gap, which is what
    // `chooseTarget`'s search already does — so it is reused here with a single
    // destination instead of a list of food.
    const route = chooseTarget(board, from, [destination])
    const path = route === null ? [] : route.path

    boss.x = destination.x
    boss.y = destination.y
    boss.phase = 'board'
    return { type: 'pacmanExited', x: boss.x, y: boss.y, from, path }
  }

  // Loose on the board: eat the nearest block in the playable field.
  const food = boardFoodPositions(board, config)
  const target = chooseTarget(board, { x: boss.x, y: boss.y }, food)

  if (target === null) {
    // Nothing reachable, or nothing left. The run is already lost by the
    // board-cleared check, so this is a safe no-op rather than a second loss.
    return { type: 'pacmanExited', x: boss.x, y: boss.y, from: { x: boss.x, y: boss.y }, path: [] }
  }

  const from = { x: boss.x, y: boss.y }
  const { cell, path } = target
  const level = board.get(cell.x, cell.y)
  board.set(cell.x, cell.y, CELL_EMPTY)
  boss.x = cell.x
  boss.y = cell.y

  const heal = Math.round(scoreOfLevel(level) * config.healPerScore)
  boss.hp += heal
  if (boss.hp > boss.maxHp) boss.maxHp = boss.hp

  return {
    type: 'pacmanAte',
    x: cell.x,
    y: cell.y,
    from,
    path,
    level,
    heal,
    hp: boss.hp,
    fromCage: false
  }
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
