import rawModes from '../data/modes.json'
import rawThemes from '../data/themes.json'
import rawTuning from '../data/tuning.json'
import type { ModeConfig, ThemeEntry, ThemesConfig, Tuning } from './types'

/**
 * Loads and validates the data-driven config. Every tunable number in the game
 * comes from these files, so a typo here must fail loudly rather than silently
 * produce a broken board.
 */

function fail(message: string): never {
  throw new Error(`[data] ${message}`)
}

export function loadTuning(): Tuning {
  const tuning = rawTuning as unknown as Tuning

  if (tuning.board.width <= 0 || tuning.board.height <= 0) {
    fail('board.width and board.height must be positive')
  }
  if (tuning.buffer.slots <= 0) {
    fail('buffer.slots must be positive')
  }
  if (tuning.unlock.spawnWeights.length === 0) {
    fail('unlock.spawnWeights must not be empty')
  }
  if (tuning.unlock.spawnWeights.some((w) => w < 0)) {
    fail('unlock.spawnWeights must be non-negative')
  }
  if (tuning.history.limit <= 0) {
    fail('history.limit must be positive')
  }
  if (tuning.obstacles.spawnEverySteps <= 0) {
    fail('obstacles.spawnEverySteps must be positive')
  }
  // The rules only define two obstacle states (fresh and cracked), so a higher
  // hit count would have nowhere to store the extra damage. Fail loudly rather
  // than silently behaving like 2.
  if (tuning.obstacles.hits !== 1 && tuning.obstacles.hits !== 2) {
    fail('obstacles.hits must be 1 (breaks at once) or 2 (cracks, then breaks)')
  }

  const battle = tuning.battle
  if (battle.wallRow < 1) {
    fail('battle.wallRow must leave at least one cage row above the wall')
  }
  // The wall, the cage and the playable field all have to exist, otherwise the
  // arena silently degenerates into a mode with nowhere to build.
  if (battle.wallRow >= tuning.board.height - 1) {
    fail('battle.wallRow must leave at least one playable row below the wall')
  }
  if (battle.gapX < 0 || battle.gapX >= tuning.board.width) {
    fail('battle.gapX must be a column on the board')
  }
  if (battle.start.y >= battle.wallRow) {
    fail('battle.start must be inside the cage (above the wall)')
  }
  if (battle.cageBlockCount < 1) {
    fail('battle.cageBlockCount must be at least 1')
  }
  if (battle.startHp < 1) {
    fail('battle.startHp must be at least 1')
  }
  if (battle.actionPerPlacement <= 0) {
    fail('battle.actionPerPlacement must be positive')
  }
  if (battle.mergeBarDrain < 0) {
    fail('battle.mergeBarDrain must not be negative')
  }
  if (battle.damageFromLevel < 1) {
    fail('battle.damageFromLevel must be at least 1')
  }

  return tuning
}

export function loadModes(): ModeConfig[] {
  const config = rawModes as unknown as { modes: ModeConfig[] }
  const modes = config.modes

  if (!Array.isArray(modes) || modes.length === 0) {
    fail('modes.json must define at least one mode')
  }

  const seen = new Set<string>()
  for (const mode of modes) {
    if (seen.has(mode.id)) fail(`duplicate mode id: ${mode.id}`)
    seen.add(mode.id)

    if (mode.scoreByLevel.length === 0) {
      fail(`mode "${mode.id}" must define scoreByLevel`)
    }
    if (mode.scoreByLevel.some((s) => !Number.isFinite(s))) {
      fail(`mode "${mode.id}" has a non-finite score in scoreByLevel`)
    }
    if (mode.maxLevelBonus < 0) {
      fail(`mode "${mode.id}" has a negative maxLevelBonus`)
    }
    if (mode.winAtLevel !== null) {
      if (mode.winAtLevel < 1 || mode.winAtLevel > mode.scoreByLevel.length) {
        fail(
          `mode "${mode.id}" winAtLevel ${mode.winAtLevel} is outside 1..${mode.scoreByLevel.length}`
        )
      }
    }
    if (mode.battle === true && mode.winAtLevel !== null) {
      // Battle mode is won by the boss's hp hitting zero; a level win would make
      // that unreachable and leave two competing win conditions.
      fail(`mode "${mode.id}" is a battle mode, so winAtLevel must be null`)
    }
    if (mode.battle === true && mode.obstacles) {
      fail(`mode "${mode.id}" cannot be both a battle and an obstacle mode`)
    }
  }

  return modes
}

export function loadThemes(): ThemesConfig {
  const config = rawThemes as unknown as { themes: ThemeEntry[] }
  if (!Array.isArray(config.themes) || config.themes.length === 0) {
    fail('themes.json must define at least one theme')
  }

  const seen = new Set<string>()
  for (const theme of config.themes) {
    if (seen.has(theme.id)) fail(`duplicate theme id: ${theme.id}`)
    seen.add(theme.id)
    if (theme.dir.startsWith('/') || /^[a-z]+:/i.test(theme.dir)) {
      fail(
        `theme "${theme.id}" dir must be a relative path (no leading slash or scheme) so packed builds keep working`
      )
    }
  }

  return config
}

export function findMode(modes: readonly ModeConfig[], id: string): ModeConfig | null {
  return modes.find((mode) => mode.id === id) ?? null
}

export function requireMode(modes: readonly ModeConfig[], id: string): ModeConfig {
  const mode = findMode(modes, id)
  if (mode === null) fail(`unknown mode id: ${id}`)
  return mode
}

export function findTheme(themes: readonly ThemeEntry[], id: string): ThemeEntry | null {
  return themes.find((theme) => theme.id === id) ?? null
}

/**
 * Mode rule text with its tunable numbers filled in.
 *
 * Rule lines embed values that live in tuning.json ("every N steps"). Writing
 * those numbers into the description as literals means the text silently goes
 * stale the moment the tunable changes — so the description carries a
 * placeholder and the value is substituted here.
 */
export function formatModeDescription(mode: ModeConfig, tuning: Tuning): string {
  return mode.description.replace(/\{obstacleEvery\}/g, String(tuning.obstacles.spawnEverySteps))
}
