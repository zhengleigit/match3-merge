import { describe, expect, it } from 'vitest'
import { formatModeDescription, loadModes, loadTuning } from '../src/core/data'

const modes = loadModes()
const tuning = loadTuning()

describe('mode rule text', () => {
  /**
   * Regression guard: the obstacle interval used to be written as a literal
   * "每 10 步" in the description, so changing tuning.json silently left the
   * rules line telling the player the wrong number.
   */
  it('fills the obstacle interval from the tuning data', () => {
    const obstacle = modes.find((mode) => mode.id === 'obstacle')
    expect(obstacle).toBeDefined()

    const text = formatModeDescription(obstacle!, tuning)
    expect(text).toContain(`每 ${tuning.obstacles.spawnEverySteps} 步`)
  })

  it('follows the tunable rather than a hardcoded number', () => {
    const obstacle = modes.find((mode) => mode.id === 'obstacle')!
    const patched = { ...tuning, obstacles: { ...tuning.obstacles, spawnEverySteps: 7 } }

    expect(formatModeDescription(obstacle, patched)).toContain('每 7 步')
    expect(formatModeDescription(obstacle, patched)).not.toContain('10 步')
  })

  it('leaves no unsubstituted placeholder in any mode description', () => {
    for (const mode of modes) {
      expect(formatModeDescription(mode, tuning)).not.toContain('{')
    }
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
