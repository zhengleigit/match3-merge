import { describe, expect, it } from 'vitest'
import {
  HUD_BOTTOM_PX,
  MOBILE_BREAKPOINT,
  boardCellAt,
  bufferSlotRect,
  carriedCellAt,
  carriedSlotAt,
  computeLayout,
  dragLiftPx,
  pointerKindOf,
  rulesBand,
  type Layout,
  type PointerKind
} from '../src/view/layout'

/**
 * Dragging a block with a finger.
 *
 * On a phone the carried block is drawn a whole cell above the touch point,
 * because a fingertip is wider than a board cell and would otherwise hide the
 * block completely. The drop then has to follow the *block*, not the finger, or
 * the gesture stops being "what you see is what you get".
 *
 * The awkward part is geometric rather than logical: a lift of 56px is 1.3-2.1
 * cells on a phone (cells are only 27-44px there), and the finger has to stay
 * inside the board, so a lift can only ever move the target *upwards*. These
 * tests pin down the escape hatch — clamping the target to the nearest row —
 * and, just as importantly, that it never fires on a desktop pointer.
 */

const BUFFER_SLOTS = 3
const LB_ROWS = 3

/** Real phone portrait sizes plus a desktop window, in CSS pixels. */
const PHONES: Array<[number, number]> = [
  [320, 568],
  [375, 667],
  [375, 812],
  [390, 844],
  [414, 896]
]
const DESKTOP: Array<[number, number]> = [
  [640, 480],
  [768, 1024],
  [1113, 1043],
  [1440, 900]
]

function layoutAt(width: number, height: number): Layout {
  return computeLayout(width, height, 7, 10, BUFFER_SLOTS, LB_ROWS)
}

/** Horizontal centre of column `x`. */
function columnPx(layout: Layout, x: number): number {
  return layout.boardX + (x + 0.5) * layout.cell
}

/** Where a finger must be to target row `y`, given the lift. */
function fingerYFor(layout: Layout, y: number, kind: PointerKind): number {
  return layout.boardY + (y + 0.5) * layout.cell + dragLiftPx(layout, kind)
}

/**
 * The drop target as the input layer sees it: tray first, then board.
 *
 * Kept in one place so these tests exercise the same precedence the game uses
 * rather than a simplified copy of it.
 */
type Target =
  | { kind: 'slot'; slot: number }
  | { kind: 'cell'; x: number; y: number }
  | null

function targetAt(layout: Layout, px: number, py: number, kind: PointerKind): Target {
  const slot = carriedSlotAt(layout, px, py, kind)
  if (slot !== null) return { kind: 'slot', slot }
  const cell = carriedCellAt(layout, px, py, kind)
  return cell === null ? null : { kind: 'cell', x: cell.x, y: cell.y }
}

describe('drag: classifying the pointer', () => {
  it('recognises the three kinds the browser reports', () => {
    expect(pointerKindOf('touch')).toBe('touch')
    expect(pointerKindOf('pen')).toBe('pen')
    expect(pointerKindOf('mouse')).toBe('mouse')
  })

  it('treats an unknown or missing pointerType as a mouse', () => {
    // Older engines report "". Falling back to mouse is the conservative
    // choice: the block stays under the pointer rather than the drop target
    // jumping up while the player is aiming.
    expect(pointerKindOf('')).toBe('mouse')
    expect(pointerKindOf('unknown-future-device')).toBe('mouse')
  })
})

describe('drag: lift height', () => {
  it('clears a fingertip even on the smallest board', () => {
    // The floor is what makes this work: a fraction of the cell would shrink
    // exactly when the cell (and the problem) is at its worst.
    for (const [w, h] of PHONES) {
      const layout = layoutAt(w, h)
      expect(dragLiftPx(layout, 'touch'), `${w}x${h}`).toBeGreaterThanOrEqual(56)
      // Must out-reach a cell, or the block would sit on the row the finger is
      // already touching.
      expect(dragLiftPx(layout, 'touch'), `${w}x${h}`).toBeGreaterThan(layout.cell)
    }
  })

  it('tidies the mouse and pen block just above the cursor', () => {
    for (const [w, h] of DESKTOP) {
      const layout = layoutAt(w, h)
      const lift = dragLiftPx(layout, 'mouse')
      expect(lift).toBeGreaterThan(0)
      expect(lift).toBeLessThan(layout.cell)
      expect(dragLiftPx(layout, 'pen')).toBe(lift)
    }
  })
})

