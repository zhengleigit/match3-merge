import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readZip, ZipFormatError, type ZipEntry } from '../src/core/zip'
import { stripCommonPrefix } from '../src/view/assets'
import { deflateRaw as inflate, toArrayBuffer } from '../src/view/inflate'

/**
 * The zip reader is the one place where a malformed theme pack could take the
 * whole game down, so it is tested with real archives rather than mocks.
 *
 * Decompression goes through the exact production inflater
 * (`DecompressionStream('deflate-raw')`) and compression through its mirror
 * image, so the test covers the same bytes the browser will see.
 */

async function compressRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toArrayBuffer(data)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface FileSpec {
  name: string
  body: string
  /** 0 = store, 8 = deflate. Defaults to 8. */
  method?: number
  /** Extra bytes appended to the local header (not the central record). */
  localExtra?: Uint8Array
  /** Set bit 0 to mark the entry encrypted. */
  encrypted?: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Minimal zip writer used only by these tests. */
async function makeZip(files: readonly FileSpec[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const name = new TextEncoder().encode(file.name)
    const raw = new TextEncoder().encode(file.body)
    const method = file.method ?? 8
    const payload = method === 8 ? await compressRaw(raw) : raw
    const extra = file.localExtra ?? new Uint8Array(0)
    const crc = crc32(raw)
    const flags = file.encrypted === true ? 0x0001 : 0

    const header = new Uint8Array(30)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, 0x04034b50, true)
    headerView.setUint16(4, 20, true)
    headerView.setUint16(6, flags, true)
    headerView.setUint16(8, method, true)
    headerView.setUint32(14, crc, true)
    headerView.setUint32(18, payload.length, true)
    headerView.setUint32(22, raw.length, true)
    headerView.setUint16(26, name.length, true)
    headerView.setUint16(28, extra.length, true)

    parts.push(header, name, extra, payload)

    const record = new Uint8Array(46)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x02014b50, true)
    recordView.setUint16(4, 20, true)
    recordView.setUint16(6, 20, true)
    recordView.setUint16(8, flags, true)
    recordView.setUint16(10, method, true)
    recordView.setUint32(16, crc, true)
    recordView.setUint32(20, payload.length, true)
    recordView.setUint32(24, raw.length, true)
    recordView.setUint16(28, name.length, true)
    recordView.setUint32(42, offset, true)

    central.push(record, name)
    offset += header.length + name.length + extra.length + payload.length
  }

  const centralBytes = concat(central)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, files.length, true)
  endView.setUint16(10, files.length, true)
  endView.setUint32(12, centralBytes.length, true)
  endView.setUint32(16, offset, true)

  return concat([...parts, centralBytes, end])
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function names(entries: readonly ZipEntry[]): string[] {
  return entries.map((entry) => entry.name)
}

function text(entry: ZipEntry): string {
  return new TextDecoder('utf-8').decode(entry.data)
}

