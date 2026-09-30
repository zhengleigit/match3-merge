import type { ParticleSpec } from '../core/fxMap'

/**
 * Particle system: object pool + typed arrays (structure-of-arrays).
 *
 * Two constraints drive this design, both from the project's architecture
 * rules:
 *  1. No allocation on the per-frame path — hence typed arrays and a ring
 *     buffer instead of a growing array of objects.
 *  2. No per-frame string building — HSL colour strings are precomputed into a
 *     fixed palette and fade is done with `globalAlpha`, so `draw()` only ever
 *     assigns existing strings.
 */

/** Hue buckets in the precomputed palette. */
const HUE_BUCKETS = 36

function makePalette(saturation: number, lightness: number): string[] {
  const palette: string[] = []
  for (let i = 0; i < HUE_BUCKETS; i++) {
    palette.push(`hsl(${Math.round((i * 360) / HUE_BUCKETS)} ${saturation}% ${lightness}%)`)
  }
  return palette
}

export class ParticleSystem {
  readonly capacity: number

  private count = 0
  private cursor = 0

  private readonly px: Float32Array
  private readonly py: Float32Array
  private readonly vx: Float32Array
  private readonly vy: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private readonly size: Float32Array
  private readonly gravity: Float32Array
  private readonly hue: Float32Array
  private readonly additive: Uint8Array

  private readonly palette = makePalette(72, 62)
  private readonly additivePalette = makePalette(90, 68)

  /** Tiny inline PRNG: avoids touching the game RNG and allocates nothing. */
  private seed = 0x9e3779b9

  constructor(capacity: number) {
    this.capacity = Math.max(16, Math.floor(capacity))
    this.px = new Float32Array(this.capacity)
    this.py = new Float32Array(this.capacity)
    this.vx = new Float32Array(this.capacity)
    this.vy = new Float32Array(this.capacity)
    this.life = new Float32Array(this.capacity)
    this.maxLife = new Float32Array(this.capacity)
    this.size = new Float32Array(this.capacity)
    this.gravity = new Float32Array(this.capacity)
    this.hue = new Float32Array(this.capacity)
    this.additive = new Uint8Array(this.capacity)
  }

  get activeCount(): number {
    return this.count
  }

  private random(): number {
    // xorshift32
    let s = this.seed
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    this.seed = s | 0
    return ((s >>> 0) % 100000) / 100000
  }

  private range(min: number, max: number): number {
    if (max <= min) return min
    return min + this.random() * (max - min)
  }

  /**
   * Spawns one burst.
   *
   * @param spec      descriptor from fxMap (board-space centre, counts, ranges)
   * @param px        centre in canvas pixels
   * @param py        centre in canvas pixels
   * @param speedScale  multiplier so effects scale with the cell size
   */
  burst(spec: ParticleSpec, px: number, py: number, speedScale: number): void {
    const total = Math.min(spec.count, this.capacity)
    for (let i = 0; i < total; i++) {
      const index = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity
      if (this.count < this.capacity) this.count++

      // Random direction on a circle; rings bias outward uniformly.
      const angle = this.random() * Math.PI * 2
      const speed = this.range(spec.speedMin, spec.speedMax) * speedScale

      this.px[index] = px
      this.py[index] = py
      this.vx[index] = Math.cos(angle) * speed
      this.vy[index] = Math.sin(angle) * speed
      this.maxLife[index] = this.range(spec.lifeMinMs, spec.lifeMaxMs)
      this.life[index] = this.maxLife[index]
      this.size[index] = this.range(spec.sizeMin, spec.sizeMax)
      this.gravity[index] = spec.gravity * speedScale
      this.hue[index] = spec.hue
      this.additive[index] = spec.additive ? 1 : 0
    }
  }

  /**
   * Expands one ring marker. Stored as a particle with a special hue marker so
   * the ring shares the pool. Rings are drawn as an expanding stroked circle.
   */
  ring(px: number, py: number, hue: number, radius: number): void {
    const index = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    if (this.count < this.capacity) this.count++

    this.px[index] = px
    this.py[index] = py
    this.vx[index] = 0
    this.vy[index] = 0
    this.maxLife[index] = 420
    this.life[index] = 420
    this.size[index] = radius
    this.gravity[index] = 0
    this.hue[index] = hue
    // 2 = ring marker
    this.additive[index] = 2
  }

  update(dtMs: number): void {
    if (this.count === 0) return
    const dt = dtMs / 1000

    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue

      this.life[i] -= dtMs
      if (this.life[i] <= 0) continue

      const isRing = this.additive[i] === 2
      if (isRing) continue

      this.vy[i] += this.gravity[i] * dt
      this.px[i] += this.vx[i] * dt
      this.py[i] += this.vy[i] * dt
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (this.count === 0) return

    ctx.save()
    let modeSet = false

    for (let i = 0; i < this.capacity; i++) {
      const remaining = this.life[i]
      if (remaining <= 0) continue

      const t = this.maxLife[i] > 0 ? remaining / this.maxLife[i] : 0
      const kind = this.additive[i]

      if (kind === 2) {
        // Expanding ring: fades as it grows.
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = t * 0.7
        const hueBucket = Math.min(
          HUE_BUCKETS - 1,
          Math.max(0, Math.round((this.hue[i] / 360) * HUE_BUCKETS) % HUE_BUCKETS)
        )
        ctx.strokeStyle = this.additivePalette[hueBucket]
        ctx.lineWidth = Math.max(1, this.size[i] * 0.12)
        ctx.beginPath()
        ctx.arc(this.px[i], this.py[i], this.size[i] * (1.6 - t), 0, Math.PI * 2)
        ctx.stroke()
        modeSet = true
        continue
      }

      const wantAdditive = kind === 1
      if (wantAdditive !== modeSet) {
        ctx.globalCompositeOperation = wantAdditive ? 'lighter' : 'source-over'
        modeSet = wantAdditive
      }

      ctx.globalAlpha = t
      const bucket = ((Math.round(this.hue[i] / 10) % HUE_BUCKETS) + HUE_BUCKETS) % HUE_BUCKETS
      ctx.fillStyle = wantAdditive ? this.additivePalette[bucket] : this.palette[bucket]

      const size = Math.max(1, this.size[i] * (0.4 + 0.6 * t))
      ctx.fillRect(this.px[i] - size / 2, this.py[i] - size / 2, size, size)
    }

    ctx.restore()
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
  }

  clear(): void {
    this.life.fill(0)
    this.count = 0
    this.cursor = 0
  }
}
