import { blockSlot, SLOT } from '../core/theme'
import { hueForLevel } from '../core/fxMap'
import { imageFor, type ThemeAssets } from './assets'
import { innerRect, type Rect } from './layout'

/**
 * Sprite drawing.
 *
 * Every element prefers the active theme's image and falls back to a
 * procedural drawing when the slot is absent or failed to load.
 *
 * Two constraints shape this module:
 *
 *  1. **Blocks are only slightly smaller than their cell.** Level 1 sits at
 *     `MIN_BLOCK_SCALE` of the cell and the top level fills it, so the size
 *     ladder stays readable without any block looking tiny.
 *
 *  2. **No allocation while drawing.** Canvas gradients and colour strings are
 *     objects/strings that would otherwise be rebuilt for every block on every
 *     frame, so they are precomputed per level and cached until the cell size
 *     changes (`SpriteStyles`). Drawing then only assigns cached references and
 *     uses `ctx.translate` to place pre-built gradients.
 */

/** Level 1 occupies this fraction of a cell; the top level fills it. */
export const MIN_BLOCK_SCALE = 0.82

export function blockScaleFor(level: number, levelCount: number): number {
  if (levelCount <= 1) return 1
  const t = Math.min(1, Math.max(0, (level - 1) / (levelCount - 1)))
  return MIN_BLOCK_SCALE + (1 - MIN_BLOCK_SCALE) * t
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Rounded-rect path with independent width and height (the board is not square). */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function squarePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath()
  ctx.rect(x, y, w, h)
}

// ---------------------------------------------------------------------------
// Cached per-level styling
// ---------------------------------------------------------------------------

interface LevelStyle {
  /** Body gradient in local space (0..size), placed with translate. */
  body: CanvasGradient
  /** Upper-left specular sheen, local space. */
  sheen: CanvasGradient
  /** Soft top gloss band, local space. */
  gloss: CanvasGradient
  /** Soft outer halo, drawn instead of shadowBlur (which is far costlier). */
  halo: string
  /** Offset copy under the block, for lift. */
  shadow: string
  /** Dark inset rim: reads as a cut gem rather than a flat tile. */
  innerRim: string
  /** Thin bright outer edge, for definition against neighbours. */
  outerRim: string
  label: string
  /** Light halo behind the digit so it stays legible on any hue. */
  labelHalo: string
}

/**
 * Precomputes gradients and colour strings per level for one cell size.
 * Rebuilt only when the layout changes, never per frame.
 */
export class SpriteStyles {
  private size = -1
  private readonly cache = new Map<string, LevelStyle>()

  /** Cell size the cache was built for. */
  get builtFor(): number {
    return this.size
  }

  private build(ctx: CanvasRenderingContext2D, level: number, size: number): LevelStyle {
    const hue = hueForLevel(level)

    // Three stops: a bright lit face, a saturated mid tone, then a deep base.
    const body = ctx.createLinearGradient(0, 0, 0, size)
    body.addColorStop(0, `hsl(${hue} 96% 78%)`)
    body.addColorStop(0.34, `hsl(${hue} 88% 60%)`)
    body.addColorStop(0.72, `hsl(${hue} 82% 48%)`)
    body.addColorStop(1, `hsl(${hue} 76% 36%)`)

    // Off-centre radial highlight, as if lit from the upper left.
    const sheen = ctx.createRadialGradient(
      size * 0.32,
      size * 0.26,
      size * 0.02,
      size * 0.32,
      size * 0.26,
      size * 0.78
    )
    sheen.addColorStop(0, 'rgba(255,255,255,0.62)')
    sheen.addColorStop(0.45, 'rgba(255,255,255,0.16)')
    sheen.addColorStop(1, 'rgba(255,255,255,0)')

    const gloss = ctx.createLinearGradient(0, 0, 0, size * 0.46)
    gloss.addColorStop(0, 'rgba(255,255,255,0.42)')
    gloss.addColorStop(1, 'rgba(255,255,255,0)')

    return {
      body,
      sheen,
      gloss,
      halo: `hsla(${hue}, 100%, 64%, 0.24)`,
      shadow: `hsla(${hue}, 75%, 10%, 0.55)`,
      innerRim: `hsla(${hue}, 72%, 20%, 0.5)`,
      outerRim: `hsla(${hue}, 100%, 86%, 0.9)`,
      label: 'rgba(9,11,22,0.92)',
      labelHalo: 'rgba(255,255,255,0.55)'
    }
  }

