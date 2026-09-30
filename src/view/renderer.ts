import type { GameView } from '../core/game'
import { formatDuration, type ScoreEntry } from '../core/leaderboard'
import { SLOT } from '../core/theme'
import { CELL_OBSTACLE_CRACKED } from '../core/types'
import { imageFor, type ThemeAssets } from './assets'
import type { FloaterSystem } from './floaters'
import {
  boardCellRect,
  bufferSlotRect,
  leaderboardBand,
  nextSlotRect,
  rulesBand,
  scoreBand,
  titleBand,
  type Layout,
  type Rect
} from './layout'
import type { ParticleSystem } from './particles'
import type { MergeFxSystem } from './mergeFx'
import {
  SpriteStyles,
  drawBlock,
  drawCellFrame,
  drawImageStretched,
  drawObstacle,
  drawSlot,
  roundRectPath
} from './sprites'

/**
 * Canvas composition.
 *
 * Layout: the board on the left, and a right-hand column holding
 * score -> next -> buffer slots (top to bottom).
 *
 * Draw order: page background -> board plate -> empty cell wells -> blocks and
 * obstacles -> drag ghost -> side column -> particles -> floaters.
 *
 * Particles and floaters share this canvas and this single pass rather than
 * living on their own layer, which saves a composite step per frame.
 */

export interface RenderState {
  view: GameView
  layout: Layout
  assets: ThemeAssets
  styles: SpriteStyles
  /**
   * Board to draw instead of `view.cells`, used while an automatic chain is
   * being animated so the player sees each link in turn. Null = live board.
   */
  overrideCells: number[] | null
  /** Precomputed score labels per level (index 0 = level 1). */
  labels: readonly string[]
  /**
   * HUD strings, rebuilt only when the underlying values change.
   * Formatting numbers inside the frame loop would allocate every frame.
   */
  texts: { score: string; steps: string; mode: string; best: string; rules: string }
  selectedSlot: number | null
  /** Slot the pointer is currently over (hover feedback). */
  hoverSlot: number | null  /** True while the pointer is over the next slot. */
  hoverNext: boolean
  /**
   * True while the dragged block came from the "next" slot. The slot is then
   * drawn empty: the block has visibly left it, and its replacement should not
   * appear until the block is actually put down.
   */
  dragFromNext: boolean  /** Level being dragged, or 0 when nothing is being dragged. */
  dragLevel: number
  dragPx: { x: number; y: number } | null
  /** Board cell under the pointer while dragging (drop preview). */
  hoverCell: { x: number; y: number } | null
  /** Cell that just rejected a drop, with the timestamp it stops flashing. */
  rejectedCell: { x: number; y: number; untilMs: number } | null
  particles: ParticleSystem
  floaters: FloaterSystem
  /** Merge "swell, flash, collapse" animation for consumed blocks. */
  mergeFx: MergeFxSystem
  /** Ranked finished runs, newest ranking first. */
  leaderboard: readonly ScoreEntry[]
  /** Screen-shake offset in pixels; the board translates by this. */
  shakeOffset: { x: number; y: number }
  timeMs: number
  reducedMotion: boolean
}

const CELL_RADIUS_RATIO = 0.2

function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)))
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number
): void {
  const naturalW = image.naturalWidth > 0 ? image.naturalWidth : image.width
  const naturalH = image.naturalHeight > 0 ? image.naturalHeight : image.height
  if (naturalW <= 0 || naturalH <= 0) return

  const scale = Math.max(width / naturalW, height / naturalH)
  const w = naturalW * scale
  const h = naturalH * scale
  ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h)
}

function drawPageBackground(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { width, height } = state.layout
  const image = imageFor(state.assets, SLOT.pageBackground)

  if (image !== null) {
    drawCover(ctx, image, width, height)
    return
  }

  const gradient = ctx.createLinearGradient(0, 0, width * 0.4, height)
  gradient.addColorStop(0, '#1a2142')
  gradient.addColorStop(0.45, '#131934')
  gradient.addColorStop(1, '#0a0d1c')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  // Two soft colour washes so the backdrop is not a flat slab.
  const glowA = ctx.createRadialGradient(width * 0.2, height * 0.1, 0, width * 0.2, height * 0.1, width * 0.8)
  glowA.addColorStop(0, 'rgba(96,120,255,0.20)')
  glowA.addColorStop(1, 'rgba(96,120,255,0)')
  ctx.fillStyle = glowA
  ctx.fillRect(0, 0, width, height)

  const glowB = ctx.createRadialGradient(
    width * 0.85,
    height * 0.9,
    0,
    width * 0.85,
    height * 0.9,
    width * 0.7
  )
  glowB.addColorStop(0, 'rgba(255,132,196,0.14)')
  glowB.addColorStop(1, 'rgba(255,132,196,0)')
  ctx.fillStyle = glowB
  ctx.fillRect(0, 0, width, height)
}

