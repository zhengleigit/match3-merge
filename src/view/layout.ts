/**
 * Layout and coordinate maths.
 *
 * Two structural variants, chosen by viewport width:
 *
 * DESKTOP (>= MOBILE_BREAKPOINT)
 *   ┌───────────── 模式名 ──────────────┐
 *   │               │  分数             │
 *   │  7x10 棋盘     ├──────────────────┤
 *   │               │  下一个           │
 *   ├───────────────┴──────────────────┤
 *   │        [暂存1][暂存2][暂存3]        │
 *   ├──────────────────────────────────┤
 *   │            模式规则                │
 *   ├──────────────────────────────────┤
 *   │            排行榜                  │
 *   └──────────────────────────────────┘
 *
 * MOBILE (< MOBILE_BREAKPOINT)
 *   No side column at all, otherwise the board would be squeezed to nothing.
 *   ┌────── 模式名 ────────── 分数 ──────┐
 *   │           7x10 棋盘                │
 *   ├──────────────────────────────────┤
 *   │   [下一个][暂存1][暂存2][暂存3]      │
 *   ├──────────────────────────────────┤
 *   │            模式规则                │
 *   ├──────────────────────────────────┤
 *   │            排行榜                  │
 *   └──────────────────────────────────┘
 *
 * Buttons and dialogs live in the DOM (see hud.ts).
 *
 * All values are CSS pixels; main.ts applies the device-pixel-ratio transform
 * so drawing code can stay in logical units.
 */

import type { LayoutMode } from '../core/settings'

/** Vertical space reserved for the DOM bottom bar. Keep in sync with styles.css. */
export const HUD_BOTTOM_PX = 62
/**
 * Space reserved above the bottom bar for the one-line gesture hint.
 *
 * The hint is DOM, positioned at the bottom of the window, so without reserving
 * its height the canvas would happily draw the leaderboard underneath it —
 * which is exactly what happened before this existed.
 */
export const HUD_HINT_PX = 18
/** Space under the DOM bar before content starts. */
export const HUD_TOP_PX = 14

/** Below this width the side column is dropped and the layout goes vertical. */
export const MOBILE_BREAKPOINT = 560

const MARGIN_MIN = 8
const GAP_RATIO = 0.18
const CELL_MIN = 14
const CELL_MAX = 88

/** Band heights in cell units. */
const TITLE_CELLS_MOBILE = 1.15
const TITLE_CELLS_DESKTOP = 0.62
const RULES_CELLS_MOBILE = 0.8
const RULES_CELLS_DESKTOP = 0.58

/**
 * Width of the desktop side column as a multiple of the cell.
 * The board is usually height-constrained, so there is horizontal slack; a
 * one-cell column wastes it and makes the score text unreadably narrow.
 */
const SIDE_WIDTH_RATIO = 1.5
/** Below this column width the desktop panel drops to two lines. */
const COMPACT_SIDE_WIDTH = 84
/** Height of the desktop score panel, in cell units. */
const SCORE_PANEL_CELLS = 2.05
/** Shorter variant used when the column is too narrow for four lines. */
const SCORE_PANEL_CELLS_COMPACT = 1.8

/** Vertical gap between stacked bands, as a multiple of cell * GAP_RATIO. */
const BAND_GAP_RATIO = 1.3
/** Number of gaps between the stacked bands (title|board|slots|rules|board). */
const BAND_COUNT = 4
/**
 * Extra space between the "next" slot and the buffer slots, in cell units.
 * Mobile only: the next slot is a different kind of thing from the tray, and
 * on a narrow screen the shared row otherwise reads as four interchangeable
 * slots.
 */
const NEXT_BRIDGE_CELLS = 0.55

/**
 * How far above the finger a dragged block is drawn, in pixels.
 *
 * A fingertip covers roughly 40-50 CSS px, and a phone cell is only 27-44 px,
 * so a block drawn at the touch point is completely hidden by the hand that is
 * carrying it. The offset is therefore an absolute floor rather than a fraction
 * of a cell: a fraction would shrink exactly when the screen (and the cell)
 * gets small, which is when the problem is worst.
 */
