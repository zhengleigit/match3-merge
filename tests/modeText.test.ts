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
