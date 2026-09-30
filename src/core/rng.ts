/**
 * Seeded RNG (mulberry32).
 *
 * Deterministic by design, and — critically — its state can be read and
 * restored. That is what lets `undo` roll back randomness so a player cannot
 * reroll the "next" block by undoing and replaying the same move.
 */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /**
   * Current internal state, safe to persist in a snapshot.
   *
   * Normalised to an unsigned 32-bit value so a snapshot taken before an
   * action compares equal to one captured after a restore. The internal
   * arithmetic keeps the state as a signed int32, which would otherwise make
   * the same bit pattern look like two different numbers.
   */
  getState(): number {
    return this.state >>> 0
  }

  /** Restore a previously captured state (used by undo). */
  setState(state: number): void {
    this.state = state | 0
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0
    return Math.floor(this.next() * maxExclusive)
  }

  /**
   * Weighted pick. Weights must be non-negative; the table is expected to be
   * pre-truncated to the unlocked range by the caller.
   * Returns the chosen index, or -1 when every weight is zero.
   */
  pickWeighted(weights: readonly number[]): number {
    let total = 0
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]
      if (w > 0) total += w
    }
    if (total <= 0) return -1

    let roll = this.next() * total
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]
      if (w <= 0) continue
      roll -= w
      if (roll < 0) return i
    }
    // Floating point guard: fall back to the last non-zero weight.
    for (let i = weights.length - 1; i >= 0; i--) {
      if (weights[i] > 0) return i
    }
    return -1
  }
}

/** Fresh seed for a new run. Kept injectable so tests stay deterministic. */
export function makeSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
}
