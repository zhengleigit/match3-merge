import type { FloaterSpec } from '../core/fxMap'

/**
 * Score floaters ("+74", "+1", chain multipliers).
 *
 * Pooled like the particle system: fixed-size typed arrays, no allocation on
 * the per-frame path. The label string is created once when the floater is
 * spawned, never while drawing.
 */

const CAPACITY = 48
const LIFE_MS = 900
const RISE_PX = 34

export type FloaterTone = FloaterSpec['tone']

export class FloaterSystem {
  private readonly px = new Float32Array(CAPACITY)
  private readonly py = new Float32Array(CAPACITY)
  private readonly life = new Float32Array(CAPACITY)
  private readonly tone = new Uint8Array(CAPACITY)
  private readonly labels: Array<string | null> = new Array(CAPACITY).fill(null)
  private cursor = 0

  // Font strings are rebuilt only when the size changes, so draw() never
  // allocates (concatenating a string per floater per frame would).
  private cachedFontPx = -1
  private fontNormal = ''
  private fontBonus = ''

  /** Adds a floater at a canvas-pixel position. */
  add(px: number, py: number, text: string, tone: FloaterTone): void {
    const index = this.cursor
    this.cursor = (this.cursor + 1) % CAPACITY

    this.px[index] = px
    this.py[index] = py
    this.life[index] = LIFE_MS
    this.tone[index] = tone === 'bonus' ? 2 : tone === 'chain' ? 1 : 0
    this.labels[index] = text
  }

  update(dtMs: number): void {
    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dtMs
      this.py[i] -= (RISE_PX * dtMs) / LIFE_MS
    }
  }

  draw(ctx: CanvasRenderingContext2D, fontPx: number): void {
    if (fontPx !== this.cachedFontPx) {
      this.cachedFontPx = fontPx
      this.fontNormal = `600 ${Math.round(fontPx * 1.1)}px system-ui, "Microsoft YaHei", sans-serif`
      this.fontBonus = `700 ${Math.round(fontPx * 1.5)}px system-ui, "Microsoft YaHei", sans-serif`
    }

    let drawing = false

    for (let i = 0; i < CAPACITY; i++) {
      const remaining = this.life[i]
      const label = this.labels[i]
      if (remaining <= 0 || label === null) continue

      if (!drawing) {
        ctx.save()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        drawing = true
      }

      const t = remaining / LIFE_MS
      // Pop in quickly, fade out at the end.
      const appear = t > 0.85 ? (1 - t) / 0.15 : 1
      ctx.globalAlpha = Math.min(1, appear) * Math.min(1, t * 2.6)

      const kind = this.tone[i]
      ctx.font = kind === 2 ? this.fontBonus : this.fontNormal
      ctx.fillStyle = kind === 2 ? '#ffd166' : kind === 1 ? '#9ae6b4' : '#e8ecf5'

      ctx.fillText(label, this.px[i], this.py[i])
    }

    if (drawing) {
      ctx.restore()
      ctx.globalAlpha = 1
    }
  }

  clear(): void {
    this.life.fill(0)
    this.labels.fill(null)
    this.cursor = 0
  }
}
