import {
  boardCellAt,
  bufferSlotAt,
  carriedCellAt,
  dragLiftPx,
  isNextSlotAt,
  pointerKindOf,
  type Layout,
  type PointerKind
} from '../view/layout'

/**
 * Pointer input -> semantic actions.
 *
 * The rules layer never sees a pointer event; this module is the single place
 * where raw input becomes "pull the next block", "select a buffer slot",
 * "place on a cell" or "invalid drop".
 *
 * Interaction styles, all supported on purpose:
 *  - tap the "next" slot, tap a buffer slot, tap a cell  (single-handed, precise)
 *  - press a buffer slot and drag onto a cell            (same gesture, fewer taps)
 *  - press the "next" slot and drag onto a cell          (skips the buffer entirely)
 */

export interface PointerCallbacks {
  onPullNext(): void
  onSelectSlot(slot: number): void
  /** Place a buffered block. */
  onPlace(slot: number, x: number, y: number): void
  /** Drop the "next" block onto a buffer slot. */
  onNextToBuffer(slot: number): void
  /** Drop the "next" block straight onto the board. */
  onPlaceNext(x: number, y: number): void
  onInvalidDrop(): void
}

export interface PointerState {
  selectedSlot: number | null
  dragSlot: number
  dragLevel: number
  dragPx: { x: number; y: number } | null
  /**
   * Board cell the block is currently over, which is also the cell it would
   * drop into. Null whenever the pointer is not over the board.
   */
  hoverCell: { x: number; y: number } | null
  /**
   * Pixels the carried block is drawn above the pointer.
   *
   * Lives here rather than in the renderer so the drawing and the drop target
   * are guaranteed to agree: both derive from the same number, computed once.
   */
  dragLift: number
  hoverSlot: number | null
  hoverNext: boolean
  /**
   * True while the block being dragged came out of the "next" slot.
   *
   * The rules layer keeps the queued block until the drop lands, so the view
   * uses this to blank the next slot during the gesture — the player should see
   * the slot empty while carrying the block, and see the replacement only once
   * the block is put down.
   */
  dragFromNext: boolean
}

/** Movement needed before a press becomes a drag instead of a tap. */
const DRAG_THRESHOLD_PX = 6

type DragSource = 'none' | 'buffer' | 'next'

export class PointerInput {
  readonly state: PointerState = {
    selectedSlot: null,
    dragSlot: -1,
    dragLevel: 0,
    dragPx: null,
    hoverCell: null,
    dragLift: 0,
    hoverSlot: null,
    hoverNext: false,
    dragFromNext: false
  }

  private layout: Layout
  private boundRect: DOMRect | null = null

  private pressing = false
  private pressStartX = 0
  private pressStartY = 0
  private pressSource: DragSource = 'none'
  private dragSource: DragSource = 'none'
  private dragging = false
  /** Pointer kind of the gesture in progress; decides the lift. */
  private pressKind: PointerKind = 'mouse'

  constructor(
    private readonly canvas: HTMLCanvasElement,
    layout: Layout,
    private readonly callbacks: PointerCallbacks,
    /** Supplies the level currently in a buffer slot (0 = empty). */
    private readonly levelOfSlot: (slot: number) => number,
    /** Supplies the level in the "next" slot (0 = none). */
    private readonly levelOfNext: () => number,
    /** Whether input should be ignored right now (dialogs, game over). */
    private readonly isBlocked: () => boolean
  ) {
    this.layout = layout

    canvas.addEventListener('pointerdown', this.handleDown)
    canvas.addEventListener('pointermove', this.handleMove)
    canvas.addEventListener('pointerup', this.handleUp)
    canvas.addEventListener('pointercancel', this.handleCancel)
    canvas.addEventListener('pointerleave', this.handleLeave)
  }

  /** Call on resize; also refreshes the cached bounding rect. */
  setLayout(layout: Layout): void {
    this.layout = layout
    this.boundRect = null
  }

  /** Call from the app when the selection changes (e.g. after a placement). */
  setSelectedSlot(slot: number | null): void {
    this.state.selectedSlot = slot
  }

  clearDrag(): void {
    this.dragging = false
    this.pressing = false
    this.pressSource = 'none'
    this.dragSource = 'none'
    this.pressKind = 'mouse'
    this.state.dragSlot = -1
    this.state.dragLevel = 0
    this.state.dragPx = null
    this.state.hoverCell = null
    this.state.dragLift = 0
    this.state.dragFromNext = false
  }

  private toLocal(event: PointerEvent): { x: number; y: number } {
    if (this.boundRect === null) {
      this.boundRect = this.canvas.getBoundingClientRect()
    }
    return { x: event.clientX - this.boundRect.left, y: event.clientY - this.boundRect.top }
  }

