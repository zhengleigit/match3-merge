import { describe, expect, it } from 'vitest'
import {
  cellCentre,
  densityMultiplier,
  describeEvents,
  groupCentre,
  hueForLevel,
  type FxContext
} from '../src/core/fxMap'
import type { GameEvent } from '../src/core/types'

function ctx(overrides?: Partial<FxContext>): FxContext {
  return { density: 1, levelHues: [10, 20, 30, 40, 50], reducedMotion: false, ...overrides }
}

function totalParticles(events: readonly GameEvent[], context = ctx()): number {
  return describeEvents(events, context).particles.reduce((sum, p) => sum + p.count, 0)
}

describe('fxMap: helpers', () => {
  it('places a cell centre half a cell in', () => {
    expect(cellCentre(2, 3)).toEqual({ x: 2.5, y: 3.5 })
  })

  it('averages a consumed group into one centre', () => {
    expect(groupCentre([{ x: 0, y: 0 }, { x: 2, y: 0 }])).toEqual({ x: 1.5, y: 0.5 })
  })

  it('falls back safely for an empty group', () => {
    expect(groupCentre([])).toEqual({ x: 0, y: 0 })
  })

  it('cycles hues by level and clamps beyond the table', () => {
    expect(hueForLevel(1, [10, 20])).toBe(10)
    expect(hueForLevel(2, [10, 20])).toBe(20)
    expect(hueForLevel(9, [10, 20])).toBe(20)
    expect(hueForLevel(0, [10, 20])).toBe(200)
  })

  it('reads density multipliers from the config', () => {
    expect(densityMultiplier('low')).toBeLessThan(densityMultiplier('medium'))
    expect(densityMultiplier('high')).toBeGreaterThan(densityMultiplier('medium'))
  })
})

describe('fxMap: chain pitch ladder', () => {
  const chainOf = (steps: number): GameEvent[] =>
    Array.from({ length: steps }, (_, i) => ({
      type: 'merged' as const,
      x: 2,
      y: 2,
      chain: i + 1,
      consumed: 3,
      consumedCells: [
        { x: 0, y: 2 },
        { x: 1, y: 2 },
        { x: 2, y: 2 }
      ],
      fromLevel: i + 1,
      toLevel: i + 2,
      score: 3
    }))

  it('emits one merge sound per chain step', () => {
    const sounds = describeEvents(chainOf(4), ctx()).sounds.filter((s) => s.id === 'merge')
    expect(sounds).toHaveLength(4)
  })

  it('raises the pitch strictly with every chain step', () => {
    const sounds = describeEvents(chainOf(4), ctx()).sounds.filter((s) => s.id === 'merge')
    for (let i = 1; i < sounds.length; i++) {
      expect(sounds[i].semitone).toBeGreaterThan(sounds[i - 1].semitone)
    }
  })

  it('spaces the chain sounds out in time', () => {
    const sounds = describeEvents(chainOf(3), ctx()).sounds.filter((s) => s.id === 'merge')
    expect(sounds[0].delayMs).toBe(0)
    expect(sounds[1].delayMs).toBeGreaterThan(0)
    expect(sounds[2].delayMs).toBeGreaterThan(sounds[1].delayMs)
  })

  it('floats the score gained by each merge', () => {
    const floaters = describeEvents(chainOf(2), ctx()).floaters
    expect(floaters).toHaveLength(2)
    expect(floaters[0].text).toBe('+3')
  })
})

