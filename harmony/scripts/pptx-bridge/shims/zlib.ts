// node:zlib shim — media insert (M2) throws instead of silently corrupting.
export function deflateSync(_data: Uint8Array): Uint8Array {
  throw new Error('node:zlib deflateSync unavailable in browser shell (media insert is M2)')
}