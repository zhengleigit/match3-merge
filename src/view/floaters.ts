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

/**
 * Tones are mapped to small integers once, here, so the per-floater and
 * per-frame paths only ever deal in numbers — no string comparison while
 * drawing, and adding a tone is a one-line change.
 */
const TONE_SCORE = 0
const TONE_CHAIN = 1
const TONE_BONUS = 2
const TONE_HEAL = 3
const TONE_DAMAGE = 4
const TONE_IMMUNE = 5

const FLOATER_TONE_INDEX: Record<FloaterTone, number> = {
  score: TONE_SCORE,
  chain: TONE_CHAIN,
  bonus: TONE_BONUS,
  heal: TONE_HEAL,
  damage: TONE_DAMAGE,
  immune: TONE_IMMUNE
}

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
    this.tone[index] = FLOATER_TONE_INDEX[tone]
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
      ctx.font =
        kind === TONE_BONUS || kind === TONE_HEAL || kind === TONE_DAMAGE || kind === TONE_IMMUNE
          ? this.fontBonus
          : this.fontNormal
      ctx.fillStyle =
        kind === TONE_BONUS
          ? '#ffd166'
          : kind === TONE_HEAL
            ? '#8ef0b4'
            : kind === TONE_DAMAGE
              ? '#ff8fa3'
              : kind === TONE_IMMUNE
                ? '#a8b6d8'
                : kind === TONE_CHAIN
                  ? '#9ae6b4'
                  : '#e8ecf5'

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
