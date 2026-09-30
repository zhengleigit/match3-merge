import {
  CELL_EMPTY,
  CELL_OBSTACLE,
  CELL_OBSTACLE_CRACKED,
  isObstacleValue,
  type Pos
} from './types'

/**
 * The board grid.
 *
 * Cell values: `CELL_EMPTY` (0), `CELL_OBSTACLE` (-1), `CELL_OBSTACLE_CRACKED`
 * (-2), or a positive block level (1..maxLevel).
 */

/**
 * Orthogonal 4-neighbourhood only. Diagonal neighbours deliberately do NOT
 * count as adjacent — this is a confirmed rule, and tests assert the negative.
 */
export const NEIGHBOR_OFFSETS: readonly Pos[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 }
]

export class Board {
  readonly width: number
  readonly height: number
  readonly cells: Int8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = new Int8Array(width * height)
  }

  index(x: number, y: number): number {
    return y * this.width + x
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return CELL_OBSTACLE
    return this.cells[this.index(x, y)]
  }

  set(x: number, y: number, value: number): void {
    if (!this.inBounds(x, y)) return
    this.cells[this.index(x, y)] = value
  }

  isEmpty(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.get(x, y) === CELL_EMPTY
  }

  isBlock(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.get(x, y) > CELL_EMPTY
  }

  isObstacle(x: number, y: number): boolean {
    return this.inBounds(x, y) && isObstacleValue(this.get(x, y))
  }

  /** True only once an obstacle has taken a hit and is one short of breaking. */
  isCrackedObstacle(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.get(x, y) === CELL_OBSTACLE_CRACKED
  }

  /** Orthogonal neighbours that are inside the board. */
  neighbors(x: number, y: number): Pos[] {
    const out: Pos[] = []
    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i++) {
      const nx = x + NEIGHBOR_OFFSETS[i].x
      const ny = y + NEIGHBOR_OFFSETS[i].y
      if (this.inBounds(nx, ny)) out.push({ x: nx, y: ny })
    }
    return out
  }

  emptyPositions(): Pos[] {
    const out: Pos[] = []
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.cells[this.index(x, y)] === CELL_EMPTY) out.push({ x, y })
      }
    }
    return out
  }

  hasEmptyCell(): boolean {
    const total = this.cells.length
    for (let i = 0; i < total; i++) {
      if (this.cells[i] === CELL_EMPTY) return true
    }
    return false
  }

  countBlocks(): number {
    let n = 0
    const total = this.cells.length
    for (let i = 0; i < total; i++) {
      if (this.cells[i] > CELL_EMPTY) n++
    }
    return n
  }

  countObstacles(): number {
    let n = 0
    const total = this.cells.length
    for (let i = 0; i < total; i++) {
      if (isObstacleValue(this.cells[i])) n++
    }
    return n
  }

  /**
   * Connected group of same-level blocks containing (x, y), found with an
   * iterative flood fill (no recursion, so a full board cannot blow the stack).
   * Returns an empty array when (x, y) is not a block.
   */
  findGroup(x: number, y: number): Pos[] {
    const level = this.get(x, y)
    if (level <= CELL_EMPTY) return []

    const seen = new Uint8Array(this.cells.length)
    const start = this.index(x, y)
    seen[start] = 1

    const group: Pos[] = [{ x, y }]
    const stack: number[] = [start]

    while (stack.length > 0) {
      const current = stack.pop() as number
      const cx = current % this.width
      const cy = (current - cx) / this.width

      for (let i = 0; i < NEIGHBOR_OFFSETS.length; i++) {
        const nx = cx + NEIGHBOR_OFFSETS[i].x
        const ny = cy + NEIGHBOR_OFFSETS[i].y
        if (!this.inBounds(nx, ny)) continue

        const ni = this.index(nx, ny)
        if (seen[ni] === 1) continue
        if (this.cells[ni] !== level) continue

        seen[ni] = 1
        group.push({ x: nx, y: ny })
        stack.push(ni)
      }
    }

    return group
  }

  toArray(): number[] {
    return Array.from(this.cells)
  }

  copyFromArray(values: readonly number[]): void {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = values[i] ?? CELL_EMPTY
    }
  }

  clone(): Board {
    const copy = new Board(this.width, this.height)
    copy.cells.set(this.cells)
    return copy
  }
}
