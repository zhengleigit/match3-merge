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

/** True for either obstacle state. Use this rather than comparing to -1. */
export function isObstacleValue(value: number): boolean {
  return value === CELL_OBSTACLE || value === CELL_OBSTACLE_CRACKED
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
  /** Level NUMBER that wins the run (endless: 10 => the 89-point block). */
  winAtLevel: number | null
}

export interface StepUnlockFallback {
  enabled: boolean
  stepsPerLevel: number
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
export type CascadeOwnedEvent = 'merged' | 'maxCleared' | 'obstacleHit' | 'obstacleCleared'

export type InvalidReason =
  | 'game-over'
  | 'win-pending'
  | 'buffer-full'
  | 'empty-slot'
  | 'no-next'
  | 'out-of-bounds'
  | 'cell-occupied'
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
  rngState: number
}
