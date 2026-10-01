import { HUD_BOTTOM_PX, HUD_HINT_PX } from './layout'
import type { ParticleDensity } from '../core/types'
import type { LayoutMode, Settings } from '../core/settings'

/**
 * DOM-based HUD.
 *
 * Score, buttons, dialogs and the settings panel are DOM rather than canvas:
 * text stays crisp, buttons stay keyboard- and screen-reader-friendly, and the
 * canvas only has to draw the play area.
 */

export type DensitySetting = ParticleDensity

/**
 * One entry in the theme dropdown.
 *
 * Deliberately structural rather than `ThemeSource`: the HUD only ever needs a
 * label and a value, and keeping it that way means the theme registry (which
 * pulls in a build-time glob) is not dragged into the HUD's dependency graph.
 */
export interface ThemeOption {
  id: string
  name: string
}

export interface HudCallbacks {
  onPullNext(): void
  onSelectSlot(slot: number): void
  onUndo(): void
  onRequestRestart(): void
  onConfirmRestart(): void
  onCancelRestart(): void
  /** Leaves the run and goes back to the home screen (the run is parked). */
  onGoHome(): void
  onContinueAfterWin(): void
  onEndAfterWin(): void
  onSettingsChange(patch: Partial<Omit<Settings, 'version'>>): void
  onOpenSettings(): void
  onCloseSettings(): void
  /** Toggles sound from the always-visible button in the bottom row. */
  onToggleSound(): void
}

