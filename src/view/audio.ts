import { sfxConfig, type SoundId, type SoundPreset, type SoundSpec } from '../core/fxMap'

/**
 * Web Audio sound engine.
 *
 * Sounds are synthesised at runtime (oscillator + ADSR envelope, optional
 * noise layer), so the game ships with sound and zero audio assets. A theme
 * may override any sound id with a real file; a missing or undecodable file
 * silently falls back to the synth preset.
 *
 * Browsers block audio until a user gesture, so `unlock()` is called from the
 * first click (picking a mode) and is safe to call repeatedly.
 */

interface Voice {
  gain: GainNode
  /** AudioContext time at which this voice stops. */
  stopsAt: number
}

const MAX_VOICES = sfxConfig.master.maxVoices

export class AudioEngine {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null

  /** Decoded theme overrides, keyed by sound id. */
  private readonly overrides = new Map<SoundId, AudioBuffer>()
  /** Voices still playing, used for the concurrency cap. */
  private readonly active: Voice[] = []
  private readonly lastPlayedAt = new Map<SoundId, number>()

  private enabled = true
  private volume = 0.7

  get isEnabled(): boolean {
    return this.enabled
  }

  get masterVolume(): number {
    return this.volume
  }

  /**
   * Creates or resumes the AudioContext. Must be called from a user gesture.
   * Returns true when audio is actually running.
   */
  unlock(): boolean {
    try {
      if (this.context === null) {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

        if (Ctor === undefined) return false

        this.context = new Ctor()
        this.master = this.context.createGain()
        this.master.gain.value = this.enabled ? this.volume : 0
        this.master.connect(this.context.destination)
      }

      if (this.context.state === 'suspended') {
        void this.context.resume()
      }
      return true
    } catch {
      this.context = null
      this.master = null
      return false
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.applyVolume()
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume))
    this.applyVolume()
  }

  private applyVolume(): void {
    if (this.master === null || this.context === null) return
    const target = this.enabled ? this.volume : 0
    this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.01)
  }

  /**
   * Loads theme-provided audio files. Failures are ignored: the synth preset
   * stays in place, which is exactly the fallback the theme system promises.
   *
   * The override set is replaced wholesale rather than merged: a theme that
   * ships fewer sounds than the previous one would otherwise keep playing the
   * previous theme's audio, which reads as a bug to the player.
   */
  async loadOverrides(sources: Array<{ id: SoundId; url: string }>): Promise<void> {
    if (!this.unlock() || this.context === null) return

    this.overrides.clear()

    await Promise.all(
      sources.map(async ({ id, url }) => {
        try {
          const response = await fetch(url, { cache: 'force-cache' })
          if (!response.ok) return
          const data = await response.arrayBuffer()
          const buffer = await this.context!.decodeAudioData(data)
          this.overrides.set(id, buffer)
        } catch {
          // Keep the synthesised preset.
        }
      })
    )
  }

  private currentNoiseBuffer(): AudioBuffer | null {
    if (this.context === null) return null
    if (this.noiseBuffer !== null) return this.noiseBuffer

    const seconds = 0.5
    const length = Math.floor(this.context.sampleRate * seconds)
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate)
    const data = buffer.getChannelData(0)

    // Deterministic noise so repeated sessions sound identical.
    let seed = 0x1234567
    for (let i = 0; i < length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      data[i] = (seed / 0x3fffffff) - 1
    }

    this.noiseBuffer = buffer
    return buffer
  }

  private pruneVoices(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].stopsAt <= now) {
        this.active[i].gain.disconnect()
        this.active.splice(i, 1)
      }
    }
  }

  /** Plays one sound. Extra voices beyond the cap are dropped. */
  play(spec: SoundSpec): void {
    if (!this.enabled || this.volume <= 0) return
    if (!this.unlock()) return

    const context = this.context
    const master = this.master
    if (context === null || master === null) return

    const now = context.currentTime
    this.pruneVoices(now)

    const preset = sfxConfig.sounds[spec.id]
    if (preset === undefined) return

    // Rapid repeats of the same sound duck instead of stacking into noise.
    const previous = this.lastPlayedAt.get(spec.id)
    let gainScale = Math.max(0, spec.gain)
    if (previous !== undefined && (now - previous) * 1000 < sfxConfig.master.retriggerWindowMs) {
      gainScale *= sfxConfig.master.retriggerGainFalloff
    }
    this.lastPlayedAt.set(spec.id, now)

    const override = this.overrides.get(spec.id)
    if (override !== undefined) {
      this.playBuffer(context, master, override, spec, gainScale, now)
      return
    }

    if (this.active.length >= MAX_VOICES) return
    this.playSynth(context, master, preset, spec, gainScale, now)
  }

  private playBuffer(
    context: AudioContext,
    master: GainNode,
    buffer: AudioBuffer,
    spec: SoundSpec,
    gainScale: number,
    now: number
  ): void {
    const start = now + spec.delayMs / 1000
    const source = context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = Math.pow(2, spec.semitone / 12)

    const gain = context.createGain()
    gain.gain.value = gainScale
    source.connect(gain).connect(master)
    source.start(start)

    this.active.push({ gain, stopsAt: start + buffer.duration + 0.05 })
  }

  private playSynth(
    context: AudioContext,
    master: GainNode,
    preset: SoundPreset,
    spec: SoundSpec,
    gainScale: number,
    now: number
  ): void {
    const start = now + spec.delayMs / 1000
    const duration = preset.durationMs / 1000
    const attack = Math.max(0.001, preset.attackMs / 1000)
    const baseFreq = preset.freq * Math.pow(2, spec.semitone / 12)

    const gain = context.createGain()
    gain.connect(master)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainScale), start + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

    // An arpeggio schedules a few short notes on the same envelope graph.
    const steps = preset.arpeggio ?? [0]
    const stepDuration = duration / steps.length

    for (let i = 0; i < steps.length; i++) {
      const stepStart = start + i * stepDuration
      if (preset.wave !== 'noise' && !preset.noise) {
        const osc = context.createOscillator()
        // Inside this branch the wave is a real oscillator type, never 'noise'.
        osc.type = preset.wave
        const freq = baseFreq * Math.pow(2, steps[i] / 12)
        osc.frequency.setValueAtTime(freq, stepStart)
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, freq * preset.sweepTo),
          stepStart + stepDuration
        )
        osc.connect(gain)
        osc.start(stepStart)
        osc.stop(stepStart + stepDuration)
      }

      if (preset.noise || preset.wave === 'noise') {
        const noiseBuffer = this.currentNoiseBuffer()
        if (noiseBuffer !== null) {
          const source = context.createBufferSource()
          source.buffer = noiseBuffer
          const noiseGain = context.createGain()
          noiseGain.gain.setValueAtTime(preset.noiseGain ?? 0.2, stepStart)
          noiseGain.gain.exponentialRampToValueAtTime(0.0001, stepStart + stepDuration)
          source.connect(noiseGain).connect(master)
          source.start(stepStart)
          source.stop(stepStart + stepDuration)
        }
      }
    }

    this.active.push({ gain, stopsAt: start + duration + 0.05 })
  }

  /** Plays a batch of descriptors in the order fxMap produced them. */
  playAll(specs: readonly SoundSpec[]): void {
    for (let i = 0; i < specs.length; i++) this.play(specs[i])
  }

  get overrideCount(): number {
    return this.overrides.size
  }
}
