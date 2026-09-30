/**
 * Builds the demo zip theme packs under `src/themes/packs/`.
 *
 * A theme pack is just a zip containing:
 *
 *   theme.json          -- same schema as a folder theme
 *   blocks/level1.svg ... level10.svg
 *   page-bg.svg  board-bg.svg  home-bg.svg  obstacle.svg
 *   slot-buffer.svg  slot-next.svg  slot-frame.svg  slot-highlight.svg
 *
 * Drop any zip like that into `src/themes/packs/` and it appears in the settings
 * panel after a rebuild. This script exists so the repo ships two working packs
 * to demonstrate the format, and so the pack writer is exercised in CI.
 *
 * Usage: node tools/build-theme-packs.mjs
 */

import { deflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'src', 'themes', 'packs')

// ---------------------------------------------------------------------------
// Minimal zip writer (deflate, no zip64)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Fixed timestamp keeps builds byte-for-byte reproducible. */
const DOS_TIME = 0
const DOS_DATE = (1980 - 1980) << 9 | (1 << 5) | 1

function zip(files) {
  const local = []
  const central = []
  let offset = 0

  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8')
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const deflated = deflateRawSync(raw, { level: 9 })
    // Only worth compressing if it actually got smaller.
    const stored = deflated.length >= raw.length
    const payload = stored ? raw : deflated
    const method = stored ? 0 : 8
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(DOS_TIME, 10)
    header.writeUInt16LE(DOS_DATE, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(payload.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)

    local.push(header, nameBytes, payload)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(DOS_TIME, 12)
    record.writeUInt16LE(DOS_DATE, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(nameBytes.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)

    central.push(record, nameBytes)
    offset += header.length + nameBytes.length + payload.length
  }

  const centralBuffer = Buffer.concat(central)
  // A Map has no `.length`, and writing `undefined` silently produces 0, which
  // makes the archive look empty. Count explicitly.
  const count = files.size
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...local, centralBuffer, end])
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

const LEVELS = 10

/**
 * A pack palette: one hue per level, plus the chrome colours.
 * `chrome` is deliberately low-contrast so the board never fights the blocks.
 */
