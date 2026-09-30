import { describe, expect, it } from 'vitest'
import {
  HUD_BOTTOM_PX,
  HUD_TOP_PX,
  MOBILE_BREAKPOINT,
  boardCellAt,
  boardCellRect,
  boardSpaceToPx,
  bufferSlotAt,
  bufferSlotRect,
  computeLayout,
  innerRect,
  isNextSlotAt,
  leaderboardBand,
  leaderboardCells,
  nextSlotRect,
  rowIncludesNext,
  rowSlotCount,
  rowSlotRect,
  rulesBand,
  scoreBand,
  titleBand,
  type Layout
} from '../src/view/layout'

const BUFFER_SLOTS = 3
const LB_ROWS = 3

/** Phone portrait (mobile variant) and a desktop window (side-column variant). */
const MOBILE_VIEWPORTS: Array<[number, number]> = [
  [320, 568],
  [375, 812],
  [414, 896]
]
const DESKTOP_VIEWPORTS: Array<[number, number]> = [
  [640, 480],
  [768, 1024],
  [1113, 1043],
  [1440, 900]
]
const ALL = [...MOBILE_VIEWPORTS, ...DESKTOP_VIEWPORTS]

function at(width: number, height: number): Layout {
  return computeLayout(width, height, 7, 10, BUFFER_SLOTS, LB_ROWS)
}

function forced(width: number, height: number, mode: 'auto' | 'desktop' | 'mobile'): Layout {
  return computeLayout(width, height, 7, 10, BUFFER_SLOTS, LB_ROWS, mode)
}

describe('layout: forced variant from settings', () => {
  it('overrides the viewport on both axes', () => {
    // Forcing is the point: a narrow window can still get the side column, and
    // a wide one can still get the single-column arrangement.
    expect(forced(375, 812, 'desktop').mobile).toBe(false)
    expect(forced(1440, 900, 'mobile').mobile).toBe(true)
  })

  it('matches the automatic choice when asked to', () => {
    for (const [w, h] of ALL) {
      const auto = at(w, h)
      const explicit = forced(w, h, 'auto')
      expect(explicit).toEqual(auto)
      expect(forced(w, h, 'mobile').mobile).toBe(true)
      expect(forced(w, h, 'desktop').mobile).toBe(false)
    }
  })

  it('produces a consistent geometry for a forced mobile layout on a wide window', () => {
    // A forced layout must still satisfy every structural invariant, otherwise
    // the board would be drawn outside the reserved bands.
    const layout = forced(1200, 900, 'mobile')

    expect(rowIncludesNext(layout)).toBe(true)
    expect(scoreBand(layout).w).toBe(layout.boardW)
    expect(titleBand(layout).y).toBeLessThan(layout.boardY)
    expect(layout.boardY + layout.boardH).toBeLessThanOrEqual(layout.bufferY)
  })
})

describe('layout: variant selection', () => {
  it('drops the side column on narrow viewports', () => {
    for (const [w, h] of MOBILE_VIEWPORTS) {
      expect(w).toBeLessThan(MOBILE_BREAKPOINT)
      expect(at(w, h).mobile).toBe(true)
    }
  })

  it('uses the side column on roomy viewports', () => {
    for (const [w, h] of DESKTOP_VIEWPORTS) {
      expect(w).toBeGreaterThanOrEqual(MOBILE_BREAKPOINT)
      expect(at(w, h).mobile).toBe(false)
    }
  })

  it('gives the mobile board the full width (no side column reserved)', () => {
    const mobile = at(375, 812)
    const desktop = at(768, 1024)

    // The mobile score band spans the board, not a side column.
    expect(scoreBand(mobile).w).toBe(mobile.boardW)
    expect(mobile.sideW).toBe(mobile.boardW)
    // The desktop column is a real separate column.
    expect(scoreBand(desktop).w).toBeLessThan(desktop.boardW)
    expect(desktop.sideX).toBe(desktop.boardX + desktop.boardW + desktop.gap)
  })
})

