import type { Pos } from '../core/types'

/**
 * Animates the boss travelling along the route the rules layer chose.
 *
 * The rules resolve a turn synchronously, so by the time the view sees a
 * `pacmanAte` event the boss is already standing on the food. This class exists
 * purely to show the journey: it holds the sprite at a fractional position
 * between the event's `from` and its destination, one cell at a time.
 *
 * It deliberately owns no game state. If it is interrupted, the worst case is
 * that the sprite snaps to wherever the rules say the boss is — never a rules
 * inconsistency.
 */

/** Per-cell travel time. Fast enough that a long route is still a short wait. */
const STEP_MS = 105
/** Floor and ceiling on a whole journey, so neither a 1-cell hop nor a long
 *  walk across the board feels wrong. */
const MIN_TOTAL_MS = 170
const MAX_TOTAL_MS = 640

export class PacManAnimator {
  /** Waypoints still to visit, excluding the current position. */
  private route: Pos[] = []
  private elapsed = 0
  private total = 0
  private origin: Pos = { x: 0, y: 0 }
  private running = false

  /** True while the boss is visibly in motion. */
  get active(): boolean {
    return this.running
  }

  /** Total duration of the current journey, in ms. */
  get durationMs(): number {
    return this.total
  }

  /**
   * Starts a journey.
   *
   * Returns false and does nothing when there is nowhere to go, so callers can
   * treat "no animation" as "fire the effects right away".
   */
  begin(from: Pos, path: readonly Pos[]): boolean {
    this.cancel()
    if (path.length === 0) return false

    this.origin = { x: from.x, y: from.y }
    this.route = path.map((step) => ({ x: step.x, y: step.y }))
    this.total = Math.min(MAX_TOTAL_MS, Math.max(MIN_TOTAL_MS, this.route.length * STEP_MS))
    this.elapsed = 0
    this.running = true
    return true
  }

  /**
   * Advances the journey. Returns true on the frame it finishes, so the caller
   * can fire the arrival effects exactly once.
   */
  update(dtMs: number): boolean {
    if (!this.running) return false

    this.elapsed += dtMs
    if (this.elapsed < this.total) return false

    this.running = false
    return true
  }

  /**
   * Fractional board position, or null when idle.
   *
   * Interpolation is linear within a step, which reads as steady travel; the
   * eye follows that better than an eased curve when the subject is a sprite
   * chasing food.
   */
  position(): { x: number; y: number } | null {
    if (!this.running) return null

    const steps = this.route.length
    const progress = Math.min(1, this.elapsed / this.total)
    const travelled = progress * steps
    const index = Math.min(steps - 1, Math.floor(travelled))
    const withinStep = travelled - index

    const from = index === 0 ? this.origin : this.route[index - 1]
    const to = this.route[index]

    return {
      x: from.x + (to.x - from.x) * withinStep,
      y: from.y + (to.y - from.y) * withinStep
    }
  }

  /** Where the sprite is heading, or null when idle. */
  heading(): { x: number; y: number } | null {
    if (!this.running) return null
    const steps = this.route.length
    const progress = Math.min(1, this.elapsed / this.total)
    const index = Math.min(steps - 1, Math.floor(progress * steps))
    const from = index === 0 ? this.origin : this.route[index - 1]
    const to = this.route[index]
    return { x: to.x - from.x, y: to.y - from.y }
  }

  /** Stops immediately and snaps the sprite back to the rules' own position. */
  cancel(): void {
    this.running = false
    this.route = []
    this.elapsed = 0
    this.total = 0
  }
}