describe('drag: the drop target follows the carried block', () => {
  it('aims one row above the finger on a phone', () => {
    const layout = layoutAt(375, 812)
    const x = 3

    for (let y = 0; y < layout.rows; y++) {
      const fingerY = fingerYFor(layout, y, 'touch')
      if (fingerY > layout.bufferY) continue // outside the reachable strip
      const cell = carriedCellAt(layout, columnPx(layout, x), fingerY, 'touch')
      expect(cell, `row ${y}`).toEqual({ x, y })
    }
  })

  it('lands on the cell under the finger for a mouse', () => {
    const layout = layoutAt(1440, 900)
    for (let y = 0; y < layout.rows; y++) {
      const mid = layout.boardY + (y + 0.5) * layout.cell
      const cell = carriedCellAt(layout, columnPx(layout, 2), mid, 'mouse')
      expect(cell, `row ${y}`).toEqual({ x: 2, y })
    }
  })

  it('agrees with the cell the block is actually drawn on', () => {
    // The renderer snaps the ghost to the reported cell, so "the block is on
    // the square it will land in" holds only while this stays true.
    const layout = layoutAt(375, 812)
    for (let i = 0; i < 400; i++) {
      const px = layout.boardX + (i * 37) % layout.boardW
      const py = layout.boardY + (i * 53) % (layout.boardH + 40)
      for (const kind of ['touch', 'mouse'] as PointerKind[]) {
        const reported = carriedCellAt(layout, px, py, kind)
        if (reported === null) continue
        const anchorY = py - dragLiftPx(layout, kind)
        const direct = boardCellAt(layout, px, anchorY)
        if (direct !== null) expect(reported).toEqual(direct)
      }
    }
  })
})

describe('drag: every row must stay reachable', () => {
  /**
   * The reason the overhang exists.
   *
   * A phone lift is bigger than a cell, so aiming at the top row needs the
   * finger at a negative-ish y and aiming at the bottom row needs it past the
   * board's bottom edge. The sweep is bounded by the rules band rather than by
   * the slot row, which is the real limit: a finger further down than that is
   * over the mode text, and nothing there should place a block.
   */
  it('lets a finger reach every row on every phone', () => {
    for (const [w, h] of PHONES) {
      const layout = layoutAt(w, h)
      const limit = rulesBand(layout).y
      expect(limit, `${w}x${h} has room below the board`).toBeGreaterThan(
        layout.boardY + layout.boardH
      )

      for (let y = 0; y < layout.rows; y++) {
        const x = 3
        let hitAt = -1
        for (let py = layout.boardY; py <= limit && hitAt < 0; py++) {
          const t = targetAt(layout, columnPx(layout, x), py, 'touch')
          if (t !== null && t.kind === 'cell' && t.x === x && t.y === y) hitAt = py
        }
        expect(hitAt, `${w}x${h} row ${y}`).toBeGreaterThanOrEqual(0)
        // The finger must stay inside the play area while aiming, otherwise the
        // reach would be theoretical.
        expect(hitAt, `${w}x${h} row ${y} finger`).toBeLessThan(limit)
      }
    }
  })

  it('pins a target above the board to the first row, keeping the column', () => {
    const layout = layoutAt(375, 812)
    const x = 5

    const above = carriedCellAt(layout, columnPx(layout, x), layout.boardY, 'touch')
    expect(above).toEqual({ x, y: 0 })
  })

  it('does not clamp on a desktop, where the lift fits inside a cell', () => {
    // Regression guard: the overhang must be zero for a mouse, so nothing about
    // the desktop drag target widens. A pointer above the board belongs to the
    // side column there, and reporting the top row instead would place blocks
    // nobody asked for.
    const layout = layoutAt(1440, 900)
    expect(layout.mobile).toBe(false)
    expect(dragLiftPx(layout, 'mouse')).toBeLessThan(layout.cell)

    expect(carriedCellAt(layout, columnPx(layout, 3), layout.boardY - 4, 'mouse')).toBeNull()
    expect(
      carriedCellAt(layout, layout.boardX - 10, layout.boardY + layout.cell, 'mouse')
    ).toBeNull()
  })

  it('reports no cell when the block is carried off the board sideways', () => {
    const layout = layoutAt(375, 812)
    expect(carriedCellAt(layout, -20, layout.boardY + layout.cell, 'touch')).toBeNull()
    expect(carriedCellAt(layout, layout.width + 20, layout.boardY + layout.cell, 'touch')).toBeNull()
  })
})

