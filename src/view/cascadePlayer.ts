import type { CascadeStep } from '../core/types'

/**
 * Plays an automatic merge chain one link at a time.
 *
 * Why this exists: the rules layer resolves a whole cascade synchronously, so
 * without sequencing every merge of a chain lands on screen in the same frame
 * and the player cannot see what caused what. This walks the chain step by
 * step, holding the pre-step board on screen while each merge animates, then
 * revealing the post-step board.
 *
 * Allocation-free on the frame path: it only holds references to the step data
 * the rules layer already produced.
 */

const STEP_MS = 330
/** A max-level clear has a longer animation and needs more room. */
const STEP_MS_BIG = 500

export interface CascadeTick {
  /** The step whose animation just began, or null. */
  started: CascadeStep | null
  /** True on the frame the whole chain finished. */
  finished: boolean
}

export class CascadePlayer {
  private steps: readonly CascadeStep[] = []
  private index = -1
  private stepElapsed = 0
  private stepDuration = STEP_MS
  private running = false
  /**
   * Whether the current link has already been reported as started.
   *
   * Deliberately an explicit flag rather than `stepElapsed === 0`: `advance()`
   * resets the elapsed time, so inferring "just started" from it made every
   * link report twice and fire its sound and particles double.
   */
  private reported = false

  /** True while a chain is being animated (input should be ignored). */
  get active(): boolean {
    return this.running
  }

  /** 1-based index of the link being shown; 0 when idle. */
  get currentStep(): number {
    return this.running ? this.index + 1 : 0
  }

  get totalSteps(): number {
    return this.steps.length
  }

  /**
   * Starts playing a chain. Returns false when there is nothing to sequence,
   * in which case the caller should apply the effects immediately.
   */
  begin(steps: readonly CascadeStep[]): boolean {
    if (steps.length === 0) return false

    this.steps = steps
    this.index = 0
    this.stepElapsed = 0
    this.stepDuration = stepDurationOf(steps[0])
    this.running = true
    this.reported = false
    return true
  }

  /**
   * Advances the timeline. `started` is reported on the first frame of each
   * link so the caller can fire that link's effects exactly once.
   */
  update(dtMs: number): CascadeTick {
    if (!this.running) return { started: null, finished: false }

    let started: CascadeStep | null = null
    if (!this.reported) {
      started = this.steps[this.index] ?? null
      this.reported = true
    }

    this.stepElapsed += dtMs
    if (this.stepElapsed < this.stepDuration) {
      return { started, finished: false }
    }

    // This link is done. Either move on (the next link is reported on the
    // following frame) or finish the chain.
    const nextIndex = this.index + 1
    if (nextIndex >= this.steps.length) {
      this.running = false
      this.steps = []
      this.index = -1
      this.stepElapsed = 0
      return { started, finished: true }
    }

    this.index = nextIndex
    this.stepElapsed = 0
    this.stepDuration = stepDurationOf(this.steps[nextIndex])
    this.reported = false
    return { started, finished: false }
  }

  /**
   * Board to render instead of the live one, or null when idle.
   *
   * While a link animates we show the board *before* that link, so the blocks
   * about to be consumed are visible and the new block appears only when the
   * link completes.
   */
  overrideCells(): number[] | null {
    if (!this.running) return null
    const current = this.steps[this.index]
    return current === undefined ? null : current.cellsBefore
  }

  /** Aborts playback (undo, restart, mode change). */
  cancel(): void {
    this.running = false
    this.steps = []
    this.index = -1
    this.stepElapsed = 0
  }
}

function stepDurationOf(step: CascadeStep | undefined): number {
  if (step === undefined) return STEP_MS
  for (let i = 0; i < step.events.length; i++) {
    if (step.events[i].type === 'maxCleared') return STEP_MS_BIG
  }
  return STEP_MS
}
