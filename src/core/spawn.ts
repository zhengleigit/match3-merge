import type { Rng } from './rng'

/**
 * Spawns new blocks.
 *
 * Unlock rule (confirmed): a level only enters the spawn pool once the player
 * has actually *created* it by merging (`maxReachedLevel`, which only ever
 * rises). The weight table is truncated to that range and re-normalised, so
 * the relative odds of the unlocked levels stay meaningful.
 */
export function unlockedWeights(
  weights: readonly number[],
  maxReachedLevel: number,
  levelCount: number
): number[] {
  const limit = Math.max(1, Math.min(maxReachedLevel, weights.length, levelCount))
  const out: number[] = []
  for (let i = 0; i < limit; i++) {
    const w = weights[i]
    out.push(w > 0 ? w : 0)
  }
  // Guarantee at least level 1 is spawable even if the table is misconfigured.
  if (out.every((w) => w <= 0)) out[0] = 1
  return out
}

/**
 * Picks the level for a new block. Always returns a level in
 * [1, min(maxReachedLevel, levelCount)].
 */
export function pickSpawnLevel(
  rng: Rng,
  weights: readonly number[],
  maxReachedLevel: number,
  levelCount: number
): number {
  const table = unlockedWeights(weights, maxReachedLevel, levelCount)
  const index = rng.pickWeighted(table)
  return index < 0 ? 1 : index + 1
}

/**
 * Optional accelerator for the mid-game: unlocks levels purely by step count
 * on top of the merge-based unlock. Disabled by default (see tuning.json).
 */
export function stepUnlockLevel(
  steps: number,
  enabled: boolean,
  stepsPerLevel: number,
  levelCount: number
): number {
  if (!enabled || stepsPerLevel <= 0) return 1
  const unlocked = Math.floor(steps / stepsPerLevel) + 1
  return Math.max(1, Math.min(unlocked, levelCount))
}