describe('fxMap: max-level clear is the loudest effect', () => {
  const merge: GameEvent = {
    type: 'merged',
    x: 2,
    y: 2,
    chain: 1,
    consumed: 3,
    consumedCells: [{ x: 0, y: 2 }],
    fromLevel: 1,
    toLevel: 2,
    score: 3
  }
  const maxClear: GameEvent = {
    type: 'maxCleared',
    x: 2,
    y: 2,
    level: 5,
    consumed: 3,
    consumedCells: [{ x: 0, y: 2 }],
    score: 24,
    bonus: 50
  }

  it('uses more particles than an ordinary merge', () => {
    expect(totalParticles([maxClear])).toBeGreaterThan(totalParticles([merge]))
  })

  it('shakes harder and longer than an ordinary merge', () => {
    const weak = describeEvents([merge], ctx()).shake
    const strong = describeEvents([maxClear], ctx()).shake

    expect(strong).not.toBeNull()
    expect(strong?.strength).toBeGreaterThan(weak?.strength ?? 0)
    expect(strong?.durationMs).toBeGreaterThan(weak?.durationMs ?? 0)
  })

  it('uses its own distinct sound rather than the merge sound', () => {
    const sounds = describeEvents([maxClear], ctx()).sounds
    expect(sounds.map((s) => s.id)).toContain('maxClear')
    expect(sounds.map((s) => s.id)).not.toContain('merge')
  })

  it('floats the combined score plus bonus', () => {
    const floaters = describeEvents([maxClear], ctx()).floaters
    expect(floaters[0].text).toBe('+74') // 3 x 8 + 50
    expect(floaters[0].tone).toBe('bonus')
  })
})

describe('fxMap: invalid moves are audio only', () => {
  it('produces a sound but no particles and no shake', () => {
    const fx = describeEvents([{ type: 'invalid', reason: 'cell-occupied' }], ctx())

    expect(fx.particles).toHaveLength(0)
    expect(fx.shake).toBeNull()
    expect(fx.floaters).toHaveLength(0)
    expect(fx.sounds.map((s) => s.id)).toEqual(['invalid'])
  })

  it('never turns an invalid move into a louder effect when batched', () => {
    const events: GameEvent[] = [
      { type: 'invalid', reason: 'cell-occupied' },
      { type: 'invalid', reason: 'buffer-full' }
    ]
    const fx = describeEvents(events, ctx())
    expect(fx.particles).toHaveLength(0)
    expect(fx.sounds).toHaveLength(2)
  })
})

describe('fxMap: density and reduced motion', () => {
  const merge: GameEvent = {
    type: 'merged',
    x: 1,
    y: 1,
    chain: 1,
    consumed: 3,
    consumedCells: [{ x: 1, y: 1 }],
    fromLevel: 2,
    toLevel: 3,
    score: 6
  }

  it('scales particle counts with the density setting', () => {
    const low = totalParticles([merge], ctx({ density: densityMultiplier('low') }))
    const medium = totalParticles([merge], ctx({ density: densityMultiplier('medium') }))
    const high = totalParticles([merge], ctx({ density: densityMultiplier('high') }))

    expect(low).toBeLessThan(medium)
    expect(high).toBeGreaterThan(medium)
  })

  it('suppresses particles and shake but keeps the sound under reduced motion', () => {
    const fx = describeEvents([merge], ctx({ reducedMotion: true }))

    expect(fx.particles).toHaveLength(0)
    expect(fx.shake).toBeNull()
    expect(fx.sounds.map((s) => s.id)).toContain('merge')
  })

  it('skips a burst entirely when the scaled count rounds to zero', () => {
    const fx = describeEvents([{ type: 'placed', x: 0, y: 0, level: 1 }], ctx({ density: 0.01 }))
    expect(fx.particles).toHaveLength(0)
  })
})

