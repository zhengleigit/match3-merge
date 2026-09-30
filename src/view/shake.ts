import { fxConfig, type ShakeSpec } from '../core/fxMap'

/**
 * Screen shake.
 *
 * Driven by a decaying oscillation rather than per-frame randomness: jitter
 * looks like a rendering glitch, whereas a smooth decaying wave reads as
 * impact. Strength is normalised (0..1) and scaled by the config's pixel cap.
 */
export class Shake {
  private strength = 0
  private remainingMs = 0
  private durationMs = 0
  private elapsedMs = 0
  private offsetX = 0
  private offsetY = 0

  /** Applies a new shake, keeping the strongest one if two land together. */
  apply(spec: ShakeSpec | null, reducedMotion: boolean): void {
    if (spec === null || reducedMotion || spec.strength <= 0) return
    if (spec.strength < this.strength && this.remainingMs > 0) return

    this.strength = Math.min(1, spec.strength)
    this.durationMs = Math.min(spec.durationMs, fxConfig.shake.maxDurationMs)
    this.remainingMs = this.durationMs
    this.elapsedMs = 0
  }

  update(dtMs: number): void {
    if (this.remainingMs <= 0) {
      this.offsetX = 0
      this.offsetY = 0
      return
    }

    this.remainingMs -= dtMs
    this.elapsedMs += dtMs

    if (this.remainingMs <= 0) {
      this.strength = 0
      this.offsetX = 0
      this.offsetY = 0
      return
    }

    const progress = this.durationMs > 0 ? this.elapsedMs / this.durationMs : 1
    const decay = (1 - progress) * (1 - progress)
    const amplitude = this.strength * fxConfig.shake.maxOffsetPx * decay

    // Two incommensurate frequencies so the motion does not look periodic.
    this.offsetX = Math.sin(this.elapsedMs * 0.045) * amplitude
    this.offsetY = Math.cos(this.elapsedMs * 0.031) * amplitude * 0.75
  }

  get x(): number {
    return this.offsetX
  }

  get y(): number {
    return this.offsetY
  }

  get active(): boolean {
    return this.remainingMs > 0
  }

  clear(): void {
    this.strength = 0
    this.remainingMs = 0
    this.elapsedMs = 0
    this.offsetX = 0
    this.offsetY = 0
  }
}
