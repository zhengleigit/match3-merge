import { describe, expect, it } from 'vitest'
import { CascadePlayer } from '../src/view/cascadePlayer'
import type { CascadeStep, GameEvent } from '../src/core/types'

function mergeEvent(chain: number): GameEvent {
  return {
    type: 'merged',
    x: 2,
    y: 2,
    chain,
    consumed: 3,
    consumedCells: [{ x: 2, y: 2 }],
    fromLevel: chain,
    toLevel: chain + 1,
    score: 3
  }
}

function step(chain: number, marker: number): CascadeStep {
  return {
    cellsBefore: [marker],
    cellsAfter: [marker + 1],
    events: [mergeEvent(chain)]
  }
}

const STEPS: CascadeStep[] = [step(1, 10), step(2, 20), step(3, 30)]

describe('CascadePlayer: sequencing', () => {
  it('reports nothing to play for an empty chain', () => {
    const player = new CascadePlayer()
    expect(player.begin([])).toBe(false)
    expect(player.active).toBe(false)
    expect(player.overrideCells()).toBeNull()
  })

  it('starts on the first link and reports it exactly once', () => {
    const player = new CascadePlayer()
    expect(player.begin(STEPS)).toBe(true)
    expect(player.active).toBe(true)
    expect(player.totalSteps).toBe(3)
    expect(player.currentStep).toBe(1)

    const first = player.update(16)
    expect(first.started).toBe(STEPS[0])
    expect(first.finished).toBe(false)

    // Subsequent frames of the same link must not re-fire its effects.
    expect(player.update(16).started).toBeNull()
    expect(player.update(16).started).toBeNull()
  })

  it('advances through every link in order and then finishes', () => {
    const player = new CascadePlayer()
    player.begin(STEPS)

    const started: CascadeStep[] = []
    let finished = false

    // Drive it well past the total duration.
    for (let i = 0; i < 400 && !finished; i++) {
      const tick = player.update(16)
      if (tick.started !== null) started.push(tick.started)
      if (tick.finished) finished = true
    }

    expect(started.map((s) => s.cellsBefore[0])).toEqual([10, 20, 30])
    expect(finished).toBe(true)
    expect(player.active).toBe(false)
  })

  it('holds the pre-link board while a link plays, then releases it', () => {
    const player = new CascadePlayer()
    player.begin(STEPS)

    player.update(16)
    // Showing the board BEFORE the first link: the consumed blocks visible.
    expect(player.overrideCells()).toEqual([10])

    player.update(400)
    expect(player.overrideCells()).toEqual([20])

    player.update(400)
    expect(player.overrideCells()).toEqual([30])

    player.update(400)
    // Chain over: the live board takes over again.
    expect(player.overrideCells()).toBeNull()
    expect(player.active).toBe(false)
  })

  it('gives a max-level clear a longer link', () => {
    const big: CascadeStep = {
      cellsBefore: [1],
      cellsAfter: [0],
      events: [{ type: 'maxCleared', x: 0, y: 0, level: 5, consumed: 3, consumedCells: [], score: 24, bonus: 50 }]
    }

    const normalPlayer = new CascadePlayer()
    normalPlayer.begin([step(1, 1)])
    normalPlayer.update(16)
    normalPlayer.update(340) // just past the normal duration
    const normalAdvanced = normalPlayer.overrideCells()

    const bigPlayer = new CascadePlayer()
    bigPlayer.begin([big, step(2, 5)])
    bigPlayer.update(16)
    bigPlayer.update(340) // NOT past the big duration yet
    // Still on the max-level link, because it gets more time.
    expect(bigPlayer.overrideCells()).toEqual([1])
    expect(normalAdvanced).toBeNull()
  })

  it('cancel stops playback and releases the board immediately', () => {
    const player = new CascadePlayer()
    player.begin(STEPS)
    player.update(16)

    player.cancel()

    expect(player.active).toBe(false)
    expect(player.overrideCells()).toBeNull()
    expect(player.currentStep).toBe(0)
    // update() after cancel is inert.
    expect(player.update(100).started).toBeNull()
    expect(player.update(100).finished).toBe(false)
  })

  it('can be restarted after finishing', () => {
    const player = new CascadePlayer()
    player.begin(STEPS)
    let done = false
    for (let i = 0; i < 400 && !done; i++) done = player.update(16).finished
    expect(done).toBe(true)

    expect(player.begin(STEPS)).toBe(true)
    expect(player.currentStep).toBe(1)
    expect(player.update(16).started).toBe(STEPS[0])
  })

  it('handles a single-link chain without getting stuck', () => {
    const player = new CascadePlayer()
    const only: CascadeStep[] = [step(1, 7)]
    player.begin(only)

    const first = player.update(16)
    expect(first.started).toBe(only[0])
    expect(first.finished).toBe(false)

    // One more tick past the duration finishes it.
    const end = player.update(400)
    expect(end.finished).toBe(true)
    expect(player.active).toBe(false)
    expect(player.overrideCells()).toBeNull()
  })
})
