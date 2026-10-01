import { describe, expect, it } from 'vitest'
import {
  describeObstacleRamp,
  describeStartPocket,
  formatModeDescription,
  loadModes,
  loadTuning
} from '../src/core/data'

const modes = loadModes()
const tuning = loadTuning()

describe('mode rule text', () => {
  /**
   * Regression guard: the obstacle interval used to be written as a literal
   * "每 10 步" in the description, so changing tuning.json silently left the
   * rules line telling the player the wrong number.
   */
  it('fills the obstacle schedule from the tuning data', () => {
    const obstacle = modes.find((mode) => mode.id === 'obstacle')
    expect(obstacle).toBeDefined()

    const text = formatModeDescription(obstacle!, tuning)
    // The first band's rate appears verbatim...
    expect(text).toContain(`每 ${tuning.obstacles.spawnBands[0].every} 步`)
    // ...and every later band is announced by its starting step.
    for (const band of tuning.obstacles.spawnBands.slice(1)) {
      const rate = band.every === 1 ? '每步' : `每 ${band.every} 步`
      expect(text).toContain(`第 ${band.fromStep} 步起${rate}`)
    }
  })

  it('follows the tunable rather than a hardcoded number', () => {
    const obstacle = modes.find((mode) => mode.id === 'obstacle')!
    const patched = {
      ...tuning,
      obstacles: { ...tuning.obstacles, spawnBands: [{ fromStep: 1, every: 7 }] }
    }

    expect(formatModeDescription(obstacle, patched)).toContain('每 7 步')
    expect(formatModeDescription(obstacle, patched)).not.toContain('10 步')
  })

  it('describes a schedule that never speeds up with a single clause', () => {
    // No pointless "第 1 步起" prefix when there is only one band.
    expect(describeObstacleRamp([{ fromStep: 1, every: 4 }])).toBe('每 4 步')
  })

  it('reads "every step" as 每步 rather than 每 1 步', () => {
    expect(
      describeObstacleRamp([
        { fromStep: 1, every: 3 },
        { fromStep: 201, every: 1 }
      ])
    ).toBe('每 3 步，第 201 步起每步')
  })

  it('lists the shipped schedule in step order', () => {
    const text = describeObstacleRamp(tuning.obstacles.spawnBands)
    const positions = tuning.obstacles.spawnBands.map((band) =>
      band.fromStep === 1 ? 0 : text.indexOf(`第 ${band.fromStep} 步起`)
    )
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b))
  })

  it('leaves no unsubstituted placeholder in any mode description', () => {
    for (const mode of modes) {
      expect(formatModeDescription(mode, tuning)).not.toContain('{')
    }
  })

  it('announces the opening pocket from the tuning data', () => {
    const obstacle = modes.find((mode) => mode.id === 'obstacle')!
    const text = formatModeDescription(obstacle, tuning)

    expect(text).toContain(describeStartPocket(tuning.obstacles.startClear))
    expect(text).toContain(
      `${tuning.obstacles.startClear.width}×${tuning.obstacles.startClear.height}`
    )
  })

  it('follows a retuned pocket instead of a hardcoded 3×3', () => {
    const obstacle = modes.find((mode) => mode.id === 'obstacle')!
    const patched = {
      ...tuning,
      obstacles: { ...tuning.obstacles, startClear: { width: 5, height: 4 } }
    }

    expect(formatModeDescription(obstacle, patched)).toContain('5×4')
    expect(formatModeDescription(obstacle, patched)).not.toContain('3×3')
  })

  it('leaves modes without placeholders untouched', () => {
    const basic = modes.find((mode) => mode.id === 'basic')!
    expect(formatModeDescription(basic, tuning)).toBe(basic.description)
  })
})

describe('mode visibility', () => {
  /**
   * The home screen offers only the visible modes. Hiding rather than deleting
   * keeps a mode's config valid, so its saved scores and leaderboard rows still
   * resolve if it is ever shown again.
   */
  it('keeps the hidden mode in the data rather than removing it', () => {
    const basic = modes.find((mode) => mode.id === 'basic')
    expect(basic).toBeDefined()
    expect(basic?.hidden).toBe(true)
  })

  it('still exposes every mode by id, hidden or not', () => {
    // Resolving by id is what lets an existing save survive being hidden.
    expect(modes.map((mode) => mode.id)).toEqual(
      expect.arrayContaining(['basic', 'battle', 'obstacle', 'endless'])
    )
  })

  it('leaves at least one mode on offer', () => {
    // An all-hidden config would leave the home screen empty with no way to
    // start, so `loadModes` refuses it outright.
    expect(modes.filter((mode) => mode.hidden !== true).length).toBeGreaterThan(0)
  })

  it('does not hide the modes the game boots with', () => {
    const visible = modes.filter((mode) => mode.hidden !== true)
    expect(visible.map((mode) => mode.id)).toEqual(
      expect.arrayContaining(['battle', 'obstacle', 'endless'])
    )
  })
})
