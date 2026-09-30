import type { Board } from './board'
import { clearAdjacentObstacles } from './obstacles'
import { CELL_EMPTY, type CascadeStep, type GameEvent, type Pos } from './types'

/**
 * Merge resolution — the heart of the rules.
 *
 * Confirmed rules encoded here:
 *  - Only orthogonal adjacency counts (see Board).
 *  - A connected same-level group of >= 3 is consumed IN FULL; exactly one
 *    bigger block is created at the placement cell. A group of 5 still yields
 *    a single block.
 *  - Score = sum of the consumed blocks' own values (3 x level-1 = 3 points).
 *  - Chains run automatically until the board is stable.
 *  - At the mode's MAX level there is no bigger block: the whole cluster is
 *    removed, `maxLevelBonus` is paid, and the chain ends.
 */

export interface CascadeOptions {
  scoreByLevel: readonly number[]
  maxLevelBonus: number
  obstacleClearBonus: number
  /** Level NUMBER that wins the run, or null. */
  winAtLevel: number | null
  /** Set once the win has already been claimed in this run. */
  winAlreadyClaimed: boolean
  cascadeEnabled: boolean
}

export interface CascadeResult {
  events: GameEvent[]
  /**
   * One entry per chain link, each carrying the board before and after it.
   * The view plays these in order so the player can follow the chain.
   */
  steps: CascadeStep[]
  score: number
  /** Highest level created by this cascade (0 when nothing was created). */
  maxCreatedLevel: number
  /** True when resolution paused because the win level was created. */
  stoppedForWin: boolean
  /** Where to resume if the player chooses to keep playing after winning. */
  resume: { x: number; y: number; level: number } | null
  /** Level now sitting at (x, y); CELL_EMPTY when the cell was cleared. */
  finalLevel: number
}

/** Score of one block of `level`, clamped to the configured table. */
export function scoreOfLevel(scoreByLevel: readonly number[], level: number): number {
  if (level <= 0 || scoreByLevel.length === 0) return 0
  const index = Math.min(level, scoreByLevel.length) - 1
  return scoreByLevel[index]
}

/**
 * Resolves merges for a block that the caller has ALREADY placed at (x, y).
 */
export function resolveCascade(
  board: Board,
  x: number,
  y: number,
  level: number,
  options: CascadeOptions
): CascadeResult {
  const events: GameEvent[] = []
  const steps: CascadeStep[] = []
  const levelCount = options.scoreByLevel.length

  let score = 0
  let maxCreatedLevel = 0
  let chain = 1
  let currentLevel = level
  let stoppedForWin = false
  let resume: CascadeResult['resume'] = null

  for (;;) {
    const group = board.findGroup(x, y)
    if (group.length < 3) break

    // Captured before anything is consumed, so the view can render the blocks
    // that are about to disappear.
    const cellsBefore = board.toArray()
    const stepEvents: GameEvent[] = []

    // Consume the entire cluster.
    for (let i = 0; i < group.length; i++) {
      board.set(group[i].x, group[i].y, CELL_EMPTY)
    }

    const gained = group.length * scoreOfLevel(options.scoreByLevel, currentLevel)
    score += gained

    // A merge blasts orthogonally touching obstacles.
    const clearedObstacles: Pos[] = clearAdjacentObstacles(board, group)
    for (let i = 0; i < clearedObstacles.length; i++) {
      const p = clearedObstacles[i]
      score += options.obstacleClearBonus
      stepEvents.push({ type: 'obstacleCleared', x: p.x, y: p.y, bonus: options.obstacleClearBonus })
    }

    const isMaxLevel = currentLevel >= levelCount

    if (isMaxLevel) {
      // No bigger block exists: clear the cluster, pay the bonus, end the chain.
      const bonus = options.maxLevelBonus
      if (bonus > 0) score += bonus
      stepEvents.push({
        type: 'maxCleared',
        x,
        y,
        level: currentLevel,
        consumed: group.length,
        consumedCells: group,
        score: gained,
        bonus
      })
      events.push(...stepEvents)
      steps.push({ cellsBefore, cellsAfter: board.toArray(), events: stepEvents })
      currentLevel = CELL_EMPTY
      break
    }

    const nextLevel = currentLevel + 1
    board.set(x, y, nextLevel)
    if (nextLevel > maxCreatedLevel) maxCreatedLevel = nextLevel

    stepEvents.push({
      type: 'merged',
      x,
      y,
      chain,
      consumed: group.length,
      consumedCells: group,
      fromLevel: currentLevel,
      toLevel: nextLevel,
      score: gained
    })

    events.push(...stepEvents)
    steps.push({ cellsBefore, cellsAfter: board.toArray(), events: stepEvents })

    currentLevel = nextLevel

    const isWin =
      options.winAtLevel !== null &&
      nextLevel >= options.winAtLevel &&
      !options.winAlreadyClaimed

    if (isWin) {
      stoppedForWin = true
      resume = { x, y, level: nextLevel }
      break
    }

    if (!options.cascadeEnabled) break
    chain++
  }

  return {
    events,
    steps,
    score,
    maxCreatedLevel,
    stoppedForWin,
    resume,
    finalLevel: board.get(x, y)
  }
}
