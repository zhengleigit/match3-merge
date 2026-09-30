/**
 * Generates the placeholder art for the bundled "example" theme.
 *
 * Run with:  node tools/generate-placeholder-theme.mjs
 *
 * The point of these assets is to prove the theme pipeline end to end: switch
 * the theme in settings and every sprite visibly changes. Replace them with
 * your own artwork using the same file names and you are done — see
 * public/themes/README.md.
 *
 * Level art encodes the level twice (hue AND polygon side count) so the ladder
 * stays readable for colour-blind players and in greyscale.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const themeDir = join(here, '..', 'public', 'themes', 'example')

/**
 * Score table of endless mode. Used for the hue/level ladder only: the number
 * baked into each sprite is the block's LEVEL, matching the procedural
 * renderer (the score table lives in the rules line under the board).
 */
const SCORES = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
const HUES = [200, 168, 48, 18, 288, 262, 196, 128, 62, 332]

const SIZE = 256

function polygonPoints(cx, cy, radius, sides, rotationDeg = -90) {
  const points = []
  const rotation = (rotationDeg * Math.PI) / 180
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i * 2 * Math.PI) / sides
    points.push(`${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`)
  }
  return points.join(' ')
}

function blockSvg(level) {
  const hue = HUES[(level - 1) % HUES.length]
  const sides = Math.min(12, level + 2)
  // Fill most of the canvas: the renderer draws theme art at the theme's own
  // padding, so the artwork itself must not leave a big empty margin.
  const scale = 0.8 + (0.18 * (level - 1)) / (SCORES.length - 1)
  const half = (SIZE * scale) / 2
  const inset = SIZE / 2 - half
  const side = SIZE - inset * 2
  const radius = side * 0.22

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="g${level}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 78% 68%)"/>
      <stop offset="1" stop-color="hsl(${hue} 66% 44%)"/>
    </linearGradient>
  </defs>
  <rect x="${inset.toFixed(1)}" y="${inset.toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="${radius.toFixed(1)}"
        fill="url(#g${level})" stroke="hsl(${hue} 88% 82%)" stroke-width="4"/>
  <polygon points="${polygonPoints(SIZE / 2, SIZE / 2, side * 0.3, sides)}"
           fill="rgba(255,255,255,0.22)" stroke="rgba(255,255,255,0.85)" stroke-width="3"/>
  <text x="${SIZE / 2}" y="${SIZE / 2 + 11}" text-anchor="middle"
        font-family="system-ui, sans-serif" font-size="34" font-weight="700"
        fill="rgba(12,14,26,0.92)">${level}</text>
</svg>
`
}

function pageBackgroundSvg() {
  const dots = []
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const opacity = 0.03 + ((x * 7 + y * 13) % 5) * 0.008
      dots.push(
        `<circle cx="${x * 46 + 18}" cy="${y * 46 + 18}" r="${3 + ((x + y) % 3)}" fill="#7f8cff" opacity="${opacity.toFixed(3)}"/>`
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 552 552" width="552" height="552">
  <defs>
    <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2140"/>
      <stop offset="0.55" stop-color="#12172c"/>
      <stop offset="1" stop-color="#0a0d18"/>
    </linearGradient>
  </defs>
  <rect width="552" height="552" fill="url(#pg)"/>
  ${dots.join('\n  ')}
</svg>
`
}

