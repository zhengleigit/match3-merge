import { describe, expect, it } from 'vitest'
import {
  SLOT,
  blockPath,
  blockSlot,
  blockSlotsForLevels,
  hasAnySprite,
  isKnownSlot,
  parseTheme,
  proceduralTheme,
  resolveThemeEntry,
  slotPath,
  soundSlot
} from '../src/core/theme'
import type { ThemeEntry } from '../src/core/types'

const entries: ThemeEntry[] = [
  { id: 'default', name: 'Default', dir: 'themes/default', description: '' },
  { id: 'example', name: 'Example', dir: 'themes/example', description: '' }
]

describe('theme: slot names', () => {
  it('builds block and sound slot names', () => {
    expect(blockSlot(1)).toBe('block.level1')
    expect(blockSlot(10)).toBe('block.level10')
    expect(soundSlot('merge')).toBe('sfx.merge')
  })

  it('recognises exactly the documented slots', () => {
    expect(isKnownSlot('block.level1')).toBe(true)
    expect(isKnownSlot('block.level10')).toBe(true)
    expect(isKnownSlot('block.level11')).toBe(false)
    expect(isKnownSlot('page.background')).toBe(true)
    expect(isKnownSlot('board.background')).toBe(true)
    expect(isKnownSlot('obstacle')).toBe(true)
    expect(isKnownSlot('obstacle.cracked')).toBe(true)
    expect(isKnownSlot('obstacle.crumbled')).toBe(false)
    expect(isKnownSlot('slot.buffer')).toBe(true)
    expect(isKnownSlot('slot.next')).toBe(true)
    expect(isKnownSlot('slot.cellFrame')).toBe(true)
    expect(isKnownSlot('slot.highlight')).toBe(true)
    expect(isKnownSlot('sfx.merge')).toBe(true)
    expect(isKnownSlot('sfx.anythingGoes')).toBe(true)
    expect(isKnownSlot('nonsense')).toBe(false)
  })

  it('lists slots for the levels a mode can reach', () => {
    expect(blockSlotsForLevels(3)).toEqual(['block.level1', 'block.level2', 'block.level3'])
  })
})

describe('theme: parsing', () => {
  it('reads a well-formed theme', () => {
    const { theme, warnings } = parseTheme(
      {
        id: 'example',
        name: '示例',
        blockScale: 0.9,
        padding: 0.12,
        slots: { 'block.level1': 'blocks/1.svg', 'sfx.merge': 'audio/merge.wav' }
      },
      'fallback'
    )

    expect(warnings).toEqual([])
    expect(theme.id).toBe('example')
    expect(theme.name).toBe('示例')
    expect(theme.blockScale).toBe(0.9)
    expect(theme.padding).toBe(0.12)
    expect(theme.slots['block.level1']).toBe('blocks/1.svg')
  })

  it('treats a null slot as "not provided" rather than an error', () => {
    const { theme, warnings } = parseTheme(
      { id: 'x', slots: { 'block.level1': null, 'block.level2': 'b2.svg' } },
      'x'
    )

    expect(warnings).toEqual([])
    expect(theme.slots['block.level1']).toBeUndefined()
    expect(theme.slots['block.level2']).toBe('b2.svg')
  })

  it('ignores unknown slots and reports them', () => {
    const { theme, warnings } = parseTheme(
      { id: 'x', slots: { 'block.level1': 'a.svg', 'block.level11': 'b.svg', bogus: 'c.svg' } },
      'x'
    )

    expect(theme.slots['block.level1']).toBe('a.svg')
    expect(theme.slots['block.level11']).toBeUndefined()
    expect(theme.slots.bogus).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })

  it('rejects absolute and scheme-qualified paths so packed builds keep working', () => {
    const { theme, warnings } = parseTheme(
      { id: 'x', slots: { 'block.level1': '/abs/a.svg', 'block.level2': 'file:///b.svg' } },
      'x'
    )

    expect(theme.slots['block.level1']).toBeUndefined()
    expect(theme.slots['block.level2']).toBeUndefined()
    expect(warnings).toHaveLength(2)
  })

  it('reports a non-string slot value and falls back for that slot only', () => {
    const { theme, warnings } = parseTheme(
      { id: 'x', slots: { 'block.level1': 42, 'block.level2': 'b.svg' } },
      'x'
    )

    expect(theme.slots['block.level1']).toBeUndefined()
    expect(theme.slots['block.level2']).toBe('b.svg')
    expect(warnings).toHaveLength(1)
  })

  it('falls back for missing/invalid id and name', () => {
    const { theme } = parseTheme({ slots: {} }, 'fallback-id')
    expect(theme.id).toBe('fallback-id')
    expect(theme.name).toBe('fallback-id')
  })

  it('defaults invalid scale and padding', () => {
    const { theme } = parseTheme({ id: 'x', blockScale: -1, padding: 0, slots: {} }, 'x')
    expect(theme.blockScale).toBe(1)
    expect(theme.padding).toBe(0.08)
  })

  it('throws only when the payload is unusable', () => {
    expect(() => parseTheme(null, 'x')).toThrow()
    expect(() => parseTheme('nope', 'x')).toThrow()
    expect(() => parseTheme({ id: 'x', slots: 'nope' }, 'x')).toThrow()
  })
})

describe('theme: paths', () => {
  const theme = parseTheme(
    { id: 'x', slots: { 'block.level2': 'blocks/2.svg', 'board.background': 'board.svg' } },
    'x'
  ).theme

  it('resolves a slot to a path relative to the theme directory', () => {
    expect(slotPath(theme, 'themes/x', 'block.level2')).toBe('themes/x/blocks/2.svg')
    expect(blockPath(theme, 'themes/x', 2)).toBe('themes/x/blocks/2.svg')
  })

  it('returns null for slots the theme does not provide', () => {
    expect(slotPath(theme, 'themes/x', 'block.level5')).toBeNull()
    expect(blockPath(theme, 'themes/x', 5)).toBeNull()
    expect(slotPath(theme, 'themes/x', SLOT.obstacle)).toBeNull()
  })

  it('detects whether a theme provides any sprite at all', () => {
    expect(hasAnySprite(theme)).toBe(true)
    expect(hasAnySprite(proceduralTheme())).toBe(false)
  })

  it('gives the procedural theme no slots so everything is drawn by code', () => {
    const procedural = proceduralTheme('default', '默认')
    expect(procedural.slots).toEqual({})
    expect(hasAnySprite(procedural)).toBe(false)
  })
})

describe('theme: entry resolution', () => {
  it('finds a theme by id', () => {
    expect(resolveThemeEntry(entries, 'example').id).toBe('example')
  })

  it('falls back to the first entry for an unknown or absent id', () => {
    expect(resolveThemeEntry(entries, 'deleted-theme').id).toBe('default')
    expect(resolveThemeEntry(entries, null).id).toBe('default')
  })

  it('throws when nothing is configured', () => {
    expect(() => resolveThemeEntry([], 'default')).toThrow()
  })
})
