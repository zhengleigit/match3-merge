import { describe, expect, it } from 'vitest'
import { obstacleBandAt, shouldSpawnObstacle } from '../src/core/obstacles'
import { loadTuning } from '../src/core/data'
import type { ObstacleBand } from '../src/core/types'

/**
 * The escalating obstacle schedule.
 *
 * The shipped table is:
 *   steps   1-100   one obstacle every 3 steps
 *   steps 101-200   one every 2
 *   steps 201+      one every step
 *
 * The boundaries are the whole point of the feature, so they are pinned here
 * explicitly rather than inferred from a few sample steps.
 */

const SHIPPED: readonly ObstacleBand[] = loadTuning().obstacles.spawnBands
const SINGLE: readonly ObstacleBand[] = [{ fromStep: 1, every: 3 }]

/** Steps in `[from, to]` where an obstacle spawns. */
function spawnsIn(bands: readonly ObstacleBand[], from: number, to: number): number[] {
  const out: number[] = []
  for (let step = from; step <= to; step++) {
    if (shouldSpawnObstacle(bands, step)) out.push(step)
  }
  return out
}

describe('obstacles: the shipped schedule', () => {
  it('is the three bands the mode advertises', () => {
    expect(SHIPPED).toEqual([
      { fromStep: 1, every: 3 },
      { fromStep: 101, every: 2 },
      { fromStep: 201, every: 1 }
    ])
  })

  it('picks the band whose fromStep is the highest at or below the step', () => {
    expect(obstacleBandAt(SHIPPED, 1)?.every).toBe(3)
    expect(obstacleBandAt(SHIPPED, 100)?.every).toBe(3)
    expect(obstacleBandAt(SHIPPED, 101)?.every).toBe(2)
    expect(obstacleBandAt(SHIPPED, 200)?.every).toBe(2)
    expect(obstacleBandAt(SHIPPED, 201)?.every).toBe(1)
    expect(obstacleBandAt(SHIPPED, 9999)?.every).toBe(1)
  })

  it('spawns nothing before the first band starts', () => {
    // A schedule that begins later than step 1 must not spawn from step 0.
    const late: readonly ObstacleBand[] = [{ fromStep: 5, every: 1 }]
    expect(obstacleBandAt(late, 0)).toBeNull()
    expect(obstacleBandAt(late, 4)).toBeNull()
    expect(shouldSpawnObstacle(late, 4)).toBe(false)
    expect(shouldSpawnObstacle(late, 5)).toBe(true)
  })
})

describe('obstacles: band 1 (steps 1-100, every 3)', () => {
  it('spawns on steps 3, 6, 9, ... and not before', () => {
    expect(spawnsIn(SHIPPED, 1, 12)).toEqual([3, 6, 9, 12])
  })

  it('spawns on step 99 but not 100', () => {
    // 99 = 3 x 33, 100 is not a multiple of 3.
    expect(shouldSpawnObstacle(SHIPPED, 99)).toBe(true)
    expect(shouldSpawnObstacle(SHIPPED, 100)).toBe(false)
  })

  it('produces 33 obstacles across its 100 steps', () => {
    expect(spawnsIn(SHIPPED, 1, 100)).toHaveLength(33)
  })
})

describe('obstacles: band 2 (steps 101-200, every 2)', () => {
  it('counts from its own first step rather than from the run', () => {
    // Band 2 starts at 101. Counting from the band means the first spawn is two
    // band-steps in, at 102 — not tied to the run's parity.
    expect(shouldSpawnObstacle(SHIPPED, 101)).toBe(false)
    expect(shouldSpawnObstacle(SHIPPED, 102)).toBe(true)
    expect(spawnsIn(SHIPPED, 101, 108)).toEqual([102, 104, 106, 108])
  })

  it('spawns on step 200, its last', () => {
    // 100 band-steps in, and 100 is even.
    expect(shouldSpawnObstacle(SHIPPED, 200)).toBe(true)
  })

  it('produces 50 obstacles across its 100 steps', () => {
    expect(spawnsIn(SHIPPED, 101, 200)).toHaveLength(50)
  })

  it('is twice as dense as band 1', () => {
    const first = spawnsIn(SHIPPED, 1, 100).length
    const second = spawnsIn(SHIPPED, 101, 200).length
    expect(second).toBe(first * 2 - 16)
    expect(second).toBeGreaterThan(first)
  })
})

describe('obstacles: band 3 (steps 201+, every step)', () => {
  it('spawns on every single step from 201 on', () => {
    // Starting the window at 198 shows the hand-over: band 2 still spaces its
    // spawns out (198, 200), and from 201 nothing is skipped.
    expect(spawnsIn(SHIPPED, 198, 210)).toEqual([
      198, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210
    ])
  })

  it('never skips a step, however far the run goes', () => {
    for (let step = 201; step <= 320; step++) {
      expect(shouldSpawnObstacle(SHIPPED, step), `step ${step}`).toBe(true)
    }
  })
})

describe('obstacles: monotonic escalation', () => {
  it('never gets slower', () => {
    // A band that is less frequent than the one before it would be dead config,
    // and the player would experience the difficulty going backwards.
    for (let i = 1; i < SHIPPED.length; i++) {
      expect(SHIPPED[i].every).toBeLessThanOrEqual(SHIPPED[i - 1].every)
    }
  })

  it('produces a strictly rising spawn count per 100 steps', () => {
    const counts = [spawnsIn(SHIPPED, 1, 100).length, spawnsIn(SHIPPED, 101, 200).length]
    // Band 3 is every step, so its first 100 steps are simply 100.
    expect(counts[0]).toBeLessThan(counts[1])
    expect(100).toBeGreaterThan(counts[1])
  })
})

describe('obstacles: custom schedules', () => {
  it('handles a single band as the degenerate case of the same table', () => {
    expect(obstacleBandAt(SINGLE, 1)?.every).toBe(3)
    expect(obstacleBandAt(SINGLE, 10_000)?.every).toBe(3)
    expect(spawnsIn(SINGLE, 1, 6)).toEqual([3, 6])
  })

  it('treats a non-positive interval as "never spawn"', () => {
    // Rather than dividing by zero or spawning on every step.
    expect(shouldSpawnObstacle([{ fromStep: 1, every: 0 }], 5)).toBe(false)
    expect(shouldSpawnObstacle([{ fromStep: 1, every: -2 }], 5)).toBe(false)
  })

  it('is a pure function of the step count', () => {
    // Undo rewinds the step counter and nothing else, so the schedule has to be
    // derivable from the number alone — no hidden "steps since last spawn".
    const a = spawnsIn(SHIPPED, 95, 110)
    const b = spawnsIn(SHIPPED, 95, 110)
    expect(a).toEqual(b)
    expect(shouldSpawnObstacle(SHIPPED, 103)).toBe(shouldSpawnObstacle(SHIPPED, 103))
  })
})