export const TOUCH_LIFT_MIN_PX = 56

/**
 * The same offset for a mouse or stylus, in cell units.
 *
 * Those pointers are thin, so the block only needs to clear the cursor glyph.
 * Lifting it a whole cell would make it read as detached from the pointer.
 */
const MOUSE_LIFT_CELLS = 0.15

/** Pointer kind, as far as drag behaviour is concerned. */
export type PointerKind = 'mouse' | 'pen' | 'touch'

/**
 * Classifies a `PointerEvent.pointerType` string.
 *
 * Anything unrecognised (including the empty string older engines report) is
 * treated as a mouse: that is the conservative case, since it keeps the block
 * under the cursor instead of moving the drop target out from under the player.
 */
export function pointerKindOf(pointerType: string): PointerKind {
  if (pointerType === 'touch') return 'touch'
  if (pointerType === 'pen') return 'pen'
  return 'mouse'
}

/** Vertical offset of the dragged block above the pointer, in pixels. */
export function dragLiftPx(layout: Layout, kind: PointerKind): number {
  if (kind === 'touch') return Math.max(layout.cell, TOUCH_LIFT_MIN_PX)
  return Math.round(layout.cell * MOUSE_LIFT_CELLS)
}

/** Leaderboard geometry, in cell units. */
const LB_HEADER_CELLS = 0.95
const LB_ROW_CELLS = 0.68
/**
 * Mobile gets a shorter leaderboard.
 *
 * The band is sized from the cell, and on a phone the board fills the width, so
 * the same cell-unit height produces a very tall panel with a lot of air around
 * the text — while taking height away from the board.
 */
const LB_HEADER_CELLS_MOBILE = 0.78
const LB_ROW_CELLS_MOBILE = 0.56

export interface Rect {
  x: number
  y: number
  size: number
}

export interface Band {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  width: number
  height: number
  /** True when the side column was dropped for a narrow viewport. */
  mobile: boolean

  cell: number
  cols: number
  rows: number
  gap: number

  boardX: number
  boardY: number
  /** Board width in pixels (cols * cell) — NOT square: the board is 7x10. */
  boardW: number
  /** Board height in pixels (rows * cell). */
  boardH: number

  /** Desktop only: left edge of the side column (score + next). */
  sideX: number
  /** Desktop only: width of the side column. */
  sideW: number
  /** Desktop only: true when the panel must drop to two lines. */
  compactScore: boolean

  /** Mode name band, above the board. */
  titleY: number
  titleH: number

  /** Score block: a row above the board on mobile, a column panel on desktop. */
  scoreY: number
  scoreH: number

  /** Desktop only: the next slot in the side column. */
  nextY: number

  /** Slot row under the board. On mobile it starts with the next slot. */
  bufferX0: number
  bufferY: number
  bufferSlots: number
  /** Extra gap inserted before the first buffer slot (mobile only), in px. */
  nextBridge: number

  /** Mode rules band, under the slot row. */
  rulesY: number
  rulesH: number

