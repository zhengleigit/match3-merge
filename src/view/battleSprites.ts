import { SLOT } from '../core/theme'
import type { PacManState } from '../core/types'
import { imageFor, type ThemeAssets } from './assets'
import { drawImageContained, roundRectPath } from './sprites'
import type { Rect } from './layout'

/**
 * Battle-mode actors: the indestructible wall, and the boss.
 *
 * Both are drawn procedurally. The wall can be replaced by theme art, but the
 * boss deliberately cannot: it carries live state (hp and action bars) that has
 * to be legible at a glance, and painters would have to reproduce the layout of
 * those bars exactly. Keeping it in code means the numbers can never end up
 * hidden behind a sprite.
 */

const PACMAN_BODY_RATIO = 0.34
const HP_BAR_RATIO = 0.44
const BAR_HEIGHT_RATIO = 0.075
const BAR_GAP_RATIO = 0.055

/** Indestructible wall segment: theme art, or a riveted stone slab. */
export function drawWall(ctx: CanvasRenderingContext2D, assets: ThemeAssets, rect: Rect): void {
  const image = imageFor(assets, SLOT.wall)
  if (image !== null) {
    drawImageContained(ctx, image, rect)
    return
  }

  const inset = rect.size * 0.02
  const x = rect.x + inset
  const y = rect.y + inset
  const size = rect.size - inset * 2

  roundRectPath(ctx, x, y, size, size, size * 0.16)
  const slab = ctx.createLinearGradient(x, y, x, y + size)
  slab.addColorStop(0, 'rgba(96,104,132,0.98)')
  slab.addColorStop(0.5, 'rgba(70,77,102,0.98)')
  slab.addColorStop(1, 'rgba(48,54,74,0.98)')
  ctx.fillStyle = slab
  ctx.fill()

  // Blockwork: two courses of bricks, offset, so the wall reads as built rather
  // than as another kind of block.
  ctx.save()
  roundRectPath(ctx, x, y, size, size, size * 0.16)
  ctx.clip()
  ctx.strokeStyle = 'rgba(22,26,42,0.55)'
  ctx.lineWidth = Math.max(1, size * 0.045)
  ctx.beginPath()
  ctx.moveTo(x, y + size / 2)
  ctx.lineTo(x + size, y + size / 2)
  ctx.moveTo(x + size / 2, y)
  ctx.lineTo(x + size / 2, y + size / 2)
  ctx.moveTo(x + size * 0.5, y + size / 2)
  ctx.lineTo(x + size * 0.5, y + size)
  ctx.stroke()
  ctx.restore()

  ctx.strokeStyle = 'rgba(190,204,240,0.42)'
  ctx.lineWidth = Math.max(1, size * 0.04)
  roundRectPath(ctx, x, y, size, size, size * 0.16)
  ctx.stroke()
}

/**
 * The boss, plus its two status bars.
 *
 * The bars sit directly under the disc and are sized from the cell, so they stay
 * readable at every zoom level. The hp bar is scaled against `maxHp` — the
 * highest the boss ever reached — because its hp grows through the opening of a
 * run; a bar scaled against the starting value would overfill immediately.
 *
 * `x`/`y` are fractional cells while the boss is travelling, which is how the
 * view shows it walking its route instead of teleporting onto its food.
 */
export function drawPacMan(
  ctx: CanvasRenderingContext2D,
  layout: { cell: number; boardX: number; boardY: number },
  boss: PacManState,
  x: number,
  y: number,
  heading: { x: number; y: number } | null,
  timeMs: number,
  moving: boolean
): void {
  const cx = layout.boardX + x * layout.cell + layout.cell / 2
  const cy = layout.boardY + y * layout.cell + layout.cell / 2
  const size = layout.cell
  const radius = size * PACMAN_BODY_RATIO

  // Chomp: fast while travelling, idle in the cage (nothing to hunt).
  const speed = moving ? 0.018 : boss.phase === 'cage' ? 0.0022 : 0.006
  const phase = (timeMs * speed) % 1
  const open = Math.abs(Math.sin(phase * Math.PI)) * 0.30 + 0.04

  // Face the way it is going; default to "down" when standing still.
  let facing = Math.PI / 2
  if (heading !== null && (heading.x !== 0 || heading.y !== 0)) {
    facing = Math.atan2(heading.y, heading.x)
  }

  ctx.save()

  // Glow, so the boss is never lost against a busy board.
  const glow = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 1.9)
  glow.addColorStop(0, 'rgba(255,226,92,0.45)')
  glow.addColorStop(1, 'rgba(255,226,92,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(cx, cy, radius * 1.9, 0, Math.PI * 2)
  ctx.fill()

  // Body: a yellow disc with a wedge cut out towards the direction it faces.
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.arc(cx, cy, radius, facing + open * Math.PI, facing - open * Math.PI + Math.PI * 2)
  ctx.closePath()
  const body = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius)
  body.addColorStop(0, '#ffe680')
  body.addColorStop(0.55, '#ffd23f')
  body.addColorStop(1, '#f0a90f')
  ctx.fillStyle = body
  ctx.fill()

  ctx.strokeStyle = 'rgba(84,52,0,0.55)'
  ctx.lineWidth = Math.max(1, size * 0.02)
  ctx.stroke()

  // Eye, offset perpendicular to the facing direction.
  const eyeX = cx + Math.cos(facing - Math.PI / 2) * radius * 0.34 + Math.cos(facing) * radius * 0.16
  const eyeY = cy + Math.sin(facing - Math.PI / 2) * radius * 0.34 + Math.sin(facing) * radius * 0.16
  ctx.beginPath()
  ctx.arc(eyeX, eyeY, radius * 0.16, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(38,28,4,0.92)'
  ctx.fill()

  ctx.restore()

  // Two bars, stacked directly under the disc. They stay with the sprite while
  // it moves, so the player can always see what the journey cost or healed.
  const barW = size * HP_BAR_RATIO * 2
  const barH = Math.max(3, size * BAR_HEIGHT_RATIO)
  const barX = cx - barW / 2
  const topY = cy + size * (0.5 - 0.20)

  const hpRatio = boss.maxHp > 0 ? Math.max(0, Math.min(1, boss.hp / boss.maxHp)) : 0
  drawBar(ctx, barX, topY, barW, barH, hpRatio, '#ff4d5e', 'rgba(255,120,140,0.30)')

  const barY = topY + barH + Math.max(2, size * BAR_GAP_RATIO)
  drawBar(
    ctx,
    barX,
    barY,
    barW,
    barH,
    Math.max(0, Math.min(1, boss.bar)),
    '#ffffff',
    'rgba(228,238,255,0.30)'
  )
}

/** One status bar: a dark track, a filled portion, and a hairline outline. */
function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number,
  fill: string,
  track: string
): void {
  const radius = h / 2

  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fillStyle = 'rgba(8,11,22,0.92)'
  ctx.fill()

  // The empty track is drawn even at 0%. A bar that vanishes when empty cannot
  // be read as "this fills up" — the player would never learn the action bar
  // exists until the first time it fires.
  const inset = Math.max(1, h * 0.18)
  roundRectPath(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, radius)
  ctx.fillStyle = track
  ctx.fill()

  const innerW = w - inset * 2
  const filled = Math.max(0, innerW * ratio)
  if (filled > 0.5) {
    roundRectPath(ctx, x + inset, y + inset, filled, h - inset * 2, radius)
    ctx.fillStyle = fill
    ctx.fill()
  }

  ctx.strokeStyle = 'rgba(226,236,255,0.75)'
  ctx.lineWidth = 1
  roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius)
  ctx.stroke()
}