/**
 * The board plate. Square corners on purpose: rounded corners on a plate that
 * exactly wraps the grid read as bulging outward past the outermost cells.
 */
function drawBoardPlate(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { boardX, boardY, boardW, boardH } = state.layout
  const image = imageFor(state.assets, SLOT.boardBackground)

  if (image !== null) {
    drawImageStretched(ctx, image, boardX, boardY, boardW, boardH)
    return
  }

  // A darker plate with a bright top edge, floating above the page.
  const pad = Math.max(3, state.layout.cell * 0.09)
  const x = boardX - pad
  const y = boardY - pad
  const w = boardW + pad * 2
  const h = boardH + pad * 2

  // Outer bloom. Square-cornered too: any radius here would read as the board
  // plate bulging outward past the outermost cells.
  roundRectPath(ctx, x - pad * 0.7, y - pad * 0.7, w + pad * 1.4, h + pad * 1.4, 0)
  ctx.fillStyle = 'rgba(90,116,255,0.13)'
  ctx.fill()

  roundRectPath(ctx, x, y, w, h, 0)
  const plate = ctx.createLinearGradient(x, y, x, y + h)
  plate.addColorStop(0, 'rgba(42,52,96,0.95)')
  plate.addColorStop(0.5, 'rgba(28,35,68,0.95)')
  plate.addColorStop(1, 'rgba(18,23,46,0.95)')
  ctx.fillStyle = plate
  ctx.fill()

  ctx.strokeStyle = 'rgba(150,176,255,0.35)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Bright top rim.
  ctx.strokeStyle = 'rgba(190,208,255,0.30)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x, y + 0.5)
  ctx.lineTo(x + w, y + 0.5)
  ctx.stroke()
}

function drawBoardContents(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { view, layout, labels, assets, styles } = state
  const cells = state.overrideCells ?? view.cells
  const radius = layout.cell * CELL_RADIUS_RATIO
  const now = state.timeMs

  for (let y = 0; y < layout.rows; y++) {
    for (let x = 0; x < layout.cols; x++) {
      const value = cells[y * layout.cols + x]
      const rect = boardCellRect(layout, x, y)

      if (value === 0) {
        drawCellFrame(ctx, assets, rect, radius, (x + y) % 2 === 1)

        const rejected = state.rejectedCell
        if (rejected !== null && rejected.x === x && rejected.y === y && rejected.untilMs > now) {
          ctx.strokeStyle = 'rgba(255,99,132,0.95)'
          ctx.lineWidth = 2
          rect_stroke(ctx, rect)
        }
        continue
      }

      if (value < 0) {
        // Both obstacle states land here; the cracked one is drawn damaged.
        drawObstacle(ctx, assets, rect, value === CELL_OBSTACLE_CRACKED)
        continue
      }

      drawBlock(ctx, assets, styles, rect, value, view.levelCount, labels)
    }
  }
}

function rect_stroke(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.beginPath()
  ctx.rect(rect.x + 1, rect.y + 1, rect.size - 2, rect.size - 2)
  ctx.stroke()
}