  leaderboardX: number
  leaderboardY: number
  leaderboardW: number
  leaderboardH: number
  leaderboardRows: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Height of the leaderboard band, in cell units. */
export function leaderboardCells(rows: number, mobile = false): number {
  return mobile
    ? LB_HEADER_CELLS_MOBILE + rows * LB_ROW_CELLS_MOBILE
    : LB_HEADER_CELLS + rows * LB_ROW_CELLS
}

/** True when the next slot shares the row under the board with the buffer. */
export function rowIncludesNext(layout: Layout): boolean {
  return layout.mobile
}

/** Number of slots drawn in the row under the board. */
export function rowSlotCount(layout: Layout): number {
  return layout.bufferSlots + (rowIncludesNext(layout) ? 1 : 0)
}

/**
 * Fits every band into the viewport.
 *
 * Each band's height is expressed in cell units, so the cell size can be
 * solved in one pass from both axes without iterating.
 */
export function computeLayout(
  width: number,
  height: number,
  cols: number,
  rows: number,
  bufferSlots: number,
  leaderboardRows: number,
  layoutMode: LayoutMode = 'auto'
): Layout {
  // "auto" follows the viewport; the explicit modes override it so a player can
  // keep the wide arrangement on a narrow window (or the compact one on a
  // wide screen) without resizing anything.
  const mobile =
    layoutMode === 'mobile'
      ? true
      : layoutMode === 'desktop'
        ? false
        : width < MOBILE_BREAKPOINT
  const margin = Math.max(MARGIN_MIN, Math.min(width, height) * 0.02)
  const availW = width - margin * 2
  const availH = height - HUD_TOP_PX - HUD_BOTTOM_PX - HUD_HINT_PX - margin * 2

  const titleCells = mobile ? TITLE_CELLS_MOBILE : TITLE_CELLS_DESKTOP
  const rulesCells = mobile ? RULES_CELLS_MOBILE : RULES_CELLS_DESKTOP
  const lbCells = leaderboardCells(leaderboardRows, mobile)

  // Vertical: title + board + slot row + rules + leaderboard, plus the gaps.
  const verticalCells =
    titleCells + rows + 1 + rulesCells + lbCells + GAP_RATIO * BAND_GAP_RATIO * BAND_COUNT
  const byHeight = availH / verticalCells

  // Horizontal: mobile has no side column, so the board can use the full width.
  const horizontalCells = mobile ? cols + GAP_RATIO : cols + SIDE_WIDTH_RATIO + GAP_RATIO
  const byWidth = availW / horizontalCells

  const cell = clamp(Math.floor(Math.min(byWidth, byHeight)), CELL_MIN, CELL_MAX)
  const gap = Math.max(2, Math.round(cell * GAP_RATIO))
  const bandGap = Math.round(cell * GAP_RATIO * BAND_GAP_RATIO)

  const boardW = cell * cols
  const boardH = cell * rows
  const sideW = mobile ? boardW : Math.max(cell, Math.round(cell * SIDE_WIDTH_RATIO))
  const contentW = mobile ? boardW : boardW + gap + sideW

  const titleH = Math.round(cell * titleCells)
  const rulesH = Math.round(cell * rulesCells)
  const lbH = Math.round(cell * lbCells)
  const contentH = titleH + boardH + cell + rulesH + lbH + bandGap * BAND_COUNT

  const boardX = Math.round((width - contentW) / 2)
  const titleY = Math.round(HUD_TOP_PX + margin + Math.max(0, (availH - contentH) / 2))
  const boardY = titleY + titleH + bandGap
  const bufferY = boardY + boardH + bandGap
  const rulesY = bufferY + cell + bandGap
  const leaderboardY = rulesY + rulesH + bandGap

  // Desktop side column: score above the next slot, vertically centred on the
  // board. Mobile reuses the title band for the score instead.
  const sideX = boardX + boardW + gap
  const compactScore = !mobile && sideW < COMPACT_SIDE_WIDTH
  const panelH = Math.round(cell * (compactScore ? SCORE_PANEL_CELLS_COMPACT : SCORE_PANEL_CELLS))
  const panelTop = Math.round(boardY + Math.max(0, (boardH - (panelH + gap + cell)) / 2))

  const scoreY = mobile ? titleY : panelTop
  const scoreH = mobile ? titleH : panelH
  const nextY = mobile ? bufferY : panelTop + panelH + gap

  // Slot row, centred under the board. On mobile the next slot leads the row
  // and is pushed away from the buffer by `nextBridge`.
  const slotCount = bufferSlots + (mobile ? 1 : 0)
  const nextBridge = mobile ? Math.round(cell * NEXT_BRIDGE_CELLS) : 0
  const rowWidth = rowWidthOf(cell, gap, slotCount, nextBridge, mobile)
  const rowX0 = Math.round(boardX + (boardW - rowWidth) / 2)
  const bufferX0 = mobile ? rowX0 + cell + gap + nextBridge : rowX0

  const leaderboardW = Math.max(boardW, rowWidth)

  return {
    width,
    height,
    mobile,
    cell,
    cols,
    rows,
    gap,
    boardX,
    boardY,
    boardW,
    boardH,
    sideX,
    sideW,
    compactScore,
    titleY,
    titleH,
    scoreY,
    scoreH,
    nextY,
    bufferX0,
    bufferY,
    bufferSlots,
    nextBridge,
    rulesY,
    rulesH,
    leaderboardX: Math.round(boardX + (boardW - leaderboardW) / 2),
    leaderboardY,
    leaderboardW,
    leaderboardH: lbH,
    leaderboardRows
  }
}

// ---------------------------------------------------------------------------
// Rects
// ---------------------------------------------------------------------------

export function boardCellRect(layout: Layout, x: number, y: number): Rect {
  return {
    x: layout.boardX + x * layout.cell,
    y: layout.boardY + y * layout.cell,
    size: layout.cell
  }
}

/** Mode-name band above the board. */
export function titleBand(layout: Layout): Band {
  return { x: layout.boardX, y: layout.titleY, w: layout.boardW, h: layout.titleH }
}

/** Score block: a full-width row on mobile, the side panel on desktop. */
export function scoreBand(layout: Layout): Band {
  if (layout.mobile) {
    return { x: layout.boardX, y: layout.scoreY, w: layout.boardW, h: layout.scoreH }
  }
  return { x: layout.sideX, y: layout.scoreY, w: layout.sideW, h: layout.scoreH }
}

/** Mode rules band under the slot row. */
export function rulesBand(layout: Layout): Band {
  return { x: layout.boardX, y: layout.rulesY, w: layout.boardW, h: layout.rulesH }
}

export function leaderboardBand(layout: Layout): Band {
  return {
    x: layout.leaderboardX,
    y: layout.leaderboardY,
    w: layout.leaderboardW,
    h: layout.leaderboardH
  }
}

/** Slot `i` of the row under the board (index 0 is the next slot on mobile). */
export function rowSlotRect(layout: Layout, i: number): Rect {
  return {
    x: rowSlotX(layout, i),
    y: layout.bufferY,
    size: layout.cell
  }
}

/**
 * X of row slot `i`, taking the mobile next->buffer bridge into account.
 * Single source of truth so the offset maths is not repeated in three places.
 */
function rowSlotX(layout: Layout, i: number): number {
  const origin = layout.bufferX0 - (rowIncludesNext(layout) ? layout.cell + layout.gap + layout.nextBridge : 0)
  const bridge = rowIncludesNext(layout) && i >= 1 ? layout.nextBridge : 0
  return origin + i * (layout.cell + layout.gap) + bridge
}

/** Total width of the slot row. */
function rowWidthOf(
  cell: number,
  gap: number,
  slotCount: number,
  nextBridge: number,
  mobile: boolean
): number {
  const bridge = mobile ? nextBridge : 0
  return slotCount * cell + (slotCount - 1) * gap + bridge
}

/** The "next" slot: side column on desktop, row slot 0 on mobile. */
export function nextSlotRect(layout: Layout): Rect {
  if (layout.mobile) return rowSlotRect(layout, 0)
  return { x: layout.sideX, y: layout.nextY, size: layout.cell }
}

/** Buffer slot n: row slot n on desktop, row slot n+1 on mobile. */
export function bufferSlotRect(layout: Layout, slot: number): Rect {
  return rowSlotRect(layout, slot + (rowIncludesNext(layout) ? 1 : 0))
}

/** Inset used for the visible block, leaving a gutter between neighbours. */
export function innerRect(rect: Rect, padding: number): Rect {
  const pad = rect.size * padding
  return { x: rect.x + pad, y: rect.y + pad, size: rect.size - pad * 2 }
}

export function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 }
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export function boardCellAt(layout: Layout, px: number, py: number): { x: number; y: number } | null {
  const localX = px - layout.boardX
  const localY = py - layout.boardY
  if (localX < 0 || localY < 0) return null

  const x = Math.floor(localX / layout.cell)
  const y = Math.floor(localY / layout.cell)
  if (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows) return null
  return { x, y }
}