describe('layout: board geometry', () => {
  it('keeps the board rectangular, not square (7 cols x 10 rows)', () => {
    // Regression: boardSize was used for both axes, so the plate covered only
    // 7 of the 10 rows and the slot row overlapped the board.
    for (const [w, h] of ALL) {
      const layout = at(w, h)
      expect(layout.boardW).toBe(layout.cell * 7)
      expect(layout.boardH).toBe(layout.cell * 10)
      expect(layout.boardH).toBeGreaterThan(layout.boardW)
    }
  })

  it('fits every band inside the viewport on all viewports', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)

      expect(layout.boardX).toBeGreaterThanOrEqual(0)
      expect(layout.boardY).toBeGreaterThanOrEqual(HUD_TOP_PX)

      // Title band sits above the board.
      const title = titleBand(layout)
      expect(title.y + title.h).toBeLessThanOrEqual(layout.boardY)

      // Slot row stays on screen.
      const last = bufferSlotRect(layout, BUFFER_SLOTS - 1)
      const first = bufferSlotRect(layout, 0)
      expect(first.x).toBeGreaterThanOrEqual(0)
      expect(last.x + last.size).toBeLessThanOrEqual(width)
      if (layout.mobile) {
        const next = nextSlotRect(layout)
        expect(next.x).toBeGreaterThanOrEqual(0)
        expect(next.x).toBeLessThan(first.x)
      }

      // Score, rules and leaderboard stay on screen.
      for (const band of [scoreBand(layout), rulesBand(layout), leaderboardBand(layout)]) {
        expect(band.x).toBeGreaterThanOrEqual(0)
        expect(band.x + band.w).toBeLessThanOrEqual(width)
      }

      // The bottom-most band clears the DOM bar.
      expect(leaderboardBand(layout).y + leaderboardBand(layout).h).toBeLessThanOrEqual(
        height - HUD_BOTTOM_PX + 1
      )
    }
  })

  it('clamps the cell size on degenerate viewports', () => {
    expect(at(100, 200).cell).toBeGreaterThanOrEqual(14)
    expect(at(4000, 4000).cell).toBeLessThanOrEqual(88)
  })
})

describe('layout: vertical band order', () => {
  it('stacks title -> board -> slots -> rules -> leaderboard without overlap', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)
      const title = titleBand(layout)
      const slots = bufferSlotRect(layout, 0)
      const rules = rulesBand(layout)
      const lb = leaderboardBand(layout)

      expect(title.y + title.h).toBeLessThanOrEqual(layout.boardY)
      expect(slots.y).toBeGreaterThanOrEqual(layout.boardY + layout.boardH)
      expect(rules.y).toBeGreaterThanOrEqual(slots.y + slots.size)
      expect(lb.y).toBeGreaterThanOrEqual(rules.y + rules.h)
      expect(lb.y + lb.h).toBeGreaterThan(lb.y)
    }
  })

  it('sizes the leaderboard band from the requested row count', () => {
    const three = at(1113, 1043)
    expect(three.leaderboardRows).toBe(3)
    expect(three.leaderboardH).toBe(Math.round(three.cell * leaderboardCells(3)))

    const five = computeLayout(1113, 1043, 7, 10, BUFFER_SLOTS, 5)
    expect(five.leaderboardH).toBeGreaterThan(three.leaderboardH)
    expect(five.cell).toBeLessThanOrEqual(three.cell)
  })

  it('makes the mobile leaderboard shorter than the desktop one', () => {
    // Regression: the band is sized in cell units, and a phone's cell is big
    // because the board fills the width. At the desktop ratio the ranking took
    // a huge slab of the screen and its text dwarfed the rules line.
    expect(leaderboardCells(3, true)).toBeLessThan(leaderboardCells(3, false))

    const mobile = at(375, 812)
    expect(mobile.mobile).toBe(true)
    expect(mobile.leaderboardH).toBe(Math.round(mobile.cell * leaderboardCells(3, true)))

    // The ratio itself, not just the cell size, is what changed.
    const mobileRatio = mobile.leaderboardH / mobile.cell
    const desktop = at(1113, 1043)
    expect(mobileRatio).toBeLessThan(desktop.leaderboardH / desktop.cell)
  })
})

