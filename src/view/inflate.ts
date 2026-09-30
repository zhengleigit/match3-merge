/**
 * Browser-side decompression helpers.
 *
 * Kept out of `core/zip.ts` so the archive parser stays pure: the parser takes
 * an inflate function as a parameter, and this is the real implementation.
 */

/**
 * Copies bytes into a fresh, non-shared ArrayBuffer.
 *
 * `Uint8Array` can in principle wrap a `SharedArrayBuffer`, which `Blob` will
 * not accept. Copying also detaches the result from the source buffer, which
 * matters because an archive's buffer stays alive for all of its entries.
 */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength)
  new Uint8Array(out).set(data)
  return out
}

/** Inflates a raw DEFLATE stream (no zlib/gzip wrapper). */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable in this browser')
  }

  // `deflate-raw` is exactly what zip stores: DEFLATE without a wrapper.
  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(
    new DecompressionStream('deflate-raw')
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