function hits(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px < rect.x + rect.size && py >= rect.y && py < rect.y + rect.size
}

export function bufferSlotAt(layout: Layout, px: number, py: number): number | null {
  for (let slot = 0; slot < layout.bufferSlots; slot++) {
    if (hits(bufferSlotRect(layout, slot), px, py)) return slot
  }
  return null
}

export function isNextSlotAt(layout: Layout, px: number, py: number): boolean {
  return hits(nextSlotRect(layout), px, py)
}

/**
 * Which tray slot a drag would drop into, given where the pointer is.
 *
 * The sibling of `carriedCellAt`, and deliberately the same rule: the target is
 * wherever the carried block is drawn, not wherever the finger is. A player
 * holding a block over a tray slot lets go expecting it to go in that slot, so
 * the finger being on the empty space *below* the slot must not matter.
 *
 * On a phone the two areas stay apart on their own. The block is lifted 56px,
 * so a finger on the tray row resolves to the board's last row, while the tray
 * is reached from 56px lower — the two finger positions are disjoint, and there
 * is no precedence to argue about. `tests/drag.test.ts` pins that down.
 */
export function carriedSlotAt(
  layout: Layout,
  px: number,
  py: number,
  kind: PointerKind
): number | null {
  return bufferSlotAt(layout, px, py - dragLiftPx(layout, kind))
}