describe('layout: the slot row under the board', () => {
  it('lays the slots side by side at the same Y', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)
      const count = rowSlotCount(layout)
      const ys = new Set<number>()

      for (let slot = 0; slot < BUFFER_SLOTS; slot++) {
        ys.add(bufferSlotRect(layout, slot).y)
      }
      expect(ys.size).toBe(1)

      // Consecutive slots never overlap.
      for (let slot = 1; slot < BUFFER_SLOTS; slot++) {
        const previous = bufferSlotRect(layout, slot - 1)
        const current = bufferSlotRect(layout, slot)
        expect(current.x).toBe(previous.x + previous.size + layout.gap)
      }

      expect(count).toBe(layout.mobile ? BUFFER_SLOTS + 1 : BUFFER_SLOTS)
    }
  })

  it('puts the next slot first in the row on mobile, and in the column on desktop', () => {
    const mobile = at(375, 812)
    expect(rowIncludesNext(mobile)).toBe(true)
    const mobileNext = nextSlotRect(mobile)
    const mobileFirst = bufferSlotRect(mobile, 0)
    expect(mobileNext.y).toBe(mobileFirst.y)
    expect(mobileNext.x).toBeLessThan(mobileFirst.x)
    // The next slot shares the row with the buffer.
    expect(mobileNext.y).toBe(mobile.bufferY)

    const desktop = at(1113, 1043)
    expect(rowIncludesNext(desktop)).toBe(false)
    const desktopNext = nextSlotRect(desktop)
    expect(desktopNext.x).toBe(desktop.sideX)
    expect(desktopNext.y).toBeLessThan(desktop.bufferY)
    // Desktop buffer slot 0 is the first slot of the row.
    expect(bufferSlotRect(desktop, 0).x).toBe(desktop.bufferX0)
  })

  it('separates the next slot from the buffer a bit more on mobile', () => {
    // The next slot is a different kind of thing from the tray, and on a
    // narrow screen a uniform row reads as four interchangeable slots.
    for (const [width, height] of MOBILE_VIEWPORTS) {
      const layout = at(width, height)
      const next = nextSlotRect(layout)
      const first = bufferSlotRect(layout, 0)
      const uniform = layout.cell + layout.gap

      expect(layout.nextBridge).toBeGreaterThan(0)
      expect(first.x - next.x).toBe(uniform + layout.nextBridge)
    }

    // Desktop keeps the uniform gap (the next slot is not in the row at all).
    const desktop = at(1113, 1043)
    expect(desktop.nextBridge).toBe(0)
    expect(bufferSlotRect(desktop, 1).x - bufferSlotRect(desktop, 0).x).toBe(
      desktop.cell + desktop.gap
    )
  })

  it('keeps the buffered slots evenly spaced on mobile despite the bridge', () => {
    const layout = at(375, 812)
    for (let slot = 1; slot < BUFFER_SLOTS; slot++) {
      const previous = bufferSlotRect(layout, slot - 1)
      const current = bufferSlotRect(layout, slot)
      expect(current.x - previous.x).toBe(layout.cell + layout.gap)
    }
  })

  it('centres the slot row under the board', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)
      // Measure the ROW, not the next slot: on desktop the next slot lives in
      // the side column and would make this comparison meaningless.
      const first = rowSlotRect(layout, 0)
      const last = rowSlotRect(layout, rowSlotCount(layout) - 1)
      const leftGap = first.x - layout.boardX
      const rightGap = layout.boardX + layout.boardW - (last.x + last.size)
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1)
    }
  })
})

describe('layout: score placement', () => {
  it('shares the title row on mobile', () => {
    const mobile = at(375, 812)
    const score = scoreBand(mobile)
    const title = titleBand(mobile)

    expect(score.y).toBe(title.y)
    expect(score.h).toBe(title.h)
    expect(score.y + score.h).toBeLessThanOrEqual(mobile.boardY)
  })

  it('uses a vertical panel above the next slot on desktop', () => {
    const desktop = at(1113, 1043)
    const score = scoreBand(desktop)

    expect(score.y).toBeGreaterThanOrEqual(desktop.boardY)
    expect(score.y + score.h).toBeLessThanOrEqual(nextSlotRect(desktop).y)
    expect(score.x).toBe(desktop.sideX)
    expect(score.w).toBe(desktop.sideW)
  })

  it('widens the desktop column beyond one cell and only compacts when narrow', () => {
    const wide = at(1113, 1043)
    expect(wide.sideW).toBeGreaterThan(wide.cell)
    expect(wide.compactScore).toBe(false)

    const phone = at(375, 812)
    // On mobile the score is a wide band, so the compact flag is irrelevant.
    expect(phone.compactScore).toBe(false)
    expect(scoreBand(phone).w).toBeGreaterThan(phone.cell)
  })
})

