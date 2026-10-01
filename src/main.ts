import './styles.css'

import { loadModes, loadThemes, loadTuning, formatModeDescription } from './core/data'
import {
  densityMultiplier,
  describeEvents,
  fxConfig,
  type FxDescriptor,
  type SoundId
} from './core/fxMap'
import { Game, type GameView } from './core/game'
import {
  LEADERBOARD_VISIBLE,
  LeaderboardStore,
  type ScoreEntry
} from './core/leaderboard'
import { makeSeed } from './core/rng'
import { RunStore, type SavedRun } from './core/runs'
import {
  ProgressStore,
  SettingsStore,
  defaultSettings,
  type Settings
} from './core/settings'
import type { GameEvent, ModeConfig } from './core/types'
import { attachKeyboard } from './input/keyboard'
import { PointerInput } from './input/pointer'
import { imageFor, releaseTheme, type ThemeAssets } from './view/assets'
import { AudioEngine } from './view/audio'
import { FloaterSystem } from './view/floaters'
import { Hud } from './view/hud'
import { HomeScreen } from './view/home'
import {
  HUD_BOTTOM_PX,
  boardSpaceToPx,
  computeLayout,
  type Layout
} from './view/layout'
import { ParticleSystem } from './view/particles'
import { MergeFxSystem } from './view/mergeFx'
import { CascadePlayer } from './view/cascadePlayer'
import { PacManAnimator } from './view/pacmanAnimator'
import { render, type RenderState } from './view/renderer'
import { Shake } from './view/shake'
import { SpriteStyles } from './view/sprites'
import { isStoragePersistent, localStorageAdapter } from './view/storage'
import { findSource, loadThemeSource, themeSources } from './view/themeRegistry'
import { SLOT } from './core/theme'

// ---------------------------------------------------------------------------
// Data + stores
// ---------------------------------------------------------------------------

const tuning = loadTuning()
const modes = loadModes()

/**
 * Folder themes (registered in themes.json) plus any zip pack found in
 * src/themes/packs. Both are offered in the settings dropdown.
 */
const themes = themeSources(loadThemes().themes)

/** Cell size of every sprite a theme may need, in all modes' level counts. */
const themeLevelCounts: readonly number[] = modes.map((item) => item.scoreByLevel.length)

const settingsStore = new SettingsStore(
  localStorageAdapter,
  defaultSettings(tuning.theme.defaultId, tuning.fx.particleDensity)
)
const progressStore = new ProgressStore(localStorageAdapter)
const leaderboardStore = new LeaderboardStore(localStorageAdapter)
const runStore = new RunStore(localStorageAdapter)

// Drop parked runs for modes that no longer exist (e.g. after a data edit).
runStore.prune(modes.map((item) => item.id))

/** Cached top-N rows; refreshed only when a run finishes. */
let leaderboardRows: ScoreEntry[] = leaderboardStore.list(LEADERBOARD_VISIBLE)

/** Wall-clock bookkeeping for the current run (duration is shown in the list). */
let runStartedAt = Date.now()

let settings: Settings = settingsStore.get()

function beginRun(): void {
  runStartedAt = Date.now()
}