describe('fxMap: merge collapse animation data', () => {
  const merge: GameEvent = {
    type: 'merged',
    x: 3,
    y: 2,
    chain: 2,
    consumed: 3,
    consumedCells: [
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 }
    ],
    fromLevel: 2,
    toLevel: 3,
    score: 6
  }
  const maxClear: GameEvent = {
    type: 'maxCleared',
    x: 3,
    y: 2,
    level: 5,
    consumed: 3,
    consumedCells: [
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 }
    ],
    score: 24,
    bonus: 50
  }

  it('reports every consumed block and the target cell for a merge', () => {
    const burst = describeEvents([merge], ctx()).mergeBursts
    expect(burst).toHaveLength(1)
    expect(burst[0].cells).toHaveLength(3)
    expect(burst[0].target).toEqual({ x: 3, y: 2 })
    expect(burst[0].toLevel).toBe(3)
    expect(burst[0].big).toBe(false)
  })

  it('marks a max-level clear as big with no created block', () => {
    const burst = describeEvents([maxClear], ctx()).mergeBursts
    expect(burst).toHaveLength(1)
    expect(burst[0].big).toBe(true)
    expect(burst[0].toLevel).toBe(0)
    expect(burst[0].target).toEqual({ x: 3, y: 2 })
  })

  it('emits one burst per chain step', () => {
    const chain: GameEvent[] = [1, 2, 3].map((step) => ({
      type: 'merged' as const,
      x: 2,
      y: 2,
      chain: step,
      consumed: 3,
      consumedCells: [{ x: 2, y: 2 }],
      fromLevel: step,
      toLevel: step + 1,
      score: 3
    }))
    expect(describeEvents(chain, ctx()).mergeBursts).toHaveLength(3)
  })

  it('produces no burst for events that consume nothing', () => {
    const events: GameEvent[] = [
      { type: 'placed', x: 0, y: 0, level: 1 },
      { type: 'toBuffer', level: 1, slot: 0 },
      { type: 'spawned', level: 1 },
      { type: 'invalid', reason: 'cell-occupied' },
      { type: 'obstacleSpawned', x: 1, y: 1 },
      { type: 'obstacleHit', x: 1, y: 1 },
      { type: 'obstacleCleared', x: 1, y: 1, bonus: 1 },
      { type: 'undo' },
      { type: 'restarted' }
    ]
    expect(describeEvents(events, ctx()).mergeBursts).toHaveLength(0)
  })

  it('keeps the burst data even when particles are suppressed', () => {
    // Reduced motion removes particles and shake but the collapse is the
    // clearest read of "these blocks became that one", so it stays.
    const fx = describeEvents([merge], ctx({ reducedMotion: true }))
    expect(fx.particles).toHaveLength(0)
    expect(fx.shake).toBeNull()
    expect(fx.mergeBursts).toHaveLength(1)
  })
})

describe('fxMap: obstacles and other events', () => {
  it('reports obstacle spawn, damage and clear distinctly', () => {
    const spawn = describeEvents([{ type: 'obstacleSpawned', x: 3, y: 4 }], ctx())
    const hit = describeEvents([{ type: 'obstacleHit', x: 3, y: 4 }], ctx())
    const cleared = describeEvents([{ type: 'obstacleCleared', x: 3, y: 4, bonus: 1 }], ctx())

    expect(spawn.sounds.map((s) => s.id)).toEqual(['obstacleSpawn'])
    expect(hit.sounds.map((s) => s.id)).toEqual(['obstacleCrack'])
    expect(cleared.sounds.map((s) => s.id)).toEqual(['obstacleBreak'])
    expect(cleared.floaters[0].text).toBe('+1')
  })

  it('does not announce a score for an obstacle that only cracked', () => {
    // The bonus belongs to the destruction, and a "+1" for chipping would
    // promise points the player never received.
    const hit = describeEvents([{ type: 'obstacleHit', x: 3, y: 4 }], ctx())
    expect(hit.floaters).toHaveLength(0)
    expect(hit.particles.length).toBeGreaterThan(0)
  })

  it('never produces a tracer unless something is being shot at', () => {
    const events: GameEvent[] = [
      { type: 'placed', x: 0, y: 0, level: 1 },
      { type: 'obstacleHit', x: 1, y: 1 },
      { type: 'obstacleCleared', x: 1, y: 1, bonus: 1 },
      { type: 'pacmanAte', x: 1, y: 1, from: { x: 0, y: 0 }, path: [], level: 5, heal: 8, hp: 9, fromCage: true }
    ]
    expect(describeEvents(events, ctx()).tracers).toHaveLength(0)
  })

  it('makes the crack a smaller effect than the break', () => {
    const hit = describeEvents([{ type: 'obstacleHit', x: 3, y: 4 }], ctx())
    const cleared = describeEvents([{ type: 'obstacleCleared', x: 3, y: 4, bonus: 1 }], ctx())

    expect(hit.particles[0].count).toBeLessThan(cleared.particles[0].count)
  })

  it('maps buffer, spawn, undo, win and game over to their own sounds', () => {
    const cases: Array<[GameEvent, string]> = [
      [{ type: 'toBuffer', level: 1, slot: 0 }, 'pick'],
      [{ type: 'spawned', level: 1 }, 'spawn'],
      [{ type: 'placed', x: 0, y: 0, level: 1 }, 'place'],
      [{ type: 'undo' }, 'undo'],
      [{ type: 'win', level: 10, score: 500 }, 'win'],
      [{ type: 'gameOver', score: 120 }, 'gameOver']
    ]

    for (const [event, expected] of cases) {
      const sounds = describeEvents([event], ctx()).sounds.map((s) => s.id)
      expect(sounds).toContain(expected)
    }
  })

  it('produces nothing for a restart', () => {
    const fx = describeEvents([{ type: 'restarted' }], ctx())
    expect(fx.sounds).toHaveLength(0)
    expect(fx.particles).toHaveLength(0)
  })
})

