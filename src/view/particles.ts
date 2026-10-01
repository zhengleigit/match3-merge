import type { ParticleSpec, TracerSpec } from '../core/fxMap'

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
  // Tracers: a particle that travels from an origin to a target. Origins and
  // targets are their own arrays rather than being packed into the velocity
  // fields, so a tracer's motion never has to be reverse-engineered later.
  private readonly ox: Float32Array
  private readonly oy: Float32Array
  private readonly tx: Float32Array
  private readonly ty: Float32Array

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
    this.ox = new Float32Array(this.capacity)
    this.oy = new Float32Array(this.capacity)
    this.tx = new Float32Array(this.capacity)
    this.ty = new Float32Array(this.capacity)
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

  /**
   * Fires a volley that travels from one point to another.
   *
   * Used so a merge visibly SHOOTS the boss rather than just making it flinch:
   * the particles leave the merged cell and arrive at the boss, which is what
   * makes "my merge hurt it" legible without any UI.
   *
   * Motion is linear so every shot lands exactly when its life expires.
   */
  tracer(spec: TracerSpec, fromX: number, fromY: number, toX: number, toY: number): void {
    const total = Math.min(spec.count, this.capacity)
    for (let i = 0; i < total; i++) {
      const index = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity
      if (this.count < this.capacity) this.count++

      // Start from a small disc around the origin so the volley has some body
      // instead of being a single pixel line.
      const angle = this.random() * Math.PI * 2
      const spread = this.range(0, spec.spreadPx)
      const sx = fromX + Math.cos(angle) * spread
      const sy = fromY + Math.sin(angle) * spread

      this.ox[index] = sx
      this.oy[index] = sy
      this.px[index] = sx
      this.py[index] = sy
      this.tx[index] = toX
      this.ty[index] = toY
      this.vx[index] = 0
      this.vy[index] = 0
      // Staggered so the volley reads as a stream of shots rather than a wall.
      const life = this.range(spec.durationMs * 0.75, spec.durationMs * 1.25)
      this.maxLife[index] = life
      this.life[index] = life
      this.size[index] = this.range(spec.sizeMin, spec.sizeMax)
      this.gravity[index] = 0
      this.hue[index] = spec.hue
      // 3 = tracer marker
      this.additive[index] = 3
    }
  }

  update(dtMs: number): void {
    if (this.count === 0) return
    const dt = dtMs / 1000

    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue

      this.life[i] -= dtMs
      if (this.life[i] <= 0) continue

      const kind = this.additive[i]
      if (kind === 2) continue

      if (kind === 3) {
        // Linear interpolation from origin to target, so arrival coincides with
        // the end of the particle's life.
        const progress = 1 - this.life[i] / this.maxLife[i]
        this.px[i] = this.ox[i] + (this.tx[i] - this.ox[i]) * progress
        this.py[i] = this.oy[i] + (this.ty[i] - this.oy[i]) * progress
        continue
      }

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

      const wantAdditive = kind === 1 || kind === 3
      if (wantAdditive !== modeSet) {
        ctx.globalCompositeOperation = wantAdditive ? 'lighter' : 'source-over'
        modeSet = wantAdditive
      }

      ctx.globalAlpha = t
      const bucket = ((Math.round(this.hue[i] / 10) % HUE_BUCKETS) + HUE_BUCKETS) % HUE_BUCKETS
      ctx.fillStyle = wantAdditive ? this.additivePalette[bucket] : this.palette[bucket]

      // Tracers stay bright for their whole flight: they are the readout of
      // "this merge is hitting the boss", so fading them out early weakens it.
      const fade = kind === 3 ? 0.55 + 0.45 * t : t
      const size = Math.max(1, this.size[i] * (0.4 + 0.6 * fade))
      ctx.globalAlpha = fade
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
