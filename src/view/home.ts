import { LEADERBOARD_VISIBLE, formatDuration, type ScoreEntry } from '../core/leaderboard'
import type { LayoutMode, Settings } from '../core/settings'
import type { ModeConfig } from '../core/types'
import { MOBILE_BREAKPOINT } from './layout'

/**
 * Home screen.
 *
 * A DOM overlay rather than canvas: it is a menu, so crisp text, hover states,
 * keyboard focus and scrolling all come for free. It reuses the `.hud__*`
 * classes that Hud injects, so there is only one set of styles in the app.
 *
 * The home screen owns the entry flow: pick a mode -> optionally resume the
 * parked run for that mode -> play. Leaving a run is what parks it.
 */

export interface HomeCallbacks {
  onStartMode(modeId: string): void
  onResumeMode(modeId: string): void
  onRestartMode(modeId: string): void
  onOpenSettings(): void
  onCloseSettings(): void
  /** Switches the interface between the desktop and mobile arrangements. */
  onLayoutMode(mode: LayoutMode): void
}

export interface HomeState {
  modes: readonly ModeConfig[]
  /** Best score per mode id. */
  bestScores: Record<string, number>
  /** Modes with a parked run, and a short summary of each. */
  parked: Record<string, { score: number; steps: number; at: number }>
  leaderboard: readonly ScoreEntry[]
  settings: Settings
  storageHealthy: boolean
  /**
   * Theme-supplied home background, or null to use the built-in gradient.
   * Passed as a ready URL (a path, or a blob URL for a zip theme) so the home
   * screen never has to know where the theme came from.
   */
  backgroundUrl: string | null
}

