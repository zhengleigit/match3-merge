import { Board } from './board'
import {
  advanceBoss,
  applyDamage,
  boardIsCleared,
  isSealedCell,
  mergeDamage,
  seedArena
} from './battle'
import { History, cloneSnapshot } from './history'
import { resolveCascade, scoreOfLevel, type CascadeOptions } from './merge'
import { fillStartObstacles, shouldSpawnObstacle, spawnObstacle } from './obstacles'
import { Rng, makeSeed } from './rng'
import { pickSpawnLevel, stepUnlockLevel } from './spawn'
import {
  CELL_EMPTY,
  type CascadeStep,
  type GameEvent,
  type GameSnapshot,
  type InvalidReason,
  type ModeConfig,
  type PacManState,
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
  /** Battle mode only; null in every other mode. */
  pacman: PacManState | null
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
  /** Battle mode boss; null in every other mode. */
  private boss: PacManState | null = null

  constructor(options: GameOptions) {
    this.mode = options.mode
    this.tuning = options.tuning
    this.board = new Board(options.tuning.board.width, options.tuning.board.height)
    this.rng = new Rng(options.seed ?? makeSeed())
    this.history = new History(options.tuning.history.limit)
    this.buffer = new Array<number>(options.tuning.buffer.slots).fill(CELL_EMPTY)

    this.buildOpening()

    if (options.tuning.next.preSeedAtStart) {
      this.next = this.rollSpawnLevel()
    }
  }

  /**
   * Lays out the mode's starting board.
   *
   * The opening position is board state, not a turn outcome, so it is built
   * once and then captured by the first snapshot like everything else. Both the
   * constructor and `restart()` go through here on purpose: a restart that
   * rebuilt the board without the opening obstacles would hand the player a
   * different — and much easier — board than the run started with.
   */
  private buildOpening(): void {
    if (this.mode.obstacles) {
      fillStartObstacles(this.board, this.tuning.obstacles.startClear)
    }

    if (this.mode.battle) {
      this.boss = seedArena(this.board, this.tuning.battle, (n) => this.rng.int(n))
    } else {
      this.boss = null
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
    if (this.isSealed(x, y)) return false
    return this.board.isEmpty(x, y)
  }

  /**
   * True for cells the player may never place into in battle mode: the cage,
   * the wall, and the wall's gap (which is the boss's doorway).
   */
  private isSealed(x: number, y: number): boolean {
    if (!this.mode.battle) return false
    if (!this.board.inBounds(x, y)) return false
    return isSealedCell(this.tuning.battle, y)
  }

  /** Copy of the boss state, safe for the view to hold on to. */
  private bossView(): PacManState | null {
    return this.boss === null ? null : { ...this.boss }
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
      boardFull: this.isBoardFull(),
      pacman: this.bossView()
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

    this.steps++

    if (this.boss !== null) {
      // Battle resolves in a fixed order, and the order matters: the merge's
      // damage lands first, so a killing blow stops the boss from taking the
      // bite that this very placement would otherwise have earned it.
      const aftermath = this.resolveBattleTurn(cascade.steps)
      events.push(...aftermath.events)
      if (aftermath.over) return events
    } else {
      // Step bookkeeping happens after the chain so obstacles reflect the result.
      events.push(...this.maybeSpawnObstacle())
    }

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

  /**
   * The boss half of a battle turn: merge damage, then the action bar.
   *
   * Damage is applied per chain link rather than as one lump, so the view can
   * burst particles on the step that actually caused the wound.
   */
  private resolveBattleTurn(steps: readonly CascadeStep[]): {
    events: GameEvent[]
    over: boolean
  } {
    const config = this.tuning.battle
    const boss = this.boss
    if (boss === null) return { events: [], over: false }

    const events: GameEvent[] = []
    const score = (level: number): number => scoreOfLevel(this.mode.scoreByLevel, level)

    let merged = false

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      for (let e = 0; e < step.events.length; e++) {
        const event = step.events[e]
        if (event.type !== 'merged' && event.type !== 'maxCleared') continue
        merged = true

        // `merged` reports the level it consumed as `fromLevel`; `maxCleared`
        // reports it as `level`. Both are the level of the blocks destroyed,
        // which is what decides whether this hit was strong enough to wound.
        const consumedLevel = event.type === 'merged' ? event.fromLevel : event.level
        const damage = mergeDamage(config, consumedLevel, event.consumed, score)
        if (!damage.dealt) continue

        // The boss is untouchable while it is sealed in the cage — including the
        // moment it stands in the wall's gap, which is still not the field. Only
        // once it is loose on the board can it be hurt.
        if (boss.phase !== 'board') {
          const blocked: GameEvent = {
            type: 'pacmanImmune',
            x: boss.x,
            y: boss.y,
            srcX: event.x,
            srcY: event.y
          }
          ;(step.events as GameEvent[]).push(blocked)
          events.push(blocked)
          continue
        }

        const lethal = applyDamage(boss, damage.amount)
        const wound: GameEvent = {
          type: 'pacmanHurt',
          // The boss is where the damage lands...
          x: boss.x,
          y: boss.y,
          // ...and the merge cell is where the shot comes from.
          srcX: event.x,
          srcY: event.y,
          amount: damage.amount,
          hp: boss.hp
        }
        // Attaching it to the chain step is what sequences the effect with the
        // merge that caused it rather than firing it all at once.
        ;(step.events as GameEvent[]).push(wound)
        events.push(wound)

        if (lethal) {
          this.hasWon = true
          const defeat: GameEvent = {
            type: 'pacmanDefeated',
            x: boss.x,
            y: boss.y,
            hp: boss.hp,
            score: this.score
          }
          events.push(defeat)
          return { events, over: true }
        }
      }
    }

    // Merging is the player's defence: a turn that produced one contributes no
    // action-bar progress, so it buys a turn rather than pushing the boss back.
    const turn = advanceBoss(this.board, config, boss, score, merged)
    events.push(...turn.events)

    if (boardIsCleared(this.board, config)) {
      this.gameOver = true
      events.push({ type: 'gameOver', score: this.score })
      return { events, over: true }
    }

    return { events, over: false }
  }

  /** Returns the rejection event for an illegal target cell, or null when fine. */
  private checkTarget(x: number, y: number): GameEvent | null {
    if (!this.board.inBounds(x, y)) return this.invalid('out-of-bounds')
    // Sealed cells are rejected before the occupancy check so the player is told
    // "you can't build here" rather than "that cell is taken".
    if (this.isSealed(x, y)) return this.invalid('sealed-zone')
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

    // A fresh opening: the pocket is re-walled and the cage is restocked.
    this.buildOpening()

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
      pacman: this.boss === null ? null : { ...this.boss },
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
    this.boss = copy.pacman
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
    // The rate escalates with the step count, so which interval applies is a
    // pure function of `steps`.
    if (!shouldSpawnObstacle(this.tuning.obstacles.spawnBands, this.steps)) return []

    const spot = spawnObstacle(this.board, this.rng)
    if (spot === null) return []
    return [{ type: 'obstacleSpawned', x: spot.x, y: spot.y }]
  }

  /**
   * True when nothing can be placed anywhere any more.
   *
   * `spawnObstacle` only drops into empty cells, so in obstacle mode this is
   * effectively "the board is full". Battle mode needs the narrow definition
   * instead: its cage starts full and the wall can never be used, so counting
   * the whole board would report a loss on the very first frame.
   */
  private isBoardFull(): boolean {
    if (!this.mode.battle) return !this.board.hasEmptyCell()
    return !this.board.hasFreeCellInRows(this.tuning.battle.wallRow + 1, this.board.height - 1)
  }

  private checkGameOver(): GameEvent[] {
    // Battle mode has its own losing condition (the board running out of
    // blocks), evaluated inside resolveBattleTurn.
    if (this.mode.battle) return []
    if (!this.isBoardFull()) return []
    this.gameOver = true
    return [{ type: 'gameOver', score: this.score }]
  }
}
