/**
 * Shared types for the rules layer.
 *
 * HARD RULE: nothing under src/core may touch the DOM, canvas, Image,
 * AudioContext or timers. This layer must be runnable inside vitest's node
 * environment so the rules can be simulated and asserted without a browser.
 */

// ---------------------------------------------------------------------------
// Board cells
// ---------------------------------------------------------------------------

/** Empty cell. */
export const CELL_EMPTY = 0

/** Impassable obstacle at full health: blocks placement, never merges. */
export const CELL_OBSTACLE = -1

/**
 * Obstacle that has already taken a hit.
 *
 * Still impassable and still unable to merge — only its appearance and its
 * remaining health differ, so every "is this cell free?" check must treat both
 * obstacle values the same way.
 */
export const CELL_OBSTACLE_CRACKED = -2

/**
 * Indestructible wall (battle mode).
 *
 * Like an obstacle it blocks placement and never merges, but no merge can ever
 * remove it. Kept as its own value rather than as "an obstacle with a huge hit
 * count" so the obstacle damage path can never touch it.
 */
export const CELL_WALL = -3

/** True for either damageable obstacle state. Use this rather than comparing to -1. */
export function isObstacleValue(value: number): boolean {
  return value === CELL_OBSTACLE || value === CELL_OBSTACLE_CRACKED
}

/** True for anything that occupies a cell without being a mergeable block. */
export function isSolidValue(value: number): boolean {
  return value < CELL_EMPTY
}

export interface Pos {
  x: number
  y: number
}

export type ParticleDensity = 'low' | 'medium' | 'high'

// ---------------------------------------------------------------------------
// Data-driven config (loaded from src/data/*.json)
// ---------------------------------------------------------------------------

export interface ModeConfig {
  id: string
  name: string
  description: string
  /** scoreByLevel[n - 1] is the score of a single level-n block. */
  scoreByLevel: number[]
  /** Extra points when a max-level group is consumed. 0 disables the bonus. */
  maxLevelBonus: number
  /** Whether obstacles spawn during play. */
  obstacles: boolean
  /** Battle mode: a sealed arena with a Pac-Man hunting the board. */
  battle: boolean
  /** Level NUMBER that wins the run (endless: 10 => the 89-point block). */
  winAtLevel: number | null
}

export interface StepUnlockFallback {
  enabled: boolean
  stepsPerLevel: number
}

/**
 * Battle-mode arena and boss parameters.
 *
 * The board is split into three horizontal bands by `wallRow`:
 *
 *   rows 0 .. wallRow-1    the cage: holds the boss's food, no placement allowed
 *   row  wallRow           an indestructible wall, pierced by one gap at `gapX`
 *   rows wallRow+1 ..      the playable field the player defends
 *
 * Geometry lives here rather than in code so the arena can be reshaped without
 * touching the rules.
 */
export interface BattleConfig {
  wallRow: number
  /** The single opening in the wall; also where the boss leaves the cage. */
  gapX: number
  /** Level of the blocks stacked in the cage. */
  cageBlockLevel: number
  cageBlockCount: number
  /** Where the boss starts; always inside the cage. */
  start: { x: number; y: number }
  /** Starting hit points. */
  startHp: number
  /**
   * Placements needed to fill the action bar, i.e. the boss acts once every N
   * placements. Fractional values are allowed.
   */
  turnsPerAction: number
  /**
   * When true, a placement that produced a merge adds NO action-bar progress.
   *
   * This is what turns merging into the player's defence: it does not push the
   * boss backwards, it buys a turn. Set to false and the boss simply acts every
   * `turnsPerAction` placements regardless of how well the player plays.
   */
  mergesDelayAction: boolean
  /** HP lost per point of score in a damaging merge. */
  damagePerScore: number
  /** HP gained per point of score of an eaten block. */
  healPerScore: number
  /**
   * Minimum level a merge must consume before it hurts the boss.
   * 1 means every merge hurts it.
   */
  damageFromLevel: number
}

/** Where the boss is in its hunt. */
export type PacManPhase = 'cage' | 'exit' | 'board'

export interface PacManState {
  x: number
  y: number
  hp: number
  /** Highest hp reached this run; the hp bar is drawn relative to it. */
  maxHp: number
  /** Action bar, 0..1. Fills as the player places; acting resets it to 0. */
  bar: number
  phase: PacManPhase
}

export interface Tuning {
  board: { width: number; height: number }
  buffer: { slots: number; initiallyEmpty: boolean }
  next: { preSeedAtStart: boolean }
  unlock: {
    strategy: 'byMaxReachedLevel'
    /** spawnWeights[n - 1] = relative weight of level n. */
    spawnWeights: number[]
    stepUnlockFallback: StepUnlockFallback
  }
  cascade: { enabled: boolean }
  obstacles: {
    spawnEverySteps: number
    clearBonus: number
    /**
     * Hits needed to destroy a fresh obstacle. 1 removes the cracked stage
     * entirely; 2 means the first hit cracks it and the second shatters it.
     */
    hits: number
    /** A max-level merge destroys whatever it touches in a single hit. */
    breakOutrightAtMaxLevel: boolean
  }
  battle: BattleConfig
  history: { limit: number }
  theme: { defaultId: string }
  fx: { particleDensity: ParticleDensity }
}

