import { Board } from './board'
import { History, cloneSnapshot } from './history'
import { resolveCascade, type CascadeOptions } from './merge'
import { spawnObstacle } from './obstacles'
import { Rng, makeSeed } from './rng'
import { pickSpawnLevel, stepUnlockLevel } from './spawn'
import {
  CELL_EMPTY,
  type GameEvent,
  type GameSnapshot,
  type InvalidReason,
  type ModeConfig,
  type Tuning
} from './types'

export interface GameOptions {
  mode: ModeConfig
  tuning: Tuning
  /** Injected so runs (and tests) are reproducible. */
  seed?: number
}

/** Read-only state handed to the presentation layer each frame. */
export interface GameView {
  modeId: string
  modeName: string
  width: number
  height: number
  cells: number[]
  /** Buffer slots; 0 means the slot is empty. */
  buffer: number[]
  /** The next block; 0 means none. */
  next: number
  score: number
  steps: number
  maxReachedLevel: number
  levelCount: number
  scoreByLevel: number[]
  hasWon: boolean
  gameOver: boolean
  pendingWin: { level: number; score: number } | null
  canUndo: boolean
  /** True when no empty cell is left (the losing condition). */
  boardFull: boolean
}

/**
 * The rules state machine.
 *
 * Turn order for a placement:
 *   place -> cascade merges -> step count -> obstacle spawn -> win / game over
 *
 * A snapshot is taken before each placement, so `undo` rewinds the whole turn
 * (chain, obstacle spawn, obstacle clears, score and RNG) in one action.
 */
export class Game {
  readonly mode: ModeConfig
  readonly tuning: Tuning

  private board: Board
  private rng: Rng
  private history: History

  private buffer: number[]
  private next = CELL_EMPTY
  private score = 0
  private steps = 0
  private maxReachedLevel = 1
  private hasWon = false
  private gameOver = false
  private pendingWin: { level: number; score: number } | null = null
  /** Position of a cascade paused by the win, so "continue" can resume it. */
  private resume: { x: number; y: number; level: number } | null = null

