import { describe, expect, it } from 'vitest'
import { loadTuning } from '../src/core/data'
import { Rng } from '../src/core/rng'
import { pickSpawnLevel, stepUnlockLevel, unlockedWeights } from '../src/core/spawn'

const WEIGHTS = [70, 20, 8, 4, 3, 3, 3, 3, 3, 3]

describe('unlockedWeights', () => {
  it('truncates the table to the unlocked range', () => {
    expect(unlockedWeights(WEIGHTS, 1, 10)).toEqual([70])
    expect(unlockedWeights(WEIGHTS, 3, 10)).toEqual([70, 20, 8])
  })

  it('never exceeds the level count of the mode', () => {
    // Basic mode has 5 levels, so levels 6-10 must not be spawable.
    expect(unlockedWeights(WEIGHTS, 10, 5)).toHaveLength(5)
  })

  it('clamps a level count above the weight table length', () => {
    expect(unlockedWeights([70, 20], 10, 10)).toHaveLength(2)
  })

  it('falls back to level 1 when the table is all zeros', () => {
    expect(unlockedWeights([0, 0, 0], 3, 3)).toEqual([1, 0, 0])
  })

  it('treats negative weights as zero', () => {
    expect(unlockedWeights([-5, 10], 2, 2)).toEqual([0, 10])
  })
})

describe('pickSpawnLevel', () => {
  it('always returns level 1 before anything else has been unlocked', () => {
    const rng = new Rng(1)
    for (let i = 0; i < 500; i++) {
      expect(pickSpawnLevel(rng, WEIGHTS, 1, 5)).toBe(1)
    }
  })

  it('never returns a level above the unlocked ceiling', () => {
    const rng = new Rng(99)
    for (let i = 0; i < 2000; i++) {
      expect(pickSpawnLevel(rng, WEIGHTS, 2, 5)).toBeLessThanOrEqual(2)
    }
  })

  it('never returns a level above the mode level count', () => {
    const rng = new Rng(7)
    for (let i = 0; i < 2000; i++) {
      expect(pickSpawnLevel(rng, WEIGHTS, 10, 5)).toBeLessThanOrEqual(5)
    }
  })

  it('respects the weight ratio once level 2 is unlocked', () => {
    const rng = new Rng(4242)
    let level2 = 0
    const draws = 20000
    for (let i = 0; i < draws; i++) {
      if (pickSpawnLevel(rng, WEIGHTS, 2, 5) === 2) level2++
    }

    // 20 / (70 + 20) = 0.222
    expect(level2 / draws).toBeGreaterThan(0.19)
    expect(level2 / draws).toBeLessThan(0.25)
  })

  it('is deterministic for a given seed', () => {
    const a = new Rng(2024)
    const b = new Rng(2024)
    const first: number[] = []
    const second: number[] = []
    for (let i = 0; i < 50; i++) {
      first.push(pickSpawnLevel(a, WEIGHTS, 5, 5))
      second.push(pickSpawnLevel(b, WEIGHTS, 5, 5))
    }
    expect(first).toEqual(second)
  })
})

describe('spawn weights: configured tuning intent', () => {
  /**
   * The table is data, but its *shape* is a design rule: a higher level must
   * never be as likely as a lower one, and the top of the ladder must stay
   * rare even after it unlocks. Without this guard a careless edit could make
   * high-level blocks a common draw and flatten the difficulty curve.
   */
  const configured: number[] = (loadTuning().unlock.spawnWeights as number[]).slice()

  it('is non-increasing, so rarer levels really are rarer', () => {
    for (let i = 1; i < configured.length; i++) {
      expect(configured[i]).toBeLessThanOrEqual(configured[i - 1])
    }
  })

  it('keeps every configured weight positive', () => {
    for (const weight of configured) expect(weight).toBeGreaterThan(0)
  })

  it('keeps the top level a rare draw once the whole ladder is unlocked', () => {
    const total = configured.reduce((sum, w) => sum + w, 0)
    const topShare = configured[configured.length - 1] / total
    // With the whole ladder unlocked the final level must stay under ~2%.
    expect(topShare).toBeLessThan(0.02)
  })

  it('keeps the mid levels clearly less likely than level 1', () => {
    const level1 = configured[0]
    const level4 = configured[3]
    expect(level4).toBeLessThan(level1 * 0.06)
  })

  /**
   * End-to-end check that the tuned weights reach the sampler, not just the
   * file: draw many blocks with the whole ladder unlocked and measure the
   * share of each level.
   */
  it('actually samples high levels rarely once the ladder is unlocked', () => {
    const rng = new Rng(20260930)
    const draws = 40000
    const counts = new Array<number>(configured.length).fill(0)

    for (let i = 0; i < draws; i++) {
      const level = pickSpawnLevel(rng, configured, configured.length, configured.length)
      counts[level - 1]++
    }

    const level1Share = counts[0] / draws
    const topShare = counts[counts.length - 1] / draws
    const midShare = counts[4] / draws

    // Level 1 stays the bulk of the supply.
    expect(level1Share).toBeGreaterThan(0.55)
    // The top of the ladder stays a rare draw (well under 2%).
    expect(topShare).toBeLessThan(0.02)
    // And each step up the ladder is rarer than the one below it.
    expect(counts[4]).toBeLessThan(counts[3])
    expect(counts[3]).toBeLessThan(counts[2])
    expect(midShare).toBeLessThan(level1Share)
  })
})

describe('stepUnlockLevel (optional fallback, disabled by default)', () => {
  it('stays at level 1 while disabled', () => {
    expect(stepUnlockLevel(500, false, 10, 5)).toBe(1)
  })

  it('unlocks one level per interval when enabled', () => {
    expect(stepUnlockLevel(0, true, 10, 5)).toBe(1)
    expect(stepUnlockLevel(10, true, 10, 5)).toBe(2)
    expect(stepUnlockLevel(30, true, 10, 5)).toBe(4)
  })

  it('clamps to the mode level count', () => {
    expect(stepUnlockLevel(9999, true, 10, 5)).toBe(5)
  })
})