export interface HudState {
  canUndo: boolean
  started: boolean
  settings: Settings
  storageHealthy: boolean
}
const STYLE_ID = 'hud-styles'

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
:root { --hud-bottom: ${HUD_BOTTOM_PX}px; --hud-hint: ${HUD_HINT_PX}px; }
.hud { position: fixed; inset: 0; pointer-events: none; font: 400 14px/1.4 system-ui, "Microsoft YaHei", sans-serif; color: #e8ecf5; }
.hud__bottom { position: absolute; left: 0; right: 0; bottom: 0; height: var(--hud-bottom); display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 10px; flex-wrap: nowrap; }
.hud button { pointer-events: auto; font: inherit; color: inherit; background: rgba(255,255,255,.08); border: 1px solid rgba(160,180,255,.22); border-radius: 10px; padding: 8px 12px; cursor: pointer; white-space: nowrap; }
.hud button:hover:not(:disabled) { background: rgba(255,255,255,.15); border-color: rgba(180,198,255,.45); }
.hud button:disabled { opacity: .34; cursor: default; }
.hud button.primary { background: #4f5fd7; border-color: #6d7bff; }
.hud button.primary:hover { background: #5f6ee6; }
.hud__icon { padding: 8px 11px; }
.hud__dialog { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(6,8,16,.72); pointer-events: auto; backdrop-filter: blur(3px); padding: 14px; overflow-y: auto; font: 400 14px/1.5 system-ui, "Microsoft YaHei", sans-serif; color: #e8ecf5; }
.hud__panel { background: #171c2e; border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 20px; width: min(400px, 100%); max-height: calc(100dvh - 28px); overflow-y: auto; box-shadow: 0 18px 50px rgba(0,0,0,.5); }
/* The mode picker is short by design (names only), so it must never scroll. */
.hud__panel--compact { max-height: none; overflow: visible; width: min(340px, 100%); }
.hud__panel h2 { margin: 0 0 4px; font-size: 18px; }
.hud__panel p { margin: 0 0 14px; color: #9aa7cc; font-size: 13px; }
.hud__row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; }
.hud__row label { color: #b9c4e2; }
.hud__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.hud__hint { position: absolute; left: 0; right: 0; top: calc(100% - var(--hud-bottom) - var(--hud-hint)); height: var(--hud-hint);
  display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; color: #8f9cc0; }
.hud input[type=range] { width: 140px; pointer-events: auto; }
.hud select { font: inherit; color: inherit; background: #212840; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; padding: 6px 8px; pointer-events: auto; }
.hud__warn { margin-top: 10px; font-size: 12px; color: #ffb86b; }
`
  document.head.appendChild(style)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export class Hud {
  private readonly root: HTMLDivElement
  private readonly undoButton: HTMLButtonElement
  private readonly restartButton: HTMLButtonElement
  private readonly soundButton: HTMLButtonElement
  private readonly hint: HTMLElement
  private dialog: HTMLElement | null = null

  private state: HudState | null = null

  constructor(
    private readonly callbacks: HudCallbacks,
    private readonly themes: readonly ThemeOption[]
  ) {
    injectStyles()

    this.root = el('div', 'hud')

    this.hint = el('div', 'hud__hint')

    const bottom = el('div', 'hud__bottom')
    this.undoButton = el('button', undefined, '撤销')
    this.undoButton.title = '撤销上一步（Ctrl/Cmd + Z）'
    this.undoButton.addEventListener('click', () => this.callbacks.onUndo())

    this.restartButton = el('button', undefined, '重新开始')
    this.restartButton.title = '重新开始（R）'
    this.restartButton.addEventListener('click', () => this.callbacks.onRequestRestart())

    const homeButton = el('button', undefined, '返回主页')
    homeButton.title = '返回主页（本局会保存，下次可继续）'
    homeButton.addEventListener('click', () => this.callbacks.onGoHome())

    const settingsButton = el('button', 'hud__icon', '⚙')
    settingsButton.title = '设置'
    settingsButton.addEventListener('click', () => this.callbacks.onOpenSettings())

    // A raw mute flag is invisible otherwise: it lives two taps deep in the
    // settings panel, so a muted player has no way to notice or recover.
    this.soundButton = el('button', 'hud__icon', '🔊')
    this.soundButton.title = '音效开关'
    this.soundButton.addEventListener('click', () => this.callbacks.onToggleSound())

    bottom.append(this.undoButton, this.restartButton, homeButton, this.soundButton, settingsButton)

    this.root.append(this.hint, bottom)
    document.body.appendChild(this.root)
  }

  update(state: HudState): void {
    const previous = this.state
    this.state = state

    if (previous === null || previous.canUndo !== state.canUndo) {
      this.undoButton.disabled = !state.canUndo
    }

    if (previous === null || previous.settings.soundEnabled !== state.settings.soundEnabled) {
      const on = state.settings.soundEnabled
      this.soundButton.textContent = on ? '🔊' : '🔇'
      this.soundButton.title = on ? '音效：开（点击静音）' : '音效：关（点击开启）'
      this.soundButton.style.opacity = on ? '1' : '0.55'
    }

    // The scoreboard lives on the canvas and mode choice happens on the home
    // screen, so this line is only a first-run gesture hint.
    const hintLabel = state.started ? '按住方块可以拖到棋盘上' : ''
    if (this.hint.textContent !== hintLabel) this.hint.textContent = hintLabel
  }

  showRestartConfirm(): void {
    const panel = el('div', 'hud__panel')
    panel.append(el('h2', undefined, '重新开始？'))
    panel.append(el('p', undefined, '当前分数会丢失（最高分会保留），撤销历史也会清空。'))

    const actions = el('div', 'hud__actions')
    const cancel = el('button', undefined, '取消')
    cancel.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onCancelRestart()
    })
    const confirm = el('button', 'primary', '重新开始')
    confirm.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onConfirmRestart()
    })
    actions.append(cancel, confirm)
    panel.append(actions)
    this.openDialog(panel, true)
  }

  showGameOver(score: number, best: number, canUndo: boolean, battle = false): void {
    const panel = el('div', 'hud__panel')
    panel.append(el('h2', undefined, battle ? '棋盘被吃光了' : '棋盘已满'))
    panel.append(
      el(
        'p',
        undefined,
        battle
          ? `本局得分 ${score}，最高分 ${Math.max(best, score)}。可玩区的方块被吃光了。`
          : `本局得分 ${score}，最高分 ${Math.max(best, score)}。放不下新方块了。`
      )
    )

    const actions = el('div', 'hud__actions')
    if (canUndo) {
      const undo = el('button', undefined, '撤销上一步')
      undo.addEventListener('click', () => {
        this.closeDialog()
        this.callbacks.onUndo()
      })
      actions.append(undo)
    }
    const again = el('button', 'primary', undefined)
    again.textContent = '重新开始'
    again.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onRequestRestart()
    })
    actions.append(again)
    panel.append(actions)
    this.openDialog(panel, true)
  }

  /**
   * Battle mode's victory: the boss's hit points reached zero.
   *
   * Separate from `showWin`, which belongs to the level-based win of endless
   * mode and offers "keep playing". There is nothing to continue here.
   */
  showVictory(score: number, best: number): void {
    const panel = el('div', 'hud__panel')
    panel.append(el('h2', undefined, '吃豆人被打倒了！'))
    panel.append(
      el('p', undefined, `本局得分 ${score}，最高分 ${Math.max(best, score)}。它的血被你打空了。`)
    )

    const actions = el('div', 'hud__actions')
    const again = el('button', 'primary', '再来一局')
    again.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onRequestRestart()
    })
    actions.append(again)
    panel.append(actions)
    this.openDialog(panel, true)
  }

  showWin(levelScore: number, score: number): void {
    const panel = el('div', 'hud__panel')
    panel.append(el('h2', undefined, '合成了 ' + String(levelScore) + ' 分方块！'))
    panel.append(el('p', undefined, `你赢了，当前 ${score} 分。可以继续挑战更高分。`))

    const actions = el('div', 'hud__actions')
    const end = el('button', undefined, '结束本局')
    end.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onEndAfterWin()
    })
    const keepGoing = el('button', 'primary', '继续挑战')
    keepGoing.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onContinueAfterWin()
    })
    actions.append(end, keepGoing)
    panel.append(actions)
    this.openDialog(panel, true)
  }

  /**
   * Renders the settings panel into `container` and calls `onClose` when the
   * player is done.
   *
   * Exposed as a standalone builder because the same panel is shown from two
   * places — the in-game ⚙ button and the home screen — and duplicating it
   * would guarantee the two drift apart.
   */
  buildSettingsPanel(
    container: HTMLElement,
    settings: Settings,
    storageHealthy: boolean,
    onSettingsChange: (patch: Partial<Omit<Settings, 'version'>>) => void,
    onClose: () => void
  ): void {
    container.replaceChildren()

    const panel = el('div', 'hud__panel')
    panel.append(el('h2', undefined, '设置'))
    panel.append(el('p', undefined, '设置与最高分分开保存，互不影响。'))

    // Theme
    const themeRow = el('div', 'hud__row')
    themeRow.append(el('label', undefined, '主题'))
    const themeSelect = el('select')
    for (const theme of this.themes) {
      const option = el('option', undefined, theme.name)
      option.value = theme.id
      if (theme.id === settings.themeId) option.selected = true
      themeSelect.append(option)
    }
    themeSelect.addEventListener('change', () => {
      onSettingsChange({ themeId: themeSelect.value })
    })
    themeRow.append(themeSelect)
    panel.append(themeRow)

    // Sound toggle
    const soundRow = el('div', 'hud__row')
    soundRow.append(el('label', undefined, '音效'))
    const soundToggle = el('button', undefined, settings.soundEnabled ? '开启' : '关闭')
    soundToggle.addEventListener('click', () => {
      onSettingsChange({ soundEnabled: !settings.soundEnabled })
    })
    soundRow.append(soundToggle)
    panel.append(soundRow)

    // Volume
    const volumeRow = el('div', 'hud__row')
    volumeRow.append(el('label', undefined, '音量'))
    const volume = el('input')
    volume.type = 'range'
    volume.min = '0'
    volume.max = '100'
    volume.value = String(Math.round(settings.volume * 100))
    volume.addEventListener('input', () => {
      onSettingsChange({ volume: Number(volume.value) / 100 })
    })
    volumeRow.append(volume)
    panel.append(volumeRow)

    // Particle density
    const densityRow = el('div', 'hud__row')
    densityRow.append(el('label', undefined, '粒子密度'))
    const densitySelect = el('select')
    const densities: Array<[DensitySetting, string]> = [
      ['low', '低'],
      ['medium', '中'],
      ['high', '高']
    ]
    for (const [value, label] of densities) {
      const option = el('option', undefined, label)
      option.value = value
      if (value === settings.particleDensity) option.selected = true
      densitySelect.append(option)
    }
    densitySelect.addEventListener('change', () => {
      onSettingsChange({ particleDensity: densitySelect.value as DensitySetting })
    })
    densityRow.append(densitySelect)
    panel.append(densityRow)

    // Layout variant
    const layoutRow = el('div', 'hud__row')
    layoutRow.append(el('label', undefined, '界面布局'))
    const layoutSelect = el('select')
    const layoutModes: Array<[LayoutMode, string]> = [
      ['auto', '自动'],
      ['desktop', '电脑版'],
      ['mobile', '手机版']
    ]
    for (const [value, label] of layoutModes) {
      const option = el('option', undefined, label)
      option.value = value
      if (value === settings.layoutMode) option.selected = true
      layoutSelect.append(option)
    }
    layoutSelect.addEventListener('change', () => {
      onSettingsChange({ layoutMode: layoutSelect.value as LayoutMode })
    })
    layoutRow.append(layoutSelect)
    panel.append(layoutRow)

    if (!storageHealthy) {
      panel.append(el('div', 'hud__warn', '浏览器存储不可用：本次设置与最高分只保存在内存中。'))
    }

    const actions = el('div', 'hud__actions')
    const close = el('button', 'primary', '完成')
    close.addEventListener('click', () => {
      this.closeDialog()
      onClose()
    })
    actions.append(close)
    panel.append(actions)

    container.append(panel)
  }

  showSettings(settings: Settings, storageHealthy: boolean): void {
    const host = el('div')
    this.buildSettingsPanel(
      host,
      settings,
      storageHealthy,
      (patch) => this.callbacks.onSettingsChange(patch),
      () => this.callbacks.onCloseSettings()
    )
    const panel = host.firstElementChild
    if (panel instanceof HTMLElement) this.openDialog(panel, true)
  }

  isDialogOpen(): boolean {
    return this.dialog !== null
  }

  private openDialog(content: HTMLElement, dismissOnBackdrop: boolean): void {
    this.closeDialog()
    const overlay = el('div', 'hud__dialog')
    overlay.append(content)
    if (dismissOnBackdrop) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          this.closeDialog()
        }
      })
    }
    this.dialog = overlay
    this.root.append(overlay)
  }

  closeDialog(): void {
    if (this.dialog !== null) {
      this.dialog.remove()
      this.dialog = null
    }
  }
}