export interface SettingsPanelHooks {
  render(container: HTMLElement, state: HomeState, close: () => void): void
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

const STYLE_ID = 'home-styles'

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.home { position: fixed; inset: 0; display: grid; place-items: center; padding: 16px;
  background: radial-gradient(130% 100% at 50% -10%, #23305e 0%, #131a30 42%, #080b16 78%);
  backdrop-filter: blur(8px); overflow-y: auto; font: 400 14px/1.5 system-ui, "Microsoft YaHei", sans-serif; color: #e8ecf5; }
.home__inner { width: min(430px, 100%); padding: 8px 0 20px; }
.home__title { margin: 0 0 4px; font-size: 34px; font-weight: 800; letter-spacing: 4px; text-align: center;
  background: linear-gradient(180deg, #ffffff 0%, #9fb0ff 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 4px 18px rgba(120,150,255,.35)); }
.home__subtitle { margin: 0 0 22px; text-align: center; font-size: 12px; color: #8f9cc0; letter-spacing: 3px; }
.home__modes { display: grid; gap: 10px; }
.home__mode { position: relative; display: block; width: 100%; text-align: left; padding: 15px 18px 15px 20px;
  color: inherit; font: inherit; cursor: pointer; border-radius: 14px; overflow: hidden;
  background: linear-gradient(180deg, rgba(64,80,148,.55) 0%, rgba(28,36,72,.75) 100%);
  border: 1px solid rgba(150,175,255,.28);
  box-shadow: 0 6px 20px rgba(4,7,18,.45), inset 0 1px 0 rgba(255,255,255,.10);
  transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease; }
.home__mode::before { content: ''; position: absolute; left: 0; top: 12%; bottom: 12%; width: 4px; border-radius: 0 4px 4px 0;
  background: linear-gradient(180deg, #8fa4ff, #5f6ee6); }
.home__mode:hover { transform: translateY(-1px); border-color: rgba(190,206,255,.6);
  box-shadow: 0 10px 26px rgba(4,7,18,.55), inset 0 1px 0 rgba(255,255,255,.16); }
.home__mode:active { transform: translateY(0); }
.home__mode-name { display: block; font-size: 18px; font-weight: 700; margin-bottom: 4px; letter-spacing: 1px; }
.home__mode-meta { display: flex; gap: 14px; font-size: 12px; color: #a3b0d4; }
.home__badge { position: absolute; top: 13px; right: 15px; font-size: 11px; font-weight: 700;
  color: #241a02; background: linear-gradient(180deg, #ffe08a, #f2b23f); border-radius: 999px; padding: 2px 10px;
  box-shadow: 0 2px 10px rgba(242,178,63,.35); }
.home__actions { margin-top: 16px; display: grid; gap: 10px; }
.home__actions button { padding: 13px; border-radius: 12px; font-size: 15px; font-weight: 600;
  background: linear-gradient(180deg, rgba(48,60,110,.6) 0%, rgba(24,31,60,.75) 100%);
  border: 1px solid rgba(150,175,255,.24); box-shadow: 0 4px 14px rgba(4,7,18,.35); }
/* Layout switch: three segments so the current arrangement is always visible,
   rather than a single button whose label has to be guessed. */
.home__layout { margin-top: 18px; }
.home__layout-label { display: block; margin-bottom: 7px; font-size: 12px; color: #8f9cc0; letter-spacing: 2px; text-align: center; }
.home__segments { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.home__segment { padding: 10px 6px; border-radius: 11px; font-size: 13px; font-weight: 600; cursor: pointer;
  color: inherit; font-family: inherit; text-align: center;
  background: rgba(255,255,255,.05); border: 1px solid rgba(150,175,255,.20);
  transition: background .12s ease, border-color .12s ease, color .12s ease; }
.home__segment:hover { background: rgba(255,255,255,.12); }
.home__segment--on { color: #0d1226; background: linear-gradient(180deg, #c8d3ff, #8f9dff);
  border-color: #b6c2ff; box-shadow: 0 3px 12px rgba(143,157,255,.30); }
/*
 * The interface-layout switch has to be visible where it lives.
 *
 * Only the canvas used to react to it, and the home screen is a DOM menu that
 * looked byte-for-byte identical in all three modes — so tapping 手机版 /
 * 电脑版 appeared to do nothing at all. The menu now follows the setting too.
 */
.home__body { display: grid; grid-template-columns: 1fr; }
.home__col { min-width: 0; }
.home__layout-note { display: block; margin-top: 8px; text-align: center; font-size: 12px; color: #8f9cc0; }
.home--mobile .home__inner { width: min(400px, 100%); }
@media (min-width: 640px) {
  .home--desktop .home__inner { width: min(780px, 100%); }
  .home--desktop .home__body { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 0 20px; align-items: start; }
  .home--desktop .home__board { margin-top: 0; padding: 14px 14px 10px; border-top: 0; border-radius: 14px;
    background: rgba(255,255,255,.045); border: 1px solid rgba(150,175,255,.16); }
}
/* Scrim keeping home text legible over an arbitrary theme background. */
.home__scrim { position: fixed; inset: 0; pointer-events: none;
  background: radial-gradient(120% 90% at 50% 0%, rgba(10,14,28,.55) 0%, rgba(6,9,18,.78) 100%); }
.home__board { margin-top: 22px; border-top: 1px solid rgba(255,255,255,.10); padding-top: 14px; }
.home__board h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #b9c4e2; letter-spacing: 3px; }
.home__row { display: flex; align-items: baseline; gap: 10px; padding: 5px 2px; font-size: 13px; border-radius: 8px; }
.home__row:first-of-type { background: linear-gradient(90deg, rgba(255,209,102,.10), rgba(255,209,102,0)); }
.home__rank { width: 18px; color: #7f8cb4; font-weight: 700; }
.home__rank--top { color: #ffd166; }
.home__row-mode { flex: 1; color: #cfd7f0; }
.home__row-score { color: #ffffff; font-weight: 700; font-variant-numeric: tabular-nums; }
.home__row-time { color: #8f9cc0; font-size: 12px; font-variant-numeric: tabular-nums; }
.home__empty { font-size: 12px; color: #7f8cb4; }
`
  document.head.appendChild(style)
}

export class HomeScreen {
  private readonly root: HTMLDivElement
  private visible = false
  private state: HomeState | null = null
  private dialog: HTMLElement | null = null

  constructor(private readonly callbacks: HomeCallbacks) {
    injectStyles()

    this.root = el('div', 'home')
    this.root.style.display = 'none'
    document.body.appendChild(this.root)
  }

  get isVisible(): boolean {
    return this.visible
  }

  /** True while any home-owned dialog or the home screen itself is up. */
  get isBlocking(): boolean {
    return this.visible
  }

  show(state: HomeState): void {
    this.state = state
    this.visible = true
    this.root.style.display = ''
    this.render()
  }

  hide(): void {
    this.closeDialog()
    this.visible = false
    this.root.style.display = 'none'
  }

  /** Re-renders in place, e.g. after a settings change. */
  refresh(state: HomeState): void {
    this.state = state
    if (this.visible) this.render()
  }

  isDialogOpen(): boolean {
    return this.dialog !== null
  }

  closeDialog(): void {
    if (this.dialog !== null) {
      this.dialog.remove()
      this.dialog = null
    }
  }

  private render(): void {
    const state = this.state
    if (state === null) return

    this.applyLayoutClass(state)
    this.applyBackground(state)
    this.root.replaceChildren()
    if (state.backgroundUrl !== null) this.root.append(el('div', 'home__scrim'))
    const inner = el('div', 'home__inner')

    inner.append(el('h1', 'home__title', '三消合成'))
    inner.append(el('p', 'home__subtitle', '凑三合一 · 越合越大'))

    // Two columns on a wide screen, one on a phone. Which of the two is used is
    // decided by CSS from the layout-mode class, so the switch visibly changes
    // the menu as well as the board.
    const body = el('div', 'home__body')
    const main = el('div', 'home__col')

    // Mode cards. Clicking a card either resumes a parked run or starts fresh.
    const modes = el('div', 'home__modes')
    for (const mode of state.modes) {
      const button = el('button', 'home__mode')
      button.append(el('span', 'home__mode-name', mode.name))

      const meta = el('span', 'home__mode-meta')
      const best = state.bestScores[mode.id] ?? 0
      meta.append(el('span', undefined, `最高 ${best}`))
      const parked = state.parked[mode.id]
      if (parked !== undefined) {
        meta.append(el('span', undefined, `上局 ${parked.score} 分 / ${parked.steps} 步`))
      }
      button.append(meta)

      if (parked !== undefined) {
        button.append(el('span', 'home__badge', '可继续'))
      }

      button.addEventListener('click', () => {
        if (state.parked[mode.id] !== undefined) {
          this.showResumeChooser(mode)
        } else {
          this.callbacks.onStartMode(mode.id)
        }
      })
      modes.append(button)
    }
    main.append(modes)

    const actions = el('div', 'home__actions')
    const settingsButton = el('button', undefined, '⚙  设置')
    settingsButton.addEventListener('click', () => this.callbacks.onOpenSettings())
    actions.append(settingsButton)
    main.append(actions)

    main.append(this.buildLayoutSwitch(state))

    body.append(main, this.buildLeaderboard(state))
    inner.append(body)
    this.root.append(inner)
  }

  /** Puts the current layout mode on the root so CSS can react to it. */
  private applyLayoutClass(state: HomeState): void {
    this.root.className = `home home--${state.settings.layoutMode}`
  }

  /**
   * Applies the theme background, if it provides one.
   *
   * The scrim is a sibling rather than a CSS filter so the text keeps full
   * contrast whatever colour the theme's artwork happens to be.
   */
  private applyBackground(state: HomeState): void {
    const url = state.backgroundUrl

    if (url === null) {
      this.root.style.backgroundImage = ''
      this.root.style.backgroundSize = ''
      this.root.style.backgroundPosition = ''
      return
    }

    this.root.style.backgroundImage = `url("${url}")`
    this.root.style.backgroundSize = 'cover'
    this.root.style.backgroundPosition = 'center'
  }

  /**
   * Desktop / mobile switch.
   *
   * The control lives here rather than only in the settings panel because a
   * player on a tablet or a resized window wants to fix the layout in one tap
   * without opening a dialog first.
   */
  private buildLayoutSwitch(state: HomeState): HTMLElement {
    const block = el('div', 'home__layout')
    block.append(el('span', 'home__layout-label', '界面布局'))

    const segments = el('div', 'home__segments')
    const options: Array<[LayoutMode, string]> = [
      ['auto', '自动'],
      ['desktop', '电脑版'],
      ['mobile', '手机版']
    ]

    for (const [value, label] of options) {
      const on = state.settings.layoutMode === value
      const button = el('button', on ? 'home__segment home__segment--on' : 'home__segment', label)
      button.type = 'button'
      if (on) button.setAttribute('aria-current', 'true')
      button.title =
        value === 'auto'
          ? '根据窗口宽度自动选择'
          : value === 'desktop'
            ? '固定使用电脑版（侧边栏）布局'
            : '固定使用手机版（单列）布局'
      button.addEventListener('click', () => {
        if (state.settings.layoutMode === value) return
        this.callbacks.onLayoutMode(value)
      })
      segments.append(button)
    }

    block.append(segments)

    // Spell out what the choice currently means. Without this the only feedback
    // is the highlight moving, which is easy to miss and says nothing about
    // what actually changes. "auto" is reported as the variant it resolves to,
    // so the player can tell what they are actually looking at.
    const note =
      state.settings.layoutMode === 'desktop'
        ? '电脑版 · 侧栏布局'
        : state.settings.layoutMode === 'mobile'
          ? '手机版 · 单列布局'
          : `自动 · 当前${window.innerWidth < MOBILE_BREAKPOINT ? '单列' : '侧栏'}`
    block.append(el('span', 'home__layout-note', note))
    return block
  }

  private buildLeaderboard(state: HomeState): HTMLElement {
    const board = el('div', 'home__board')
    board.append(el('h3', undefined, '排行榜'))

    const entries = state.leaderboard.slice(0, LEADERBOARD_VISIBLE)
    if (entries.length === 0) {
      board.append(el('div', 'home__empty', '还没有记录，完成一局就会出现在这里'))
      return board
    }

    entries.forEach((entry, index) => {
      const row = el('div', 'home__row')
      row.append(el('span', index === 0 ? 'home__rank home__rank--top' : 'home__rank', String(index + 1)))
      row.append(el('span', 'home__row-mode', entry.modeName))
      row.append(el('span', 'home__row-score', String(entry.score)))
      row.append(el('span', 'home__row-time', formatDuration(entry.durationMs)))
      board.append(row)
    })

    return board
  }

  /** Asks whether to continue the parked run or start over. */
  private showResumeChooser(mode: ModeConfig): void {
    const state = this.state
    if (state === null) return

    const parked = state.parked[mode.id]
    this.closeDialog()

    const overlay = el('div', 'hud__dialog')
    const panel = el('div', 'hud__panel hud__panel--compact')
    panel.append(el('h2', undefined, mode.name))

    const describe =
      parked === undefined
        ? '开始新的一局。'
        : `上局进行中：${parked.score} 分、${parked.steps} 步。`
    panel.append(el('p', undefined, describe))

    const actions = el('div', 'hud__actions')
    const restart = el('button', undefined, '重新开始')
    restart.addEventListener('click', () => {
      this.closeDialog()
      this.callbacks.onRestartMode(mode.id)
    })
    actions.append(restart)

    if (parked !== undefined) {
      const resume = el('button', 'primary', '继续上局')
      resume.addEventListener('click', () => {
        this.closeDialog()
        this.callbacks.onResumeMode(mode.id)
      })
      actions.append(resume)
    }

    panel.append(actions)
    overlay.append(panel)
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.closeDialog()
    })
    this.dialog = overlay
    // Deliberately appended to <body>, not to this.root: render() calls
    // replaceChildren() on the root, and a dialog living inside it was being
    // torn down by any re-render — including ones triggered asynchronously by
    // a theme finishing its image loads.
    document.body.append(overlay)
  }

  /** Host element for the shared settings panel, rendered by Hud. */
  openSettingsHost(render: (container: HTMLElement, close: () => void) => void): void {
    this.closeDialog()

    const overlay = el('div', 'hud__dialog')
    const container = el('div')
    render(container, () => {
      this.closeDialog()
      this.callbacks.onCloseSettings()
    })

    overlay.append(container)
    this.dialog = overlay
    // See the note in showResumeChooser: body, not root.
    document.body.append(overlay)
  }
}