/**
 * Which board cell a drag would drop into, given where the pointer is.
 *
 * The dropped block is drawn `dragLiftPx` above the pointer (see `dragLiftPx`),
 * so the cell under the block — not the cell under the finger — is the one the
 * player is aiming at. This is what makes the gesture "what you see is what you
 * get": the block and the highlighted target are the same square.
 *
 * The reach limit is the whole difficulty here. On a phone the lift is 56px but
 * a cell is only 27-44px, so the block sits 1.3-2.1 rows above the finger. The
 * finger cannot leave the board area, which means the lift can only ever move
 * the target *upwards* — and the bottom rows would be unreachable.
 *
 * The escape is to let the finger go *below* the board by exactly the amount
 * the lift overshoots one cell (`lift - cell`). That is the shortest overhang
 * that puts the block's centre inside the last row, and it is 0 whenever the
 * lift fits inside a cell — so a mouse, whose block barely leaves the cursor,
 * keeps its old target area unchanged. Above the board the same margin applies
 * but the target is additionally pinned to the first row, because a finger
 * cannot go above the screen.
 */
export function carriedCellAt(
  layout: Layout,
  px: number,
  py: number,
  kind: PointerKind
): { x: number; y: number } | null {
  const anchorY = py - dragLiftPx(layout, kind)

  const direct = boardCellAt(layout, px, anchorY)
  if (direct !== null) return direct

  // Vertical overhang the finger is allowed, in pixels. Zero for a mouse; on a
  // phone it is the amount by which the block is drawn more than a row higher.
  const overhang = Math.max(0, dragLiftPx(layout, kind) - layout.cell)
  const boardBottom = layout.boardY + layout.boardH
  const aboveBoard = anchorY < layout.boardY && py >= layout.boardY - overhang && py <= boardBottom + overhang
  if (aboveBoard && px >= layout.boardX && px < layout.boardX + layout.boardW) {
    return { x: Math.floor((px - layout.boardX) / layout.cell), y: 0 }
  }

  return null
}

/** Maps a board-space position (can be fractional) to pixels. */
export function boardSpaceToPx(layout: Layout, x: number, y: number): { x: number; y: number } {
  return { x: layout.boardX + x * layout.cell, y: layout.boardY + y * layout.cell }
}
