import { loadModes, loadTuning } from '../src/core/data'
import { Game } from '../src/core/game'
import { CELL_OBSTACLE, CELL_OBSTACLE_CRACKED, CELL_WALL } from '../src/core/types'
import type { GameSnapshot, ModeConfig, PacManState, Pos, Tuning } from '../src/core/types'

/** Tuning cloned from the real data file, optionally mutated for a test. */
export function makeTuning(mutate?: (tuning: Tuning) => void): Tuning {
  const copy = JSON.parse(JSON.stringify(loadTuning())) as Tuning
  mutate?.(copy)
  return copy
}

const allModes = loadModes()

/** A real mode from modes.json, optionally mutated for a test. */
export function makeMode(id: string, mutate?: (mode: ModeConfig) => void): ModeConfig {
  const found = allModes.find((mode) => mode.id === id)
  if (found === undefined) throw new Error(`mode not found: ${id}`)
  const copy = JSON.parse(JSON.stringify(found)) as ModeConfig
  mutate?.(copy)
  return copy
}

export function makeGame(options?: {
  modeId?: string
  mutateTuning?: (tuning: Tuning) => void
  mutateMode?: (mode: ModeConfig) => void
  seed?: number
}): Game {
  const modeId = options?.modeId ?? 'basic'
  return new Game({
    mode: makeMode(modeId, options?.mutateMode),
    tuning: makeTuning(options?.mutateTuning),
    seed: options?.seed ?? 12345
  })
}

/** Forces every spawn to be level 1, so move sequences are fully predictable. */
export function onlyLevelOne(tuning: Tuning): void {
  tuning.unlock.spawnWeights = [1]
}

export interface CraftSpec {
  blocks?: Array<Pos & { level: number }>
  obstacles?: Pos[]
  /** Obstacles that have already taken one hit. */
  crackedObstacles?: Pos[]
  /** Indestructible wall cells (battle mode). */
  walls?: Pos[]
  buffer?: number[]
  next?: number
  score?: number
  steps?: number
  maxReachedLevel?: number
  hasWon?: boolean
  gameOver?: boolean
  pacman?: PacManState | null
  rngState?: number
}

/**
 * Builds a snapshot for a hand-made board state.
 *
 * `Game.restore()` is deliberately public: it is the same seam `undo` uses, so
 * tests can set up late-game positions (level-9 triples, a nearly full board)
 * without simulating thousands of real moves.
 */
export function craft(width: number, height: number, spec: CraftSpec): GameSnapshot {
  const cells = new Array<number>(width * height).fill(0)

  for (const block of spec.blocks ?? []) {
    cells[block.y * width + block.x] = block.level
  }
  for (const spot of spec.obstacles ?? []) {
    cells[spot.y * width + spot.x] = CELL_OBSTACLE
  }
  for (const spot of spec.crackedObstacles ?? []) {
    cells[spot.y * width + spot.x] = CELL_OBSTACLE_CRACKED
  }
  for (const spot of spec.walls ?? []) {
    cells[spot.y * width + spot.x] = CELL_WALL
  }

  return {
    cells,
    buffer: spec.buffer ?? [0, 0, 0],
    next: spec.next ?? 0,
    score: spec.score ?? 0,
    steps: spec.steps ?? 0,
    maxReachedLevel: spec.maxReachedLevel ?? 1,
    hasWon: spec.hasWon ?? false,
    gameOver: spec.gameOver ?? false,
    pendingWin: null,
    pacman: spec.pacman ?? null,
    rngState: spec.rngState ?? 1
  }
}

/** Every cell value in row-major order, handy for compact assertions. */
export function cellsOf(game: Game): number[] {
  return game.view().cells
}

export function levelAt(game: Game, x: number, y: number): number {
  const view = game.view()
  return view.cells[y * view.width + x]
}