  private handleDown = (event: PointerEvent): void => {
    if (this.isBlocked()) return

    const point = this.toLocal(event)
    this.pressing = true
    this.dragging = false
    this.pressStartX = point.x
    this.pressStartY = point.y
    this.dragSource = 'none'
    this.pressKind = pointerKindOf(event.pointerType)
    // Set at press time, not once the drag actually starts, so the block does
    // not jump under the finger the moment the threshold is crossed.
    this.state.dragLift = dragLiftPx(this.layout, this.pressKind)

    const slot = bufferSlotAt(this.layout, point.x, point.y)
    const onNext = isNextSlotAt(this.layout, point.x, point.y)

    if (slot !== null && this.levelOfSlot(slot) > 0) {
      this.pressSource = 'buffer'
      this.state.dragSlot = slot
      this.state.dragLevel = this.levelOfSlot(slot)
      this.state.dragPx = { x: point.x, y: point.y }
    } else if (onNext && this.levelOfNext() > 0) {
      // Dragging straight from "next" is allowed; the buffer is skipped.
      this.pressSource = 'next'
      this.state.dragSlot = -1
      this.state.dragLevel = this.levelOfNext()
      this.state.dragPx = { x: point.x, y: point.y }
    } else {
      this.pressSource = onNext ? 'next' : 'none'
      this.state.dragLift = 0
    }

    this.canvas.setPointerCapture(event.pointerId)
  }

  private handleMove = (event: PointerEvent): void => {
    const point = this.toLocal(event)

    if (!this.pressing) {
      // Hover feedback only.
      this.state.hoverSlot = bufferSlotAt(this.layout, point.x, point.y)
      this.state.hoverNext = isNextSlotAt(this.layout, point.x, point.y)
      return
    }

    const dx = point.x - this.pressStartX
    const dy = point.y - this.pressStartY
    const moved = Math.hypot(dx, dy)

    if (!this.dragging && moved >= DRAG_THRESHOLD_PX && this.state.dragLevel > 0) {
      this.dragging = true
      this.dragSource = this.pressSource
    }

    if (this.dragging) {
      this.state.dragPx = { x: point.x, y: point.y }
      // The target is the cell under the lifted block, not under the finger.
      this.state.hoverCell = carriedCellAt(this.layout, point.x, point.y, this.pressKind)
      this.state.dragFromNext = this.dragSource === 'next'
    }
  }

  private handleUp = (event: PointerEvent): void => {
    if (!this.pressing) return
    const point = this.toLocal(event)
    const wasDragging = this.dragging
    const source = this.dragSource
    const slot = this.state.dragSlot
    const hadLevel = this.state.dragLevel > 0

    this.pressing = false
    this.dragging = false
    this.dragSource = 'none'
    this.state.dragPx = null
    this.state.hoverCell = null
    this.state.dragSlot = -1
    this.state.dragLevel = 0
    this.state.dragLift = 0
    this.state.dragFromNext = false

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }

    if (wasDragging) {
      const cell = carriedCellAt(this.layout, point.x, point.y, this.pressKind)
      const dropSlot = bufferSlotAt(this.layout, point.x, point.y)
      if (!hadLevel) {
        this.callbacks.onInvalidDrop()
        return
      }

      // Dropping "next" onto a buffer slot stages it there. The tray is tested
      // first, and with the raw finger position, because the lifted block aims
      // a whole cell higher: a finger over the tray would otherwise resolve to
      // the board's bottom row and the block could never be staged by dragging.
      if (source === 'next') {
        if (dropSlot !== null) {
          this.callbacks.onNextToBuffer(dropSlot)
          return
        }
        if (cell !== null) {
          this.callbacks.onPlaceNext(cell.x, cell.y)
          return
        }
        this.callbacks.onInvalidDrop()
        return
      }

      // A staged block can only go onto the board, so the tray is deliberately
      // not consulted here: "the block I am carrying is over the tray" is not a
      // meaningful target, and treating it as one would steal drops aimed at
      // the bottom row directly below the tray.
      if (cell !== null) {
        this.callbacks.onPlace(slot, cell.x, cell.y)
        return
      }
      this.callbacks.onInvalidDrop()
      return
    }

    // Simple tap.
    if (this.pressSource === 'next') {
      this.callbacks.onPullNext()
      return
    }

    const tapSlot = bufferSlotAt(this.layout, point.x, point.y)
    if (tapSlot !== null) {
      if (this.levelOfSlot(tapSlot) > 0) {
        // Tapping the selected slot again clears the selection.
        if (this.state.selectedSlot === tapSlot) {
          this.state.selectedSlot = null
        } else {
          this.callbacks.onSelectSlot(tapSlot)
        }
      }
      return
    }

    const cell = boardCellAt(this.layout, point.x, point.y)
    if (cell !== null) {
      const selected = this.state.selectedSlot
      if (selected !== null && this.levelOfSlot(selected) > 0) {
        this.callbacks.onPlace(selected, cell.x, cell.y)
      } else {
        this.callbacks.onInvalidDrop()
      }
      return
    }

    // Tapping empty space drops the selection.
    this.state.selectedSlot = null
  }

  private handleCancel = (): void => {
    this.clearDrag()
  }

  private handleLeave = (): void => {
    if (this.pressing) return
    this.state.hoverSlot = null
    this.state.hoverNext = false
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.handleDown)
    this.canvas.removeEventListener('pointermove', this.handleMove)
    this.canvas.removeEventListener('pointerup', this.handleUp)
    this.canvas.removeEventListener('pointercancel', this.handleCancel)
    this.canvas.removeEventListener('pointerleave', this.handleLeave)
  }
}