function drawDropPreview(ctx: CanvasRenderingContext2D, state: RenderState): void {
  if (state.dragLevel <= 0 || state.hoverCell === null) return

  const rect = boardCellRect(state.layout, state.hoverCell.x, state.hoverCell.y)
  // Draw the real block, semi-transparent, plus a bright ring. An earlier
  // version drew a faint white ghost here, which combined with suppressing the
  // drag ghost made the block appear to vanish before the drop.
  drawBlock(
    ctx,
    state.assets,
    state.styles,
    rect,
    state.dragLevel,
    state.view.levelCount,
    state.labels,
    { alpha: 0.62 }
  )

  ctx.save()
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = 2
  roundRectPath(ctx, rect.x + 2, rect.y + 2, rect.size - 4, rect.size - 4, rect.size * 0.2)
  ctx.stroke()
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Side column: score / next / buffer
// ---------------------------------------------------------------------------

/**
 * Mode name, in the band above the board.
 *
 * On mobile the score shares this band, so the title is left-aligned; on
 * desktop the band is dedicated to it and the text is centred.
 */
function drawTitle(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const band = titleBand(state.layout)
  const size = clampSize(Math.min(band.h * 0.62, state.layout.cell * 0.46), 12, 30)

  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(226,234,255,0.96)'
  ctx.font = `700 ${size}px system-ui, "Microsoft YaHei", sans-serif`

  if (state.layout.mobile) {
    ctx.textAlign = 'left'
    ctx.fillText(state.texts.mode, band.x + band.w * 0.03, band.y + band.h / 2, band.w * 0.46)
  } else {
    ctx.textAlign = 'center'
    ctx.fillText(state.texts.mode, band.x + band.w / 2, band.y + band.h / 2, band.w * 0.9)
  }
}

/**
 * Score block.
 *
 * Desktop: a vertical panel in the side column (value, then best and steps).
 * Mobile: a horizontal band on the title row, score right-aligned next to the
 * mode name. The mode name itself is drawn by `drawTitle`.
 */
function drawScore(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const band = scoreBand(state.layout)
  const { texts } = state

  if (state.layout.mobile) {
    const pad = band.w * 0.03
    // Three lines share one band. Positions used to be hard-coded fractions of
    // the band height, so on a phone — where the band is tall because the cell
    // is — the big score grew straight into the steps line underneath it.
    // Deriving the score size from what the two small lines leave behind makes
    // the stack self-limiting at any band height.
    const labelSize = clampSize(band.h * 0.17, 9, 12)
    const smallSize = clampSize(band.h * 0.17, 8, 11)
    const leading = Math.max(2, Math.round(band.h * 0.06))
    const valueSize = clampSize(band.h - labelSize - smallSize - leading * 2, 13, 26)

    const stack = labelSize + leading + valueSize + leading + smallSize
    let cursor = band.y + Math.max(0, (band.h - stack) / 2)
    const right = band.x + band.w - pad

    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'

    ctx.fillStyle = 'rgba(196,210,255,0.9)'
    ctx.font = `600 ${labelSize}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText('分数', right, cursor, band.w * 0.2)

    cursor += labelSize + leading
    ctx.fillStyle = '#ffffff'
    ctx.font = `800 ${valueSize}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText(texts.score, right, cursor, band.w * 0.5)

    cursor += valueSize + leading
    ctx.fillStyle = 'rgba(186,200,240,0.9)'
    ctx.font = `500 ${smallSize}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText(`${texts.steps} · ${texts.best}`, right, cursor, band.w * 0.5)
    return
  }

  const x = band.x
  const y = band.y
  const w = band.w
  const h = band.h
  const radius = Math.min(w, h) * 0.16

  roundRectPath(ctx, x, y, w, h, radius)
  const panel = ctx.createLinearGradient(x, y, x, y + h)
  panel.addColorStop(0, 'rgba(72,92,172,0.60)')
  panel.addColorStop(0.55, 'rgba(44,56,118,0.60)')
  panel.addColorStop(1, 'rgba(32,42,92,0.60)')
  ctx.fillStyle = panel
  ctx.fill()
  ctx.strokeStyle = 'rgba(160,182,255,0.5)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  const cx = x + w / 2
  const maxWidth = w * 0.86
  const labelSize = clampSize(Math.min(w * 0.19, h * 0.1), 9, 16)
  const scoreSize = clampSize(Math.min(w * 0.4, h * 0.24), 15, 38)
  const smallSize = clampSize(Math.min(w * 0.17, h * 0.09), 8, 15)
  const compact = state.layout.compactScore

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  ctx.fillStyle = 'rgba(196,210,255,0.9)'
  ctx.font = `600 ${labelSize}px system-ui, "Microsoft YaHei", sans-serif`
  ctx.fillText('分数', cx, y + h * 0.13)

  ctx.fillStyle = '#ffffff'
  ctx.font = `800 ${scoreSize}px system-ui, "Microsoft YaHei", sans-serif`
  // maxWidth auto-shrinks a long score so it can never overflow the column.
  ctx.fillText(texts.score, cx, y + h * (compact ? 0.5 : 0.36), maxWidth)

  ctx.strokeStyle = 'rgba(180,200,255,0.26)'
  ctx.lineWidth = 1
  const dividerY = y + h * (compact ? 0.72 : 0.58)
  ctx.beginPath()
  ctx.moveTo(x + w * 0.14, dividerY)
  ctx.lineTo(x + w * 0.86, dividerY)
  ctx.stroke()

  ctx.fillStyle = 'rgba(186,200,240,0.92)'
  ctx.font = `500 ${smallSize}px system-ui, "Microsoft YaHei", sans-serif`
  if (compact) {
    ctx.fillText(texts.steps, cx, y + h * 0.87, maxWidth)
    return
  }

  ctx.fillText(texts.best, cx, y + h * 0.71, maxWidth)
  ctx.fillText(texts.steps, cx, y + h * 0.86, maxWidth)
}

/** Mode rules, in the band under the slot row. */
function drawRules(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const band = rulesBand(state.layout)
  const size = clampSize(band.h * 0.42, 9, 14)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(158,174,220,0.85)'
  ctx.font = `400 ${size}px system-ui, "Microsoft YaHei", sans-serif`
  ctx.fillText(state.texts.rules, band.x + band.w / 2, band.y + band.h / 2, band.w * 0.96)
}

function drawSideColumn(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { view, layout, labels, assets, styles } = state

  // Score is drawn by drawScore() (it lives in the title band on mobile).
  if (!layout.mobile) {
    const nextRect = nextSlotRect(layout)
    drawSlot(ctx, assets, nextRect, 'next', state.hoverNext)
    if (view.next > 0 && !state.dragFromNext) {
      drawBlock(ctx, assets, styles, nextRect, view.next, view.levelCount, labels)
    }
  }

  for (let slot = 0; slot < layout.bufferSlots; slot++) {
    const rect = bufferSlotRect(layout, slot)
    const selected = state.selectedSlot === slot
    const hovered = state.hoverSlot === slot
    drawSlot(ctx, assets, rect, 'buffer', selected || hovered)

    const level = view.buffer[slot]
    if (level > 0) {
      drawBlock(ctx, assets, styles, rect, level, view.levelCount, labels)
    }

    // Mark the selection so the state survives a glance away.
    if (selected) {
      ctx.strokeStyle = 'rgba(170,192,255,0.98)'
      ctx.lineWidth = 3
      const inset = 3
      roundRectPath(
        ctx,
        rect.x + inset,
        rect.y + inset,
        rect.size - inset * 2,
        rect.size - inset * 2,
        rect.size * CELL_RADIUS_RATIO
      )
      ctx.stroke()
    }
  }
}

/** The "next" slot when it shares the row under the board (mobile). */
function drawRowNext(ctx: CanvasRenderingContext2D, state: RenderState): void {
  if (!state.layout.mobile) return

  const rect = nextSlotRect(state.layout)
  drawSlot(ctx, state.assets, rect, 'next', state.hoverNext)
  // Hidden while its block is being carried (see RenderState.dragFromNext).
  if (state.view.next > 0 && !state.dragFromNext) {
    drawBlock(ctx, state.assets, state.styles, rect, state.view.next, state.view.levelCount, state.labels)
  }
}

function drawDragGhost(ctx: CanvasRenderingContext2D, state: RenderState): void {
  if (state.dragPx === null) return
  if (state.dragLevel <= 0) return

  const size = state.layout.cell
  // Offset upward so the block stays visible under a finger or cursor, and
  // draw it over the drop preview so it never disappears mid-drag.
  const lift = state.hoverCell !== null ? size * 0.15 : 0
  const rect: Rect = {
    x: state.dragPx.x - size / 2,
    y: state.dragPx.y - size / 2 - lift,
    size
  }
  drawBlock(ctx, state.assets, state.styles, rect, state.dragLevel, state.view.levelCount, state.labels, {
    alpha: 0.96
  })
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function drawLeaderboard(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { x, y, w, h } = leaderboardBand(state.layout)
  const radius = Math.min(w, h) * 0.07

  roundRectPath(ctx, x, y, w, h, radius)
  const panel = ctx.createLinearGradient(x, y, x, y + h)
  panel.addColorStop(0, 'rgba(38,48,92,0.72)')
  panel.addColorStop(1, 'rgba(20,26,52,0.72)')
  ctx.fillStyle = panel
  ctx.fill()
  ctx.strokeStyle = 'rgba(140,164,255,0.28)'
  ctx.lineWidth = 1
  ctx.stroke()

  const pad = Math.max(6, w * 0.03)
  // On a phone the board fills the width, so the cell — and therefore this band
  // — is large; scaling the text with it made the ranking shout over the board
  // it sits under. Mobile gets a flatter scale and a lower cap, which lands the
  // rows at about the same size as the rules line above them.
  const headerSize = state.layout.mobile
    ? clampSize(h * 0.11, 9, 13)
    : clampSize(h * 0.17, 10, 20)
  const rowSize = state.layout.mobile
    ? clampSize(h * 0.105, 8, 12)
    : clampSize(h * 0.16, 9, 18)

  // Explicit column boundaries: rank | mode | score | duration. Letting each
  // text right-align independently made the score and duration touch.
  const timeW = w * 0.26
  const scoreW = w * 0.2
  const columnGap = Math.max(6, w * 0.035)
  const timeRight = x + w - pad
  const scoreRight = timeRight - timeW - columnGap
  const modeX = x + pad + rowSize * 1.7
  const modeMax = Math.max(20, scoreRight - scoreW - columnGap - modeX)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  ctx.fillStyle = 'rgba(196,210,255,0.95)'
  ctx.font = `700 ${headerSize}px system-ui, "Microsoft YaHei", sans-serif`
  ctx.fillText('排行榜', x + pad, y + h * 0.15)

  // Column headers, right-aligned to match the values below them.
  if (w >= 240) {
    ctx.textAlign = 'right'
    ctx.fillStyle = 'rgba(150,166,214,0.75)'
    ctx.font = `500 ${Math.round(headerSize * 0.78)}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText('得分', scoreRight, y + h * 0.15, scoreW)
    ctx.fillText('用时', timeRight, y + h * 0.15, timeW)
  }

  const entries = state.leaderboard
  const rows = state.layout.leaderboardRows

  if (entries.length === 0) {
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(150,166,214,0.7)'
    ctx.font = `400 ${rowSize}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText('还没有记录，结束一局就会出现在这里', x + pad, y + h * 0.6, w - pad * 2)
    return
  }

  for (let i = 0; i < rows && i < entries.length; i++) {
    const entry = entries[i]
    const rowY = y + h * (0.32 + (i + 0.5) * 0.2)
    const dim = i > 0

    // Rank
    ctx.textAlign = 'left'
    ctx.fillStyle = i === 0 ? '#ffd166' : 'rgba(170,184,224,0.85)'
    ctx.font = `${i === 0 ? 700 : 500} ${rowSize}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText(`${i + 1}`, x + pad, rowY)

    // Mode name, truncated by maxWidth so it cannot collide with the score.
    ctx.fillStyle = dim ? 'rgba(206,216,244,0.9)' : '#ffffff'
    ctx.fillText(entry.modeName, modeX, rowY, modeMax)

    // Score
    ctx.textAlign = 'right'
    ctx.fillStyle = i === 0 ? '#ffd166' : 'rgba(206,216,244,0.92)'
    ctx.fillText(String(entry.score), scoreRight, rowY, scoreW)

    // Duration
    ctx.fillStyle = 'rgba(150,166,214,0.85)'
    ctx.font = `400 ${rowSize}px system-ui, "Microsoft YaHei", sans-serif`
    ctx.fillText(formatDuration(entry.durationMs), timeRight, rowY, timeW)
  }
}

export function render(ctx: CanvasRenderingContext2D, state: RenderState): void {
  const { width, height } = state.layout

  ctx.save()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, width, height)

  drawPageBackground(ctx, state)

  const isDragging = state.dragLevel > 0 && state.dragPx !== null

  drawTitle(ctx, state)

  // The board shakes as a unit; the surrounding bands stay put so drops stay
  // predictable and the score stays readable.
  ctx.save()
  ctx.translate(state.shakeOffset.x, state.shakeOffset.y)
  drawBoardPlate(ctx, state)
  drawBoardContents(ctx, state)
  // Merge animation and the drop preview sit above the board but still inside
  // the shake transform, so they move with the grid.
  state.mergeFx.draw(
    ctx,
    state.layout,
    state.assets,
    state.styles,
    state.labels,
    state.view.levelCount
  )
  drawDropPreview(ctx, state)
  ctx.restore()

  drawScore(ctx, state)
  drawRowNext(ctx, state)
  drawSideColumn(ctx, state)
  drawRules(ctx, state)
  drawLeaderboard(ctx, state)

  if (isDragging) drawDragGhost(ctx, state)

  state.particles.draw(ctx)
  state.floaters.draw(ctx, Math.max(11, state.layout.cell * 0.26))

  ctx.restore()
}