  /** Returns the style for a level, rebuilding the cache if the size changed. */
  get(ctx: CanvasRenderingContext2D, level: number, levelCount: number, size: number): LevelStyle {
    if (size !== this.size) {
      this.cache.clear()
      this.size = size
    }
    // The cell size enters the key so the two sizes never collide.
    const key = `${level}/${levelCount}`
    const found = this.cache.get(key)
    if (found !== undefined) return found

    const style = this.build(ctx, level, size)
    this.cache.set(key, style)
    return style
  }
}

// ---------------------------------------------------------------------------
// Backgrounds, frames, slots
// ---------------------------------------------------------------------------

/** Draws a theme image fitted into the rect, preserving aspect ratio. */
export function drawImageContained(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  rect: Rect
): void {
  const natural = image.naturalWidth > 0 ? image.naturalWidth : image.width
  const naturalHeight = image.naturalHeight > 0 ? image.naturalHeight : image.height
  if (natural <= 0 || naturalHeight <= 0) return

  const scale = Math.min(rect.size / natural, rect.size / naturalHeight)
  const w = natural * scale
  const h = naturalHeight * scale
  ctx.drawImage(image, rect.x + (rect.size - w) / 2, rect.y + (rect.size - h) / 2, w, h)
}

/**
 * Stretches a theme image to fill an arbitrary rect. Used for the board plate,
 * which is a non-square 7x10 area that a plate texture should cover.
 */
export function drawImageStretched(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const natural = image.naturalWidth > 0 ? image.naturalWidth : image.width
  const naturalHeight = image.naturalHeight > 0 ? image.naturalHeight : image.height
  if (natural <= 0 || naturalHeight <= 0) return
  ctx.drawImage(image, x, y, w, h)
}

/** Empty board cell: theme frame, or a subtle tinted well. */
export function drawCellFrame(
  ctx: CanvasRenderingContext2D,
  assets: ThemeAssets,
  rect: Rect,
  radius: number,
  checker: boolean
): void {
  const image = imageFor(assets, SLOT.slotCellFrame)
  if (image !== null) {
    drawImageContained(ctx, image, rect)
    return
  }

  // A recessed glass well: a soft dark fill with a hairline highlight along the
  // bottom edge. The checker tint is kept barely perceptible on purpose —
  // strong alternation reads as a dirty surface rather than as structure.
  roundRectPath(ctx, rect.x, rect.y, rect.size, rect.size, radius)
  const well = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.size)
  well.addColorStop(0, checker ? 'rgba(6,10,24,0.34)' : 'rgba(6,10,24,0.26)')
  well.addColorStop(1, checker ? 'rgba(30,40,80,0.22)' : 'rgba(30,40,80,0.16)')
  ctx.fillStyle = well
  ctx.fill()

  ctx.strokeStyle = 'rgba(150,178,255,0.10)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Hairline inner highlight at the bottom: reads as a bevel cut into the
  // board, which is what makes the blocks look like they sit on top.
  const inset = Math.max(1, rect.size * 0.06)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  roundRectPath(
    ctx,
    rect.x + inset,
    rect.y + inset,
    rect.size - inset * 2,
    rect.size - inset * 2,
    Math.max(1, radius - inset * 0.5)
  )
  ctx.stroke()
}