describe('readZip', () => {
  it('reads deflated entries back byte-for-byte', async () => {
    const archive = await makeZip([{ name: 'theme.json', body: '{"id":"a"}' }])
    const result = await readZip(archive, inflate)

    expect(result.warnings).toEqual([])
    expect(names(result.entries)).toEqual(['theme.json'])
    expect(text(result.entries[0])).toBe('{"id":"a"}')
  })

  it('reads stored (uncompressed) entries without inflating', async () => {
    const archive = await makeZip([{ name: 'plain.txt', body: 'A'.repeat(400), method: 0 }])
    const result = await readZip(archive, async () => {
      throw new Error('inflater must not be called for stored entries')
    })

    expect(result.warnings).toEqual([])
    expect(text(result.entries[0])).toBe('A'.repeat(400))
  })

  it('keeps nested paths and archive order', async () => {
    const archive = await makeZip([
      { name: 'theme.json', body: '{}' },
      { name: 'blocks/level1.svg', body: '<svg/>' },
      { name: 'blocks/level2.svg', body: '<svg></svg>' }
    ])
    const result = await readZip(archive, inflate)
    expect(names(result.entries)).toEqual(['theme.json', 'blocks/level1.svg', 'blocks/level2.svg'])
  })

  it('uses the local header extra length, not the central one', async () => {
    // A writer may put a data descriptor or alignment padding in the local
    // header only. Reading the payload at the central directory's idea of the
    // offset would corrupt every following byte, so this is worth a guard.
    const archive = await makeZip([{ name: 'a.txt', body: 'payload', localExtra: new Uint8Array(12) }])
    const result = await readZip(archive, inflate)
    expect(text(result.entries[0])).toBe('payload')
  })

  it('skips directory entries silently', async () => {
    const archive = await makeZip([
      { name: 'blocks/', body: '', method: 0 },
      { name: 'blocks/level1.svg', body: '<svg/>' }
    ])
    const result = await readZip(archive, inflate)
    expect(names(result.entries)).toEqual(['blocks/level1.svg'])
    expect(result.warnings).toEqual([])
  })

  it('skips encrypted entries with a warning', async () => {
    const archive = await makeZip([
      { name: 'secret.bin', body: 'x', encrypted: true },
      { name: 'ok.txt', body: 'fine' }
    ])
    const result = await readZip(archive, inflate)

    expect(names(result.entries)).toEqual(['ok.txt'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('secret.bin')
    expect(result.warnings[0]).toContain('encrypted')
  })

  it('skips unsupported compression methods with a warning', async () => {
    const archive = await makeZip([{ name: 'weird.bin', body: 'x', method: 12 }])
    const result = await readZip(archive, inflate)

    expect(result.entries).toEqual([])
    expect(result.warnings[0]).toContain('unsupported compression 12')
  })

  it('reports a failing inflater instead of throwing', async () => {
    const archive = await makeZip([{ name: 'broken.bin', body: 'needs deflate' }])
    const result = await readZip(archive, async () => {
      throw new Error('corrupt stream')
    })

    expect(result.entries).toEqual([])
    expect(result.warnings[0]).toContain('could not be decompressed')
  })

  it('rejects data that is not a zip at all', async () => {
    await expect(readZip(new TextEncoder().encode('hello world, definitely not a zip'), inflate)).rejects.toThrow(
      ZipFormatError
    )
    await expect(readZip(new Uint8Array(0), inflate)).rejects.toThrow(ZipFormatError)
  })

  it('rejects a central directory that runs past the end of the file', async () => {
    const archive = await makeZip([{ name: 'a.txt', body: 'abc' }])
    // Point the central directory far beyond the real file end.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    const eocd = archive.length - 22
    view.setUint32(eocd + 12, 0x00ff_ffff, true)

    await expect(readZip(archive, inflate)).rejects.toThrow(/past the end/)
  })

  it('rejects ZIP64 archives', async () => {
    const archive = await makeZip([{ name: 'a.txt', body: 'abc' }])
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    view.setUint32(archive.length - 22 + 16, 0xffffffff, true)

    await expect(readZip(archive, inflate)).rejects.toThrow(/ZIP64/)
  })

  it('still reads an archive whose entry count is wrong', async () => {
    // A homemade packer that counts a Map's `.length` writes 0 here, which
    // would make a valid archive look empty.
    const archive = await makeZip([
      { name: 'theme.json', body: '{}' },
      { name: 'blocks/level1.svg', body: '<svg/>' }
    ])
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    view.setUint16(archive.length - 22 + 8, 0, true)
    view.setUint16(archive.length - 22 + 10, 0, true)

    const result = await readZip(archive, inflate)
    expect(names(result.entries)).toEqual(['theme.json', 'blocks/level1.svg'])
  })
})

describe('stripCommonPrefix', () => {
  const entry = (name: string): ZipEntry => ({ name, data: new Uint8Array(0) })

  it('leaves a flat archive untouched', () => {
    const files = stripCommonPrefix([entry('theme.json'), entry('blocks/level1.svg')])
    expect([...files.keys()]).toEqual(['theme.json', 'blocks/level1.svg'])
  })

  it('strips a single shared top-level folder', () => {
    // "compress this folder" is the default in every file manager, so this
    // shape is what users will actually produce.
    const files = stripCommonPrefix([
      entry('neon/theme.json'),
      entry('neon/blocks/level1.svg'),
      entry('neon/page-bg.svg')
    ])
    expect([...files.keys()]).toEqual(['theme.json', 'blocks/level1.svg', 'page-bg.svg'])
  })

  it('keeps the folder when two share the archive root', () => {
    const files = stripCommonPrefix([entry('a/theme.json'), entry('b/theme.json')])
    expect([...files.keys()]).toEqual(['a/theme.json', 'b/theme.json'])
  })

  it('normalises backslashes and leading slashes', () => {
    const files = stripCommonPrefix([entry('/theme.json'), entry('blocks\\level1.svg')])
    expect([...files.keys()]).toEqual(['theme.json', 'blocks/level1.svg'])
  })
})

describe('bundled theme packs', () => {
  it.each(['neon', 'paper'])('%s.zip is readable and complete', async (id) => {
    const path = join(process.cwd(), 'src', 'themes', 'packs', `${id}.zip`)
    const result = await readZip(new Uint8Array(readFileSync(path)), inflate)

    expect(result.warnings).toEqual([])

    const files = stripCommonPrefix(result.entries)
    const manifest = files.get('theme.json')
    expect(manifest).toBeDefined()

    const parsed = JSON.parse(new TextDecoder().decode(manifest as Uint8Array)) as {
      id: string
      name: string
      slots: Record<string, string>
    }
    expect(parsed.id).toBe(id)

    // Every slot the manifest advertises must actually be in the archive,
    // otherwise the pack installs but silently draws half of it in code.
    for (const [slot, relative] of Object.entries(parsed.slots)) {
      expect(files.has(relative), `${slot} -> ${relative}`).toBe(true)
    }

    // All ten levels, so the endless mode's chain has sprites throughout.
    for (let level = 1; level <= 10; level++) {
      expect(files.has(`blocks/level${level}.svg`)).toBe(true)
    }
  })
})