describe('drag: the tray is aimed with the block too', () => {
  /**
   * Why the finger has to be *below* the tray.
   *
   * The block hangs a whole cell above the hand. Holding it over a slot means
   * the finger is on the empty space under the row — so a finger actually on
   * the tray resolves to the board's last row, because that is where the block
   * is. The two finger positions do not overlap, which is what makes the rule
   * unambiguous.
   */
  it('resolves to the slot a finger below the row is aiming at', () => {
    const layout = layoutAt(375, 812)
    const lift = dragLiftPx(layout, 'touch')

    for (let slot = 0; slot < BUFFER_SLOTS; slot++) {
      const rect = bufferSlotRect(layout, slot)
      const fingerY = rect.y + rect.size / 2 + lift
      const fingerX = rect.x + rect.size / 2

      // The finger is past the bottom of the tray...
      expect(fingerY, `slot ${slot} finger`).toBeGreaterThan(layout.bufferY + layout.cell)
      // ...and the block, not the finger, is what lands on the slot.
      expect(carriedSlotAt(layout, fingerX, fingerY, 'touch'), `slot ${slot}`).toBe(slot)
      expect(targetAt(layout, fingerX, fingerY, 'touch'), `slot ${slot}`).toEqual({
        kind: 'slot',
        slot
      })
    }
  })

  it('sends a finger resting on the tray to the board, not the tray', () => {
    // The other half of the same rule. The block is over the board's last row,
    // so that is where it goes; reporting the tray would be dropping a block in
    // a place it visibly is not.
    const layout = layoutAt(375, 812)
    const rect = bufferSlotRect(layout, 1)
    const onTray = { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 }

    expect(carriedSlotAt(layout, onTray.x, onTray.y, 'touch')).toBeNull()
    expect(targetAt(layout, onTray.x, onTray.y, 'touch')).toEqual({
      kind: 'cell',
      x: Math.floor((onTray.x - layout.boardX) / layout.cell),
      y: layout.rows - 1
    })
  })

  it('stays inside the viewport and clear of the bottom bar', () => {
    // Reachability is only real if the finger can physically be there. The row
    // below the tray is where the mode rules are drawn, so the aiming spot must
    // finish above the fixed HUD bar as well.
    for (const [w, h] of PHONES) {
      const layout = layoutAt(w, h)
      const lift = dragLiftPx(layout, 'touch')
      const lowest = layout.bufferY + layout.cell + lift
      const barTop = h - HUD_BOTTOM_PX

      expect(layout.bufferY + layout.cell, `${w}x${h} tray visible`).toBeLessThan(barTop)
      expect(lowest, `${w}x${h} aiming spot`).toBeLessThan(barTop)
    }
  })

  it('never reports a tray slot and a board cell at the same time', () => {
    // The input layer asks for the slot first and only then the board, which is
    // only safe while the two can never both match. Sweeping the whole board
    // column plus the strip under it keeps that assumption honest.
    const layout = layoutAt(375, 812)
    let overlaps = 0
    for (let py = layout.boardY; py < layout.height; py++) {
      for (let px = 0; px < layout.width; px += 3) {
        if (
          carriedSlotAt(layout, px, py, 'touch') !== null &&
          carriedCellAt(layout, px, py, 'touch') !== null
        ) {
          overlaps++
        }
      }
    }
    expect(overlaps).toBe(0)
  })

  it('leaves the mouse on the slot under the cursor', () => {
    // The desktop lift is a few pixels, so "the block is over the slot" and "the
    // cursor is over the slot" agree everywhere that matters, and a mouse user
    // keeps click-where-you-point.
    for (const [w, h] of DESKTOP) {
      const layout = layoutAt(w, h)
      expect(carriedSlotAt(layout, 0, 0, 'mouse'), `${w}x${h}`).toBeNull()
      for (let slot = 0; slot < BUFFER_SLOTS; slot++) {
        const rect = bufferSlotRect(layout, slot)
        const x = rect.x + rect.size / 2
        const y = rect.y + rect.size / 2
        expect(carriedSlotAt(layout, x, y, 'mouse'), `${w}x${h} slot ${slot}`).toBe(slot)
      }
    }
  })

  it('leaves the buffer slots where they were', () => {
    const layout = layoutAt(375, 812)
    for (let slot = 0; slot < BUFFER_SLOTS; slot++) {
      const rect = bufferSlotRect(layout, slot)
      expect(rect.y).toBeGreaterThanOrEqual(layout.bufferY)
      expect(rect.y + rect.size).toBeLessThanOrEqual(layout.bufferY + layout.cell + 1)
    }
  })
})

describe('drag: viewport sanity', () => {
  it('measures the phone cells these offsets were chosen against', () => {
    // Documents the constraint the design works within. If the layout ever
    // stops producing small cells on phones, the 56px floor can be revisited.
    for (const [w, h] of PHONES) {
      const layout = layoutAt(w, h)
      expect(layout.mobile, `${w}x${h}`).toBe(true)
      expect(layout.cell, `${w}x${h}`).toBeLessThan(dragLiftPx(layout, 'touch'))
    }
  })

  it('still switches to the side column above the breakpoint', () => {
    expect(layoutAt(MOBILE_BREAKPOINT - 1, 812).mobile).toBe(true)
    expect(layoutAt(MOBILE_BREAKPOINT, 812).mobile).toBe(false)
  })
})