/** A slot (next / buffer): theme image or a glowing filled rounded rect. */
export function drawSlot(
  ctx: CanvasRenderingContext2D,
  assets: ThemeAssets,
  rect: Rect,
  slot: 'buffer' | 'next',
  highlighted: boolean
): void {
  const image = imageFor(assets, slot === 'next' ? SLOT.slotNext : SLOT.slotBuffer)
  if (image !== null) {
    drawImageContained(ctx, image, rect)
  } else {
    const radius = rect.size * 0.18
    // The "next" slot is marked by a warmer accent, but kept muted so it does
    // not compete with the block sitting inside it.
    const accent = slot === 'next' ? '226,190,128' : '140,164,255'

    roundRectPath(ctx, rect.x, rect.y, rect.size, rect.size, radius)
    const fill = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.size)
    fill.addColorStop(0, `rgba(${accent}, ${highlighted ? 0.26 : 0.13})`)
    fill.addColorStop(1, `rgba(${accent}, ${highlighted ? 0.12 : 0.05})`)
    ctx.fillStyle = fill
    ctx.fill()

    ctx.strokeStyle = `rgba(${accent}, ${highlighted ? 0.95 : 0.38})`
    ctx.lineWidth = highlighted ? 2.5 : 1.25
    ctx.stroke()

    // Inner dashed inset so an empty slot still reads as a container.
    const inset = rect.size * 0.14
    ctx.setLineDash([Math.max(3, rect.size * 0.09), Math.max(3, rect.size * 0.09)])
    ctx.strokeStyle = `rgba(${accent}, 0.3)`
    ctx.lineWidth = 1
    roundRectPath(
      ctx,
      rect.x + inset,
      rect.y + inset,
      rect.size - inset * 2,
      rect.size - inset * 2,
      radius * 0.7
    )
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (highlighted) {
    const highlight = imageFor(assets, SLOT.slotHighlight)
    if (highlight !== null) {
      drawImageContained(ctx, highlight, rect)
    }
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A block on the board or in a slot. */
export function drawBlock(
  ctx: CanvasRenderingContext2D,
  assets: ThemeAssets,
  styles: SpriteStyles,
  rect: Rect,
  level: number,
  levelCount: number,
  labels: readonly string[],
  options?: { ghost?: boolean; alpha?: number }
): void {
  if (level <= 0) return

  const alpha = options?.alpha ?? 1
  const ghost = options?.ghost === true

  ctx.save()
  ctx.globalAlpha = alpha

  const image = imageFor(assets, blockSlot(level))
  if (image !== null) {
    // Artwork already encodes the level, so the renderer must NOT shrink it
    // further: only the theme's own padding/scale apply.
    const inner = innerRect(rect, assets.theme.padding)
    const size = inner.size * assets.theme.blockScale
    const box: Rect = {
      x: inner.x + (inner.size - size) / 2,
      y: inner.y + (inner.size - size) / 2,
      size
    }
    if (ghost) ctx.globalAlpha = alpha * 0.55
    drawImageContained(ctx, image, box)
    ctx.restore()
    return
  }

  // Procedural fallback: the level ladder is expressed as size AND hue.
  const scale = blockScaleFor(level, levelCount)
  const inner = innerRect(rect, (1 - scale) / 2)
  const size = inner.size
  const radius = size * 0.24

  if (ghost) {
    ctx.globalAlpha = alpha * 0.5
    roundRectPath(ctx, inner.x, inner.y, size, size, radius)
    ctx.fillStyle = 'rgba(255,255,255,0.14)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()
    return
  }

  const style = styles.get(ctx, level, levelCount, size)

  // Soft outer halo, drawn as a larger copy instead of shadowBlur (which costs
  // a full blur pass per block).
  const haloPad = size * 0.075
  roundRectPath(
    ctx,
    inner.x - haloPad,
    inner.y - haloPad,
    size + haloPad * 2,
    size + haloPad * 2,
    radius + haloPad
  )
  ctx.fillStyle = style.halo
  ctx.fill()

  // Lift: a dark copy offset downward. Reads as a shadow at a fraction of the
  // cost of a real one, and gives the block thickness without an emboss.
  const liftY = size * 0.075
  roundRectPath(ctx, inner.x, inner.y + liftY, size, size, radius)
  ctx.fillStyle = style.shadow
  ctx.fill()

  // Body + shading, all in local space so the cached gradients can be reused
  // verbatim. (Rebuilding them per block per frame would allocate constantly.)
  ctx.save()
  ctx.translate(inner.x, inner.y)
  roundRectPath(ctx, 0, 0, size, size, radius)
  ctx.fillStyle = style.body
  ctx.fill()

  ctx.save()
  ctx.clip()

  // Broad top gloss, then an off-centre specular sheen: together these give a
  // lit-from-above gem read rather than a flat tile.
  ctx.fillStyle = style.gloss
  ctx.fillRect(0, 0, size, size * 0.46)
  ctx.fillStyle = style.sheen
  ctx.fillRect(0, 0, size, size)

  // Dark inner rim. Stroking an inset path produces a contained edge that makes
  // the face look cut, not embossed.
  const inset = Math.max(1, size * 0.055)
  ctx.lineWidth = Math.max(1, size * 0.05)
  ctx.strokeStyle = style.innerRim
  roundRectPath(
    ctx,
    inset,
    inset,
    size - inset * 2,
    size - inset * 2,
    Math.max(1, radius - inset * 0.6)
  )
  ctx.stroke()

  ctx.restore()

  // Thin bright outer edge, purely for definition against neighbours.
  ctx.strokeStyle = style.outerRim
  ctx.lineWidth = Math.max(1, size * 0.032)
  roundRectPath(ctx, 0, 0, size, size, radius)
  ctx.stroke()

  ctx.restore()

  // Level number once it is readable. The block shows its LEVEL, not its score
  // value: the level is what the player reasons about ("I need three 4s"),
  // while the score table lives in the rules line under the board.
  const label = labels[level - 1]
  if (size >= 20 && label !== undefined && label.length > 0) {
    // Two-digit levels need a slightly smaller size to stay inside the block.
    const ratio = label.length > 1 ? 0.42 : 0.56
    ctx.font = `800 ${Math.round(size * ratio)}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // A light halo behind the digit keeps it readable on every hue, including
    // the light ones, without resorting to an embossed look.
    ctx.lineWidth = Math.max(2, size * 0.075)
    ctx.lineJoin = 'round'
    ctx.strokeStyle = style.labelHalo
    ctx.strokeText(label, inner.x + size / 2, inner.y + size / 2)

    ctx.fillStyle = style.label
    ctx.fillText(label, inner.x + size / 2, inner.y + size / 2)
  }

  ctx.restore()
}

/** Obstacle: theme image or a spiked grey tile. */
export function drawObstacle(
  ctx: CanvasRenderingContext2D,
  assets: ThemeAssets,
  rect: Rect
): void {
  const image = imageFor(assets, SLOT.obstacle)
  if (image !== null) {
    drawImageContained(ctx, image, innerRect(rect, 0.1))
    return
  }

  const inner = innerRect(rect, 0.1)
  const size = inner.size
  const radius = size * 0.2

  roundRectPath(ctx, inner.x, inner.y, size, size, radius)
  const gradient = ctx.createLinearGradient(inner.x, inner.y, inner.x, inner.y + size)
  gradient.addColorStop(0, 'rgba(140,148,180,0.98)')
  gradient.addColorStop(1, 'rgba(74,80,104,0.98)')
  ctx.fillStyle = gradient
  ctx.fill()
  ctx.save()
  ctx.clip()

  ctx.strokeStyle = 'rgba(20,24,40,0.55)'
  ctx.lineWidth = Math.max(1, size * 0.09)
  const step = Math.max(6, size * 0.26)
  for (let d = -size; d < size * 2; d += step) {
    ctx.beginPath()
    ctx.moveTo(inner.x + d, inner.y)
    ctx.lineTo(inner.x + d - size, inner.y + size)
    ctx.stroke()
  }
  ctx.restore()

  ctx.strokeStyle = 'rgba(226,232,255,0.6)'
  ctx.lineWidth = Math.max(1, size * 0.05)
  roundRectPath(ctx, inner.x, inner.y, size, size, radius)
  ctx.stroke()

  // A small crossed-out mark so it never reads as a playable block.
  ctx.strokeStyle = 'rgba(255,224,138,0.95)'
  ctx.lineWidth = Math.max(2, size * 0.13)
  ctx.lineCap = 'round'
  const pad = size * 0.3
  ctx.beginPath()
  ctx.moveTo(inner.x + pad, inner.y + pad)
  ctx.lineTo(inner.x + size - pad, inner.y + size - pad)
  ctx.moveTo(inner.x + size - pad, inner.y + pad)
  ctx.lineTo(inner.x + pad, inner.y + size - pad)
  ctx.stroke()
  ctx.lineCap = 'butt'
}

/** Re-exported for callers that need a plain square path. */
export { squarePath }