describe('fxMap: the merge shoots the boss', () => {
  const wound: GameEvent = {
    type: 'pacmanHurt',
    // Damage lands on the boss...
    x: 3,
    y: 2,
    // ...and comes from the merge at (0, 5).
    srcX: 0,
    srcY: 5,
    amount: 9,
    hp: 31
  }

  it('fires a volley from the merge cell to the boss', () => {
    const fx = describeEvents([wound], ctx())
    expect(fx.tracers).toHaveLength(1)

    const shot = fx.tracers[0]
    // Both ends are cell centres, so the streaks line up at any zoom level.
    expect(shot.from).toEqual({ x: 0.5, y: 5.5 })
    expect(shot.to).toEqual({ x: 3.5, y: 2.5 })
    expect(shot.count).toBeGreaterThan(0)
    expect(shot.durationMs).toBeGreaterThan(0)
  })

  it('keeps the impact burst and the damage number on the boss', () => {
    const fx = describeEvents([wound], ctx())
    // The burst is what says "it got hit", so it must not be moved to the
    // source cell along with the volley.
    expect(fx.particles.length).toBeGreaterThan(0)
    expect(fx.particles[0].x).toBeCloseTo(3.5, 6)
    expect(fx.floaters[0].text).toBe('-9')
    expect(fx.floaters[0].tone).toBe('damage')
  })

  it('scales the volley with the particle density setting', () => {
    const low = describeEvents([wound], ctx({ density: 0.5 })).tracers[0]
    const high = describeEvents([wound], ctx({ density: 1.6 })).tracers[0]
    expect(high.count).toBeGreaterThan(low.count)
  })

  it('suppresses the volley under reduced motion', () => {
    // A streak flying across the board is exactly the kind of motion that
    // setting exists to remove, but the damage number must survive.
    const fx = describeEvents([wound], ctx({ reducedMotion: true }))
    expect(fx.tracers).toHaveLength(0)
    expect(fx.floaters[0].text).toBe('-9')
  })

  it('shows being shrugged off differently from being hit', () => {
    // Same position, opposite meaning: a merge that did nothing must not look
    // like a merge that landed, or the player cannot tell the cage blocks them.
    const immune = describeEvents(
      [{ type: 'pacmanImmune', x: 3, y: 2, srcX: 0, srcY: 5 }],
      ctx()
    )

    // No volley: nothing flew anywhere, because nothing happened.
    expect(immune.tracers).toHaveLength(0)
    expect(immune.floaters[0].text).toBe('无敌')
    expect(immune.floaters[0].tone).toBe('immune')
    // Still some visual, or the move would look broken.
    expect(immune.particles.length).toBeGreaterThan(0)
    // The shield pulse lands on the boss.
    expect(immune.particles[0].x).toBeCloseTo(3.5, 6)
    expect(immune.sounds.map((s) => s.id)).toEqual(['invalid'])
  })
})

describe('fxMap: particle budget', () => {
  it('keeps a large burst inside the configured maximum', () => {
    const events: GameEvent[] = Array.from({ length: 20 }, () => ({
      type: 'maxCleared' as const,
      x: 3,
      y: 3,
      level: 5,
      consumed: 3,
      consumedCells: [{ x: 3, y: 3 }],
      score: 24,
      bonus: 50
    }))

    const fx = describeEvents(events, ctx({ density: densityMultiplier('high') }))
    const total = fx.particles.reduce((sum, p) => sum + p.count, 0)

    expect(total).toBeLessThanOrEqual(512)
    expect(total).toBeGreaterThan(0)
  })
})
