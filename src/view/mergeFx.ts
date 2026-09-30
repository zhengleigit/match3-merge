import type { MergeBurstSpec } from '../core/fxMap'
import type { ThemeAssets } from './assets'
import { boardCellRect, type Layout, type Rect } from './layout'
import { SpriteStyles, drawBlock, roundRectPath } from './sprites'

/**
 * Merge animation: the blocks that were consumed swell up, flash white, then
 * collapse into the cell where the new block appears.
 *
 * Pooled and allocation-free on the frame path, like the particle system: a
 * fixed set of slots each holding a fixed-capacity typed array of source
 * positions. Nothing is created while updating or drawing.
 */

const MAX_EFFECTS = 8
/** A merge consumes at least 3 blocks; 8 is far more than any real cluster. */
const MAX_CELLS = 8

const DURATION_NORMAL_MS = 300
const DURATION_BIG_MS = 460

/** Fraction of the timeline spent swelling before the collapse starts. */
const SWELL_END = 0.34
const SWELL_SCALE = 0.22
/** The flash is brightest just as the collapse begins. */
const FLASH_PEAK = 0.85

interface Effect {
  active: boolean
  elapsed: number
  duration: number
  count: number
  targetX: number
  targetY: number
  level: number
  big: boolean
  xs: Float32Array
  ys: Float32Array
}

function easeOutCubic(t: number): number {
  const inv = 1 - t
  return 1 - inv * inv * inv
}

function easeInCubic(t: number): number {
  return t * t * t
}

export class MergeFxSystem {
  private readonly effects: Effect[] = []
  private cursor = 0

  constructor() {
    for (let i = 0; i < MAX_EFFECTS; i++) {
      this.effects.push({
        active: false,
        elapsed: 0,
        duration: DURATION_NORMAL_MS,
        count: 0,
        targetX: 0,
        targetY: 0,
        level: 0,
        big: false,
        xs: new Float32Array(MAX_CELLS),
        ys: new Float32Array(MAX_CELLS)
      })
    }
  }

  get activeCount(): number {
    let n = 0
    for (let i = 0; i < this.effects.length; i++) if (this.effects[i].active) n++
    return n
  }

  /** Starts one animation. Oldest effect is reused when the pool is full. */
  add(spec: MergeBurstSpec): void {
    const effect = this.effects[this.cursor]
    this.cursor = (this.cursor + 1) % this.effects.length

    const count = Math.min(spec.cells.length, MAX_CELLS)
    for (let i = 0; i < count; i++) {
      effect.xs[i] = spec.cells[i].x
      effect.ys[i] = spec.cells[i].y
    }

    effect.active = count > 0
    effect.elapsed = 0
    effect.duration = spec.big ? DURATION_BIG_MS : DURATION_NORMAL_MS
    effect.count = count
    effect.targetX = spec.target.x
    effect.targetY = spec.target.y
    effect.level = spec.toLevel
    effect.big = spec.big
  }

  update(dtMs: number): void {
    for (let i = 0; i < this.effects.length; i++) {
      const effect = this.effects[i]
      if (!effect.active) continue

      effect.elapsed += dtMs
      if (effect.elapsed >= effect.duration) effect.active = false
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    layout: Layout,
    assets: ThemeAssets,
    styles: SpriteStyles,
    labels: readonly string[],
    levelCount: number
  ): void {
    for (let i = 0; i < this.effects.length; i++) {
      const effect = this.effects[i]
      if (!effect.active) continue

      const p = Math.min(1, effect.elapsed / effect.duration)
      const cell = layout.cell
      const targetRect = boardCellRect(layout, effect.targetX, effect.targetY)

      for (let c = 0; c < effect.count; c++) {
        const sourceRect = boardCellRect(
          layout,
          Math.round(effect.xs[c]),
          Math.round(effect.ys[c])
        )

        let centreX = sourceRect.x + sourceRect.size / 2
        let centreY = sourceRect.y + sourceRect.size / 2
        let scale: number
        let alpha: number

        if (p <= SWELL_END) {
          // Swell and brighten in place.
          const t = p / SWELL_END
          scale = 1 + SWELL_SCALE * easeOutCubic(t)
          alpha = 1
        } else {
          // Collapse into the target while fading out.
          const t = (p - SWELL_END) / (1 - SWELL_END)
          const move = easeInCubic(t)
          const targetCentreX = targetRect.x + targetRect.size / 2
          const targetCentreY = targetRect.y + targetRect.size / 2
          centreX += (targetCentreX - centreX) * move
          centreY += (targetCentreY - centreY) * move
          scale = (1 + SWELL_SCALE) * (1 - 0.55 * move)
          alpha = 1 - t
        }

        const size = cell * scale
        const rect: Rect = {
          x: centreX - size / 2,
          y: centreY - size / 2,
          size
        }

        ctx.save()
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
        // The created level is shown while collapsing so the eye connects the
        // consumed blocks to the block they become.
        const drawLevel = effect.level > 0 ? effect.level : 1
        drawBlock(ctx, assets, styles, rect, drawLevel, levelCount, labels)

        // White flash, peaking as the collapse starts.
        const flash =
          p <= SWELL_END
            ? (p / SWELL_END) * FLASH_PEAK
            : FLASH_PEAK * (1 - (p - SWELL_END) / (1 - SWELL_END))
        if (flash > 0.01) {
          ctx.globalAlpha = Math.max(0, Math.min(1, flash * (effect.big ? 1 : 0.8)))
          ctx.fillStyle = '#ffffff'
          roundRectPath(ctx, rect.x, rect.y, rect.size, rect.size, rect.size * 0.24)
          ctx.fill()
        }
        ctx.restore()
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.effects.length; i++) this.effects[i].active = false
    this.cursor = 0
  }
}
