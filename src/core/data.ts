import rawModes from '../data/modes.json'
import rawThemes from '../data/themes.json'
import rawTuning from '../data/tuning.json'
import type {
  ModeConfig,
  ObstacleBand,
  StartClearArea,
  ThemeEntry,
  ThemesConfig,
  Tuning
} from './types'

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
  const bands = tuning.obstacles.spawnBands
  if (!Array.isArray(bands) || bands.length === 0) {
    fail('obstacles.spawnBands must define at least one band')
  }
  for (let i = 0; i < bands.length; i++) {
    if (!Number.isInteger(bands[i].fromStep) || bands[i].fromStep < 1) {
      fail('obstacles.spawnBands[].fromStep must be an integer of at least 1')
    }
    if (!Number.isInteger(bands[i].every) || bands[i].every < 1) {
      fail('obstacles.spawnBands[].every must be an integer of at least 1')
    }
    // Ordered and non-overlapping, so "which band is in force" is unambiguous.
    // A later band with a smaller `fromStep` would simply never apply.
    if (i > 0 && bands[i].fromStep <= bands[i - 1].fromStep) {
      fail('obstacles.spawnBands must be ordered by strictly increasing fromStep')
    }
  }
  if (bands[0].fromStep !== 1) {
    fail('obstacles.spawnBands must start at fromStep 1, or no obstacle ever spawns')
  }
  const clear = tuning.obstacles.startClear
  // A pocket of zero cells would mean the board opens already full, i.e. an
  // instant loss — almost certainly a typo rather than a design choice.
  if (!Number.isInteger(clear.width) || !Number.isInteger(clear.height)) {
    fail('obstacles.startClear.width and .height must be integers')
  }
  if (clear.width < 1 || clear.height < 1) {
    fail('obstacles.startClear must be at least 1x1, or the board opens with nowhere to play')
  }
  if (clear.width > tuning.board.width || clear.height > tuning.board.height) {
    fail('obstacles.startClear must fit on the board')
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
  if (battle.turnsPerAction <= 0) {
    fail('battle.turnsPerAction must be positive (it is how many placements fill the bar)')
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

  // Hiding every mode would leave the home screen empty and the game with no way
  // to start, and nothing else in the app would report why. Fail loudly instead.
  if (!modes.some((mode) => mode.hidden !== true)) {
    fail('at least one mode must be visible (none may set "hidden": true)')
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
 * Human-readable form of the obstacle spawn schedule.
 *
 * Generated from the data rather than written into the mode description, for
 * the same reason the old interval was: a hand-written "每 3 步" silently goes
 * stale the moment the schedule is retuned, and the rules line is the only
 * place the player can learn the rate.
 */
export function describeObstacleRamp(bands: readonly ObstacleBand[]): string {
  const parts: string[] = []
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i]
    const rate = band.every === 1 ? '每步' : `每 ${band.every} 步`
    // The first band spans the opening, so its start needs no mention.
    parts.push(i === 0 && band.fromStep === 1 ? rate : `第 ${band.fromStep} 步起${rate}`)
  }
  return parts.join('，')
}

/**
 * Rule sentence for obstacle mode's opening pocket.
 *
 * Same reasoning as the spawn ramp: the pocket size is a tunable, so writing
 * "3×3" into the description as a literal would leave the rules line describing
 * a board the player is not looking at the moment it is retuned.
 */
export function describeStartPocket(clear: StartClearArea): string {
  return `开局棋盘被障碍填满，只有中间 ${clear.width}×${clear.height} 的区域可落子`
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
  return mode.description
    .replace(/\{obstacleRamp\}/g, describeObstacleRamp(tuning.obstacles.spawnBands))
    .replace(/\{obstacleStart\}/g, describeStartPocket(tuning.obstacles.startClear))
    .replace(/\{obstacleEvery\}/g, String(tuning.obstacles.spawnBands[0]?.every ?? 0))
}