export interface ThemeEntry {
  id: string
  name: string
  dir: string
  description: string
}

export interface ThemesConfig {
  themes: ThemeEntry[]
}

// ---------------------------------------------------------------------------
// Rules-layer events (consumed by the presentation layer)
// ---------------------------------------------------------------------------

/**
 * One link in an automatic merge chain.
 *
 * An entire cascade resolves synchronously inside the rules layer, but the
 * presentation has to show it one link at a time ("these three became that
 * one, which then became this one"). Carrying the board state on both sides of
 * each step is what makes that possible without duplicating any rule logic in
 * the view.
 */
export interface CascadeStep {
  /** Board with the consumed blocks still present. */
  cellsBefore: number[]
  /** Board after the merge was applied. */
  cellsAfter: number[]
  /** Merge / obstacle events belonging to this step alone. */
  events: GameEvent[]
}

/** Events produced by an automatic chain. */
export type CascadeOwnedEvent =
  | 'merged'
  | 'maxCleared'
  | 'obstacleHit'
  | 'obstacleCleared'
  /** A chain link wounded the boss, so its burst belongs to that link. */
  | 'pacmanHurt'

export type InvalidReason =
  | 'game-over'
  | 'win-pending'
  | 'buffer-full'
  | 'empty-slot'
  | 'no-next'
  | 'out-of-bounds'
  | 'cell-occupied'
  /** Inside the cage, inside the wall, or in the wall's gap: never placeable. */
  | 'sealed-zone'
  | 'no-history'

export type GameEvent =
  /** A new block appeared in the "next" slot. */
  | { type: 'spawned'; level: number }
  /** The "next" block moved into a buffer slot and a replacement spawned. */
  | { type: 'toBuffer'; level: number; slot: number }
  /** A block landed on the board. */
  | { type: 'placed'; x: number; y: number; level: number }
  /** A connected group of >= 3 was consumed and a bigger block was created. */
  | {
      type: 'merged'
      x: number
      y: number
      /** 1 = the placement itself, 2+ = chain steps. */
      chain: number
      consumed: number
      consumedCells: Pos[]
      fromLevel: number
      toLevel: number
      score: number
    }
  /** A max-level group was consumed: whole cluster removed, bonus paid, no new block. */
  | {
      type: 'maxCleared'
      x: number
      y: number
      level: number
      consumed: number
      consumedCells: Pos[]
      score: number
      bonus: number
    }
  /** An obstacle took damage and survived, now showing cracks. */
  | { type: 'obstacleHit'; x: number; y: number }
  /** An obstacle was destroyed. The bonus is paid only on this event. */
  | { type: 'obstacleCleared'; x: number; y: number; bonus: number }
  /** The boss left the cage for the wall gap. */
  | { type: 'pacmanExited'; x: number; y: number; from: Pos; path: Pos[] }
  /** The boss ate a block and healed by its score value. */
  | {
      type: 'pacmanAte'
      x: number
      y: number
      /** Cell it set off from, so the view can animate the journey. */
      from: Pos
      /** Cells walked through, ending at the eaten one. Empty when adjacent. */
      path: Pos[]
      level: number
      heal: number
      hp: number
      /** True while it was still eating its way out of the cage. */
      fromCage: boolean
    }
  /**
   * A merge wounded the boss.
   * `x`/`y` is the boss (where the damage lands); `srcX`/`srcY` is the merge
   * that caused it, so the view can send particles from one to the other.
   */
  | {
      type: 'pacmanHurt'
      x: number
      y: number
      srcX: number
      srcY: number
      amount: number
      hp: number
    }
  /** The boss's hp hit zero: the run is won. */
  | { type: 'pacmanDefeated'; x: number; y: number; hp: number; score: number }
  | { type: 'obstacleSpawned'; x: number; y: number }
  | { type: 'invalid'; reason: InvalidReason }
  /**
   * Payload (not a visual event): the per-step breakdown of an automatic chain.
   * Emitted once, after the `placed` event, when the cascade had at least one
   * step. `fxMap` ignores it; the view uses it to sequence the animation.
   */
  | { type: 'cascadeSteps'; steps: CascadeStep[] }
  /** Endless mode reached its win level. The cascade paused for the player's choice. */
  | { type: 'win'; level: number; score: number }
  | { type: 'gameOver'; score: number }
  | { type: 'undo' }
  | { type: 'restarted' }

// ---------------------------------------------------------------------------
// Undo snapshots
// ---------------------------------------------------------------------------

/**
 * Full state of one turn. Undo restores by replacing state wholesale rather
 * than by inverting operations: a single placement can trigger a chain, an
 * obstacle spawn, obstacle clears and score changes, and any "inverse" logic
 * would have to mirror all of it.
 *
 * `rngState` is what makes undo non-exploitable: replaying the same move
 * yields the same "next" block, so undoing cannot be used to reroll.
 */
export interface GameSnapshot {
  cells: number[]
  buffer: number[]
  next: number
  score: number
  steps: number
  maxReachedLevel: number
  hasWon: boolean
  gameOver: boolean
  pendingWin: { level: number; score: number } | null
  /** Null in every mode except battle. */
  pacman: PacManState | null
  rngState: number
}