/** Records a finished run and refreshes the cached leaderboard rows. */
function finishRun(): void {
  const state = view()
  progressStore.record(mode.id, state.score)
  leaderboardRows = leaderboardStore.add({
    modeId: mode.id,
    modeName: mode.name,
    score: state.score,
    at: Date.now(),
    durationMs: Date.now() - runStartedAt
  })
  leaderboardRows = leaderboardRows.slice(0, LEADERBOARD_VISIBLE)
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const canvasEl = document.getElementById('game')
if (!(canvasEl instanceof HTMLCanvasElement)) {
  throw new Error('#game canvas not found')
}
const context2d = canvasEl.getContext('2d', { alpha: false })
if (context2d === null) {
  throw new Error('2D canvas context unavailable')
}
const canvas = canvasEl
const ctx = context2d

// layout.ts owns the reserved bottom band; mirror it into CSS so the DOM bar
// and the canvas reservation can never drift apart.
document.documentElement.style.setProperty('--hud-bottom', `${HUD_BOTTOM_PX}px`)

let layout: Layout = computeLayout(
  360,
  720,
  tuning.board.width,
  tuning.board.height,
  tuning.buffer.slots,
  LEADERBOARD_VISIBLE,
  settings.layoutMode
)

/** Cached per-level gradients/colours, rebuilt only when the cell size changes. */
const spriteStyles = new SpriteStyles()

/** HUD strings, rebuilt only when their values change (never per frame). */
const texts = { score: '0', steps: '步数 0', mode: '', best: '最高 0', rules: '' }

function refreshTexts(state: GameView): void {
  if (texts.score !== String(state.score)) texts.score = String(state.score)
  const steps = `步数 ${state.steps}`
  if (texts.steps !== steps) texts.steps = steps
  const best = `最高 ${Math.max(progressStore.bestFor(mode.id), state.score)}`
  if (texts.best !== best) texts.best = best
  if (texts.mode !== state.modeName) texts.mode = state.modeName
}

/** Title = mode name, rules line = the mode's description with tunables filled in. */
function refreshModeTexts(next: ModeConfig): void {
  texts.mode = next.name
  texts.rules = formatModeDescription(next, tuning)
}

// ---------------------------------------------------------------------------
// Effects + audio
// ---------------------------------------------------------------------------

const particles = new ParticleSystem(fxConfig.maxParticles)
const floaters = new FloaterSystem()
const mergeFx = new MergeFxSystem()
const cascadePlayer = new CascadePlayer()
const pacmanAnimator = new PacManAnimator()
const shake = new Shake()
const audio = new AudioEngine()

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
let reducedMotion = reducedMotionQuery.matches
reducedMotionQuery.addEventListener('change', (event) => {
  reducedMotion = event.matches
  if (reducedMotion) {
    particles.clear()
    shake.clear()
  }
})

audio.setEnabled(settings.soundEnabled)
audio.setVolume(settings.volume)

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

let assets: ThemeAssets = {
  theme: { id: 'default', name: 'default', blockScale: 1, padding: 0.08, slots: {} },
  source: 'procedural',
  images: new Map(),
  sounds: new Map(),
  failed: new Set(),
  warnings: [],
  objectUrls: []
}

/**
 * Level labels for the blocks, precomputed so drawing never builds strings.
 * The blocks show their LEVEL (1..N), not their score value: level is what the
 * player reasons about ("I need three 4s"), the score table is in the rules.
 */
function makeLevelLabels(levelCount: number): string[] {
  const out: string[] = []
  for (let level = 1; level <= levelCount; level++) out.push(String(level))
  return out
}

let levelLabels: readonly string[] = makeLevelLabels(modes[0].scoreByLevel.length)

function rebuildLabels(next: ModeConfig): void {
  levelLabels = makeLevelLabels(next.scoreByLevel.length)
  refreshModeTexts(next)
}

async function applyTheme(themeId: string): Promise<void> {
  const source = findSource(themes, themeId) ?? themes[0]
  if (source === undefined) return

  const previous = assets
  const next = await loadThemeSource(source, themeLevelCounts)

  if (next === null) {
    // The saved theme vanished (e.g. its pack was removed). Fall back to the
    // first theme rather than leaving the game with no artwork at all.
    const fallback = themes[0]
    assets = fallback === undefined ? previous : ((await loadThemeSource(fallback, themeLevelCounts)) ?? previous)
  } else {
    assets = next
  }

  // Blob URLs from the previous pack are only safe to revoke once nothing can
  // be drawn from them any more.
  if (previous !== assets) releaseTheme(previous)

  const overrides: Array<{ id: SoundId; url: string }> = []
  for (const [id, url] of assets.sounds) overrides.push({ id, url })
  // An empty list must still be pushed: keeping the previous theme's sounds
  // would make a silent theme play the last one's audio.
  void audio.loadOverrides(overrides)

  // The home screen shows the same background slot, so it has to follow.
  syncHomeBackground()
}

/** Pushes the active theme's home background into the home screen. */
function syncHomeBackground(): void {
  if (home.isVisible) home.refresh(homeState())
}

/** Home background URL for the active theme, or null for the built-in look. */
function homeBackgroundUrl(): string | null {
  return imageFor(assets, SLOT.homeBackground)?.src ?? null
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

let mode: ModeConfig = modes[0]
let game = new Game({ mode, tuning, seed: makeSeed() })
let started = false

function view(): GameView {
  return game.view()
}

// ---------------------------------------------------------------------------
// Event -> effects pipeline
// ---------------------------------------------------------------------------

function effectiveDensity(): number {
  if (reducedMotion) return 0
  return densityMultiplier(settings.particleDensity)
}

function applyFx(fx: FxDescriptor): void {
  const speedScale = layout.cell / 48
  const ringRadius = layout.cell * 0.55

  for (let i = 0; i < fx.particles.length; i++) {
    const spec = fx.particles[i]
    const point = boardSpaceToPx(layout, spec.x, spec.y)
    particles.burst(spec, point.x, point.y, speedScale)
    if (spec.ring) particles.ring(point.x, point.y, spec.hue, ringRadius)
  }

  for (let i = 0; i < fx.mergeBursts.length; i++) {
    mergeFx.add(fx.mergeBursts[i])
  }

  for (let i = 0; i < fx.floaters.length; i++) {
    const float = fx.floaters[i]
    const point = boardSpaceToPx(layout, float.x + 0.5, float.y + 0.5)
    floaters.add(point.x, point.y, float.text, float.tone)
  }

  shake.apply(fx.shake, reducedMotion)
  audio.playAll(fx.sounds)
}

/** Maps a batch of events to effects and plays them. */
function presentEvents(events: readonly GameEvent[]): void {
  if (events.length === 0) return
  const boss = game.view().pacman
  applyFx(
    describeEvents(events, {
      density: effectiveDensity(),
      levelHues: fxConfig.levelHues,
      reducedMotion,
      // Lets boss effects land on the boss rather than on the merged cells.
      boss: boss === null ? undefined : { x: boss.x, y: boss.y }
    })
  )
}

/** Events a chain produces; when a cascade payload exists these belong to it. */
const CASCADE_OWNED: ReadonlySet<GameEvent['type']> = new Set([
  'merged',
  'maxCleared',
  'obstacleHit',
  'obstacleCleared'
])

/**
 * Effects waiting for the moment they should actually be seen.
 *
 * The rules resolve a whole turn instantly, but the boss is drawn walking to its
 * food over a few hundred milliseconds. Firing its bite effects immediately
 * would show the particles and the score before the sprite got there, so the
 * bite is held back until it arrives.
 */
const pendingFx: Array<{ atMs: number; events: GameEvent[] }> = []

function scheduleFx(events: readonly GameEvent[], afterMs: number): void {
  if (events.length === 0) return
  pendingFx.push({ atMs: performance.now() + afterMs, events: [...events] })
}

function flushPendingFx(nowMs: number): void {
  for (let i = pendingFx.length - 1; i >= 0; i--) {
    if (pendingFx[i].atMs > nowMs) continue
    const due = pendingFx.splice(i, 1)[0]
    presentEvents(due.events)
  }
}

/** A boss action that travels: its effects wait for the journey to finish. */
type JourneyEvent = Extract<GameEvent, { type: 'pacmanAte' } | { type: 'pacmanExited' }>

function isJourney(event: GameEvent): event is JourneyEvent {
  return event.type === 'pacmanAte' || event.type === 'pacmanExited'
}

/**
 * Presents one move.
 *
 * When the move triggered an automatic chain, the merges are NOT played all at
 * once: the chain is handed to CascadePlayer, which shows one link at a time
 * (each link's effects fire on the frame it begins). Everything else — the
 * placement, the obstacle spawn, the win/lose dialog — still happens now.
 */
function present(events: readonly GameEvent[]): void {
  const cascade = events.find((event) => event.type === 'cascadeSteps')

  // Start the boss walking before anything else, so its journey overlaps the
  // merge animation instead of queueing behind it.
  let journeyMs = 0
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!isJourney(event)) continue
    if (!reducedMotion && pacmanAnimator.begin(event.from, event.path)) {
      journeyMs = pacmanAnimator.durationMs
    }
    break
  }

  const immediate = events.filter((event) => !isJourney(event) && !CASCADE_OWNED.has(event.type))

  // A journey's own effects wait for the arrival; everything else fires now.
  const arrived = events.filter(isJourney)
  scheduleFx(arrived, journeyMs)

  if (cascade !== undefined) {
    const payload = immediate.filter((event) => event.type !== 'cascadeSteps')
    presentEvents(payload)

    if (cascade.steps.length > 0 && cascadePlayer.begin(cascade.steps)) {
      // The first link starts on the next frame, reported by update().
      return
    }
  } else {
    presentEvents(immediate)
  }

  syncDialogs()
}

