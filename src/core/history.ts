import type { GameSnapshot } from './types'

/**
 * Undo stack of whole-turn snapshots.
 *
 * Why snapshots instead of inverse operations: a single placement can trigger
 * a chain, an obstacle spawn, obstacle clears, score changes and an RNG
 * advance. Inverting all of that requires mirror logic per subsystem, and one
 * missed field becomes an unreproducible bug. Restoring a snapshot is a single
 * code path that tests can assert with a deep equality check.
 *
 * Cost is negligible: a 7x10 board snapshot is a few hundred bytes, capped at
 * `limit` entries (200 by default).
 */
export class History {
  private readonly limit: number
  private stack: GameSnapshot[] = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  push(snapshot: GameSnapshot): void {
    this.stack.push(snapshot)
    if (this.stack.length > this.limit) {
      // Drop the oldest entry so memory stays bounded.
      this.stack.splice(0, this.stack.length - this.limit)
    }
  }

  pop(): GameSnapshot | null {
    const snapshot = this.stack.pop()
    return snapshot === undefined ? null : snapshot
  }

  peek(): GameSnapshot | null {
    const snapshot = this.stack[this.stack.length - 1]
    return snapshot === undefined ? null : snapshot
  }

  canUndo(): boolean {
    return this.stack.length > 0
  }

  size(): number {
    return this.stack.length
  }

  clear(): void {
    this.stack = []
  }
}

/**
 * Deep copy used both for pushing snapshots and for test comparisons.
 * Every field is a primitive or a flat number array, so an explicit copy is
 * both correct and cheaper than structuredClone.
 */
export function cloneSnapshot(snapshot: GameSnapshot): GameSnapshot {
  return {
    cells: snapshot.cells.slice(),
    buffer: snapshot.buffer.slice(),
    next: snapshot.next,
    score: snapshot.score,
    steps: snapshot.steps,
    maxReachedLevel: snapshot.maxReachedLevel,
    hasWon: snapshot.hasWon,
    gameOver: snapshot.gameOver,
    pendingWin:
      snapshot.pendingWin === null
        ? null
        : { level: snapshot.pendingWin.level, score: snapshot.pendingWin.score },
    pacman: snapshot.pacman === null ? null : { ...snapshot.pacman },
    rngState: snapshot.rngState
  }
}