describe('layout: cell rects and hit testing', () => {
  it('places cells on a regular grid from the board origin', () => {
    const layout = at(1113, 1043)
    expect(boardCellRect(layout, 0, 0)).toEqual({
      x: layout.boardX,
      y: layout.boardY,
      size: layout.cell
    })
    expect(boardCellRect(layout, 2, 3).x).toBe(layout.boardX + layout.cell * 2)
    expect(boardCellRect(layout, 2, 3).y).toBe(layout.boardY + layout.cell * 3)
  })

  it('insets a rect by a padding ratio', () => {
    expect(innerRect({ x: 100, y: 50, size: 40 }, 0.25)).toEqual({ x: 110, y: 60, size: 20 })
  })

  it('maps board-space positions to pixels', () => {
    const layout = at(1113, 1043)
    expect(boardSpaceToPx(layout, 1.5, 2.5)).toEqual({
      x: layout.boardX + layout.cell * 1.5,
      y: layout.boardY + layout.cell * 2.5
    })
  })

  it('maps a point inside a cell back to that cell', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)
      for (const [x, y] of [
        [0, 0],
        [3, 4],
        [6, 9]
      ]) {
        const rect = boardCellRect(layout, x, y)
        expect(boardCellAt(layout, rect.x + rect.size / 2, rect.y + rect.size / 2)).toEqual({
          x,
          y
        })
      }
    }
  })

  it('returns null outside the board, including the bands', () => {
    const layout = at(1113, 1043)
    expect(boardCellAt(layout, layout.boardX - 1, layout.boardY)).toBeNull()
    expect(boardCellAt(layout, layout.boardX, layout.boardY - 1)).toBeNull()
    expect(boardCellAt(layout, layout.boardX + layout.boardW, layout.boardY)).toBeNull()
    expect(boardCellAt(layout, layout.boardX, layout.boardY + layout.boardH)).toBeNull()

    // Title band, slot row, rules band and leaderboard are all outside.
    const title = titleBand(layout)
    expect(boardCellAt(layout, title.x + title.w / 2, title.y + title.h / 2)).toBeNull()

    const slot = bufferSlotRect(layout, 0)
    expect(boardCellAt(layout, slot.x + slot.size / 2, slot.y + slot.size / 2)).toBeNull()

    const rules = rulesBand(layout)
    expect(boardCellAt(layout, rules.x + rules.w / 2, rules.y + rules.h / 2)).toBeNull()

    const lb = leaderboardBand(layout)
    expect(boardCellAt(layout, lb.x + lb.w / 2, lb.y + lb.h / 2)).toBeNull()
  })

  it('maps the last pixel of the last cell, not a phantom tenth row', () => {
    const layout = at(1113, 1043)
    expect(
      boardCellAt(layout, layout.boardX + layout.boardW - 0.5, layout.boardY + layout.boardH - 0.5)
    ).toEqual({ x: 6, y: 9 })
  })

  it('finds every buffer slot and the next slot without overlap', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)

      for (let slot = 0; slot < BUFFER_SLOTS; slot++) {
        const rect = bufferSlotRect(layout, slot)
        const px = rect.x + rect.size / 2
        const py = rect.y + rect.size / 2
        expect(bufferSlotAt(layout, px, py)).toBe(slot)
        expect(isNextSlotAt(layout, px, py)).toBe(false)
      }

      const next = nextSlotRect(layout)
      expect(isNextSlotAt(layout, next.x + next.size / 2, next.y + next.size / 2)).toBe(true)
      expect(bufferSlotAt(layout, next.x + next.size / 2, next.y + next.size / 2)).toBeNull()
    }
  })

  it('finds no slot in the gaps between slots', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)
      const next = nextSlotRect(layout)
      const gapX = next.x + next.size + layout.gap / 2
      expect(bufferSlotAt(layout, gapX, next.y + next.size / 2)).toBeNull()
      expect(isNextSlotAt(layout, gapX, next.y + next.size / 2)).toBe(false)
    }
  })

  it('reports no slot in the score, rules or leaderboard bands', () => {
    for (const [width, height] of ALL) {
      const layout = at(width, height)
      for (const band of [scoreBand(layout), rulesBand(layout), leaderboardBand(layout)]) {
        const px = band.x + band.w / 2
        const py = band.y + band.h / 2
        expect(isNextSlotAt(layout, px, py)).toBe(false)
        expect(bufferSlotAt(layout, px, py)).toBeNull()
      }
    }
  })
})
