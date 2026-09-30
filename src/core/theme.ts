import type { ThemeEntry } from './types'

/**
 * Theme resolution.
 *
 * Pure string handling only — no Image, no fetch. The view turns the resolved
 * paths into actual assets. Keeping it pure means slot names, fallback rules
 * and validation are unit-testable.
 *
 * Fallback is two-level:
 *   slot is null / missing  -> procedural drawing
 *   file exists but fails   -> procedural drawing (view reports the failure)
 * So a broken or partial theme can never produce a blank screen.
 */

export const SLOT = {
  pageBackground: 'page.background',
  boardBackground: 'board.background',
  /** Background of the home screen. Same cover-fill rules as the page one. */
  homeBackground: 'home.background',
  obstacle: 'obstacle',
  /** Obstacle that already took a hit; falls back to `obstacle` when absent. */
  obstacleCracked: 'obstacle.cracked',
  slotBuffer: 'slot.buffer',
  slotNext: 'slot.next',
  slotCellFrame: 'slot.cellFrame',
  slotHighlight: 'slot.highlight'
} as const

export function blockSlot(level: number): string {
  return `block.level${level}`
}

export function soundSlot(id: string): string {
  return `sfx.${id}`
}

const KNOWN_SLOT = /^(?:block\.level(?:10|[1-9])|page\.background|board\.background|home\.background|obstacle(?:\.cracked)?|slot\.(?:buffer|next|cellFrame|highlight)|sfx\.[A-Za-z]+)$/

export function isKnownSlot(slot: string): boolean {
  return KNOWN_SLOT.test(slot)
}

export interface ThemeDefinition {
  id: string
  name: string
  /** Extra scale applied to block sprites, 1 = fill the cell. */
  blockScale: number
  /** Fraction of the cell kept as padding around a block. */
  padding: number
  /** slot name -> path relative to the theme directory (null = not provided). */
  slots: Record<string, string>
}

export interface ThemeParseResult {
  theme: ThemeDefinition
  /** Non-fatal problems, e.g. unknown slot names. Surfaced once in the console. */
  warnings: string[]
}

const DEFAULT_BLOCK_SCALE = 1
const DEFAULT_PADDING = 0.08

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Normalises a parsed theme.json. Throws only when the payload is unusable;
 * unknown or null slots degrade to "procedural" instead of failing.
 */
export function parseTheme(raw: unknown, fallbackId: string): ThemeParseResult {
  if (!isRecord(raw)) {
    throw new Error('[theme] theme.json must contain an object')
  }

  const warnings: string[] = []
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id

  const slots: Record<string, string> = {}
  const rawSlots = raw.slots

  if (rawSlots !== undefined && !isRecord(rawSlots)) {
    throw new Error(`[theme:${id}] "slots" must be an object`)
  }

  if (isRecord(rawSlots)) {
    for (const [slot, value] of Object.entries(rawSlots)) {
      if (!isKnownSlot(slot)) {
        warnings.push(`unknown slot "${slot}" ignored`)
        continue
      }
      if (value === null) continue
      if (typeof value !== 'string' || value.length === 0) {
        warnings.push(`slot "${slot}" is not a non-empty string; falling back to procedural`)
        continue
      }
      if (value.startsWith('/') || /^[a-z]+:/i.test(value)) {
        warnings.push(
          `slot "${slot}" must use a relative path (got "${value}"); falling back to procedural`
        )
        continue
      }
      slots[slot] = value
    }
  }

  return {
    theme: {
      id,
      name,
      blockScale: positiveOr(raw.blockScale, DEFAULT_BLOCK_SCALE),
      padding: positiveOr(raw.padding, DEFAULT_PADDING),
      slots
    },
    warnings
  }
}

/** Procedural theme: nothing is provided, everything is drawn by code. */
export function proceduralTheme(id = 'default', name = '默认（程序化绘制）'): ThemeDefinition {
  return { id, name, blockScale: DEFAULT_BLOCK_SCALE, padding: DEFAULT_PADDING, slots: {} }
}

/**
 * Full relative path for a slot, or null when the theme does not supply it.
 * Paths stay relative so a packed build (Electron / Tauri / Capacitor) can
 * resolve them against the document base.
 */
export function slotPath(theme: ThemeDefinition, dir: string, slot: string): string | null {
  const value = theme.slots[slot]
  if (value === undefined) return null
  return `${dir}/${value}`
}

export function blockPath(
  theme: ThemeDefinition,
  dir: string,
  level: number
): string | null {
  return slotPath(theme, dir, blockSlot(level))
}

export function hasAnySprite(theme: ThemeDefinition): boolean {
  return Object.keys(theme.slots).some((slot) => !slot.startsWith('sfx.'))
}

export function findThemeEntry(entries: readonly ThemeEntry[], id: string): ThemeEntry | null {
  return entries.find((entry) => entry.id === id) ?? null
}

/** Falls back to the first entry so a stale saved theme id cannot break boot. */
export function resolveThemeEntry(
  entries: readonly ThemeEntry[],
  id: string | null
): ThemeEntry {
  if (entries.length === 0) throw new Error('[theme] no themes configured')
  if (id !== null) {
    const found = findThemeEntry(entries, id)
    if (found !== null) return found
  }
  return entries[0]
}

/** Image slots for a mode: the levels actually reachable, in order. */
export function blockSlotsForLevels(levelCount: number): string[] {
  const slots: string[] = []
  for (let level = 1; level <= levelCount; level++) slots.push(blockSlot(level))
  return slots
}