function boardBackgroundSvg() {
  // NOTE: this image is stretched to the board rect, which is 7x10 (not
  // square). Keep it stretch-friendly — a gradient plus soft dots, no hard
  // border or rounded corners that would distort.
  const dots = []
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 7; x++) {
      dots.push(
        `<circle cx="${x * 36 + 18}" cy="${y * 36 + 18}" r="2.5" fill="#8f9cff" opacity="0.06"/>`
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 252 360" width="252" height="360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#242c4f"/>
      <stop offset="0.5" stop-color="#1b2138"/>
      <stop offset="1" stop-color="#141928"/>
    </linearGradient>
  </defs>
  <rect width="252" height="360" fill="url(#bg)"/>
  ${dots.join('\n  ')}
</svg>
`
}

function obstacleSvg() {
  const hatch = []
  for (let i = -SIZE; i < SIZE * 2; i += 22) {
    hatch.push(`<line x1="${i}" y1="0" x2="${i - SIZE}" y2="${SIZE}" stroke="#20263c" stroke-width="7" opacity="0.65"/>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <g>
    <rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="20" fill="#5b6485"/>
    <clipPath id="c"><rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="20"/></clipPath>
    <g clip-path="url(#c)">${hatch.join('')}</g>
    <rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="20" fill="none" stroke="#c3cae8" stroke-width="4" opacity="0.6"/>
    <path d="M ${SIZE * 0.32} ${SIZE * 0.32} L ${SIZE * 0.68} ${SIZE * 0.68} M ${SIZE * 0.68} ${SIZE * 0.32} L ${SIZE * 0.32} ${SIZE * 0.68}"
          stroke="#ffe08a" stroke-width="12" stroke-linecap="round" opacity="0.85"/>
  </g>
</svg>
`
}

/**
 * The same obstacle after one hit.
 *
 * The intact tile carries an X-mark ("this is a wall"); the damaged one carries
 * fracture lines instead ("this is nearly gone"). That visual difference is the
 * only cue that a second hit is needed, so it is worth a dedicated sprite rather
 * than reusing the intact one.
 */
function obstacleCrackedSvg() {
  const hatch = []
  for (let i = -SIZE; i < SIZE * 2; i += 22) {
    hatch.push(`<line x1="${i}" y1="0" x2="${i - SIZE}" y2="${SIZE}" stroke="#20263c" stroke-width="7" opacity="0.5"/>`)
  }
  const mid = SIZE / 2
  const crack = `M ${mid} 18 L ${mid - 26} ${SIZE * 0.42} L ${mid + 18} ${SIZE * 0.6} L ${mid - 22} ${SIZE - 18}`
  const branchA = `M ${mid - 26} ${SIZE * 0.42} L ${SIZE * 0.16} ${SIZE * 0.3}`
  const branchB = `M ${mid + 18} ${SIZE * 0.6} L ${SIZE * 0.86} ${SIZE * 0.74}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <g>
    <rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="20" fill="#4e5673"/>
    <clipPath id="cc"><rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="20"/></clipPath>
    <g clip-path="url(#cc)">${hatch.join('')}</g>
    <rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="20" fill="none" stroke="#c3cae8" stroke-width="4" opacity="0.45"/>
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="${crack} ${branchA} ${branchB}" stroke="#12172a" stroke-width="18" opacity="0.85"/>
      <path d="${crack} ${branchA} ${branchB}" stroke="#ffecb4" stroke-width="8"/>
    </g>
  </g>
</svg>
`
}

/**
 * Home-screen background. Portrait-ish and low contrast, because menu cards and
 * white text sit on top of it; the CSS adds a scrim as well.
 */
function homeBackgroundSvg() {
  const sparkles = []
  for (let i = 0; i < 26; i++) {
    const x = (i * 137) % 552
    const y = (i * 251) % 552
    sparkles.push(
      `<circle cx="${x}" cy="${y}" r="${1 + (i % 3)}" fill="#b9c8ff" opacity="${(0.05 + (i % 4) * 0.02).toFixed(2)}"/>`
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 552 552" width="552" height="552">
  <defs>
    <linearGradient id="hg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#1d2547"/>
      <stop offset="0.5" stop-color="#111730"/>
      <stop offset="1" stop-color="#070a14"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.08" r="0.75">
      <stop offset="0" stop-color="#6c7dff" stop-opacity="0.40"/>
      <stop offset="1" stop-color="#6c7dff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="552" height="552" fill="url(#hg)"/>
  <rect width="552" height="552" fill="url(#glow)"/>
  ${sparkles.join('\n  ')}
</svg>
`
}

function slotSvg(tint, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <rect x="10" y="10" width="${SIZE - 20}" height="${SIZE - 20}" rx="26"
        fill="${tint}" stroke="${label}" stroke-width="5" opacity="0.95"/>
  <rect x="30" y="30" width="${SIZE - 60}" height="${SIZE - 60}" rx="16"
        fill="none" stroke="${label}" stroke-width="2" opacity="0.4" stroke-dasharray="8 10"/>
</svg>
`
}

function frameSvg(stroke, width, dash) {
  const dashAttr = dash ? ` stroke-dasharray="8 9"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <rect x="14" y="14" width="${SIZE - 28}" height="${SIZE - 28}" rx="24"
        fill="none" stroke="${stroke}" stroke-width="${width}"${dashAttr}/>
</svg>
`
}

/** Short 16-bit mono PCM WAV so the audio-override path is demonstrable. */
function blipWav({ freq, durationMs, sampleRate = 22050 }) {
  const samples = Math.floor((sampleRate * durationMs) / 1000)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    const envelope = Math.exp(-t * 26)
    const value = Math.sin(2 * Math.PI * freq * t) * envelope * 0.5
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2)
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

function write(relativePath, contents) {
  const target = join(themeDir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

// --- sprites -----------------------------------------------------------------

for (let level = 1; level <= SCORES.length; level++) {
  write(`blocks/level${level}.svg`, blockSvg(level))
}
write('page-bg.svg', pageBackgroundSvg())
write('home-bg.svg', homeBackgroundSvg())
write('board-bg.svg', boardBackgroundSvg())
write('obstacle.svg', obstacleSvg())
write('obstacle-cracked.svg', obstacleCrackedSvg())
write('slot-buffer.svg', slotSvg('rgba(80,110,220,0.16)', 'rgba(140,164,255,0.55)'))
write('slot-next.svg', slotSvg('rgba(240,190,90,0.14)', 'rgba(255,208,120,0.6)'))
write('cell-frame.svg', frameSvg('rgba(255,255,255,0.10)', 3, true))
write('highlight.svg', frameSvg('rgba(154,174,255,0.95)', 7, false))

// --- audio overrides ---------------------------------------------------------

write('audio/merge.wav', blipWav({ freq: 660, durationMs: 130 }))
write('audio/maxClear.wav', blipWav({ freq: 220, durationMs: 380 }))
write('audio/win.wav', blipWav({ freq: 880, durationMs: 620 }))

console.log(`generated example theme in ${themeDir}`)