/** Shows the dialogs the rules layer asks for (win / game over). */
function syncDialogs(): void {
  if (hud.isDialogOpen()) return

  const state = view()

  if (state.pendingWin !== null) {
    const levelScore = state.scoreByLevel[state.pendingWin.level - 1] ?? 0
    hud.showWin(levelScore, state.score)
    return
  }

  // Battle mode is won by defeating the boss, and has no "keep playing" step:
  // there is nothing left to challenge once it is down.
  if (mode.battle && state.hasWon && !state.gameOver) {
    finishRun()
    hud.showVictory(state.score, progressStore.bestFor(mode.id))
    return
  }

  if (state.gameOver) {
    finishRun()
    hud.showGameOver(state.score, progressStore.bestFor(mode.id), state.canUndo, mode.battle)
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

let rejectedCell: { x: number; y: number; untilMs: number } | null = null

function resetEffects(): void {
  pointer.setSelectedSlot(null)
  pointer.clearDrag()
  cascadePlayer.cancel()
  pacmanAnimator.cancel()
  pendingFx.length = 0
  particles.clear()
  floaters.clear()
  mergeFx.clear()
  shake.clear()
  rejectedCell = null
}

const hud = new Hud(
  {
    onPullNext: () => {
      audio.unlock()
      present(game.pullNextToBuffer())
    },
    onSelectSlot: (slot) => {
      pointer.setSelectedSlot(slot)
    },
    onUndo: () => {
      audio.unlock()
      // An undo during playback must abort it before rewinding, otherwise the
      // animation would keep drawing a board state that no longer exists.
      cascadePlayer.cancel()
      const events = game.undo()
      if (events[0]?.type === 'undo') {
        hud.closeDialog()
        particles.clear()
        floaters.clear()
        mergeFx.clear()
      }
      present(events)
    },
    onRequestRestart: () => {
      hud.closeDialog()
      hud.showRestartConfirm()
    },
    onConfirmRestart: () => {
      hud.closeDialog()
      started = true
      beginRun()
      resetEffects()
      present(game.restart(makeSeed()))
    },
    onCancelRestart: () => {
      hud.closeDialog()
    },
    onGoHome: () => {
      goHome()
    },
    onContinueAfterWin: () => {
      hud.closeDialog()
      present(game.continueAfterWin())
    },
    onEndAfterWin: () => {
      hud.closeDialog()
      // syncDialogs() observes gameOver and records the run exactly once.
      present(game.endAfterWin())
    },
    onSettingsChange: (patch) => {
      applySettings(patch)
    },
    onOpenSettings: () => {
      audio.unlock()
      hud.showSettings(settings, isStoragePersistent())
    },
    onCloseSettings: () => {
      hud.closeDialog()
    },
    onToggleSound: () => {
      // Must read the live setting: the button is outside the settings panel.
      const next = !settings.soundEnabled
      settings = settingsStore.set({ soundEnabled: next })
      audio.unlock()
      audio.setEnabled(settings.soundEnabled)
      if (next) {
        // Give immediate feedback that sound is back.
        audio.play({ id: 'pick', semitone: 0, gain: 1, delayMs: 0 })
      }
    }
  },
  themes
)

// ---------------------------------------------------------------------------
// Home screen / run lifecycle
// ---------------------------------------------------------------------------

/** Snapshot of a parked run, for the home cards. */
function parkedSummary(): Record<string, { score: number; steps: number; at: number }> {
  const summary: Record<string, { score: number; steps: number; at: number }> = {}
  for (const modeId of runStore.parkedModeIds()) {
    const run = runStore.load(modeId)
    if (run === null) continue
    summary[modeId] = { score: run.snapshot.score, steps: run.snapshot.steps, at: run.at }
  }
  return summary
}

const home = new HomeScreen({
  onStartMode: (modeId) => {
    startMode(modeId, null)
  },
  onResumeMode: (modeId) => {
    const run = runStore.load(modeId)
    if (run === null) {
      startMode(modeId, null)
      return
    }
    startMode(modeId, run)
  },
  onRestartMode: (modeId) => {
    runStore.clear(modeId)
    startMode(modeId, null)
  },
  onOpenSettings: () => {
    audio.unlock()
    openSettingsDialog()
  },
  onCloseSettings: () => {
    home.closeDialog()
  },
  onLayoutMode: (mode) => {
    applySettings({ layoutMode: mode })
  }
})

function homeState(): Parameters<HomeScreen['show']>[0] {
  return {
    modes,
    bestScores: progressStore.get().bestScores,
    parked: parkedSummary(),
    leaderboard: leaderboardRows,
    settings,
    storageHealthy: isStoragePersistent(),
    backgroundUrl: homeBackgroundUrl()
  }
}

function openSettingsDialog(): void {
  home.openSettingsHost((container, close) => {
    hud.buildSettingsPanel(
      container,
      settings,
      isStoragePersistent(),
      (patch) => applySettings(patch),
      close
    )
  })
}

/** Applies a settings patch and re-renders whichever settings panel is open. */
function applySettings(patch: Partial<Omit<Settings, 'version'>>): void {
  settings = settingsStore.set(patch)
  audio.setEnabled(settings.soundEnabled)
  audio.setVolume(settings.volume)
  if (patch.themeId !== undefined) {
    void applyTheme(settings.themeId)
  }
  if (patch.layoutMode !== undefined) {
    // resize() is the single place that recomputes the layout and re-registers
    // it with the pointer input, so switching variant is just a resize.
    resize()
  }

  // Rebuild for discrete choices, but not while the volume slider is being
  // dragged: rebuilding the panel would reset the thumb mid-gesture.
  const discrete =
    patch.themeId !== undefined ||
    patch.particleDensity !== undefined ||
    patch.soundEnabled !== undefined ||
    patch.layoutMode !== undefined
  if (!discrete) return

  if (!home.isVisible) {
    hud.showSettings(settings, isStoragePersistent())
    return
  }

  // The home screen owns its own copy of these controls, so redraw it — and do
  // NOT fall through to the in-game panel, which would stack the HUD's dialog
  // on top of the home screen.
  //
  // It is safe to re-render while its settings panel is open: home dialogs are
  // attached to <body>, not to the home root, so replaceChildren() cannot take
  // them down. (They used to live inside the root, and any re-render — including
  // the async one that fires when a theme finishes loading — closed the panel.)
  home.refresh(homeState())
}

/** Parks the current run (if it is still in progress) and shows the home screen. */
function goHome(): void {
  hud.closeDialog()
  cascadePlayer.cancel()
  resetEffects()

  if (hasProgress()) {
    runStore.save(mode.id, game.snapshot(), Date.now())
  }

  started = false
  home.show(homeState())
}

/** Enters a mode, either resuming a parked run or starting a fresh one. */
function startMode(modeId: string, resume: SavedRun | null): void {
  const next = modes.find((item) => item.id === modeId)
  if (next === undefined) return

  audio.unlock()
  mode = next
  game = new Game({ mode, tuning, seed: makeSeed() })
  rebuildLabels(mode)

  if (resume !== null) {
    game.restore(resume.snapshot)
    // The parked run keeps its own clock; restart it so the leaderboard entry
    // measures play time rather than wall-clock time since it was parked.
    beginRun()
  } else {
    beginRun()
  }

  started = true
  resetEffects()
  home.hide()
  syncDialogs()
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function placeFrom(slot: number, x: number, y: number): void {
  audio.unlock()
  const events = game.placeFromBuffer(slot, x, y)

  const rejected = events.some((event) => event.type === 'invalid')
  if (rejected) {
    // Keep the selection so the player can immediately try another cell.
    rejectedCell = { x, y, untilMs: performance.now() + 320 }
    pointer.setSelectedSlot(slot)
  } else {
    rejectedCell = null
    pointer.setSelectedSlot(null)
  }

  present(events)
}

/**
 * Drops the "next" block straight onto the board. Uses the rules-layer
 * `placeFromNext` so it works even when every buffer slot is occupied — the
 * block never has to be staged.
 */
function placeFromNext(x: number, y: number): void {
  audio.unlock()
  const events = game.placeFromNext(x, y)

  if (events.some((event) => event.type === 'invalid')) {
    rejectedCell = { x, y, untilMs: performance.now() + 320 }
  } else {
    rejectedCell = null
    pointer.setSelectedSlot(null)
  }

  present(events)
}

/** Stages the "next" block into a specific buffer slot (drag onto the tray). */
function nextToBuffer(slot: number): void {
  audio.unlock()
  const events = game.pullNextToBuffer(slot)
  if (events.some((event) => event.type === 'invalid')) {
    pointer.setSelectedSlot(null)
  }
  present(events)
}

const pointer = new PointerInput(
  canvas,
  layout,
  {
    onPullNext: () => {
      audio.unlock()
      present(game.pullNextToBuffer())
    },
    onSelectSlot: (slot) => {
      pointer.setSelectedSlot(slot)
    },
    onPlace: placeFrom,
    onNextToBuffer: nextToBuffer,
    onPlaceNext: placeFromNext,
    onInvalidDrop: () => {
      audio.unlock()
      present([{ type: 'invalid', reason: 'cell-occupied' }])
    }
  },
  (slot) => view().buffer[slot] ?? 0,
  () => view().next,
  () =>
    !started ||
    home.isBlocking ||
    hud.isDialogOpen() ||
    cascadePlayer.active ||
    // While the boss is visibly walking, its move is still being shown; letting
    // the player place now would start a second journey mid-stride.
    pacmanAnimator.active ||
    view().gameOver ||
    view().pendingWin !== null
)

/**
 * True when the run has something worth parking.
 *
 * A brand-new run with no moves is not progress: parking it would put a
 * meaningless "0 步" entry on the home screen. More importantly the caller must
 * SKIP rather than clear, otherwise opening a mode and immediately leaving
 * would wipe a genuinely parked run in that slot.
 */
function hasProgress(): boolean {
  return started && !view().gameOver && view().steps > 0
}

/** Parks the run without leaving it: used when the page is being hidden. */
function parkRun(): void {
  if (!hasProgress()) return
  cascadePlayer.cancel()
  runStore.save(mode.id, game.snapshot(), Date.now())
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) parkRun()
})
// `pagehide` is the reliable one for tab close / navigation on both desktop
// and mobile; `visibilitychange` alone misses some teardown paths.
window.addEventListener('pagehide', parkRun)

// Browsers only allow audio after a user gesture. Unlocking on the very first
// interaction anywhere means no action can ever be the one that silently
// produces no sound.
window.addEventListener(
  'pointerdown',
  () => {
    audio.unlock()
  },
  { once: true, capture: true }
)

attachKeyboard(
  window,
  {
    onUndo: () => {
      if (!started || home.isBlocking) return
      audio.unlock()
      cascadePlayer.cancel()
      const events = game.undo()
      if (events[0]?.type === 'undo') {
        hud.closeDialog()
        particles.clear()
        floaters.clear()
        mergeFx.clear()
      }
      present(events)
    },
    onRestart: () => {
      if (!started || home.isBlocking) return
      hud.closeDialog()
      hud.showRestartConfirm()
    }
  },
  { isBlocked: () => hud.isDialogOpen() }
)

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  const width = Math.max(240, Math.floor(window.innerWidth))
  const height = Math.max(320, Math.floor(window.innerHeight))

  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  layout = computeLayout(
    width,
    height,
    tuning.board.width,
    tuning.board.height,
    tuning.buffer.slots,
    LEADERBOARD_VISIBLE,
    settings.layoutMode
  )
  pointer.setLayout(layout)
}

