import rawFx from '../data/fx.json'
import rawSfx from '../data/sfx.json'
import type { GameEvent, ParticleDensity, Pos } from './types'

/**
 * Pure mapping from rules events to presentation instructions.
 *
 * Deliberately DOM-free: the rules layer emits events, this turns them into
 * "what should happen on screen", and the view executes it. Keeping the
 * mapping pure means rules like "a chain plays an ascending ladder" or "a
 * max-level clear is the loudest effect" are unit-testable instead of being
 * buried in a render loop.
 *
 * Coordinates in descriptors are BOARD-CELL space (floats allowed); the
 * renderer converts them to pixels.
 */

// ---------------------------------------------------------------------------
// Descriptor types
// ---------------------------------------------------------------------------

export type SoundId =
  | 'pick'
  | 'spawn'
  | 'place'
  | 'merge'
  | 'maxClear'
  | 'obstacleSpawn'
  | 'obstacleCrack'
  | 'obstacleBreak'
  | 'pacmanEat'
  | 'pacmanBite'
  | 'pacmanHurt'
  | 'pacmanExit'
  | 'pacmanDefeat'
  | 'invalid'
  | 'undo'
  | 'win'
  | 'gameOver'

export interface ParticleSpec {
  /** Cell-space centre. */
  x: number
  y: number
  count: number
  speedMin: number
  speedMax: number
  lifeMinMs: number
  lifeMaxMs: number
  sizeMin: number
  sizeMax: number
  gravity: number
  hue: number
  additive: boolean
  /** Also draw one expanding ring at this position. */
  ring: boolean
}

export interface ShakeSpec {
  strength: number
  durationMs: number
}

export type FloaterTone = 'score' | 'bonus' | 'chain' | 'heal' | 'damage' | 'immune'

export interface FloaterSpec {
  x: number
  y: number
  text: string
  tone: FloaterTone
}

/**
 * Blocks that were consumed by a merge, plus where the new block lands.
 *
 * Carried as data (board-cell space) so the view can play "the used blocks
 * swell, flash, then collapse into the new one" without the rules layer
 * knowing anything about animation.
 */
export interface MergeBurstSpec {
  /** Positions of the consumed blocks. */
  cells: Pos[]
  /** Cell the replacement block occupies. */
  target: Pos
  /** Level of the created block; 0 for a max-level clear (nothing created). */
  toLevel: number
  /** True for a max-level clear, which gets a longer, larger animation. */
  big: boolean
}

export interface SoundSpec {
  id: SoundId
  /** Semitones above the preset base frequency. */
  semitone: number
  /** Relative gain multiplier. */
  gain: number
  /** Delay before playback, used to space out a chain ladder. */
  delayMs: number
}

export interface FxDescriptor {
  particles: ParticleSpec[]
  shake: ShakeSpec | null
  floaters: FloaterSpec[]
  sounds: SoundSpec[]
  mergeBursts: MergeBurstSpec[]
  tracers: TracerSpec[]
}

/**
 * A volley that travels from one cell to another.
 *
 * Board-space on both ends, so the view converts them the same way it converts
 * a burst centre and the effect lines up at every zoom level.
 */
export interface TracerSpec {
  from: Pos
  to: Pos
  count: number
  durationMs: number
  hue: number
  sizeMin: number
  sizeMax: number
  /** Radius of the starting disc, in board cells. */
  spreadPx: number
}

export interface FxContext {
  /** Particle count multiplier from the player's density setting. */
  density: number
  /** Hue per level, index 0 = level 1. */
  levelHues: readonly number[]
  /** When true (prefers-reduced-motion) particles and shake are suppressed. */
  reducedMotion: boolean
  /**
   * Battle mode: the boss's cell, so its own effects land on it.
   * Optional so every existing call site keeps working.
   */
  boss?: Pos
}

// ---------------------------------------------------------------------------
// Preset loading
// ---------------------------------------------------------------------------

interface EventPreset {
  count: number
  countPerLevel?: number
  speed: [number, number]
  lifeMs: [number, number]
  size: [number, number]
  gravity: number
  ring: boolean
  ringFromLevel?: number
  additive: boolean
  shake: [number, number]
}

