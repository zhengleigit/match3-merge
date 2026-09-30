/**
 * Minimal ZIP reader.
 *
 * A theme pack is a zip, and players should be able to drop one into the theme
 * folder without touching any manifest. Reading it at runtime means no bundler
 * plugin and no server, so the whole thing is done with the browser's own
 * `DecompressionStream`.
 *
 * The split here is deliberate:
 *  - this module owns the byte-level work (locating the central directory and
 *    walking entries), which is pure and therefore unit-testable;
 *  - the actual inflation is injected, so nothing in `core` touches a browser
 *    API and tests can pass a fake inflater.
 *
 * Deliberately unsupported: multi-disk archives, encryption, ZIP64 and
 * compression methods other than store/deflate. Such entries are skipped with a
 * warning instead of throwing, so one odd file cannot make a theme unloadable.
 */

/** Decompresses a raw DEFLATE stream (i.e. deflate without a zlib header). */
export type InflateRaw = (data: Uint8Array) => Promise<Uint8Array>

export interface ZipEntry {
  /** Path inside the archive, always with forward slashes. */
  name: string
  /** Decompressed bytes. */
  data: Uint8Array
}

export interface ZipReadResult {
  entries: ZipEntry[]
  /** Non-fatal problems: skipped entries, unsupported methods, etc. */
  warnings: string[]
}

export class ZipFormatError extends Error {}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** The EOCD record is at most 22 bytes plus a 64 KiB comment. */
const MAX_EOCD_SEARCH = 22 + 0xffff

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16(dv: DataView, offset: number): number {
  return dv.getUint16(offset, true)
}

function u32(dv: DataView, offset: number): number {
  return dv.getUint32(offset, true)
}

/** Scans backwards for the End Of Central Directory signature. */
export function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const dv = view(bytes)
  const start = Math.max(0, bytes.length - MAX_EOCD_SEARCH)

  for (let offset = bytes.length - 22; offset >= start; offset--) {
    if (u32(dv, offset) === SIG_EOCD) return offset
  }
  return -1
}

/** Decodes a stored filename. Assumes UTF-8, which our own packs always use. */
function decodeName(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length)
  return new TextDecoder('utf-8').decode(slice)
}

function normalizeName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '')
}

interface CentralRecord {
  name: string
  method: number
  compressedSize: number
  localOffset: number
  flags: number
}

/** Reads the central directory. Returns entries in archive order. */
export function readCentralDirectory(bytes: Uint8Array): CentralRecord[] {
  const eocd = findEndOfCentralDirectory(bytes)
  if (eocd < 0) {
    throw new ZipFormatError('not a zip archive (no end-of-central-directory record)')
  }

  const dv = view(bytes)
  const total = u16(dv, eocd + 10)
  const cdOffset = u32(dv, eocd + 16)
  const cdSize = u32(dv, eocd + 12)

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipFormatError('ZIP64 archives are not supported')
  }
  if (cdOffset + cdSize > bytes.length) {
    throw new ZipFormatError('central directory runs past the end of the file')
  }

  const records: CentralRecord[] = []
  const limit = cdOffset + cdSize
  let cursor = cdOffset

  // The declared count is trusted when it is present, but it is only a hint:
  // a writer that miscounts (or zeroes) it would otherwise make a perfectly
  // good archive look empty. The directory has a known size, so walking it
  // until the signature stops matching recovers those archives.
  const maxRecords = total > 0 ? total : Number.MAX_SAFE_INTEGER
  for (let i = 0; i < maxRecords && cursor + 46 <= limit; i++) {
    if (u32(dv, cursor) !== SIG_CENTRAL) break

    const flags = u16(dv, cursor + 8)
    const method = u16(dv, cursor + 10)
    const compressedSize = u32(dv, cursor + 20)
    const nameLength = u16(dv, cursor + 28)
    const extraLength = u16(dv, cursor + 30)
    const commentLength = u16(dv, cursor + 32)
    const localOffset = u32(dv, cursor + 42)
    const name = normalizeName(decodeName(bytes, cursor + 46, nameLength))

    records.push({ name, method, compressedSize, localOffset, flags })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return records
}

/** Locates an entry's payload, honouring the local header's own name/extra lengths. */
function localDataOffset(bytes: Uint8Array, record: CentralRecord): number {
  const dv = view(bytes)
  const base = record.localOffset

  if (base + 30 > bytes.length || u32(dv, base) !== SIG_LOCAL) return -1

  const nameLength = u16(dv, base + 26)
  const extraLength = u16(dv, base + 28)
  const start = base + 30 + nameLength + extraLength

  return start + record.compressedSize > bytes.length ? -1 : start
}

/**
 * Reads every entry, decompressing as needed.
 *
 * Directories and unusable entries are skipped rather than failing the whole
 * archive: a theme pack with a stray `.DS_Store` or a `.gitkeep` must still load.
 */
export async function readZip(bytes: Uint8Array, inflateRaw: InflateRaw): Promise<ZipReadResult> {
  const warnings: string[] = []
  const entries: ZipEntry[] = []

  for (const record of readCentralDirectory(bytes)) {
    if (record.name.length === 0 || record.name.endsWith('/')) continue
    if ((record.flags & 0x0001) !== 0) {
      warnings.push(`"${record.name}" is encrypted; skipped`)
      continue
    }
    if (record.method !== METHOD_STORE && record.method !== METHOD_DEFLATE) {
      warnings.push(`"${record.name}" uses unsupported compression ${record.method}; skipped`)
      continue
    }

    const start = localDataOffset(bytes, record)
    if (start < 0) {
      warnings.push(`"${record.name}" has a damaged header; skipped`)
      continue
    }

    const raw = bytes.subarray(start, start + record.compressedSize)

    if (record.method === METHOD_STORE) {
      entries.push({ name: record.name, data: raw.slice() })
      continue
    }

    try {
      entries.push({ name: record.name, data: await inflateRaw(raw) })
    } catch {
      warnings.push(`"${record.name}" could not be decompressed; skipped`)
    }
  }

  return { entries, warnings }
}