window.addEventListener('resize', resize)
window.addEventListener('orientationchange', resize)

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let lastFrameMs = performance.now()
let running = true

document.addEventListener('visibilitychange', () => {
  running = !document.hidden
  lastFrameMs = performance.now()
  if (running) {
    audio.unlock()
    window.requestAnimationFrame(frame)
  }
})

function frame(nowMs: number): void {
  if (!running) return

  // Effects use a clamped delta so a backgrounded tab cannot teleport particles.
  const dtMs = Math.min(48, Math.max(0, nowMs - lastFrameMs))
  lastFrameMs = nowMs

  particles.update(dtMs)
  floaters.update(dtMs)
  mergeFx.update(dtMs)
  shake.update(dtMs)

  // Advance an automatic chain one link at a time, firing each link's effects
  // on the frame it begins so the player can follow what caused what.
  const tick = cascadePlayer.update(dtMs)
  if (tick.started !== null) presentEvents(tick.started.events)
  if (tick.finished) syncDialogs()

  // The boss walking to its food. Its bite effects were scheduled for the
  // moment it arrives, so this is what releases them.
  pacmanAnimator.update(dtMs)
  flushPendingFx(nowMs)

  if (rejectedCell !== null && rejectedCell.untilMs <= nowMs) rejectedCell = null

  const state = view()
  refreshTexts(state)

  const moving = pacmanAnimator.position()

  const renderState: RenderState = {
    view: state,
    layout,
    assets,
    styles: spriteStyles,
    labels: levelLabels,
    texts,
    selectedSlot: pointer.state.selectedSlot,
    hoverSlot: pointer.state.hoverSlot,
    hoverNext: pointer.state.hoverNext,
    dragFromNext: pointer.state.dragFromNext,
    dragLevel: pointer.state.dragLevel,
    dragPx: pointer.state.dragPx,
    hoverCell: pointer.state.hoverCell,
    rejectedCell,
    particles,
    floaters,
    mergeFx,
    overrideCells: cascadePlayer.overrideCells(),
    leaderboard: leaderboardRows,
    shakeOffset: { x: shake.x, y: shake.y },
    pacman: state.pacman,
    pacmanMoving:
      moving === null ? null : { x: moving.x, y: moving.y, heading: pacmanAnimator.heading() },
    timeMs: nowMs,
    reducedMotion
  }

  render(ctx, renderState)

  hud.update({
    canUndo: state.canUndo,
    started,
    settings,
    storageHealthy: isStoragePersistent()
  })

  window.requestAnimationFrame(frame)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void applyTheme(settings.themeId).then(() => {
  resize()
  window.requestAnimationFrame(frame)
  home.show(homeState())
})