interface FxConfig {
  maxParticles: number
  densityMultipliers: Record<ParticleDensity, number>
  levelHues: number[]
  shake: { maxOffsetPx: number; maxDurationMs: number }
  events: Record<string, EventPreset>
  /** Projectile defaults, shared by every tracer effect. */
  tracers: { count: number; durationMs: number; size: [number, number]; spread: number }
}

interface SfxConfig {
  master: { maxVoices: number; retriggerWindowMs: number; retriggerGainFalloff: number }
  chain: { semitonePerChain: number; delayMs: number; maxSteps: number }
  sounds: Record<string, SoundPreset>
}

export interface SoundPreset {
  wave: 'sine' | 'triangle' | 'square' | 'sawtooth' | 'noise'
  freq: number
  durationMs: number
  attackMs: number
  gain: number
  sweepTo: number
  noise: boolean
  noiseGain?: number
  arpeggio?: number[]
}

export const fxConfig = rawFx as unknown as FxConfig
export const sfxConfig = rawSfx as unknown as SfxConfig

export function densityMultiplier(
  density: ParticleDensity,
  config: FxConfig = fxConfig
): number {
  return config.densityMultipliers[density] ?? 1
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hueForLevel(level: number, hues: readonly number[] = fxConfig.levelHues): number {
  if (level <= 0 || hues.length === 0) return 200
  return hues[(Math.min(level, hues.length) - 1) % hues.length]
}

/** Centre of a cell in board-space, so bursts emanate from the middle. */
export function cellCentre(x: number, y: number): { x: number; y: number } {
  return { x: x + 0.5, y: y + 0.5 }
}

/** Average position of a consumed group; used when a cluster spans cells. */
export function groupCentre(cells: readonly Pos[]): { x: number; y: number } {
  if (cells.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (let i = 0; i < cells.length; i++) {
    sx += cells[i].x
    sy += cells[i].y
  }
  return { x: sx / cells.length + 0.5, y: sy / cells.length + 0.5 }
}

function empty(): FxDescriptor {
  return { particles: [], shake: null, floaters: [], sounds: [], mergeBursts: [], tracers: [] }
}

function burstFrom(
  preset: EventPreset,
  centre: { x: number; y: number },
  hue: number,
  countOverride?: number
): ParticleSpec {
  return {
    x: centre.x,
    y: centre.y,
    count: countOverride ?? preset.count,
    speedMin: preset.speed[0],
    speedMax: preset.speed[1],
    lifeMinMs: preset.lifeMs[0],
    lifeMaxMs: preset.lifeMs[1],
    sizeMin: preset.size[0],
    sizeMax: preset.size[1],
    gravity: preset.gravity,
    hue,
    additive: preset.additive,
    ring: preset.ring
  }
}

function shakeFrom(preset: EventPreset): ShakeSpec | null {
  const [strength, durationMs] = preset.shake
  if (strength <= 0 || durationMs <= 0) return null
  return { strength, durationMs }
}

function sound(id: SoundId, semitone = 0, gain = 1, delayMs = 0): SoundSpec {
  return { id, semitone, gain, delayMs }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Converts a batch of rules events into one descriptor.
 *
 * Invariants that tests pin down:
 *  - a chain of k merges produces k `merge` sounds with strictly rising pitch
 *  - a max-level clear is always the largest particle burst and the strongest shake
 *  - an invalid move produces a sound but never any particles
 *  - reduced motion yields no particles and no shake (sound still plays)
 */
export function describeEvents(
  events: readonly GameEvent[],
  ctx: FxContext,
  config: FxConfig = fxConfig
): FxDescriptor {
  const out = empty()
  const presetOf = (name: string): EventPreset | undefined => config.events[name]
  // Reduced motion removes the flight as well as the sparkle: a moving streak is
  // exactly the kind of effect that setting exists to suppress. The impact burst
  // and the damage number still land, so the feedback is not lost.
  const density = ctx.reducedMotion ? 0 : ctx.density
  const scale = (count: number): number => Math.round(count * density)

  const pushBurst = (spec: ParticleSpec): void => {
    if (spec.count > 0) out.particles.push(spec)
  }

  let lastShake: ShakeSpec | null = null
  const pushShake = (spec: ShakeSpec | null): void => {
    // Reduced motion disables screen shake as well as particles.
    if (spec === null || ctx.reducedMotion) return
    const clamped: ShakeSpec = {
      strength: Math.min(1, spec.strength),
      durationMs: Math.min(spec.durationMs, config.shake.maxDurationMs)
    }
    if (lastShake === null || clamped.strength > lastShake.strength) lastShake = clamped
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]

    switch (event.type) {
      case 'placed': {
        const preset = presetOf('placed')
        if (preset !== undefined) {
          const centre = cellCentre(event.x, event.y)
          pushBurst(
            burstFrom(
              preset,
              centre,
              hueForLevel(event.level, ctx.levelHues),
              scale(preset.count)
            )
          )
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('place'))
        break
      }

      case 'merged': {
        const preset = presetOf('merged')
        const hue = hueForLevel(event.toLevel, ctx.levelHues)
        if (preset !== undefined) {
          const centre = groupCentre(event.consumedCells)
          const base = preset.count + (preset.countPerLevel ?? 0) * event.toLevel
          const spec = burstFrom(preset, centre, hue, scale(base))
          // Rings only start mattering from a mid-tier merge upward.
          spec.ring = preset.ring && event.toLevel >= (preset.ringFromLevel ?? 1)
          pushBurst(spec)
          pushShake(shakeFrom(preset))
        }

        // Pitch ladder: chain step + created level.
        const chainStep = Math.min(event.chain - 1, sfxConfig.chain.maxSteps)
        const semitone = chainStep * sfxConfig.chain.semitonePerChain + (event.toLevel - 2)
        out.sounds.push(
          sound('merge', semitone, 1, chainStep * sfxConfig.chain.delayMs)
        )

        out.floaters.push({
          x: event.x,
          y: event.y,
          text: `+${event.score}`,
          tone: 'score'
        })
        out.mergeBursts.push({
          cells: event.consumedCells,
          target: { x: event.x, y: event.y },
          toLevel: event.toLevel,
          big: false
        })
        break
      }

      case 'maxCleared': {
        const preset = presetOf('maxCleared')
        if (preset !== undefined) {
          const centre = groupCentre(event.consumedCells)
          pushBurst(
            burstFrom(
              preset,
              centre,
              hueForLevel(event.level, ctx.levelHues),
              scale(preset.count)
            )
          )
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('maxClear'))
        out.floaters.push({
          x: event.x,
          y: event.y,
          text: `+${event.score + event.bonus}`,
          tone: 'bonus'
        })
        // Nothing is created in its place, so the burst collapses onto the
        // cleared cluster's own centre.
        out.mergeBursts.push({
          cells: event.consumedCells,
          target: { x: event.x, y: event.y },
          toLevel: 0,
          big: true
        })
        break
      }

      case 'pacmanAte': {
        // Two bursts: one where the block was, one at the boss, so the eye can
        // follow "that block went into it". The event's own x/y is where the
        // boss ends up, so there is no need to be told separately where it is.
        const at = cellCentre(event.x, event.y)
        const preset = presetOf('pacmanAte')
        if (preset !== undefined) {
          pushBurst(burstFrom(preset, at, 44, scale(preset.count)))
          pushBurst(burstFrom(preset, at, 44, scale(preset.count * 0.5)))
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound(event.fromCage ? 'pacmanEat' : 'pacmanBite'))
        if (event.heal > 0) {
          out.floaters.push({ x: event.x, y: event.y, text: `+${event.heal}`, tone: 'heal' })
        }
        break
      }

      case 'pacmanExited': {
        const preset = presetOf('pacmanExited')
        if (preset !== undefined) {
          pushBurst(burstFrom(preset, cellCentre(event.x, event.y), 20, scale(preset.count)))
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('pacmanExit'))
        break
      }

      case 'pacmanImmune': {
        // A shield pulse on the boss plus a plain word. It has to be visibly
        // different from a hit: same position, opposite meaning.
        const preset = presetOf('pacmanImmune')
        if (preset !== undefined) {
          pushBurst(burstFrom(preset, cellCentre(event.x, event.y), 210, scale(preset.count)))
        }
        out.sounds.push(sound('invalid'))
        out.floaters.push({ x: event.x, y: event.y, text: '无敌', tone: 'immune' })
        break
      }

      case 'pacmanHurt': {
        const preset = presetOf('pacmanHurt')
        if (preset !== undefined) {
          // The merge SHOOTS the boss: a volley leaves the merged cell and flies
          // to it, then a burst lands on impact. Without the flight the wound
          // reads as unrelated to the move that caused it.
          const shot = config.tracers
          const count = scale(shot.count)
          if (count > 0) {
            out.tracers.push({
              from: cellCentre(event.srcX, event.srcY),
              to: cellCentre(event.x, event.y),
              count,
              durationMs: shot.durationMs,
              // A hot red-orange, matching the damage number's tone.
              hue: 10,
              sizeMin: shot.size[0],
              sizeMax: shot.size[1],
              spreadPx: shot.spread
            })
          }
          // The impact burst still belongs on the boss.
          pushBurst(burstFrom(preset, cellCentre(event.x, event.y), 350, scale(preset.count)))
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('pacmanHurt'))
        out.floaters.push({ x: event.x, y: event.y, text: `-${event.amount}`, tone: 'damage' })
        break
      }

      case 'pacmanDefeated': {
        const preset = presetOf('pacmanDefeated')
        if (preset !== undefined) {
          pushBurst(burstFrom(preset, cellCentre(event.x, event.y), 150, scale(preset.count)))
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('pacmanDefeat'))
        break
      }

      case 'obstacleSpawned': {
        const preset = presetOf('obstacleSpawned')
        if (preset !== undefined) {
          pushBurst(
            burstFrom(preset, cellCentre(event.x, event.y), 268, scale(preset.count))
          )
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('obstacleSpawn'))
        break
      }

      case 'obstacleHit': {
        // The obstacle survived, so this is deliberately a smaller, duller
        // version of the break: chips fly but nothing explodes and no score
        // is announced. The crack in the artwork is the real feedback.
        const preset = presetOf('obstacleHit')
        if (preset !== undefined) {
          pushBurst(burstFrom(preset, cellCentre(event.x, event.y), 220, scale(preset.count)))
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('obstacleCrack'))
        break
      }

      case 'obstacleCleared': {
        const preset = presetOf('obstacleCleared')
        if (preset !== undefined) {
          pushBurst(
            burstFrom(preset, cellCentre(event.x, event.y), 28, scale(preset.count))
          )
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('obstacleBreak'))
        out.floaters.push({ x: event.x, y: event.y, text: `+${event.bonus}`, tone: 'bonus' })
        break
      }

      case 'toBuffer':
        out.sounds.push(sound('pick'))
        break

      case 'spawned':
        out.sounds.push(sound('spawn'))
        break

      case 'invalid':
        // Never any particles: an illegal move must not feel like progress.
        out.sounds.push(sound('invalid'))
        break

      case 'undo': {
        const preset = presetOf('undo')
        if (preset !== undefined) {
          pushBurst(
            burstFrom(
              preset,
              { x: 0, y: 0 },
              hueForLevel(4, ctx.levelHues),
              scale(preset.count)
            )
          )
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('undo'))
        break
      }

      case 'win': {
        const preset = presetOf('win')
        if (preset !== undefined) {
          pushBurst(
            burstFrom(
              preset,
              { x: 0, y: 0 },
              hueForLevel(event.level, ctx.levelHues),
              scale(preset.count)
            )
          )
          pushShake(shakeFrom(preset))
        }
        out.sounds.push(sound('win'))
        break
      }

      case 'gameOver':
        out.sounds.push(sound('gameOver'))
        break

      case 'restarted':
        break

      case 'cascadeSteps':
        // Pure payload: the view plays each step separately (see
        // CascadePlayer), so it must not also be mapped here.
        break
    }
  }

  // Respect the hard particle budget from the config.
  if (out.particles.length > 0) {
    let total = 0
    for (const spec of out.particles) total += spec.count
    if (total > config.maxParticles) {
      const ratio = config.maxParticles / total
      for (const spec of out.particles) {
        spec.count = Math.max(1, Math.floor(spec.count * ratio))
      }
    }
  }

  out.shake = lastShake
  return out
}