function makePack({ id, name, hues, pageFrom, pageTo, chrome, blockScale = 0.96 }) {
  const svg = (width, height, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${body}</svg>`

  const files = new Map()

  const background = (from, to) =>
    svg(
      160,
      240,
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">` +
        `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
        `</linearGradient></defs>` +
        `<rect width="160" height="240" fill="url(#g)"/>` +
        `<g opacity="0.14" fill="#fff">` +
        [18, 74, 130].map((y) => `<circle cx="34" cy="${y}" r="16"/><circle cx="118" cy="${y + 26}" r="11"/>`).join('') +
        `</g>`
    )

  files.set('page-bg.svg', background(pageFrom, pageTo))
  files.set('home-bg.svg', background(pageTo, pageFrom))

  // Board plate: a soft rounded rect with an inner rim.
  files.set(
    'board-bg.svg',
    svg(
      140,
      200,
      `<rect x="2" y="2" width="136" height="196" rx="18" fill="${chrome.plate}"/>` +
        `<rect x="7" y="7" width="126" height="186" rx="14" fill="none" stroke="${chrome.rim}" stroke-width="2" opacity="0.55"/>`
    )
  )

  files.set(
    'obstacle.svg',
    svg(
      100,
      100,
      `<rect x="6" y="6" width="88" height="88" rx="18" fill="${chrome.obstacle}"/>` +
        `<path d="M32 32 L68 68 M68 32 L32 68" stroke="${chrome.obstacleMark}" stroke-width="11" stroke-linecap="round"/>`
    )
  )

  const slot = (fill, stroke, inset) =>
    svg(
      100,
      100,
      `<rect x="${inset}" y="${inset}" width="${100 - inset * 2}" height="${100 - inset * 2}" rx="18" ` +
        `fill="${fill}" stroke="${stroke}" stroke-width="3"/>`
    )

  files.set('slot-buffer.svg', slot(chrome.slotBuffer, chrome.slotRim, 5))
  files.set('slot-next.svg', slot(chrome.slotNext, chrome.slotRimAccent, 5))
  files.set('slot-frame.svg', slot('none', chrome.rim, 6))
  files.set('slot-highlight.svg', slot(chrome.highlight, chrome.highlightRim, 4))

  for (let level = 1; level <= LEVELS; level++) {
    const hue = hues[(level - 1) % hues.length]
    const light = Math.max(38, 68 - (level - 1) * 2.4)
    const body = `hsl(${hue} 78% ${light}%)`
    const top = `hsl(${hue} 86% ${Math.min(88, light + 20)}%)`
    const edge = `hsl(${hue} 60% ${Math.max(18, light - 30)}%)`

    files.set(
      `blocks/level${level}.svg`,
      svg(
        100,
        100,
        `<defs><linearGradient id="b" x1="0" y1="0" x2="0.3" y2="1">` +
          `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${body}"/>` +
          `</linearGradient></defs>` +
          `<rect x="3" y="3" width="94" height="94" rx="22" fill="${edge}"/>` +
          `<rect x="4" y="4" width="92" height="92" rx="21" fill="url(#b)"/>` +
          `<ellipse cx="34" cy="28" rx="24" ry="14" fill="#fff" opacity="0.34"/>` +
          `<rect x="4" y="4" width="92" height="92" rx="21" fill="none" stroke="${edge}" stroke-width="3"/>` +
          `<circle cx="${18 + (level % 3) * 30}" cy="${70 - (level % 4) * 8}" r="${3 + (level % 4)}" fill="#fff" opacity="0.4"/>`
      )
    )
  }

  files.set(
    'theme.json',
    JSON.stringify(
      {
        id,
        name,
        blockScale,
        padding: 0.08,
        slots: {
          'page.background': 'page-bg.svg',
          'home.background': 'home-bg.svg',
          'board.background': 'board-bg.svg',
          obstacle: 'obstacle.svg',
          'slot.buffer': 'slot-buffer.svg',
          'slot.next': 'slot-next.svg',
          'slot.cellFrame': 'slot-frame.svg',
          'slot.highlight': 'slot-highlight.svg',
          ...Object.fromEntries(
            Array.from({ length: LEVELS }, (_, i) => [`block.level${i + 1}`, `blocks/level${i + 1}.svg`])
          )
        }
      },
      null,
      2
    )
  )

  return files
}

const PACKS = [
  makePack({
    id: 'neon',
    name: '霓虹夜城',
    hues: [190, 165, 95, 320, 265, 210, 150, 45, 285, 175],
    pageFrom: '#10162e',
    pageTo: '#1c2447',
    chrome: {
      plate: '#182046',
      rim: '#3d4a86',
      obstacle: '#39406b',
      obstacleMark: '#8e97c9',
      slotBuffer: '#1b2350',
      slotNext: '#232c60',
      slotRim: '#3d4a86',
      slotRimAccent: '#5f6fc4',
      highlight: 'rgba(255,255,255,0.16)',
      highlightRim: '#9fb0ff'
    },
    blockScale: 0.96
  }),
  makePack({
    id: 'paper',
    name: '纸片工坊',
    hues: [340, 18, 44, 96, 168, 205, 250, 288, 320, 60],
    pageFrom: '#f3ece0',
    pageTo: '#e3d8c6',
    chrome: {
      plate: '#efe6d6',
      rim: '#b9a888',
      obstacle: '#c9b99a',
      obstacleMark: '#8a7a5c',
      slotBuffer: '#e6dbc7',
      slotNext: '#f0e6d4',
      slotRim: '#c2b195',
      slotRimAccent: '#a8916a',
      highlight: 'rgba(120,90,40,0.12)',
      highlightRim: '#a8916a'
    },
    blockScale: 1.02
  })
]

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

for (const files of PACKS) {
  // Read the id back out of the manifest so the file name always matches.
  const manifest = JSON.parse(files.get('theme.json'))
  const buffer = zip(files)
  const target = join(OUT_DIR, `${manifest.id}.zip`)
  writeFileSync(target, buffer)
  const kb = (buffer.length / 1024).toFixed(1)
  console.log(
    `[packs] ${manifest.id} (${manifest.name}) -> src/themes/packs/${manifest.id}.zip  ${kb} kB, ${files.size} files`
  )
}