  constructor(options: GameOptions) {
    this.mode = options.mode
    this.tuning = options.tuning
    this.board = new Board(options.tuning.board.width, options.tuning.board.height)
    this.rng = new Rng(options.seed ?? makeSeed())
    this.history = new History(options.tuning.history.limit)
    this.buffer = new Array<number>(options.tuning.buffer.slots).fill(CELL_EMPTY)

    if (options.tuning.next.preSeedAtStart) {
      this.next = this.rollSpawnLevel()
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  get levelCount(): number {
    return this.mode.scoreByLevel.length
  }

  canUndo(): boolean {
    return this.history.canUndo()
  }

  /** True when the cell can accept a block right now. */
  canPlaceAt(x: number, y: number): boolean {
    return this.board.isEmpty(x, y)
  }

  view(): GameView {
    return {
      modeId: this.mode.id,
      modeName: this.mode.name,
      width: this.board.width,
      height: this.board.height,
      cells: this.board.toArray(),
      buffer: this.buffer.slice(),
      next: this.next,
      score: this.score,
      steps: this.steps,
      maxReachedLevel: this.maxReachedLevel,
      levelCount: this.levelCount,
      scoreByLevel: this.mode.scoreByLevel.slice(),
      hasWon: this.hasWon,
      gameOver: this.gameOver,
      pendingWin: this.pendingWin === null ? null : { ...this.pendingWin },
      canUndo: this.history.canUndo(),
      boardFull: !this.board.hasEmptyCell()
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Moves the "next" block into a buffer slot, then rolls a replacement.
   * Blocked while the game is over or a win dialog is pending.
   */
  pullNextToBuffer(slot?: number): GameEvent[] {
    if (this.isInputBlocked()) {
      return [this.invalid(this.gameOver ? 'game-over' : 'win-pending')]
    }
    if (this.next === CELL_EMPTY) {
      return [this.invalid('no-next')]
    }

    const target = this.resolveBufferSlot(slot)
    if (target < 0) {
      return [this.invalid('buffer-full')]
    }

    this.history.push(this.snapshot())

    const level = this.next
    this.buffer[target] = level
    const events: GameEvent[] = [{ type: 'toBuffer', level, slot: target }]

    this.next = this.rollSpawnLevel()
    if (this.next !== CELL_EMPTY) {
      events.push({ type: 'spawned', level: this.next })
    }

    return events
  }

  /** Places a buffered block on the board and resolves everything it triggers. */
  placeFromBuffer(slot: number, x: number, y: number): GameEvent[] {
    if (this.isInputBlocked()) {
      return [this.invalid(this.gameOver ? 'game-over' : 'win-pending')]
    }
    if (slot < 0 || slot >= this.buffer.length || this.buffer[slot] <= 0) {
      return [this.invalid('empty-slot')]
    }

    const rejection = this.checkTarget(x, y)
    if (rejection !== null) return [rejection]

    this.history.push(this.snapshot())

    const level = this.buffer[slot]
    this.buffer[slot] = CELL_EMPTY
    return this.placeAt(x, y, level)
  }

  /**
   * Places the "next" block straight onto the board, skipping the buffer.
   *
   * This is what makes dragging from "next" work even when all three buffer
   * slots are occupied: the block never needs to be staged.
   */
  placeFromNext(x: number, y: number): GameEvent[] {
    if (this.isInputBlocked()) {
      return [this.invalid(this.gameOver ? 'game-over' : 'win-pending')]
    }
    if (this.next === CELL_EMPTY) {
      return [this.invalid('no-next')]
    }

    const rejection = this.checkTarget(x, y)
    if (rejection !== null) return [rejection]

    this.history.push(this.snapshot())

    const level = this.next
    // A replacement is rolled immediately, mirroring the buffer flow.
    this.next = this.rollSpawnLevel()
    return this.placeAt(x, y, level)
  }

  /** Shared placement resolution: cascade, step count, obstacles, win/lose. */
  private placeAt(x: number, y: number, level: number): GameEvent[] {
    this.board.set(x, y, level)

    const events: GameEvent[] = [{ type: 'placed', x, y, level }]

    const cascade = resolveCascade(this.board, x, y, level, this.cascadeOptions())
    events.push(...cascade.events)
    // The per-step breakdown lets the view animate an automatic chain link by
    // link instead of dumping every merge on screen at once.
    if (cascade.steps.length > 0) {
      events.push({ type: 'cascadeSteps', steps: cascade.steps })
    }
    this.score += cascade.score
    if (cascade.maxCreatedLevel > this.maxReachedLevel) {
      this.maxReachedLevel = cascade.maxCreatedLevel
    }

    // Step bookkeeping happens after the chain so obstacles reflect the result.
    this.steps++
    events.push(...this.maybeSpawnObstacle())

    if (cascade.stoppedForWin && cascade.resume !== null) {
      // Claim the win exactly once per run; the dialog pauses the cascade.
      this.hasWon = true
      this.pendingWin = { level: cascade.resume.level, score: this.score }
      this.resume = cascade.resume
      events.push({ type: 'win', level: cascade.resume.level, score: this.score })
      return events
    }

    events.push(...this.checkGameOver())
    return events
  }

  /** Returns the rejection event for an illegal target cell, or null when fine. */
  private checkTarget(x: number, y: number): GameEvent | null {
    if (!this.board.inBounds(x, y)) return this.invalid('out-of-bounds')
    if (!this.board.isEmpty(x, y)) return this.invalid('cell-occupied')
    return null
  }

  /** Player chose "keep playing" after winning: finish the paused cascade. */
  continueAfterWin(): GameEvent[] {
    if (this.pendingWin === null || this.resume === null) {
      return [this.invalid('win-pending')]
    }

    const { x, y, level } = this.resume
    const options: CascadeOptions = { ...this.cascadeOptions(), winAlreadyClaimed: true }
    const cascade = resolveCascade(this.board, x, y, level, options)

    this.score += cascade.score
    if (cascade.maxCreatedLevel > this.maxReachedLevel) {
      this.maxReachedLevel = cascade.maxCreatedLevel
    }
    this.pendingWin = null
    this.resume = null

    const events: GameEvent[] = [...cascade.events]
    events.push(...this.checkGameOver())
    return events
  }

  /** Player chose "end run" after winning. */
  endAfterWin(): GameEvent[] {
    if (this.pendingWin === null) {
      return [this.invalid('win-pending')]
    }
    this.pendingWin = null
    this.resume = null
    this.gameOver = true
    return [{ type: 'gameOver', score: this.score }]
  }

  /** Rewinds the last placement in full (including cascades, obstacles, RNG). */
  undo(): GameEvent[] {
    const snapshot = this.history.pop()
    if (snapshot === null) {
      return [this.invalid('no-history')]
    }
    this.restore(snapshot)
    return [{ type: 'undo' }]
  }

  /** Clears the board, resets the score and drops the undo history. */
  restart(seed?: number): GameEvent[] {
    this.board = new Board(this.tuning.board.width, this.tuning.board.height)
    this.rng = new Rng(seed ?? makeSeed())
    this.history.clear()
    this.buffer = new Array<number>(this.tuning.buffer.slots).fill(CELL_EMPTY)
    this.next = CELL_EMPTY
    this.score = 0
    this.steps = 0
    this.maxReachedLevel = 1
    this.hasWon = false
    this.gameOver = false
    this.pendingWin = null
    this.resume = null

    if (this.tuning.next.preSeedAtStart) {
      this.next = this.rollSpawnLevel()
    }

    return [{ type: 'restarted' }]
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  snapshot(): GameSnapshot {
    return {
      cells: this.board.toArray(),
      buffer: this.buffer.slice(),
      next: this.next,
      score: this.score,
      steps: this.steps,
      maxReachedLevel: this.maxReachedLevel,
      hasWon: this.hasWon,
      gameOver: this.gameOver,
      pendingWin: this.pendingWin === null ? null : { ...this.pendingWin },
      rngState: this.rng.getState()
    }
  }

  restore(snapshot: GameSnapshot): void {
    const copy = cloneSnapshot(snapshot)
    this.board.copyFromArray(copy.cells)
    this.buffer = copy.buffer
    this.next = copy.next
    this.score = copy.score
    this.steps = copy.steps
    this.maxReachedLevel = copy.maxReachedLevel
    this.hasWon = copy.hasWon
    this.gameOver = copy.gameOver
    this.pendingWin = copy.pendingWin
    // A paused cascade cannot survive a rewind: the win flag is restored above,
    // so a replayed placement resolves normally instead of re-triggering a win.
    this.resume = null
    this.rng.setState(copy.rngState)
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isInputBlocked(): boolean {
    return this.gameOver || this.pendingWin !== null
  }

  private invalid(reason: InvalidReason): GameEvent {
    return { type: 'invalid', reason }
  }

  private resolveBufferSlot(slot?: number): number {
    if (slot !== undefined) {
      if (slot < 0 || slot >= this.buffer.length) return -1
      return this.buffer[slot] === CELL_EMPTY ? slot : -1
    }
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] === CELL_EMPTY) return i
    }
    return -1
  }

  private cascadeOptions(): CascadeOptions {
    return {
      scoreByLevel: this.mode.scoreByLevel,
      maxLevelBonus: this.mode.maxLevelBonus,
      obstacleClearBonus: this.tuning.obstacles.clearBonus,
      obstacleHits: this.tuning.obstacles.hits,
      obstacleBreakOutrightAtMaxLevel: this.tuning.obstacles.breakOutrightAtMaxLevel,
      winAtLevel: this.mode.winAtLevel,
      winAlreadyClaimed: this.hasWon,
      cascadeEnabled: this.tuning.cascade.enabled
    }
  }

  private rollSpawnLevel(): number {
    const fallback = this.tuning.unlock.stepUnlockFallback
    const bySteps = stepUnlockLevel(
      this.steps,
      fallback.enabled,
      fallback.stepsPerLevel,
      this.levelCount
    )
    const unlocked = Math.max(this.maxReachedLevel, bySteps)
    return pickSpawnLevel(this.rng, this.tuning.unlock.spawnWeights, unlocked, this.levelCount)
  }

  private maybeSpawnObstacle(): GameEvent[] {
    if (!this.mode.obstacles) return []
    if (this.steps % this.tuning.obstacles.spawnEverySteps !== 0) return []

    const spot = spawnObstacle(this.board, this.rng)
    if (spot === null) return []
    return [{ type: 'obstacleSpawned', x: spot.x, y: spot.y }]
  }

  private checkGameOver(): GameEvent[] {
    if (this.board.hasEmptyCell()) return []
    this.gameOver = true
    return [{ type: 'gameOver', score: this.score }]
  }
}
