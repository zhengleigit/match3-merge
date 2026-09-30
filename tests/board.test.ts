import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board'
import { CELL_EMPTY, CELL_OBSTACLE } from '../src/core/types'

describe('Board adjacency (4-neighbour only)', () => {
  it('connects orthogonal neighbours', () => {
    const board = new Board(3, 3)
    board.set(0, 0, 1)
    board.set(1, 0, 1)

    expect(board.findGroup(0, 0)).toHaveLength(2)
  })

  it('does NOT connect diagonal neighbours', () => {
    const board = new Board(2, 2)
    board.set(0, 0, 1)
    board.set(1, 1, 1)

    // Same level, touching at a corner: still two separate groups.
    expect(board.findGroup(0, 0)).toHaveLength(1)
    expect(board.findGroup(1, 1)).toHaveLength(1)
  })

  it('finds an L-shaped group across orthogonal steps only', () => {
    const board = new Board(3, 3)
    board.set(0, 0, 2)
    board.set(1, 0, 2)
    board.set(1, 1, 2)

    expect(board.findGroup(0, 0)).toHaveLength(3)
  })

  it('ignores blocks of a different level', () => {
    const board = new Board(3, 3)
    board.set(0, 0, 1)
    board.set(1, 0, 2)
    board.set(2, 0, 1)

    expect(board.findGroup(0, 0)).toHaveLength(1)
  })

  it('never treats an obstacle as a block', () => {
    const board = new Board(3, 3)
    board.set(0, 0, CELL_OBSTACLE)
    board.set(1, 0, CELL_OBSTACLE)

    expect(board.findGroup(0, 0)).toHaveLength(0)
    expect(board.isObstacle(0, 0)).toBe(true)
    expect(board.isBlock(0, 0)).toBe(false)
  })

  it('returns an empty group for an empty cell', () => {
    const board = new Board(3, 3)
    expect(board.findGroup(1, 1)).toHaveLength(0)
  })

  it('finds the whole group when starting from a middle cell', () => {
    const board = new Board(5, 1)
    for (let x = 0; x < 5; x++) board.set(x, 0, 3)

    expect(board.findGroup(2, 0)).toHaveLength(5)
  })
})

describe('Board bounds handling', () => {
  it('reports out-of-bounds as an obstacle so it can never be placed on', () => {
    const board = new Board(3, 3)
    expect(board.get(-1, 0)).toBe(CELL_OBSTACLE)
    expect(board.get(3, 0)).toBe(CELL_OBSTACLE)
    expect(board.inBounds(-1, 0)).toBe(false)
  })

  it('ignores writes outside the board', () => {
    const board = new Board(2, 2)
    board.set(5, 5, 3)
    expect(board.countBlocks()).toBe(0)
  })

  it('lists empty positions and detects a full board', () => {
    const board = new Board(2, 2)
    expect(board.emptyPositions()).toHaveLength(4)
    expect(board.hasEmptyCell()).toBe(true)

    board.set(0, 0, 1)
    board.set(1, 0, 1)
    board.set(0, 1, 1)
    board.set(1, 1, 1)

    expect(board.emptyPositions()).toHaveLength(0)
    expect(board.hasEmptyCell()).toBe(false)
  })

  it('round-trips through an array copy', () => {
    const board = new Board(3, 2)
    board.set(0, 0, 1)
    board.set(2, 1, CELL_OBSTACLE)

    const restored = new Board(3, 2)
    restored.copyFromArray(board.toArray())

    expect(restored.toArray()).toEqual(board.toArray())
    expect(restored.get(0, 0)).toBe(1)
    expect(restored.get(2, 1)).toBe(CELL_OBSTACLE)
    expect(restored.get(1, 1)).toBe(CELL_EMPTY)
  })
})
